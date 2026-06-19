export declare const IMAP_ENV: {
    readonly user: "APPLE_MAIL_MCP_IMAP_USER";
    readonly account: "APPLE_MAIL_MCP_IMAP_ACCOUNT";
    readonly host: "APPLE_MAIL_MCP_IMAP_HOST";
    readonly port: "APPLE_MAIL_MCP_IMAP_PORT";
    readonly password: "APPLE_MAIL_MCP_IMAP_PASSWORD";
    readonly keychainService: "APPLE_MAIL_MCP_IMAP_KEYCHAIN_SERVICE";
    readonly keychainAccount: "APPLE_MAIL_MCP_IMAP_KEYCHAIN_ACCOUNT";
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
}
interface ImapMessage {
    uid: number;
    envelope?: ImapEnvelope;
    flags?: Set<string>;
    source?: Buffer | string;
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
/** True only when IMAP is configured AND the explicit `account` matches it. */
export declare function isImapAccount(account: string | undefined, env?: NodeJS.ProcessEnv): boolean;
export declare function resolveImapConfig(env?: NodeJS.ProcessEnv): ImapConfig;
/** Map common (Gmail) mailbox names to their IMAP paths. */
export declare function resolveMailboxPath(mailbox: string | undefined, mode: "search" | "list"): string;
export declare function imapSearchMessages(args: ImapSearchArgs, deps?: {
    connect?: ImapConnect;
    config?: ImapConfig;
}): Promise<string>;
export declare function imapListMessages(args: ImapSearchArgs, deps?: {
    connect?: ImapConnect;
    config?: ImapConfig;
}): Promise<string>;
export interface ImapOpResult {
    success: boolean;
    error?: string;
    info?: string;
}
/** Test seam: override the pool's connect factory; pass null to restore. */
export declare function __setPoolConnect(fn: ImapConnect | null): void;
/** Test seam: close and clear the pooled connection. */
export declare function __resetPool(): Promise<void>;
export declare function imapCreateMailbox(name: string, deps?: {
    connect?: ImapConnect;
    config?: ImapConfig;
}): Promise<ImapOpResult>;
export declare function imapDeleteMailbox(name: string, deps?: {
    connect?: ImapConnect;
    config?: ImapConfig;
}): Promise<ImapOpResult>;
export declare function imapRenameMailbox(oldName: string, newName: string, deps?: {
    connect?: ImapConnect;
    config?: ImapConfig;
}): Promise<ImapOpResult>;
/** Read a message by composite IMAP id; returns "Subject: …\n\n<body>". */
export declare function imapGetMessage(id: string, preferHtml: boolean, deps?: {
    connect?: ImapConnect;
    config?: ImapConfig;
}): Promise<ImapOpResult>;
export declare const imapMarkRead: (id: string, deps?: {}) => Promise<ImapOpResult>;
export declare const imapMarkUnread: (id: string, deps?: {}) => Promise<ImapOpResult>;
export declare const imapFlagMessage: (id: string, deps?: {}) => Promise<ImapOpResult>;
export declare const imapUnflagMessage: (id: string, deps?: {}) => Promise<ImapOpResult>;
export declare function imapMoveMessageById(id: string, destMailbox: string, deps?: {
    connect?: ImapConnect;
    config?: ImapConfig;
}): Promise<ImapOpResult>;
export declare function imapDeleteMessageById(id: string, deps?: {
    connect?: ImapConnect;
    config?: ImapConfig;
}): Promise<ImapOpResult>;
export {};
//# sourceMappingURL=imapClient.d.ts.map