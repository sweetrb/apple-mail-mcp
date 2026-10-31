import { describe, it, expect, vi } from "vitest";
import { ImapFlow } from "imapflow";
import { ImapIdleWatcher, type IdleClient } from "@/services/imapIdle.js";
import type { ImapConfig } from "@/services/imapClient.js";

function cfg(label: string): ImapConfig {
  return {
    host: "imap.test",
    port: 993,
    secure: true,
    user: `${label}@test`,
    pass: "pw",
    accountLabel: label,
  };
}

/** A fake IDLE client the test can drive: control mailboxOpen count + emit events. */
function fakeClient(initialExists = 0) {
  const handlers: Record<string, ((d?: unknown) => void)[]> = {};
  const client: IdleClient & {
    emit: (e: string, d?: unknown) => void;
    opened: string[];
    loggedOut: boolean;
    existsCount: number;
  } = {
    opened: [],
    loggedOut: false,
    existsCount: initialExists,
    connect: async () => undefined,
    mailboxOpen: async (path: string) => {
      client.opened.push(path);
      return { exists: client.existsCount };
    },
    on: (event: string, handler: (d?: unknown) => void) => {
      (handlers[event] ??= []).push(handler);
    },
    logout: async () => {
      client.loggedOut = true;
    },
    emit: (event: string, d?: unknown) => (handlers[event] || []).forEach((h) => h(d)),
  };
  return client;
}

describe("ImapIdleWatcher (B5)", () => {
  it("settles startup when closing a pending connector does not reject connect", async () => {
    // ImapFlow can close before its socket-connect callback installs the
    // rejection handler. The socket closes, but connect() remains pending.
    const connect = vi
      .spyOn(ImapFlow.prototype, "connect")
      .mockReturnValue(new Promise<void>(() => {}));
    const close = vi.spyOn(ImapFlow.prototype, "close");
    const w = new ImapIdleWatcher({
      configs: [cfg("A")],
      onNewMail: vi.fn(),
      pollMs: 0,
    });
    try {
      const starting = w.start();
      await w.stop();
      expect(close).toHaveBeenCalled();
      await starting;
      expect(w.watchedAccounts()).toEqual([]);
    } finally {
      await w.stop();
      connect.mockRestore();
      close.mockRestore();
    }
  }, 1000);

  it("opens INBOX per account and fires onNewMail on count growth (deduped)", async () => {
    const events: { account: string; count: number }[] = [];
    const clients: Record<string, ReturnType<typeof fakeClient>> = {};
    const w = new ImapIdleWatcher({
      configs: [cfg("Personal"), cfg("Work")],
      onNewMail: (e) => events.push({ account: e.account, count: e.count }),
      connect: async (c) => (clients[c.accountLabel] = fakeClient(0)),
      pollMs: 0, // event-driven only for this test
    });
    await w.start();

    expect(w.watchedAccounts().sort()).toEqual(["Personal", "Work"]);
    expect(clients.Personal.opened).toEqual(["INBOX"]);

    clients.Personal.emit("exists", { count: 5 }); // 5 > baseline 0 → fire
    clients.Personal.emit("exists", { count: 5 }); // no growth → ignored
    clients.Personal.emit("exists", { count: 7 }); // 7 > 5 → fire
    clients.Work.emit("exists", { count: 2 }); // 2 > baseline 0 → fire

    expect(events).toEqual([
      { account: "Personal", count: 5 },
      { account: "Personal", count: 7 },
      { account: "Work", count: 2 },
    ]);

    await w.stop();
    expect(clients.Personal.loggedOut).toBe(true);
  });

  it("does not fire when the count matches the opening baseline", async () => {
    const events: unknown[] = [];
    const client = fakeClient(3); // 3 messages already present at open
    const w = new ImapIdleWatcher({
      configs: [cfg("A")],
      onNewMail: (e) => events.push(e),
      connect: async () => client,
      pollMs: 0,
    });
    await w.start();
    client.emit("exists", { count: 3 }); // equal to baseline → not new
    expect(events).toHaveLength(0);
    await w.stop();
  });

  it("polls as a fallback and fires when the polled count grows", async () => {
    vi.useFakeTimers();
    const events: { count: number }[] = [];
    const client = fakeClient(1);
    const w = new ImapIdleWatcher({
      configs: [cfg("A")],
      onNewMail: (e) => events.push({ count: e.count }),
      connect: async () => client,
      pollMs: 1000,
    });
    await w.start(); // baseline 1
    client.existsCount = 4; // two polls later the server has more mail
    await vi.advanceTimersByTimeAsync(1000);
    expect(events).toEqual([{ count: 4 }]);
    await w.stop();
    vi.useRealTimers();
  });

  it("reconnects after a dropped connection", async () => {
    vi.useFakeTimers();
    let connects = 0;
    const w = new ImapIdleWatcher({
      configs: [cfg("Personal")],
      onNewMail: () => undefined,
      reconnectMs: 1000,
      pollMs: 0,
      connect: async () => {
        connects++;
        return fakeClient();
      },
    });
    await w.start();
    expect(connects).toBe(1);

    const c = (w as unknown as { clients: Map<string, ReturnType<typeof fakeClient>> }).clients.get(
      "Personal"
    )!;
    c.emit("close");
    await vi.advanceTimersByTimeAsync(1000);
    expect(connects).toBe(2);

    await w.stop();
    vi.useRealTimers();
  });

  it("stop() prevents further reconnects", async () => {
    vi.useFakeTimers();
    let connects = 0;
    const clients: ReturnType<typeof fakeClient>[] = [];
    const w = new ImapIdleWatcher({
      configs: [cfg("A")],
      onNewMail: () => undefined,
      reconnectMs: 1000,
      pollMs: 0,
      connect: async () => {
        connects++;
        const c = fakeClient();
        clients.push(c);
        return c;
      },
    });
    await w.start();
    await w.stop();
    clients[0].emit("error"); // after stop → must not reconnect
    await vi.advanceTimersByTimeAsync(5000);
    expect(connects).toBe(1);
    vi.useRealTimers();
  });

  it("closes a connection that finishes after stop instead of watching it", async () => {
    let connected!: (client: IdleClient) => void;
    const pending = new Promise<IdleClient>((resolve) => (connected = resolve));
    const client = fakeClient();
    const w = new ImapIdleWatcher({
      configs: [cfg("A")],
      onNewMail: vi.fn(),
      connect: () => pending,
      pollMs: 0,
    });
    const starting = w.start();
    await w.stop();
    connected(client);
    await starting;
    try {
      expect(w.watchedAccounts()).toEqual([]);
      expect(client.loggedOut).toBe(true);
      expect(client.opened).toEqual([]);
    } finally {
      await w.stop();
    }
  });

  it("does not let an old pending connection replace a restarted watch", async () => {
    let connected!: (client: IdleClient) => void;
    const pending = new Promise<IdleClient>((resolve) => (connected = resolve));
    const old = fakeClient(0);
    const current = fakeClient(10);
    const events: unknown[] = [];
    let connects = 0;
    const w = new ImapIdleWatcher({
      configs: [cfg("A")],
      onNewMail: (e) => events.push(e),
      connect: () => (++connects === 1 ? pending : Promise.resolve(current)),
      pollMs: 0,
    });
    const starting = w.start();
    await w.stop();
    await w.start();
    connected(old);
    await starting;
    try {
      expect(old.loggedOut).toBe(true);
      expect(old.opened).toEqual([]);
      current.emit("exists", { count: 11 });
      expect(events).toEqual([{ account: "A", count: 11, prevCount: 10 }]);
    } finally {
      await w.stop();
    }
    expect(current.loggedOut).toBe(true);
  });

  it("ignores an old connection's events after reconnecting", async () => {
    vi.useFakeTimers();
    const old = fakeClient();
    const current = fakeClient(10);
    const onNewMail = vi.fn();
    let connects = 0;
    const w = new ImapIdleWatcher({
      configs: [cfg("A")],
      onNewMail,
      connect: async () => (++connects === 1 ? old : current),
      reconnectMs: 100,
      pollMs: 0,
    });
    try {
      await w.start();
      old.emit("close");
      await vi.advanceTimersByTimeAsync(100);
      old.emit("exists", { count: 100 });
      old.emit("error");
      await vi.advanceTimersByTimeAsync(100);
      expect(connects).toBe(2);
      expect(current.loggedOut).toBe(false);
      expect(onNewMail).not.toHaveBeenCalled();
      current.emit("exists", { count: 11 });
      expect(onNewMail).toHaveBeenCalledWith({ account: "A", count: 11, prevCount: 10 });
    } finally {
      await w.stop();
      vi.useRealTimers();
    }
  });

  it("ignores an old mailbox selection that completes after restart", async () => {
    let selected!: (mailbox: { exists: number }) => void;
    const selection = new Promise<{ exists: number }>((resolve) => (selected = resolve));
    const old = fakeClient();
    vi.spyOn(old, "mailboxOpen").mockReturnValue(selection);
    const current = fakeClient(50);
    const onNewMail = vi.fn();
    let connects = 0;
    const w = new ImapIdleWatcher({
      configs: [cfg("A")],
      onNewMail,
      connect: async () => (++connects === 1 ? old : current),
      pollMs: 0,
    });
    const starting = w.start();
    await Promise.resolve(); // the first connection is waiting for mailboxOpen
    await w.stop();
    await w.start();
    selected({ exists: 0 });
    await starting;
    try {
      current.emit("exists", { count: 10 }); // expunge, not new mail
      expect(onNewMail).not.toHaveBeenCalled();
    } finally {
      await w.stop();
    }
  });

  it("ignores new-mail events and in-flight poll results after stop", async () => {
    vi.useFakeTimers();
    let polled!: (mailbox: { exists: number }) => void;
    const poll = new Promise<{ exists: number }>((resolve) => (polled = resolve));
    const client = fakeClient();
    vi.spyOn(client, "mailboxOpen").mockResolvedValueOnce({ exists: 0 }).mockReturnValueOnce(poll);
    const onNewMail = vi.fn();
    const w = new ImapIdleWatcher({
      configs: [cfg("A")],
      onNewMail,
      connect: async () => client,
      pollMs: 100,
    });
    try {
      await w.start();
      await vi.advanceTimersByTimeAsync(100);
      await w.stop();
      polled({ exists: 1 });
      await Promise.resolve();
      client.emit("exists", { count: 2 });
      expect(onNewMail).not.toHaveBeenCalled();
    } finally {
      await w.stop();
      vi.useRealTimers();
    }
  });
});
