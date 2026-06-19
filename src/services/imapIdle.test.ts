import { describe, it, expect, vi } from "vitest";
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
});
