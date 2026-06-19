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
/** True only when IMAP is configured AND the explicit `account` matches it. */
export function isImapAccount(account, env = process.env) {
    const user = env[IMAP_ENV.user]?.trim();
    if (!user || !account)
        return false;
    const label = env[IMAP_ENV.account]?.trim() || user;
    return account === label || account === user;
}
export function resolveImapConfig(env = process.env) {
    const user = env[IMAP_ENV.user]?.trim();
    if (!user) {
        throw new Error(`IMAP not configured. Set ${IMAP_ENV.user} (login address) to enable it.`);
    }
    const host = env[IMAP_ENV.host]?.trim() || "imap.gmail.com";
    const port = env[IMAP_ENV.port] ? Number.parseInt(env[IMAP_ENV.port], 10) : 993;
    if (!Number.isInteger(port) || port <= 0) {
        throw new Error(`Invalid ${IMAP_ENV.port}: "${env[IMAP_ENV.port]}".`);
    }
    let pass = env[IMAP_ENV.password];
    if (!pass) {
        const svc = env[IMAP_ENV.keychainService]?.trim();
        const acct = env[IMAP_ENV.keychainAccount]?.trim() || user;
        if (svc)
            pass = readKeychainPassword(svc, acct) ?? undefined;
    }
    if (!pass) {
        throw new Error(`No IMAP password. Set ${IMAP_ENV.password}, or ${IMAP_ENV.keychainService}/${IMAP_ENV.keychainAccount} for the Keychain.`);
    }
    return {
        host,
        port,
        secure: port === 993,
        user,
        pass,
        accountLabel: env[IMAP_ENV.account]?.trim() || user,
    };
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
    return useClient(deps, async (client, cfg) => {
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
let pool = null;
function imapIdleMs() {
    const raw = process.env.APPLE_MAIL_MCP_IMAP_IDLE_MS;
    if (raw !== undefined) {
        const n = Number(raw);
        if (Number.isFinite(n) && n >= 0)
            return n;
    }
    return 60_000;
}
async function dropPool() {
    if (!pool)
        return;
    if (pool.idle)
        clearTimeout(pool.idle);
    const c = pool.client;
    pool = null;
    await c.logout().catch(() => undefined);
}
function scheduleIdleClose() {
    if (!pool)
        return;
    if (pool.idle)
        clearTimeout(pool.idle);
    const ms = imapIdleMs();
    if (ms <= 0)
        return;
    pool.idle = setTimeout(() => void dropPool(), ms);
    pool.idle.unref?.();
}
async function acquirePooled(cfg) {
    const key = `${cfg.host}:${cfg.port}:${cfg.user}`;
    if (pool && pool.key === key) {
        if (pool.idle)
            clearTimeout(pool.idle);
        try {
            await pool.client.noop(); // verify the kept-alive connection is still usable
            return pool.client;
        }
        catch {
            await dropPool();
        }
    }
    else if (pool) {
        await dropPool(); // config changed — replace the pooled connection
    }
    const client = await poolConnect(cfg);
    pool = { client, key };
    return client;
}
/** Test seam: override the pool's connect factory; pass null to restore. */
export function __setPoolConnect(fn) {
    poolConnect = fn ?? defaultConnect;
}
/** Test seam: close and clear the pooled connection. */
export async function __resetPool() {
    await dropPool();
}
/**
 * Run `fn` with an IMAP client. Default (production) path reuses the pooled,
 * kept-alive connection; an injected `deps.connect` connects fresh and logs out
 * per call. `retryOnDrop` reconnects once if a pooled connection dies mid-op —
 * only safe for idempotent reads, so mutations leave it false.
 */
async function useClient(deps, fn, retryOnDrop = false) {
    const cfg = deps.config ?? resolveImapConfig();
    if (deps.connect) {
        const client = await deps.connect(cfg);
        try {
            return await fn(client, cfg);
        }
        finally {
            await client.logout().catch(() => undefined);
        }
    }
    try {
        const client = await acquirePooled(cfg);
        const r = await fn(client, cfg);
        scheduleIdleClose();
        return r;
    }
    catch (e) {
        await dropPool();
        if (retryOnDrop) {
            const client = await acquirePooled(cfg);
            try {
                const r = await fn(client, cfg);
                scheduleIdleClose();
                return r;
            }
            catch (e2) {
                await dropPool();
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
    return withMailbox(ref.path, deps, async (client) => {
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
    return withMailbox(ref.path, deps, async (client) => {
        try {
            const ok = add
                ? await client.messageFlagsAdd([ref.uid], [flag], { uid: true })
                : await client.messageFlagsRemove([ref.uid], [flag], { uid: true });
            if (!ok)
                return { success: false, error: `IMAP flag update returned false for UID ${ref.uid}.` };
            return { success: true };
        }
        catch (e) {
            return { success: false, error: `IMAP flag update failed for UID ${ref.uid}: ${errText(e)}` };
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
    return withClient(deps, async (client) => {
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
    return withMailbox(ref.path, deps, async (client) => {
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
