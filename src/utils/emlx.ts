/**
 * Mail.app `.emlx` files: where a message's file lives, and how to read it.
 *
 * Mail stores each synced message as
 *
 *   <V-dir>/<account-id>/<a>.mbox/<b>.mbox/<store-uuid>/Data/<d…>/Messages/<id>.emlx
 *
 * where the `.mbox` chain mirrors the account-relative mailbox path
 * (`[Gmail]/All Mail` → `[Gmail].mbox/All Mail.mbox`), `<id>` is the Envelope
 * Index ROWID (= AppleScript `id of message`), and `<d…>` are the decimal digits
 * of `floor(id / 1000)`, least significant first (id 10371 → `Data/0/1`; ids
 * below 1000 sit directly in `Data/Messages`). A message whose body Mail hasn't
 * fully downloaded is `<id>.partial.emlx`.
 *
 * The file is a byte-count line, that many bytes of RFC 5322 message, then an
 * XML plist of Mail's own metadata.
 *
 * @module utils/emlx
 */

import { existsSync, readdirSync } from "fs";
import { join } from "path";
import { extractHtmlBody, extractTextBody } from "@/utils/mimeParse.js";

/** Directory under `Data/` holding message `id`, as path segments. */
export function dataSubdirs(id: number): string[] {
  const bucket = Math.floor(id / 1000);
  return bucket === 0 ? [] : String(bucket).split("").reverse();
}

/**
 * Candidate `.emlx` paths for message `id` in an account-relative mailbox,
 * full download first. Only lists the mailbox's store directories — no walk.
 */
export function emlxCandidates(
  versionDir: string,
  accountId: string,
  mailboxPath: string,
  id: number
): string[] {
  const segments = mailboxPath.split("/").filter(Boolean);
  if (segments.length === 0) return [];
  const mailboxDir = join(versionDir, accountId, ...segments.map((s) => `${s}.mbox`));
  let stores: string[];
  try {
    stores = readdirSync(mailboxDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(join(mailboxDir, e.name, "Data")))
      .map((e) => join(mailboxDir, e.name, "Data"));
  } catch {
    return [];
  }
  // Some stores keep Data directly under the .mbox.
  if (existsSync(join(mailboxDir, "Data"))) stores.push(join(mailboxDir, "Data"));
  const sub = dataSubdirs(id);
  return stores.flatMap((data) => [
    join(data, ...sub, "Messages", `${id}.emlx`),
    join(data, ...sub, "Messages", `${id}.partial.emlx`),
  ]);
}

/**
 * The RFC 5322 message inside an `.emlx` file, as a latin1 string of the raw
 * bytes (the form mimeParse expects), or null when the framing is wrong.
 */
export function emlxSource(bytes: Buffer): string | null {
  const nl = bytes.indexOf(0x0a);
  if (nl <= 0) return null;
  const count = Number(bytes.subarray(0, nl).toString("latin1").trim());
  if (!Number.isInteger(count) || count <= 0) return null;
  return bytes.subarray(nl + 1, nl + 1 + count).toString("latin1");
}

/** Whether `s` has `word` (lower-case ASCII) at `at`, ignoring ASCII case only, as a non-unicode `/i` regex does. */
function asciiWordAt(s: string, at: number, word: string): boolean {
  for (let k = 0; k < word.length; k++) {
    const c = s.charCodeAt(at + k);
    // Letters fold with 0x20; nothing outside A–Z/a–z matches a letter.
    if (
      c !== word.charCodeAt(k) &&
      !(c >= 0x41 && c <= 0x5a && (c | 0x20) === word.charCodeAt(k))
    ) {
      return false;
    }
  }
  return true;
}

/** Where `</tag>` first starts at or after `from` (its letters in any ASCII case, as `/<\/tag>/i`), or -1. */
function closingTagAt(html: string, tag: string, from: number): number {
  for (let i = html.indexOf("</", from); i !== -1; i = html.indexOf("</", i + 2)) {
    if (asciiWordAt(html, i + 2, tag) && html.charCodeAt(i + 2 + tag.length) === 0x3e) return i;
  }
  return -1;
}

/**
 * `html.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")`, in linear time.
 * The regex rescans the rest of the input from every opening tag, so a message
 * of unclosed `<style>` tags took hours to strip. Here every scan moves
 * forward only:
 *  - the `>` that ends an opening tag is found once and reused while it is
 *    still ahead, so openers sharing one distant `>` don't each scan to it;
 *  - once a kind of tag has no closing tag left, its later openers are skipped;
 *  - a block that is removed is never scanned again.
 */
function dropScriptsAndStyles(html: string): string {
  const noCloseFrom = { script: Infinity, style: Infinity };
  let out = "";
  let kept = 0;
  // The first `>` at or after the last search start; openers only move forward.
  let gt = -1;
  let at = html.indexOf("<");
  while (at !== -1) {
    const tag = asciiWordAt(html, at + 1, "script")
      ? "script"
      : asciiWordAt(html, at + 1, "style")
        ? "style"
        : null;
    if (tag) {
      const from = at + 1 + tag.length;
      if (gt < from) gt = html.indexOf(">", from);
      if (gt === -1) break; // no `>` anywhere after this: no later block either
      if (gt < noCloseFrom[tag]) {
        const close = closingTagAt(html, tag, gt + 1);
        if (close !== -1) {
          out += html.slice(kept, at) + " ";
          kept = close + tag.length + 3; // `</` + tag + `>`
          at = html.indexOf("<", kept);
          continue;
        }
        noCloseFrom[tag] = gt; // and so for every later one of this kind
      }
    }
    at = html.indexOf("<", at + 1);
  }
  return kept === 0 ? html : out + html.slice(kept);
}

/** `s.replace(/<[^>]+>/g, " ")`, in linear time (the regex rescans to the end after each `<` with no `>`). */
function replaceTags(s: string): string {
  let out = "";
  let kept = 0;
  let at = s.indexOf("<");
  while (at !== -1) {
    const gt = s.indexOf(">", at + 1);
    if (gt === -1) break; // no `>` after this `<`, so none after any later one
    if (gt > at + 1) {
      out += s.slice(kept, at) + " ";
      kept = gt + 1;
      at = s.indexOf("<", kept);
    } else {
      at = s.indexOf("<", at + 1); // `<>` is not a tag
    }
  }
  return kept === 0 ? s : out + s.slice(kept);
}

/**
 * Strip tags and common entities so an HTML-only body reads as text. Linear in
 * the input, whatever it holds: it runs on every message the body index reads,
 * spam included.
 */
export function htmlToText(html: string): string {
  return (
    replaceTags(dropScriptsAndStyles(html).replace(/<br\s*\/?>|<\/(p|div|tr|li|h[1-6])>/gi, "\n"))
      .replace(/&nbsp;/gi, " ")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'")
      // `&amp;` last: decoding it first would turn `&amp;lt;` into `&lt;` and then `<`.
      .replace(/&amp;/gi, "&")
      .replace(/[ \t]+/g, " ")
      .replace(/\n\s*\n+/g, "\n\n")
      .trim()
  );
}

/**
 * A message's readable text: its `text/plain` part, else its HTML part as
 * text. A plain part that is only whitespace counts as missing — some senders
 * put the whole message in HTML next to an empty plain part, and reading that
 * one would make the body look empty. Pass `html` when it is already
 * extracted; otherwise it is extracted only when needed.
 */
export function messageText(source: string, html?: string | null): string {
  const plain = extractTextBody(source);
  if (plain !== null && plain.trim() !== "") return plain;
  const part = html === undefined ? extractHtmlBody(source) : html;
  return part !== null ? htmlToText(part) : (plain ?? "");
}
