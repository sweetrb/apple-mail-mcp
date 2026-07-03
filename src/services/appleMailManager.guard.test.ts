/**
 * Unit tests for the disabled-account guard and rename-rollback behavior.
 *
 * These exercise AppleMailManager's structural mailbox ops (create / delete /
 * rename) with executeAppleScript fully mocked, so they are deterministic and
 * need no running Mail.app. The router inspects each generated AppleScript and
 * returns a canned result, letting us assert both the returned value AND which
 * scripts were (not) attempted.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  calls: [] as string[],
  router: {
    fn: (_script: string) => ({
      success: true,
      output: "",
      error: undefined as string | undefined,
    }),
  },
}));

vi.mock("@/utils/applescript.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/utils/applescript.js")>();
  return {
    ...actual,
    executeAppleScript: (script: string) => {
      h.calls.push(script);
      return h.router.fn(script);
    },
  };
});

import { AppleMailManager, describeMailboxOpError } from "@/services/appleMailManager.js";

type ScriptResult = { success: boolean; output: string; error?: string };

/** Did any captured script contain this snippet? */
const ranScript = (needle: string) => h.calls.some((s) => s.includes(needle));

/**
 * Build a content-aware router. `enabled` controls the live enabled-probe;
 * `moveResult` controls the rename move script; `destEmpty` controls the
 * rollback's empty-check. Everything else returns success/empty.
 */
function makeRouter(opts: {
  enabled?: "true" | "false" | "missing";
  moveResult?: ScriptResult;
  destEmpty?: boolean;
  /** Value returned by the `account type of account` probe (BUG B). Default ""
   *  → inconclusive → server-side guard fails open (unchanged behavior). */
  accountType?: string;
}): (script: string) => ScriptResult {
  const enabled = opts.enabled ?? "true";
  return (script: string): ScriptResult => {
    if (script.includes("account type of account")) {
      return { success: true, output: opts.accountType ?? "" };
    }
    if (script.includes("enabled of account")) {
      return { success: true, output: enabled };
    }
    if (script.includes("move m to destMailbox")) {
      return opts.moveResult ?? { success: true, output: `ok5` };
    }
    if (script.includes("if (count of messages of mb) is 0 then")) {
      // deleteMailboxIfEmpty rollback probe
      return { success: true, output: opts.destEmpty === false ? "kept" : "deleted" };
    }
    if (script.includes("make new mailbox")) {
      return { success: true, output: "ok" };
    }
    // mailbox-name fetches and anything else
    return { success: true, output: "" };
  };
}

beforeEach(() => {
  h.calls = [];
  h.router.fn = makeRouter({});
});

describe("disabled-account guard", () => {
  it("createMailbox refuses on a disabled account without attempting the create", () => {
    h.router.fn = makeRouter({ enabled: "false" });
    const mgr = new AppleMailManager();

    const res = mgr.createMailbox("Foo", "iCloud");

    expect(res.success).toBe(false);
    expect(res.error).toMatch(/disabled in Mail/);
    expect(ranScript("make new mailbox")).toBe(false);
  });

  it("deleteMailbox refuses on a disabled account without attempting the delete", () => {
    h.router.fn = makeRouter({ enabled: "false" });
    const mgr = new AppleMailManager();

    const res = mgr.deleteMailbox("Foo", "iCloud");

    expect(res.success).toBe(false);
    expect(res.error).toMatch(/disabled in Mail/);
    expect(ranScript("delete mailbox")).toBe(false);
  });

  it("renameMailbox refuses on a disabled account and creates no destination", () => {
    h.router.fn = makeRouter({ enabled: "false" });
    const mgr = new AppleMailManager();

    const res = mgr.renameMailbox("Old", "New", "iCloud");

    expect(res.success).toBe(false);
    expect(res.error).toMatch(/disabled in Mail/);
    expect(ranScript("make new mailbox")).toBe(false);
    expect(ranScript("move m to destMailbox")).toBe(false);
  });

  it("does not block when the enabled state is inconclusive (fail open)", () => {
    h.router.fn = makeRouter({ enabled: "missing" });
    const mgr = new AppleMailManager();

    const res = mgr.createMailbox("Foo", "iCloud");

    expect(res.success).toBe(true);
    expect(ranScript("make new mailbox")).toBe(true);
  });

  it("createMailbox succeeds on an enabled account", () => {
    h.router.fn = makeRouter({ enabled: "true" });
    const mgr = new AppleMailManager();

    const res = mgr.createMailbox("Foo", "iCloud");

    expect(res.success).toBe(true);
    expect(res.error).toBeUndefined();
  });
});

describe("renameMailbox rollback on move failure", () => {
  it("rolls back the empty destination when the move fails", () => {
    h.router.fn = makeRouter({
      enabled: "true",
      moveResult: { success: true, output: "error:simulated move failure" },
      destEmpty: true,
    });
    const mgr = new AppleMailManager();

    const res = mgr.renameMailbox("Old", "New", "iCloud");

    expect(res.success).toBe(false);
    expect(res.error).toMatch(/rolled back/);
    // The rollback probe ran (it deletes only when empty).
    expect(ranScript("if (count of messages of mb) is 0 then")).toBe(true);
  });

  it("keeps a non-empty destination and reports manual cleanup", () => {
    h.router.fn = makeRouter({
      enabled: "true",
      moveResult: { success: true, output: "error:simulated move failure" },
      destEmpty: false,
    });
    const mgr = new AppleMailManager();

    const res = mgr.renameMailbox("Old", "New", "iCloud");

    expect(res.success).toBe(false);
    expect(res.error).toMatch(/could not be auto-removed/);
  });
});

describe("server-side create/rename guard (BUG B)", () => {
  it("createMailbox refuses on an IMAP account with no IMAP config, attempting no create", () => {
    h.router.fn = makeRouter({ enabled: "true", accountType: "imap" });
    const mgr = new AppleMailManager();

    const res = mgr.createMailbox("Foo", "gmail");

    expect(res.success).toBe(false);
    expect(res.error).toMatch(/server/i);
    expect(ranScript("make new mailbox")).toBe(false);
  });

  it("createMailbox refuses on an iCloud account (server-side)", () => {
    h.router.fn = makeRouter({ enabled: "true", accountType: "icloud" });
    const mgr = new AppleMailManager();

    const res = mgr.createMailbox("Foo", "iCloud");

    expect(res.success).toBe(false);
    expect(res.error).toMatch(/server/i);
    expect(ranScript("make new mailbox")).toBe(false);
  });

  it("createMailbox refuses on an Exchange account (account type 'unknown')", () => {
    h.router.fn = makeRouter({ enabled: "true", accountType: "unknown" });
    const mgr = new AppleMailManager();

    const res = mgr.createMailbox("Foo", "Exchange");

    expect(res.success).toBe(false);
    expect(res.error).toMatch(/server/i);
    expect(ranScript("make new mailbox")).toBe(false);
  });

  it("createMailbox ALLOWS a local POP account (mailboxes are local)", () => {
    h.router.fn = makeRouter({ enabled: "true", accountType: "pop" });
    const mgr = new AppleMailManager();

    const res = mgr.createMailbox("Foo", "pop-account");

    expect(res.success).toBe(true);
    expect(ranScript("make new mailbox")).toBe(true);
  });

  it("createMailbox fails open when the account type is inconclusive", () => {
    h.router.fn = makeRouter({ enabled: "true", accountType: "" });
    const mgr = new AppleMailManager();

    const res = mgr.createMailbox("Foo", "mystery");

    expect(res.success).toBe(true);
    expect(ranScript("make new mailbox")).toBe(true);
  });

  it("renameMailbox refuses on a server-side account and creates no destination", () => {
    h.router.fn = makeRouter({ enabled: "true", accountType: "imap" });
    const mgr = new AppleMailManager();

    const res = mgr.renameMailbox("Old", "New", "gmail");

    expect(res.success).toBe(false);
    expect(res.error).toMatch(/rename server-side/i);
    // Crucially: no destination mailbox was created before the refusal.
    expect(ranScript("make new mailbox")).toBe(false);
    expect(ranScript("move m to destMailbox")).toBe(false);
  });

  it("renameMailbox proceeds on a local POP account", () => {
    h.router.fn = makeRouter({ enabled: "true", accountType: "pop" });
    const mgr = new AppleMailManager();

    const res = mgr.renameMailbox("Old", "New", "pop-account");

    expect(res.success).toBe(true);
    expect(ranScript("make new mailbox")).toBe(true);
    expect(ranScript("move m to destMailbox")).toBe(true);
  });
});

describe("describeMailboxOpError create verb", () => {
  it("maps a -10000 create failure to the server-side-mailbox explanation", () => {
    const msg = describeMailboxOpError("create", "AppleEvent handler failed (-10000)");
    expect(msg).toMatch(/Mail\.app cannot create server-side/);
    expect(msg).toMatch(/Create it in Mail\.app directly/);
  });

  it("passes through an unrelated create error unchanged", () => {
    expect(describeMailboxOpError("create", "boom")).toBe("boom");
  });
});
