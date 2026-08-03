/**
 * IMAP backend integration tests against a real IMAP server (GreenMail).
 *
 * Unlike test/integration.test.ts (which drives Mail.app via AppleScript and so
 * only runs on macOS), this exercises the IMAP code path end-to-end against a
 * throwaway IMAP server, so it runs on any OS — including a Linux CI runner.
 *
 * Gated by RUN_IMAP_IT so it is skipped in the normal unit suite. CI sets it and
 * provides a GreenMail service; locally:
 *   docker run -d --rm -p 3143:3143 -e GREENMAIL_OPTS='-Dgreenmail.setup.test.imap -Dgreenmail.users=tester:secret@example.com -Dgreenmail.auth.disabled' greenmail/standalone:2.1.0
 *   RUN_IMAP_IT=1 npm run test:imap
 */
import { describe, it, expect, beforeAll } from "vitest";
import { ImapFlow } from "imapflow";
import {
  type ImapConfig,
  imapListMessages,
  imapSearchMessages,
  imapGetMessage,
  imapCreateMailbox,
  imapDeleteMailbox,
  imapRenameMailbox,
  imapMarkRead,
  imapFlagMessage,
  imapUnflagMessage,
  imapMoveMessageById,
  imapDeleteMessageById,
  imapUnreadCount,
  imapListMailboxes,
  imapMailStats,
  imapListAttachments,
  imapFetchAttachment,
  imapBatchMarkRead,
  imapBatchMove,
  imapThread,
  encodeImapId,
  decodeImapId,
} from "@/services/imapClient.js";

const run = process.env.RUN_IMAP_IT ? describe : describe.skip;

const cfg: ImapConfig = {
  host: process.env.GREENMAIL_HOST ?? "127.0.0.1",
  port: Number(process.env.GREENMAIL_IMAP_PORT ?? 3143),
  secure: false,
  user: process.env.GREENMAIL_USER ?? "tester",
  pass: process.env.GREENMAIL_PASS ?? "secret",
  accountLabel: "greenmail",
};
const deps = { config: cfg };

function raw(): ImapFlow {
  return new ImapFlow({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: { user: cfg.user, pass: cfg.pass },
    logger: false,
  });
}

async function appendMessage(subject: string, body: string): Promise<void> {
  const c = raw();
  await c.connect();
  const msg = `From: sender@example.com\r\nTo: ${cfg.user}\r\nSubject: ${subject}\r\nContent-Type: text/plain\r\n\r\n${body}\r\n`;
  await c.append("INBOX", Buffer.from(msg), [], new Date());
  await c.logout();
}

function firstImapId(out: string): string {
  const m = out.match(/imap:[A-Za-z0-9_-]+/);
  if (!m) throw new Error(`no imap id in output: ${out}`);
  return m[0];
}

run("IMAP backend (GreenMail) integration", () => {
  beforeAll(async () => {
    await appendMessage("Hello One", "first body");
    await appendMessage("Hello Two", "second body");
  });

  it("lists INBOX messages with composite imap: ids", async () => {
    const out = (await imapListMessages({ mailbox: "INBOX", limit: 10 }, deps)).text;
    expect(out).toMatch(/via IMAP/);
    const id = firstImapId(out);
    expect(decodeImapId(id)?.path).toBe("INBOX");
  });

  it("server-side search finds a message by subject", async () => {
    const out = (
      await imapSearchMessages({ mailbox: "INBOX", subject: "Hello One", limit: 5 }, deps)
    ).text;
    expect(out).toMatch(/1 total matched|message\(s\) via IMAP/);
    expect(decodeImapId(firstImapId(out))).not.toBeNull();
  });

  it("get-message returns subject + body", async () => {
    const list = (await imapListMessages({ mailbox: "INBOX", limit: 10 }, deps)).text;
    const id = firstImapId(list);
    const r = await imapGetMessage(id, false, deps);
    expect(r.success).toBe(true);
    expect(r.info).toMatch(/Subject: Hello/);
    expect(r.info).toMatch(/body/);
  });

  it("mark-read and flag succeed", async () => {
    const list = (await imapListMessages({ mailbox: "INBOX", limit: 10 }, deps)).text;
    const id = firstImapId(list);
    expect((await imapMarkRead(id, deps)).success).toBe(true);
    expect((await imapFlagMessage(id, undefined, deps)).success).toBe(true);
  });

  it("flag color round-trips through the $MailFlagBitN keywords", async () => {
    const list = (await imapListMessages({ mailbox: "INBOX", limit: 10 }, deps)).text;
    const id = firstImapId(list);
    // 5 = purple = bit0 + bit2
    expect((await imapFlagMessage(id, 5, deps)).success).toBe(true);
    // unflag must clear \Flagged AND every color bit, or Mail.app keeps the color
    expect((await imapUnflagMessage(id, deps)).success).toBe(true);
  });

  it("create / rename / delete mailbox round-trips", async () => {
    expect((await imapCreateMailbox("ITbox", deps)).success).toBe(true);
    expect((await imapRenameMailbox("ITbox", "ITbox2", deps)).success).toBe(true);
    expect((await imapDeleteMailbox("ITbox2", deps)).success).toBe(true);
    // deleting a non-existent mailbox fails clearly
    const gone = await imapDeleteMailbox("ITbox2", deps);
    expect(gone.success).toBe(false);
    expect(gone.error).toMatch(/not found/i);
  });

  it("move then delete a message across mailboxes", async () => {
    expect((await imapCreateMailbox("Dest", deps)).success).toBe(true);
    await appendMessage("Movable", "move me");
    const list = (await imapListMessages({ mailbox: "INBOX", subject: undefined, limit: 50 }, deps))
      .text;
    // find the "Movable" row's id by re-searching
    const search = (
      await imapSearchMessages({ mailbox: "INBOX", subject: "Movable", limit: 1 }, deps)
    ).text;
    const id = firstImapId(search);
    expect((await imapMoveMessageById(id, "Dest", deps)).success).toBe(true);
    const inDest = (await imapListMessages({ mailbox: "Dest", limit: 10 }, deps)).text;
    const destId = firstImapId(inDest);
    expect((await imapDeleteMessageById(destId, deps)).success).toBe(true);
    await imapDeleteMailbox("Dest", deps);
    expect(list).toMatch(/via IMAP/);
  });
});

/** Append a raw MIME message and return its assigned UID. */
async function appendRaw(mime: string): Promise<number> {
  const c = raw();
  await c.connect();
  const res = await c.append("INBOX", Buffer.from(mime.replace(/\n/g, "\r\n")));
  await c.logout();
  return (res as { uid: number }).uid;
}

run("IMAP 2.1 optimizations (GreenMail) integration", () => {
  it("STATUS-based unread count, mailbox list, and stats (I3/I4/I6)", async () => {
    const c = raw();
    await c.connect();
    await c.append("INBOX", Buffer.from("From: s@x.com\r\nSubject: status-test\r\n\r\nhi"));
    await c.logout();
    expect(await imapUnreadCount("INBOX", deps)).toBeGreaterThan(0);
    const boxes = await imapListMailboxes(deps);
    expect(boxes.find((b) => b.path === "INBOX")).toBeTruthy();
    const stats = await imapMailStats(deps);
    expect(stats.totalMessages).toBeGreaterThan(0);
    expect(stats.recent.last24h).toBeGreaterThan(0);
  });

  it("attachments via BODYSTRUCTURE: list + fetch (I1)", async () => {
    const pdf = Buffer.from("PDF-BYTES-HERE").toString("base64");
    const uid = await appendRaw(
      [
        "From: a@x.com",
        "Subject: with-attachment",
        "MIME-Version: 1.0",
        'Content-Type: multipart/mixed; boundary="B"',
        "",
        "--B",
        "Content-Type: text/plain",
        "",
        "body",
        "--B",
        'Content-Type: application/pdf; name="doc.pdf"',
        'Content-Disposition: attachment; filename="doc.pdf"',
        "Content-Transfer-Encoding: base64",
        "",
        pdf,
        "--B--",
        "",
      ].join("\n")
    );
    const id = encodeImapId("greenmail", "INBOX", uid);
    const list = await imapListAttachments(id, deps);
    expect(list.success).toBe(true);
    expect(list.attachments?.map((a) => a.name)).toContain("doc.pdf");
    const fetched = await imapFetchAttachment(id, "doc.pdf", deps);
    expect(fetched.success).toBe(true);
    expect(Buffer.from(fetched.base64 as string, "base64").toString()).toBe("PDF-BYTES-HERE");
  });

  it("batch mark-read + move over a UID set (I2)", async () => {
    await imapCreateMailbox("BatchDest", deps);
    const u1 = await appendRaw("From: a@x.com\nSubject: batch-1\n\nb");
    const u2 = await appendRaw("From: a@x.com\nSubject: batch-2\n\nb");
    const ids = [encodeImapId("greenmail", "INBOX", u1), encodeImapId("greenmail", "INBOX", u2)];
    const mr = await imapBatchMarkRead(ids, deps);
    expect(mr.success).toBe(2);
    const mv = await imapBatchMove(ids, "BatchDest", deps);
    expect(mv.success).toBe(2);
    await imapDeleteMailbox("BatchDest", deps);
  });

  it("true threading links a reply to its root via References (I5)", async () => {
    await appendRaw("From: a@x.com\nSubject: Thread Root\nMessage-ID: <r1@test>\n\nroot");
    const replyUid = await appendRaw(
      "From: b@x.com\nSubject: Re: Thread Root\nMessage-ID: <r2@test>\nIn-Reply-To: <r1@test>\nReferences: <r1@test>\n\nreply"
    );
    const t = await imapThread(encodeImapId("greenmail", "INBOX", replyUid), deps, 50);
    expect(t).not.toBeNull();
    expect(t?.count).toBeGreaterThanOrEqual(2);
  });
});
