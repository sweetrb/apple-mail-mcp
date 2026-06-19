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
  imapMoveMessageById,
  imapDeleteMessageById,
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
    const out = await imapListMessages({ mailbox: "INBOX", limit: 10 }, deps);
    expect(out).toMatch(/via IMAP/);
    const id = firstImapId(out);
    expect(decodeImapId(id)?.path).toBe("INBOX");
  });

  it("server-side search finds a message by subject", async () => {
    const out = await imapSearchMessages({ mailbox: "INBOX", subject: "Hello One", limit: 5 }, deps);
    expect(out).toMatch(/1 total matched|message\(s\) via IMAP/);
    expect(decodeImapId(firstImapId(out))).not.toBeNull();
  });

  it("get-message returns subject + body", async () => {
    const list = await imapListMessages({ mailbox: "INBOX", limit: 10 }, deps);
    const id = firstImapId(list);
    const r = await imapGetMessage(id, false, deps);
    expect(r.success).toBe(true);
    expect(r.info).toMatch(/Subject: Hello/);
    expect(r.info).toMatch(/body/);
  });

  it("mark-read and flag succeed", async () => {
    const list = await imapListMessages({ mailbox: "INBOX", limit: 10 }, deps);
    const id = firstImapId(list);
    expect((await imapMarkRead(id, deps)).success).toBe(true);
    expect((await imapFlagMessage(id, deps)).success).toBe(true);
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
    const list = await imapListMessages({ mailbox: "INBOX", subject: undefined, limit: 50 }, deps);
    // find the "Movable" row's id by re-searching
    const search = await imapSearchMessages({ mailbox: "INBOX", subject: "Movable", limit: 1 }, deps);
    const id = firstImapId(search);
    expect((await imapMoveMessageById(id, "Dest", deps)).success).toBe(true);
    const inDest = await imapListMessages({ mailbox: "Dest", limit: 10 }, deps);
    const destId = firstImapId(inDest);
    expect((await imapDeleteMessageById(destId, deps)).success).toBe(true);
    await imapDeleteMailbox("Dest", deps);
    expect(list).toMatch(/via IMAP/);
  });
});
