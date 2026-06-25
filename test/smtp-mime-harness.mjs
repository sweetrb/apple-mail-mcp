/**
 * Renders the actual MIME that the SMTP transport (issue #12) produces and
 * asserts it is clean: plain-text body verbatim, no <blockquote>, no
 * Apple-Mail-URLShareWrapperClass, no `> ` quote prefixes — i.e. none of the
 * artifacts the AppleScript path injects on macOS 15+.
 *
 * Drives the real build/services/smtpMailer.js sendViaSmtp() through a
 * nodemailer stream transport (no network, no Keychain).
 *
 * Run: npm run build && node test/smtp-mime-harness.mjs
 */
import nodemailer from "nodemailer";
import { sendViaSmtp } from "../build/services/smtpMailer.js";

const captured = [];
// Injected factory: a buffering stream transport renders the MIME instead of
// connecting to an SMTP server. We still go through the real sendViaSmtp path.
const createTransport = () => {
  const t = nodemailer.createTransport({ streamTransport: true, buffer: true });
  const origSend = t.sendMail.bind(t);
  t.sendMail = async (msg) => {
    const info = await origSend(msg);
    captured.push(info.message.toString());
    return info;
  };
  return t;
};

const config = {
  host: "smtp.test",
  port: 587,
  secure: false,
  user: "alice@example.com",
  pass: "x",
  from: "alice@example.com",
};

const body = "Line one of the body.\nLine two.\nRegards,\nAlice";

const result = await sendViaSmtp(
  { to: ["bob@example.com"], subject: "NHL bracket standings", body },
  config,
  createTransport
);

const mime = captured[0] ?? "";

const checks = [
  ["send reported success", result.success === true],
  ["MIME contains the verbatim body", mime.includes("Line one of the body.")],
  ["no <blockquote> wrapping", !/blockquote/i.test(mime)],
  ["no Apple-Mail-URLShareWrapperClass", !/URLShareWrapperClass/i.test(mime)],
  ["no '> ' quoted-line prefixes", !/^> /m.test(decodeQP(mime))],
  ["has text/plain part", /content-type:\s*text\/plain/i.test(mime)],
  ["correct recipient/subject", /To:\s*bob@example.com/i.test(mime) && /Subject: .*NHL/i.test(mime)],
];

// Second send: an HTML alternative body must produce a clean multipart/alternative
// (text/plain + text/html), still free of the AppleScript blockquote artifacts.
const htmlResult = await sendViaSmtp(
  {
    to: ["bob@example.com"],
    subject: "NHL bracket standings (rich)",
    body,
    htmlBody: "<h1>Standings</h1><p>You are <strong>9th</strong>.</p>",
  },
  config,
  createTransport
);
const htmlMime = captured[1] ?? "";

const htmlChecks = [
  ["html send reported success", htmlResult.success === true],
  ["is multipart/alternative", /content-type:\s*multipart\/alternative/i.test(htmlMime)],
  ["has text/plain part", /content-type:\s*text\/plain/i.test(htmlMime)],
  ["has text/html part", /content-type:\s*text\/html/i.test(htmlMime)],
  ["html contains the markup", decodeQP(htmlMime).includes("<h1>Standings</h1>")],
  ["plain fallback preserved", htmlMime.includes("Line one of the body.")],
  ["no <blockquote> wrapping", !/blockquote/i.test(htmlMime)],
  ["no Apple-Mail-URLShareWrapperClass", !/URLShareWrapperClass/i.test(htmlMime)],
];

console.log("\n=== SMTP MIME cleanliness (issue #12) ===");
let pass = true;
for (const [label, ok] of [...checks, ...htmlChecks]) {
  console.log(`  ${ok ? "✓" : "✗"} ${label}`);
  if (!ok) pass = false;
}
console.log("\n--- rendered plain MIME (first 500 chars) ---\n" + mime.slice(0, 500));
console.log("\n--- rendered html MIME (first 700 chars) ---\n" + htmlMime.slice(0, 700));
process.exit(pass ? 0 : 1);

// Quoted-printable soft-decode just enough to check for '> ' line starts.
function decodeQP(s) {
  return s.replace(/=\r?\n/g, "").replace(/=3E/gi, ">");
}
