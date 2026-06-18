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
}
interface MailboxLock {
    release: () => void;
}
interface ImapMailboxListing {
    path: string;
    name: string;
}
export interface ImapClientLike {
    connect(): Promise<void>;
    getMailboxLock(path: string): Promise<MailboxLock>;
    search(query: Record<string, unknown>, opts: {
        uid: true;
    }): Promise<number[] | false>;
    fetch(range: string, query: Record<string, unknown>, opts: {
        uid: true;
    }): AsyncIterable<ImapMessage>;
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
    logout(): Promise<void>;
}
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
export {};
//# sourceMappingURL=imapClient.d.ts.map