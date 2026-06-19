import type { ImapConfig } from "../services/imapClient.js";
/** Minimal event-capable client surface the watcher needs (testable). */
export interface IdleClient {
    connect(): Promise<void>;
    mailboxOpen(path: string): Promise<{
        exists: number;
    }>;
    on(event: "exists", handler: (data: {
        count: number;
        prevCount: number;
    }) => void): void;
    on(event: "close" | "error", handler: (err?: unknown) => void): void;
    logout(): Promise<void>;
}
export type IdleConnect = (cfg: ImapConfig) => Promise<IdleClient>;
export interface NewMailEvent {
    account: string;
    count: number;
    prevCount: number;
}
export declare class ImapIdleWatcher {
    private readonly opts;
    private readonly connect;
    private readonly mailbox;
    private readonly reconnectMs;
    private readonly pollMs;
    private readonly clients;
    private readonly timers;
    private readonly polls;
    private readonly lastCount;
    private stopped;
    constructor(opts: {
        configs: ImapConfig[];
        onNewMail: (e: NewMailEvent) => void;
        connect?: IdleConnect;
        mailbox?: string;
        reconnectMs?: number;
        /** Poll interval (ms) as a fallback for servers that don't push IDLE EXISTS. 0 disables. */
        pollMs?: number;
    });
    /** Begin watching every configured account. Resolves once watches are kicked off. */
    start(): Promise<void>;
    /**
     * Compare an observed message count to the account's baseline and fire
     * onNewMail on growth. Updates the baseline either way (so an expunge that
     * lowers the count re-bases without a spurious later fire).
     */
    private observe;
    private watch;
    /** Polling fallback: re-check the count for servers that don't push EXISTS. */
    private startPoll;
    private scheduleReconnect;
    /** Stop all watches and close connections. */
    stop(): Promise<void>;
    /** Accounts currently being watched (test/diagnostics). */
    watchedAccounts(): string[];
}
//# sourceMappingURL=imapIdle.d.ts.map