/**
 * #267 — caller-supplied In-Reply-To / References on send-email and
 * create-draft: validated as msg-id tokens, emitted verbatim (never
 * RFC 2047-encoded, however long), and refused — never silently dropped — on a
 * transport that cannot carry them.
 */
import { describe, expect, it, vi } from "vitest";
import nodemailer from "nodemailer";
import {
  runThreadedDraft,
  sendEmailThreading,
  threadingHeaders,
  SEND_THREADING_NEEDS_SMTP,
  type ThreadedDraftDeps,
} from "@/tools/threading.js";
import { IN_REPLY_TO_SCHEMA, REFERENCES_SCHEMA } from "@/schemas.js";
import { composeRawMime, sendViaSmtp, type SmtpConfig } from "@/services/smtpMailer.js";
import {
  imapAppendDraft,
  resolveDraftImapAccount,
  type ImapClientLike,
  type ImapConfig,
} from "@/services/imapClient.js";
import { extractMimeAttachment } from "@/utils/mimeParse.js";

const LONG_ID =
  "<SN6PR02MB4205ABCDEF0123456789ABCDEF0123456789ABCDEF@SN6PR02MB4205.namprd02.prod.outlook.com>";

function header(mime: string, name: string): string | undefined {
  const head = mime.split(/\r?\n\r?\n/)[0].replace(/\r?\n[ \t]+/g, " ");
  return new RegExp(`^${name}:\\s*(.*)$`, "im").exec(head)?.[1];
}

describe("threading header schemas (#267)", () => {
  it.each(["<abc@example.com>", LONG_ID, "<CAF=x+y_z.1@mail.gmail.com>"])("accepts %s", (v) => {
    expect(IN_REPLY_TO_SCHEMA.parse(v)).toBe(v);
    expect(REFERENCES_SCHEMA.parse([v])).toEqual([v]);
  });

  it.each([
    "abc@example.com",
    "<abc@example.com",
    "<abcexample.com>",
    "<a b@example.com>",
    "<a@example.com> <b@example.com>",
    "=?utf-8?q?=3Cabc@example.com=3E?=",
    "<a@example.com>\r\nBcc: victim@example.com",
  ])("rejects %j", (v) => {
    expect(() => IN_REPLY_TO_SCHEMA.parse(v)).toThrow(/Message-ID token/);
    expect(() => REFERENCES_SCHEMA.parse([v])).toThrow();
  });

  it("rejects an empty or oversized references list", () => {
    expect(() => REFERENCES_SCHEMA.parse([])).toThrow(/at least one/);
    const many = Array.from({ length: 101 }, (_, i) => `<id${i}@example.com>`);
    expect(() => REFERENCES_SCHEMA.parse(many)).toThrow(/more than 100/);
  });
});

describe("threadingHeaders / sendEmailThreading (#267)", () => {
  it("returns undefined when no threading was requested", () => {
    expect(threadingHeaders({})).toBeUndefined();
    expect(threadingHeaders({ references: [] })).toBeUndefined();
  });

  it("defaults References to [inReplyTo] (RFC 5322 §3.6.4)", () => {
    expect(threadingHeaders({ inReplyTo: "<p@x.y>" })).toEqual({
      inReplyTo: "<p@x.y>",
      references: ["<p@x.y>"],
    });
  });

  it("keeps an explicit References chain as given", () => {
    expect(threadingHeaders({ inReplyTo: "<p@x.y>", references: ["<r@x.y>", "<p@x.y>"] })).toEqual({
      inReplyTo: "<p@x.y>",
      references: ["<r@x.y>", "<p@x.y>"],
    });
  });

  it("refuses threading on the AppleScript transport instead of dropping it", () => {
    expect(sendEmailThreading({ inReplyTo: "<p@x.y>" }, false)).toEqual({
      ok: false,
      error: SEND_THREADING_NEEDS_SMTP,
    });
    expect(sendEmailThreading({ references: ["<p@x.y>"] }, false).ok).toBe(false);
    expect(SEND_THREADING_NEEDS_SMTP).toMatch(/cannot set In-Reply-To or References/);
  });

  it("passes no-threading calls through on either transport", () => {
    expect(sendEmailThreading({}, false)).toEqual({ ok: true, headers: undefined });
    expect(sendEmailThreading({}, true)).toEqual({ ok: true, headers: undefined });
  });
});

describe("send-email over SMTP with caller threading (#267)", () => {
  it("emits >76-char ids verbatim in In-Reply-To and References, never encoded", async () => {
    const cfg: SmtpConfig = {
      host: "smtp.example.test",
      port: 587,
      secure: false,
      user: "me@example.com",
      pass: "fixture",
      from: "me@example.com",
    };
    let wire = "";
    let copy = "";
    const createTransport = () => {
      const t = nodemailer.createTransport({ streamTransport: true, buffer: true });
      const send = t.sendMail.bind(t);
      t.sendMail = async (opts) => {
        const r = await send(opts);
        wire = r.message.toString();
        return r;
      };
      return t;
    };
    const gate = sendEmailThreading(
      { inReplyTo: LONG_ID, references: ["<root@example.com>", LONG_ID] },
      true
    );
    expect(gate.ok).toBe(true);
    const result = await sendViaSmtp(
      {
        to: ["you@example.com"],
        subject: "Re: numbers",
        body: "Here you go.",
        ...(gate.ok ? gate.headers : {}),
      },
      cfg,
      createTransport as typeof nodemailer.createTransport,
      async (_u, raw) => {
        copy = raw.toString();
        return { sentCopy: true };
      }
    );
    expect(result.success).toBe(true);
    for (const mime of [wire, copy]) {
      expect(header(mime, "In-Reply-To")).toBe(LONG_ID);
      expect(header(mime, "References")).toBe(`<root@example.com> ${LONG_ID}`);
      expect(mime.split(/\r?\n\r?\n/)[0]).not.toMatch(/^(In-Reply-To|References):[^\n]*=\?/im);
    }
  });
});

describe("create-draft with threading → IMAP Drafts (#267)", () => {
  function deps(overrides: Partial<ThreadedDraftDeps> = {}) {
    const filed: { account?: string; raw?: string } = {};
    const d = {
      resolveAccount: vi.fn(() => ({ label: "Work", user: "me@example.com" })),
      smtpIdentity: vi.fn(() => ({ user: "me@example.com", from: "alias@example.com" })),
      compose: vi.fn(composeRawMime),
      append: vi.fn(async (account: string, raw: Buffer) => {
        filed.account = account;
        filed.raw = raw.toString();
        return { mailbox: "Drafts", account };
      }),
      ...overrides,
    } satisfies ThreadedDraftDeps;
    return { d, filed };
  }

  it("composes the threaded draft (attachments included) and files it into Drafts", async () => {
    const { d, filed } = deps();
    const result = await runThreadedDraft(d, {
      to: ["you@example.com"],
      cc: ["boss@example.com"],
      subject: "Re: numbers",
      body: "Draft reply.",
      inReplyTo: LONG_ID,
      attachments: [{ filename: "a.txt", contentBase64: Buffer.from("A").toString("base64") }],
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      ok: true,
      transport: "imap",
      account: "Work",
      mailbox: "Drafts",
      attachmentCount: 1,
      inReplyTo: LONG_ID,
      references: [LONG_ID],
    });
    expect(result.structuredContent?.messageId).toMatch(/^<[^>]+@[^>]+>$/);
    expect(filed.account).toBe("Work");
    const raw = filed.raw as string;
    expect(header(raw, "In-Reply-To")).toBe(LONG_ID);
    expect(header(raw, "References")).toBe(LONG_ID);
    expect(header(raw, "From")).toBe("alias@example.com");
    expect(header(raw, "Cc")).toBe("boss@example.com");
    expect(raw).not.toMatch(/^(In-Reply-To|References):[^\n]*=\?/im);
    expect(extractMimeAttachment(raw, "a.txt")?.data.toString()).toBe("A");
  });

  it("uses the IMAP login as From when the SMTP identity is another account", async () => {
    const { d, filed } = deps({ smtpIdentity: () => ({ user: "other@example.com" }) });
    await runThreadedDraft(d, {
      to: ["x@example.com"],
      subject: "s",
      body: "b",
      inReplyTo: "<p@x.y>",
    });
    expect(header(filed.raw as string, "From")).toBe("me@example.com");
  });

  it("fails loudly — nothing filed — when no IMAP account can carry the draft", async () => {
    const { d } = deps({
      resolveAccount: () => {
        throw new Error("IMAP is not configured.");
      },
    });
    const result = await runThreadedDraft(d, {
      to: ["x@example.com"],
      subject: "s",
      body: "b",
      references: ["<p@x.y>"],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("IMAP is not configured.");
    expect(result.content[0].text).toContain("no Mail.app fallback");
    expect(d.append).not.toHaveBeenCalled();
  });

  it("rejects an out-of-roots attachment before choosing an account", async () => {
    const { d } = deps();
    const result = await runThreadedDraft(d, {
      to: ["x@example.com"],
      subject: "s",
      body: "b",
      inReplyTo: "<p@x.y>",
      attachments: ["/etc/hosts"],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/outside the allowed read roots|protected location/);
    expect(d.resolveAccount).not.toHaveBeenCalled();
    expect(d.append).not.toHaveBeenCalled();
  });
});

describe("resolveDraftImapAccount (#267)", () => {
  const two = {
    APPLE_MAIL_MCP_IMAP_ACCOUNTS: JSON.stringify([
      { account: "Work", user: "me@work.example", password: "x" },
      { account: "Home", user: "me@home.example", password: "x" },
    ]),
  };

  it("refuses when IMAP is not configured", () => {
    expect(() => resolveDraftImapAccount(undefined, undefined, {})).toThrow(
      /cannot set In-Reply-To\/References.*IMAP is not configured/s
    );
  });

  it("honors an explicit account by label or login", () => {
    expect(resolveDraftImapAccount("Home", undefined, two)).toEqual({
      label: "Home",
      user: "me@home.example",
    });
    expect(resolveDraftImapAccount("me@work.example", undefined, two).label).toBe("Work");
  });

  it("refuses an account that is not a configured IMAP account", () => {
    expect(() => resolveDraftImapAccount("iCloud", undefined, two)).toThrow(
      /"iCloud" is not a configured IMAP account\. Configured: Work, Home/
    );
  });

  it("picks the SMTP identity's account when none is named, and refuses to guess otherwise", () => {
    expect(resolveDraftImapAccount(undefined, "me@home.example", two).label).toBe("Home");
    expect(() => resolveDraftImapAccount(undefined, undefined, two)).toThrow(/pass `account`/);
    expect(() => resolveDraftImapAccount(undefined, "nobody@example.com", two)).toThrow(
      /pass `account`/
    );
  });

  it("uses the only configured account when there is exactly one", () => {
    const one = { APPLE_MAIL_MCP_IMAP_USER: "solo@example.com", APPLE_MAIL_MCP_IMAP_PASSWORD: "x" };
    expect(resolveDraftImapAccount(undefined, undefined, one).user).toBe("solo@example.com");
  });
});

describe("imapAppendDraft (#267)", () => {
  const cfg: ImapConfig = {
    host: "imap.example.test",
    port: 993,
    secure: true,
    user: "me@example.com",
    pass: "x",
    accountLabel: "Work",
  };

  function client(append: ImapClientLike["append"]) {
    return {
      list: async () => [
        { path: "INBOX", name: "INBOX" },
        { path: "Entwürfe", name: "Entwürfe", specialUse: "\\Drafts" },
      ],
      append,
      logout: async () => undefined,
    } as unknown as ImapClientLike;
  }

  it("files into the SPECIAL-USE \\Drafts mailbox flagged \\Draft + \\Seen", async () => {
    const append = vi.fn(async (path: string) => ({ destination: path }));
    const r = await imapAppendDraft("Work", Buffer.from("raw"), {
      config: cfg,
      connect: async () => client(append),
    });
    expect(r).toEqual({ mailbox: "Entwürfe", account: "Work" });
    expect(append).toHaveBeenCalledWith("Entwürfe", Buffer.from("raw"), ["\\Draft", "\\Seen"]);
  });

  it("throws when the server rejects the APPEND", async () => {
    await expect(
      imapAppendDraft("Work", "raw", {
        config: cfg,
        connect: async () => client(async () => false),
      })
    ).rejects.toThrow(/rejected the APPEND/);
  });
});
