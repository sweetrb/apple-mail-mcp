export declare const IMAP_ENV: {
    readonly user: "APPLE_MAIL_MCP_IMAP_USER";
    readonly account: "APPLE_MAIL_MCP_IMAP_ACCOUNT";
    readonly host: "APPLE_MAIL_MCP_IMAP_HOST";
    readonly port: "APPLE_MAIL_MCP_IMAP_PORT";
    readonly password: "APPLE_MAIL_MCP_IMAP_PASSWORD";
    readonly keychainService: "APPLE_MAIL_MCP_IMAP_KEYCHAIN_SERVICE";
    readonly keychainAccount: "APPLE_MAIL_MCP_IMAP_KEYCHAIN_ACCOUNT";
    readonly accounts: "APPLE_MAIL_MCP_IMAP_ACCOUNTS";
};
export interface ImapConfig {
    host: string;
    port: number;
    secure: boolean;
    user: string;
    pass: string;
    accountLabel: string;
}
export interface ImapSearchArgs {
    query?: string;
    account?: string;
    from?: string;
    subject?: string;
    mailbox?: string;
    limit?: number;
    dateFrom?: string;
    dateTo?: string;
    isRead?: boolean;
    isFlagged?: boolean;
    unreadOnly?: boolean;
    offset?: number;
}
interface ImapAddress {
    name?: string;
    address?: string;
}
interface ImapEnvelope {
    subject?: string;
    date?: Date | string;
    from?: ImapAddress[];
    messageId?: string;
    inReplyTo?: string;
}
export interface ImapBodyStructure {
    part?: string;
    type?: string;
    disposition?: string;
    dispositionParameters?: Record<string, string>;
    parameters?: Record<string, string>;
    size?: number;
    encoding?: string;
    childNodes?: ImapBodyStructure[];
}
interface ImapMessage {
    uid: number;
    envelope?: ImapEnvelope;
    flags?: Set<string>;
    source?: Buffer | string;
    bodyStructure?: ImapBodyStructure;
    headers?: Buffer | string;
}
interface ImapDownload {
    meta?: {
        filename?: string;
        contentType?: string;
    };
    content: AsyncIterable<Uint8Array>;
}
interface MailboxLock {
    release: () => void;
}
interface ImapMailboxListing {
    path: string;
    name: string;
}
type FlagOpts = {
    uid: boolean;
};
export interface ImapClientLike {
    connect(): Promise<void>;
    getMailboxLock(path: string): Promise<MailboxLock>;
    search(query: Record<string, unknown>, opts: {
        uid: true;
    }): Promise<number[] | false>;
    fetch(range: string, query: Record<string, unknown>, opts: {
        uid: true;
    }): AsyncIterable<ImapMessage>;
    fetchOne(range: string, query: Record<string, unknown>, opts: {
        uid: true;
    }): Promise<ImapMessage | false>;
    list(): Promise<ImapMailboxListing[]>;
    status(path: string, query: {
        messages?: boolean;
        unseen?: boolean;
        recent?: boolean;
    }): Promise<{
        path: string;
        messages?: number;
        unseen?: number;
        recent?: number;
    }>;
    download(range: string, part: string, opts: {
        uid: true;
    }): Promise<ImapDownload>;
    mailboxCreate(path: string): Promise<{
        path: string;
        created: boolean;
    }>;
    mailboxRename(path: string, newPath: string): Promise<{
        path: string;
        newPath: string;
    }>;
    mailboxDelete(path: string): Promise<{
        path: string;
    }>;
    messageFlagsAdd(range: number[], flags: string[], opts: FlagOpts): Promise<boolean>;
    messageFlagsRemove(range: number[], flags: string[], opts: FlagOpts): Promise<boolean>;
    messageMove(range: number[], destination: string, opts: FlagOpts): Promise<unknown>;
    messageDelete(range: number[], opts: FlagOpts): Promise<boolean>;
    noop(): Promise<void>;
    logout(): Promise<void>;
}
export declare function encodeImapId(account: string, path: string, uid: number): string;
export declare function decodeImapId(id: string): {
    account: string;
    path: string;
    uid: number;
} | null;
export type ImapConnect = (cfg: ImapConfig) => Promise<ImapClientLike>;
/**
 * Dependencies threaded through every IMAP op. `account` selects which
 * configured IMAP account to use (C2 multi-account); `config`/`connect` are
 * test seams. When `account` is omitted the default/first account is used.
 */
export interface ImapDeps {
    connect?: ImapConnect;
    config?: ImapConfig;
    account?: string;
}
/** True when `account` matches any configured IMAP account (label or user). */
export declare function isImapAccount(account: string | undefined, env?: NodeJS.ProcessEnv): boolean;
/** Account labels of every configured IMAP account (C2), for diagnostics. */
export declare function listImapAccountLabels(env?: NodeJS.ProcessEnv): string[];
/**
 * Resolve full configs (passwords included) for every configured IMAP account
 * (C2/B5). Accounts whose password can't be resolved are skipped (logged), so a
 * single misconfigured account doesn't take down the rest (e.g. IDLE watchers).
 */
export declare function resolveImapConfigs(env?: NodeJS.ProcessEnv): ImapConfig[];
/**
 * Resolve the full IMAP config (password included) for `account`. With no
 * `account`, returns the default/first configured account. Throws if IMAP is
 * unconfigured or no account matches.
 */
export declare function resolveImapConfig(env?: NodeJS.ProcessEnv, account?: string): ImapConfig;
/** Map common (Gmail) mailbox names to their IMAP paths. */
export declare function resolveMailboxPath(mailbox: string | undefined, mode: "search" | "list"): string;
/**
 * Result of an IMAP search/list: the human text identical to before, plus the
 * structured payload (messages + count) so callers can pass it straight to
 * `successResponse(text, structured)` and emit `structuredContent` on the IMAP
 * path the same way the AppleScript path does.
 */
export interface ImapListResult {
    text: string;
    messages: Record<string, unknown>[];
    count: number;
    partial: boolean;
}
export declare function imapSearchMessages(args: ImapSearchArgs, deps?: ImapDeps): Promise<ImapListResult>;
export declare function imapListMessages(args: ImapSearchArgs, deps?: ImapDeps): Promise<ImapListResult>;
/** Unread count via IMAP STATUS (UNSEEN). No mailbox → sum across all mailboxes. */
export declare function imapUnreadCount(mailbox: string | undefined, deps?: ImapDeps): Promise<number>;
export interface ImapMailboxInfo {
    path: string;
    name: string;
    messages: number;
    unseen: number;
}
/** List mailboxes with per-mailbox message/unseen counts via LIST + STATUS (I6). */
export declare function imapListMailboxes(deps?: ImapDeps): Promise<ImapMailboxInfo[]>;
export interface ImapStats {
    totalMessages: number;
    totalUnread: number;
    perMailbox: {
        mailbox: string;
        messages: number;
        unseen: number;
    }[];
    recent: {
        last24h: number;
        last7d: number;
        last30d: number;
    };
}
/** Aggregate stats via STATUS (counts) + INBOX SEARCH SINCE (recent) (I3). */
export declare function imapMailStats(deps?: ImapDeps): Promise<ImapStats>;
export interface ImapOpResult {
    success: boolean;
    error?: string;
    info?: string;
}
/**
 * Health probe for the setup doctor (C3): reports whether IMAP is configured and,
 * if so, whether a connection + NOOP succeeds (auth/network/Keychain all good).
 */
export declare function imapHealthCheck(deps?: ImapDeps): Promise<{
    configured: boolean;
    ok: boolean;
    account?: string;
    host?: string;
    error?: string;
}>;
/** Test seam: override the pool's connect factory; pass null to restore. */
export declare function __setPoolConnect(fn: ImapConnect | null): void;
/** Test seam: close and clear all pooled connections. */
export declare function __resetPool(): Promise<void>;
export declare function imapCreateMailbox(name: string, deps?: ImapDeps): Promise<ImapOpResult>;
export declare function imapDeleteMailbox(name: string, deps?: ImapDeps): Promise<ImapOpResult>;
export declare function imapRenameMailbox(oldName: string, newName: string, deps?: ImapDeps): Promise<ImapOpResult>;
/** Read a message by composite IMAP id; returns "Subject: …\n\n<body>". */
export declare function imapGetMessage(id: string, preferHtml: boolean, deps?: ImapDeps): Promise<ImapOpResult>;
export declare const imapMarkRead: (id: string, deps?: {}) => Promise<ImapOpResult>;
export declare const imapMarkUnread: (id: string, deps?: {}) => Promise<ImapOpResult>;
export declare const imapFlagMessage: (id: string, deps?: {}) => Promise<ImapOpResult>;
export declare const imapUnflagMessage: (id: string, deps?: {}) => Promise<ImapOpResult>;
export declare function imapMoveMessageById(id: string, destMailbox: string, deps?: ImapDeps): Promise<ImapOpResult>;
export declare function imapDeleteMessageById(id: string, deps?: ImapDeps): Promise<ImapOpResult>;
export interface ImapAttachmentInfo {
    id: string;
    name: string;
    mimeType: string;
    size: number;
}
/** List a message's attachments via IMAP BODYSTRUCTURE (no full download). */
export declare function imapListAttachments(id: string, deps?: ImapDeps): Promise<{
    success: boolean;
    attachments?: ImapAttachmentInfo[];
    error?: string;
}>;
/** Fetch one attachment's bytes (base64) via IMAP, matched by filename. */
export declare function imapFetchAttachment(id: string, attachmentName: string, deps?: ImapDeps): Promise<{
    success: boolean;
    base64?: string;
    bytes?: number;
    mimeType?: string;
    error?: string;
}>;
export interface ImapBatchResult {
    success: number;
    failed: number;
    errors: string[];
}
export declare const imapBatchMarkRead: (ids: string[], deps?: ImapDeps) => Promise<ImapBatchResult>;
export declare const imapBatchMarkUnread: (ids: string[], deps?: ImapDeps) => Promise<ImapBatchResult>;
export declare const imapBatchFlag: (ids: string[], deps?: ImapDeps) => Promise<ImapBatchResult>;
export declare const imapBatchUnflag: (ids: string[], deps?: ImapDeps) => Promise<ImapBatchResult>;
export declare const imapBatchDelete: (ids: string[], deps?: ImapDeps) => Promise<ImapBatchResult>;
export declare function imapBatchMove(ids: string[], destMailbox: string, deps?: ImapDeps): Promise<ImapBatchResult>;
export interface ImapThreadMessage {
    id: string;
    subject: string;
    sender: string;
    date: string;
    isRead: boolean;
}
export interface ImapThreadResult {
    count: number;
    text: string;
    structured: {
        subject: string;
        messages: ImapThreadMessage[];
        count: number;
    };
}
export declare function imapThread(id: string, deps?: ImapDeps, limit?: number): Promise<ImapThreadResult | null>;
export {};
//# sourceMappingURL=imapClient.d.ts.map