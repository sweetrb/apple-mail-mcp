/**
 * IMAP backend for read/search (issue #43, Phase 1).
 *
 * AppleScript-over-Mail.app is the default. When an account is explicitly
 * configured for IMAP (env below), `search-messages` and `list-messages` route
 * here instead, running a SERVER-SIDE search — orders of magnitude faster than
 * AppleScript's client-side `whose` enumeration on large Gmail mailboxes, and
 * correct (no false-empty on timeout). Read-only; mutations stay on AppleScript.
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
export const IMAP_ENV = {
    user: "APPLE_MAIL_MCP_IMAP_USER",
    account: "APPLE_MAIL_MCP_IMAP_ACCOUNT",
    host: "APPLE_MAIL_MCP_IMAP_HOST",
    port: "APPLE_MAIL_MCP_IMAP_PORT",
    password: "APPLE_MAIL_MCP_IMAP_PASSWORD",
    keychainService: "APPLE_MAIL_MCP_IMAP_KEYCHAIN_SERVICE",
    keychainAccount: "APPLE_MAIL_MCP_IMAP_KEYCHAIN_ACCOUNT",
};
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
function formatRow(m) {
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
    return `  - UID: ${m.uid} | ${date} | ${subject} (from: ${from}) [${read}]`;
}
async function run(args, listMode, deps) {
    const cfg = deps.config ?? resolveImapConfig();
    const client = await (deps.connect ?? defaultConnect)(cfg);
    try {
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
                byUid.set(msg.uid, formatRow(msg));
            }
            const rows = newest.map((u) => byUid.get(u)).filter((r) => Boolean(r));
            const verb = listMode ? "listed" : "matched";
            return (`Found ${rows.length} message(s) via IMAP (server-side, account ${cfg.accountLabel}, mailbox "${path}"; ${uids.length} total ${verb}):\n` +
                rows.join("\n") +
                `\n\nNote: IDs are IMAP UIDs. get-message and message mutations still use the AppleScript path (Phase 1 is read/search only).`);
        }
        finally {
            lock.release();
        }
    }
    finally {
        await client.logout().catch(() => undefined);
    }
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
/** Connect, run `fn`, always log out. */
async function withClient(deps, fn) {
    const cfg = deps.config ?? resolveImapConfig();
    const client = await (deps.connect ?? defaultConnect)(cfg);
    try {
        return await fn(client, cfg);
    }
    finally {
        await client.logout().catch(() => undefined);
    }
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
