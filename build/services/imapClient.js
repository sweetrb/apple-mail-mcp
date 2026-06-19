/**
 * IMAP backend (issue #43).
 *
 * AppleScript-over-Mail.app is the default. When an account is explicitly
 * configured for IMAP (env below), operations route here instead:
 *   - read:    search-messages / list-messages (server-side SEARCH, orders of
 *              magnitude faster and correct on large Gmail mailboxes where
 *              AppleScript times out with a false-empty) and get-message;
 *   - folders: create / rename / delete-mailbox (work on the server hierarchy
 *              that AppleScript can't touch — #42);
 *   - message: mark/flag/move/delete, keyed by the composite `imap:` id the
 *              read path emits (see encodeImapId/decodeImapId below).
 * Everything is opt-in and additive; un-configured accounts use AppleScript.
 *
 * Opt-in via env (mirrors the SMTP transport pattern):
 *   APPLE_MAIL_MCP_IMAP_USER      (required — enables IMAP; the login address)
 *   APPLE_MAIL_MCP_IMAP_ACCOUNT   (Mail account name to match for routing; default = USER)
 *   APPLE_MAIL_MCP_IMAP_HOST      (default imap.gmail.com)
 *   APPLE_MAIL_MCP_IMAP_PORT      (default 993, implicit TLS)
 *   APPLE_MAIL_MCP_IMAP_PASSWORD  (else Keychain via the two vars below)
 *   APPLE_MAIL_MCP_IMAP_KEYCHAIN_SERVICE / _KEYCHAIN_ACCOUNT
 *
 * @module services/imapClient
 */
import { ImapFlow } from "imapflow";
import { readKeychainPassword } from "../services/smtpMailer.js";
import { extractHtmlBody, extractTextBody } from "../utils/mimeParse.js";
export const IMAP_ENV = {
    user: "APPLE_MAIL_MCP_IMAP_USER",
    account: "APPLE_MAIL_MCP_IMAP_ACCOUNT",
    host: "APPLE_MAIL_MCP_IMAP_HOST",
    port: "APPLE_MAIL_MCP_IMAP_PORT",
    password: "APPLE_MAIL_MCP_IMAP_PASSWORD",
    keychainService: "APPLE_MAIL_MCP_IMAP_KEYCHAIN_SERVICE",
    keychainAccount: "APPLE_MAIL_MCP_IMAP_KEYCHAIN_ACCOUNT",
    // C2 multi-account: JSON array of additional accounts, e.g.
    // [{"account":"Work","user":"me@co.com","host":"imap.co.com","keychainService":"imap.co.com"}]
    accounts: "APPLE_MAIL_MCP_IMAP_ACCOUNTS",
};
// ---------------------------------------------------------------------------
// Composite IMAP message id (Phase 3): a self-describing token the IMAP read
// path emits so the same id round-trips back to get-message and the message
// mutations. AppleScript message ids are bare numbers; an IMAP id is
// `imap:<base64url({a:account,p:mailboxPath,u:uid})>`. UIDs are per-mailbox, so
// the mailbox path must travel with the uid. base64url keeps it schema-safe.
// ---------------------------------------------------------------------------
export function encodeImapId(account, path, uid) {
    const payload = Buffer.from(JSON.stringify({ a: account, p: path, u: uid }), "utf8").toString("base64url");
    return `imap:${payload}`;
}
export function decodeImapId(id) {
    if (!id || !id.startsWith("imap:"))
        return null;
    try {
        const obj = JSON.parse(Buffer.from(id.slice("imap:".length), "base64url").toString("utf8"));
        if (typeof obj.u !== "number" || typeof obj.p !== "string")
            return null;
        return { account: String(obj.a ?? ""), path: obj.p, uid: obj.u };
    }
    catch {
        return null;
    }
}
function str(v) {
    return typeof v === "string" && v.trim() ? v.trim() : undefined;
}
/**
 * Enumerate all configured IMAP accounts (C2): the legacy single-account env
 * vars plus any in the `APPLE_MAIL_MCP_IMAP_ACCOUNTS` JSON array. Does not
 * resolve passwords. The legacy account takes precedence on label collisions.
 */
function listImapAccountSpecs(env = process.env) {
    const specs = [];
    const user = env[IMAP_ENV.user]?.trim();
    if (user) {
        specs.push({
            accountLabel: env[IMAP_ENV.account]?.trim() || user,
            user,
            host: env[IMAP_ENV.host]?.trim() || "imap.gmail.com",
            port: env[IMAP_ENV.port] ? Number.parseInt(env[IMAP_ENV.port], 10) : 993,
            password: env[IMAP_ENV.password],
            keychainService: env[IMAP_ENV.keychainService]?.trim(),
            keychainAccount: env[IMAP_ENV.keychainAccount]?.trim(),
        });
    }
    const json = env[IMAP_ENV.accounts]?.trim();
    if (json) {
        try {
            const arr = JSON.parse(json);
            if (Array.isArray(arr)) {
                for (const raw of arr) {
                    const a = raw;
                    const u = str(a.user);
                    if (!u)
                        continue;
                    const label = str(a.account) || str(a.accountLabel) || u;
                    if (specs.some((s) => s.accountLabel === label))
                        continue; // legacy wins
                    const port = a.port ? Number(a.port) : 993;
                    specs.push({
                        accountLabel: label,
                        user: u,
                        host: str(a.host) || "imap.gmail.com",
                        port,
                        password: str(a.password),
                        keychainService: str(a.keychainService),
                        keychainAccount: str(a.keychainAccount),
                    });
                }
            }
        }
        catch (e) {
            console.error(`Invalid ${IMAP_ENV.accounts} JSON, ignoring: ${String(e)}`);
        }
    }
    return specs;
}
function specToConfig(spec) {
    if (!Number.isInteger(spec.port) || spec.port <= 0) {
        throw new Error(`Invalid IMAP port for account "${spec.accountLabel}": "${spec.port}".`);
    }
    let pass = spec.password;
    if (!pass && spec.keychainService) {
        pass =
            readKeychainPassword(spec.keychainService, spec.keychainAccount || spec.user) ?? undefined;
    }
    if (!pass) {
        throw new Error(`No IMAP password for account "${spec.accountLabel}". Set a password or a Keychain service/account.`);
    }
    return {
        host: spec.host,
        port: spec.port,
        secure: spec.port === 993,
        user: spec.user,
        pass,
        accountLabel: spec.accountLabel,
    };
}
/** True when `account` matches any configured IMAP account (label or user). */
export function isImapAccount(account, env = process.env) {
    if (!account)
        return false;
    return listImapAccountSpecs(env).some((s) => s.accountLabel === account || s.user === account);
}
/** Account labels of every configured IMAP account (C2), for diagnostics. */
export function listImapAccountLabels(env = process.env) {
    return listImapAccountSpecs(env).map((s) => s.accountLabel);
}
/**
 * Resolve full configs (passwords included) for every configured IMAP account
 * (C2/B5). Accounts whose password can't be resolved are skipped (logged), so a
 * single misconfigured account doesn't take down the rest (e.g. IDLE watchers).
 */
export function resolveImapConfigs(env = process.env) {
    const out = [];
    for (const spec of listImapAccountSpecs(env)) {
        try {
            out.push(specToConfig(spec));
        }
        catch (e) {
            console.error(`Skipping IMAP account "${spec.accountLabel}": ${String(e)}`);
        }
    }
    return out;
}
/**
 * Resolve the full IMAP config (password included) for `account`. With no
 * `account`, returns the default/first configured account. Throws if IMAP is
 * unconfigured or no account matches.
 */
export function resolveImapConfig(env = process.env, account) {
    const specs = listImapAccountSpecs(env);
    if (specs.length === 0) {
        throw new Error(`IMAP not configured. Set ${IMAP_ENV.user} (login address) to enable it.`);
    }
    let spec;
    if (account) {
        spec = specs.find((s) => s.accountLabel === account || s.user === account);
        if (!spec) {
            throw new Error(`No IMAP account matching "${account}". Configured: ${specs.map((s) => s.accountLabel).join(", ")}.`);
        }
    }
    else {
        spec = specs[0];
    }
    return specToConfig(spec);
}
const defaultConnect = async (cfg) => {
    const client = new ImapFlow({
        host: cfg.host,
        port: cfg.port,
        secure: cfg.secure,
        auth: { user: cfg.user, pass: cfg.pass },
        logger: false,
    });
    await client.connect();
    return client;
};
/** Map common (Gmail) mailbox names to their IMAP paths. */
export function resolveMailboxPath(mailbox, mode) {
    if (!mailbox)
        return mode === "search" ? "[Gmail]/All Mail" : "INBOX";
    const map = {
        "all mail": "[Gmail]/All Mail",
        "sent mail": "[Gmail]/Sent Mail",
        sent: "[Gmail]/Sent Mail",
        trash: "[Gmail]/Trash",
        drafts: "[Gmail]/Drafts",
        spam: "[Gmail]/Spam",
        junk: "[Gmail]/Spam",
        starred: "[Gmail]/Starred",
        important: "[Gmail]/Important",
    };
    return map[mailbox.trim().toLowerCase()] ?? mailbox;
}
function buildCriteria(a, listMode) {
    const c = {};
    if (a.query)
        c.or = [{ subject: a.query }, { from: a.query }];
    if (a.from)
        c.from = a.from;
    if (a.subject)
        c.subject = a.subject;
    if (a.isRead === true)
        c.seen = true;
    if (a.isRead === false)
        c.unseen = true;
    if (a.unreadOnly && listMode)
        c.unseen = true;
    if (a.isFlagged === true)
        c.flagged = true;
    if (a.isFlagged === false)
        c.unflagged = true;
    if (a.dateFrom)
        c.since = new Date(a.dateFrom);
    if (a.dateTo)
        c.before = new Date(a.dateTo);
    if (Object.keys(c).length === 0)
        c.all = true;
    return c;
}
function formatRow(m, account, path) {
    const env = m.envelope ?? {};
    const subject = env.subject || "(no subject)";
    const a = env.from?.[0];
    const from = a
        ? a.name
            ? `${a.name} <${a.address ?? ""}>`
            : (a.address ?? "(unknown)")
        : "(unknown)";
    const date = env.date ? new Date(env.date).toLocaleDateString() : "";
    const read = m.flags?.has("\\Seen") ? "read" : "unread";
    // Emit the self-describing IMAP id so get-message and the message mutations
    // can route this row back to IMAP (Phase 3).
    return `  - ID: ${encodeImapId(account, path, m.uid)} | ${date} | ${subject} (from: ${from}) [${read}]`;
}
async function run(args, listMode, deps) {
    // Reads are idempotent → safe to retry once if a pooled connection is dead.
    // Route to the account named in the search args (C2 multi-account).
    return useClient({ ...deps, account: deps.account ?? args.account }, async (client, cfg) => {
        const path = resolveMailboxPath(args.mailbox, listMode ? "list" : "search");
        const lock = await client.getMailboxLock(path);
        try {
            const found = await client.search(buildCriteria(args, listMode), { uid: true });
            const uids = Array.isArray(found) ? found : [];
            if (uids.length === 0) {
                return `No messages found via IMAP in "${path}" (account ${cfg.accountLabel}).`;
            }
            const limit = args.limit ?? 50;
            const offset = args.offset ?? 0;
            // UIDs are ascending → newest are the highest. Apply offset+limit from the newest end.
            const newest = uids
                .slice()
                .reverse()
                .slice(offset, offset + limit);
            const byUid = new Map();
            for await (const msg of client.fetch(newest.join(","), { envelope: true, flags: true }, { uid: true })) {
                byUid.set(msg.uid, formatRow(msg, cfg.accountLabel, path));
            }
            const rows = newest.map((u) => byUid.get(u)).filter((r) => Boolean(r));
            const verb = listMode ? "listed" : "matched";
            return (`Found ${rows.length} message(s) via IMAP (server-side, account ${cfg.accountLabel}, mailbox "${path}"; ${uids.length} total ${verb}):\n` +
                rows.join("\n") +
                `\n\nNote: these IMAP IDs (imap:…) work with get-message and the message mutations (mark/flag/move/delete-message), which route back to IMAP.`);
        }
        finally {
            lock.release();
        }
    }, true);
}
export function imapSearchMessages(args, deps = {}) {
    return run(args, false, deps);
}
export function imapListMessages(args, deps = {}) {
    return run(args, true, deps);
}
// ===========================================================================
// Counts & stats via IMAP STATUS (2.1 optimizations I3/I4/I6)
//
// STATUS is a single server round-trip that returns authoritative message/unseen
// counts without enumerating messages — far faster and more reliable than
// AppleScript on large mailboxes (where the per-message walk times out, #8/#24).
// ===========================================================================
/** Unread count via IMAP STATUS (UNSEEN). No mailbox → sum across all mailboxes. */
export function imapUnreadCount(mailbox, deps = {}) {
    return useClient(deps, async (client) => {
        if (mailbox) {
            const s = await client.status(resolveMailboxPath(mailbox, "list"), { unseen: true });
            return s.unseen ?? 0;
        }
        let total = 0;
        for (const b of await client.list()) {
            try {
                const s = await client.status(b.path, { unseen: true });
                total += s.unseen ?? 0;
            }
            catch {
                // skip mailboxes that can't be STATUS'd (e.g. \Noselect parents)
            }
        }
        return total;
    }, true);
}
/** List mailboxes with per-mailbox message/unseen counts via LIST + STATUS (I6). */
export function imapListMailboxes(deps = {}) {
    return useClient(deps, async (client) => {
        const out = [];
        for (const b of await client.list()) {
            let messages = 0;
            let unseen = 0;
            try {
                const s = await client.status(b.path, { messages: true, unseen: true });
                messages = s.messages ?? 0;
                unseen = s.unseen ?? 0;
            }
            catch {
                // \Noselect or otherwise un-status-able mailbox → report zeros
            }
            out.push({ path: b.path, name: b.name, messages, unseen });
        }
        return out;
    }, true);
}
/** Aggregate stats via STATUS (counts) + INBOX SEARCH SINCE (recent) (I3). */
export function imapMailStats(deps = {}) {
    return useClient(deps, async (client) => {
        const perMailbox = [];
        let totalMessages = 0;
        let totalUnread = 0;
        for (const b of await client.list()) {
            try {
                const s = await client.status(b.path, { messages: true, unseen: true });
                const messages = s.messages ?? 0;
                const unseen = s.unseen ?? 0;
                totalMessages += messages;
                totalUnread += unseen;
                perMailbox.push({ mailbox: b.path, messages, unseen });
            }
            catch {
                // skip un-status-able mailbox
            }
        }
        // Recent counts against INBOX (the meaningful "received" surface).
        const since = (days) => new Date(Date.now() - days * 86_400_000);
        const countSince = async (days) => {
            try {
                const lock = await client.getMailboxLock("INBOX");
                try {
                    const found = await client.search({ since: since(days) }, { uid: true });
                    return Array.isArray(found) ? found.length : 0;
                }
                finally {
                    lock.release();
                }
            }
            catch {
                return 0;
            }
        };
        const [last24h, last7d, last30d] = await Promise.all([
            countSince(1),
            countSince(7),
            countSince(30),
        ]);
        return { totalMessages, totalUnread, perMailbox, recent: { last24h, last7d, last30d } };
    }, true);
}
function errText(e) {
    return e instanceof Error ? e.message : String(e);
}
// ---------------------------------------------------------------------------
// Connection pool (issue #50 / A3)
//
// The MCP server is long-lived and every tool call is serialized through the
// AppleScript gate, so instead of connecting + logging out (~seconds) on every
// IMAP call, one connection is kept alive and reused. A NOOP verifies liveness
// before reuse; an idle timer closes it after inactivity. An injected
// `deps.connect` (tests) bypasses the pool and connects per call.
// ---------------------------------------------------------------------------
let poolConnect = defaultConnect;
// One kept-alive connection per account (C2): keyed by host:port:user so each
// configured IMAP account keeps its own pooled connection instead of thrashing
// a single slot when calls alternate between accounts.
const pools = new Map();
function poolKey(cfg) {
    return `${cfg.host}:${cfg.port}:${cfg.user}`;
}
function imapIdleMs() {
    const raw = process.env.APPLE_MAIL_MCP_IMAP_IDLE_MS;
    if (raw !== undefined) {
        const n = Number(raw);
        if (Number.isFinite(n) && n >= 0)
            return n;
    }
    return 60_000;
}
async function dropPool(key) {
    const e = pools.get(key);
    if (!e)
        return;
    if (e.idle)
        clearTimeout(e.idle);
    pools.delete(key);
    await e.client.logout().catch(() => undefined);
}
async function dropAllPools() {
    await Promise.all([...pools.keys()].map((k) => dropPool(k)));
}
function scheduleIdleClose(key) {
    const e = pools.get(key);
    if (!e)
        return;
    if (e.idle)
        clearTimeout(e.idle);
    const ms = imapIdleMs();
    if (ms <= 0)
        return;
    e.idle = setTimeout(() => void dropPool(key), ms);
    e.idle.unref?.();
}
async function acquirePooled(cfg) {
    const key = poolKey(cfg);
    const existing = pools.get(key);
    if (existing) {
        if (existing.idle)
            clearTimeout(existing.idle);
        try {
            await existing.client.noop(); // verify the kept-alive connection is still usable
            return existing.client;
        }
        catch {
            await dropPool(key);
        }
    }
    const client = await poolConnect(cfg);
    pools.set(key, { client });
    return client;
}
/**
 * Health probe for the setup doctor (C3): reports whether IMAP is configured and,
 * if so, whether a connection + NOOP succeeds (auth/network/Keychain all good).
 */
export async function imapHealthCheck(deps = {}) {
    if (!deps.config && !process.env[IMAP_ENV.user]?.trim()) {
        return { configured: false, ok: false };
    }
    let cfg;
    try {
        cfg = deps.config ?? resolveImapConfig(process.env, deps.account);
    }
    catch (e) {
        return { configured: true, ok: false, error: errText(e) };
    }
    try {
        await useClient(deps, async (client) => {
            await client.noop();
        });
        return { configured: true, ok: true, account: cfg.accountLabel, host: cfg.host };
    }
    catch (e) {
        return {
            configured: true,
            ok: false,
            account: cfg.accountLabel,
            host: cfg.host,
            error: errText(e),
        };
    }
}
/** Test seam: override the pool's connect factory; pass null to restore. */
export function __setPoolConnect(fn) {
    poolConnect = fn ?? defaultConnect;
}
/** Test seam: close and clear all pooled connections. */
export async function __resetPool() {
    await dropAllPools();
}
/**
 * Run `fn` with an IMAP client. Default (production) path reuses the pooled,
 * kept-alive connection; an injected `deps.connect` connects fresh and logs out
 * per call. `retryOnDrop` reconnects once if a pooled connection dies mid-op —
 * only safe for idempotent reads, so mutations leave it false.
 */
async function useClient(deps, fn, retryOnDrop = false) {
    const cfg = deps.config ?? resolveImapConfig(process.env, deps.account);
    if (deps.connect) {
        const client = await deps.connect(cfg);
        try {
            return await fn(client, cfg);
        }
        finally {
            await client.logout().catch(() => undefined);
        }
    }
    const key = poolKey(cfg);
    try {
        const client = await acquirePooled(cfg);
        const r = await fn(client, cfg);
        scheduleIdleClose(key);
        return r;
    }
    catch (e) {
        await dropPool(key);
        if (retryOnDrop) {
            const client = await acquirePooled(cfg);
            try {
                const r = await fn(client, cfg);
                scheduleIdleClose(key);
                return r;
            }
            catch (e2) {
                await dropPool(key);
                throw e2;
            }
        }
        throw e;
    }
}
/** Connect, run `fn`, manage the connection (pooled in production). */
function withClient(deps, fn) {
    return useClient(deps, fn);
}
/**
 * Resolve a user-supplied mailbox name to an actual server path by listing the
 * mailboxes and matching on full path, then leaf name (case-insensitive).
 * Returns null when no such mailbox exists.
 */
async function findMailboxPath(client, name) {
    const wanted = name.trim().toLowerCase();
    const boxes = await client.list();
    const byPath = boxes.find((b) => b.path.toLowerCase() === wanted);
    if (byPath)
        return byPath.path;
    const byName = boxes.find((b) => b.name.toLowerCase() === wanted);
    return byName ? byName.path : null;
}
export function imapCreateMailbox(name, deps = {}) {
    return withClient(deps, async (client) => {
        try {
            const res = await client.mailboxCreate(name);
            return res.created
                ? { success: true, info: `Created mailbox "${res.path}".` }
                : { success: true, info: `Mailbox "${res.path}" already existed.` };
        }
        catch (e) {
            return { success: false, error: `IMAP create failed for "${name}": ${errText(e)}` };
        }
    });
}
export function imapDeleteMailbox(name, deps = {}) {
    return withClient(deps, async (client, cfg) => {
        const path = await findMailboxPath(client, name);
        if (!path) {
            return {
                success: false,
                error: `Mailbox "${name}" not found on IMAP account ${cfg.accountLabel}.`,
            };
        }
        try {
            await client.mailboxDelete(path);
            return {
                success: true,
                info: `Deleted mailbox "${path}" via IMAP (account ${cfg.accountLabel}).`,
            };
        }
        catch (e) {
            return { success: false, error: `IMAP delete failed for "${path}": ${errText(e)}` };
        }
    });
}
export function imapRenameMailbox(oldName, newName, deps = {}) {
    return withClient(deps, async (client, cfg) => {
        const path = await findMailboxPath(client, oldName);
        if (!path) {
            return {
                success: false,
                error: `Mailbox "${oldName}" not found on IMAP account ${cfg.accountLabel}.`,
            };
        }
        try {
            const res = await client.mailboxRename(path, newName);
            return { success: true, info: `Renamed "${res.path}" to "${res.newPath}" via IMAP.` };
        }
        catch (e) {
            return {
                success: false,
                error: `IMAP rename failed for "${path}" -> "${newName}": ${errText(e)}`,
            };
        }
    });
}
// ===========================================================================
// Phase 3 — message-level operations by composite IMAP id (issue #43)
//
// get-message / mark / flag / move / delete-message route here when the message
// id is an `imap:` token (emitted by the IMAP read path). The token carries the
// mailbox path + UID, so the op opens that mailbox and acts on the UID.
// ===========================================================================
/** Connect, open the message's mailbox, run `fn`, release + log out. */
async function withMailbox(path, deps, fn) {
    return withClient(deps, async (client) => {
        const lock = await client.getMailboxLock(path);
        try {
            return await fn(client);
        }
        finally {
            lock.release();
        }
    });
}
/** Read a message by composite IMAP id; returns "Subject: …\n\n<body>". */
export async function imapGetMessage(id, preferHtml, deps = {}) {
    const ref = decodeImapId(id);
    if (!ref)
        return { success: false, error: `Not an IMAP message id: "${id}".` };
    return withMailbox(ref.path, { ...deps, account: deps.account ?? ref.account }, async (client) => {
        const msg = await client.fetchOne(String(ref.uid), { envelope: true, source: true }, { uid: true });
        if (!msg)
            return { success: false, error: `IMAP message UID ${ref.uid} not found in "${ref.path}".` };
        const subject = msg.envelope?.subject || "(no subject)";
        const src = msg.source ? msg.source.toString() : "";
        const body = (preferHtml ? extractHtmlBody(src) : extractTextBody(src)) ??
            extractTextBody(src) ??
            extractHtmlBody(src) ??
            "(no readable body)";
        return { success: true, info: `Subject: ${subject}\n\n${body}` };
    });
}
function flagOp(id, flag, add, deps) {
    const ref = decodeImapId(id);
    if (!ref)
        return Promise.resolve({ success: false, error: `Not an IMAP message id: "${id}".` });
    return withMailbox(ref.path, { ...deps, account: deps.account ?? ref.account }, async (client) => {
        try {
            const ok = add
                ? await client.messageFlagsAdd([ref.uid], [flag], { uid: true })
                : await client.messageFlagsRemove([ref.uid], [flag], { uid: true });
            if (!ok)
                return { success: false, error: `IMAP flag update returned false for UID ${ref.uid}.` };
            return { success: true };
        }
        catch (e) {
            return {
                success: false,
                error: `IMAP flag update failed for UID ${ref.uid}: ${errText(e)}`,
            };
        }
    });
}
export const imapMarkRead = (id, deps = {}) => flagOp(id, "\\Seen", true, deps);
export const imapMarkUnread = (id, deps = {}) => flagOp(id, "\\Seen", false, deps);
export const imapFlagMessage = (id, deps = {}) => flagOp(id, "\\Flagged", true, deps);
export const imapUnflagMessage = (id, deps = {}) => flagOp(id, "\\Flagged", false, deps);
export async function imapMoveMessageById(id, destMailbox, deps = {}) {
    const ref = decodeImapId(id);
    if (!ref)
        return { success: false, error: `Not an IMAP message id: "${id}".` };
    return withClient({ ...deps, account: deps.account ?? ref.account }, async (client) => {
        const destPath = (await findMailboxPath(client, destMailbox)) ?? resolveMailboxPath(destMailbox, "list");
        const lock = await client.getMailboxLock(ref.path);
        try {
            await client.messageMove([ref.uid], destPath, { uid: true });
            return { success: true, info: `Moved UID ${ref.uid} to "${destPath}" via IMAP.` };
        }
        catch (e) {
            return {
                success: false,
                error: `IMAP move failed for UID ${ref.uid} -> "${destPath}": ${errText(e)}`,
            };
        }
        finally {
            lock.release();
        }
    });
}
export async function imapDeleteMessageById(id, deps = {}) {
    const ref = decodeImapId(id);
    if (!ref)
        return { success: false, error: `Not an IMAP message id: "${id}".` };
    return withMailbox(ref.path, { ...deps, account: deps.account ?? ref.account }, async (client) => {
        try {
            const ok = await client.messageDelete([ref.uid], { uid: true });
            if (!ok)
                return { success: false, error: `IMAP delete returned false for UID ${ref.uid}.` };
            return { success: true, info: `Deleted UID ${ref.uid} from "${ref.path}" via IMAP.` };
        }
        catch (e) {
            return { success: false, error: `IMAP delete failed for UID ${ref.uid}: ${errText(e)}` };
        }
    });
}
/** Walk a BODYSTRUCTURE tree collecting attachment parts (disposition or filename). */
function collectAttachments(node, out = []) {
    if (!node)
        return out;
    const filename = node.dispositionParameters?.filename || node.parameters?.name;
    const disposition = node.disposition?.toLowerCase();
    const isAttachment = !!node.part && (disposition === "attachment" || (!!filename && disposition !== "inline"));
    if (isAttachment) {
        out.push({
            part: node.part,
            filename: filename || `part-${node.part}`,
            mimeType: node.type || "application/octet-stream",
            size: node.size ?? 0,
        });
    }
    for (const child of node.childNodes ?? [])
        collectAttachments(child, out);
    return out;
}
async function streamToBuffer(content) {
    const chunks = [];
    for await (const chunk of content)
        chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
}
/** List a message's attachments via IMAP BODYSTRUCTURE (no full download). */
export async function imapListAttachments(id, deps = {}) {
    const ref = decodeImapId(id);
    if (!ref)
        return { success: false, error: `Not an IMAP message id: "${id}".` };
    return withMailbox(ref.path, { ...deps, account: deps.account ?? ref.account }, async (client) => {
        const msg = await client.fetchOne(String(ref.uid), { bodyStructure: true }, { uid: true });
        if (!msg || !msg.bodyStructure) {
            return { success: false, error: `IMAP message UID ${ref.uid} not found in "${ref.path}".` };
        }
        const attachments = collectAttachments(msg.bodyStructure).map((a) => ({
            id: `${id}#${a.part}`,
            name: a.filename,
            mimeType: a.mimeType,
            size: a.size,
        }));
        return { success: true, attachments };
    });
}
/** Fetch one attachment's bytes (base64) via IMAP, matched by filename. */
export async function imapFetchAttachment(id, attachmentName, deps = {}) {
    const ref = decodeImapId(id);
    if (!ref)
        return { success: false, error: `Not an IMAP message id: "${id}".` };
    return withMailbox(ref.path, { ...deps, account: deps.account ?? ref.account }, async (client) => {
        const msg = await client.fetchOne(String(ref.uid), { bodyStructure: true }, { uid: true });
        if (!msg || !msg.bodyStructure) {
            return { success: false, error: `IMAP message UID ${ref.uid} not found in "${ref.path}".` };
        }
        const atts = collectAttachments(msg.bodyStructure);
        const match = atts.find((a) => a.filename === attachmentName);
        if (!match) {
            const names = atts.map((a) => a.filename).join(", ") || "none";
            return {
                success: false,
                error: `Attachment "${attachmentName}" not found on UID ${ref.uid}. Available: ${names}.`,
            };
        }
        const dl = await client.download(String(ref.uid), match.part, { uid: true });
        const buf = await streamToBuffer(dl.content);
        return {
            success: true,
            base64: buf.toString("base64"),
            bytes: buf.length,
            mimeType: match.mimeType,
        };
    });
}
async function imapBatch(ids, deps, op) {
    const groups = new Map();
    const errors = [];
    let failed = 0;
    for (const id of ids) {
        const ref = decodeImapId(id);
        if (!ref) {
            failed++;
            errors.push(`Not an IMAP id: "${id}"`);
            continue;
        }
        const key = `${ref.account} ${ref.path}`;
        const g = groups.get(key) ?? { account: ref.account, path: ref.path, uids: [] };
        g.uids.push(ref.uid);
        groups.set(key, g);
    }
    let success = 0;
    for (const g of groups.values()) {
        try {
            await useClient({ ...deps, account: deps.account ?? g.account }, async (client) => {
                const lock = await client.getMailboxLock(g.path);
                try {
                    await op(client, g.uids, g.path);
                }
                finally {
                    lock.release();
                }
            });
            success += g.uids.length;
        }
        catch (e) {
            failed += g.uids.length;
            errors.push(`${g.path}: ${errText(e)}`);
        }
    }
    return { success, failed, errors };
}
export const imapBatchMarkRead = (ids, deps = {}) => imapBatch(ids, deps, async (c, uids) => {
    await c.messageFlagsAdd(uids, ["\\Seen"], { uid: true });
});
export const imapBatchMarkUnread = (ids, deps = {}) => imapBatch(ids, deps, async (c, uids) => {
    await c.messageFlagsRemove(uids, ["\\Seen"], { uid: true });
});
export const imapBatchFlag = (ids, deps = {}) => imapBatch(ids, deps, async (c, uids) => {
    await c.messageFlagsAdd(uids, ["\\Flagged"], { uid: true });
});
export const imapBatchUnflag = (ids, deps = {}) => imapBatch(ids, deps, async (c, uids) => {
    await c.messageFlagsRemove(uids, ["\\Flagged"], { uid: true });
});
export const imapBatchDelete = (ids, deps = {}) => imapBatch(ids, deps, async (c, uids) => {
    await c.messageDelete(uids, { uid: true });
});
export function imapBatchMove(ids, destMailbox, deps = {}) {
    return imapBatch(ids, deps, async (c, uids) => {
        const dest = (await findMailboxPath(c, destMailbox)) ?? resolveMailboxPath(destMailbox, "list");
        await c.messageMove(uids, dest, { uid: true });
    });
}
