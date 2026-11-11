/** Byte-preserving MIME edits for stored drafts. No SMTP or Mail.app calls. */
import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import addressparser from "nodemailer/lib/addressparser/index.js";
import { parseHeaderValue } from "nodemailer/lib/mime-funcs/index.js";
import type { AttachmentInput, SavedDraftChanges, SavedDraftContent } from "@/types.js";
import { decodeHeaderBytes, parseHeaderBlock } from "@/utils/headers.js";
import {
  cidReferences,
  extractHtmlBody,
  extractTextBody,
  parseMimeAttachments,
} from "@/utils/mimeParse.js";
import { decodeInlineAttachment, MAX_INLINE_ATTACHMENT_BYTES } from "@/utils/attachmentLimits.js";
import { resolveAttachmentReadPath } from "@/utils/attachmentReadPolicy.js";

interface Field {
  name: string;
  value: string;
  raw: string;
}
interface Part {
  id: string;
  fields: Field[];
  body: string;
  eol: string;
  type: string;
  filename?: string;
  attachment: boolean;
  cid?: string;
  boundary?: string;
  children?: Part[];
  preamble?: string;
  epilogue?: string;
}

const render = (p: Part): string => p.fields.map((f) => f.raw).join(p.eol) + p.eol + p.eol + p.body;

/** Refuse malformed/ambiguous MIME rather than guessing which content to edit. */
function parse(raw: string, id = "0", depth = 0, budget = { parts: 0 }): Part {
  if (depth > 20 || ++budget.parts > 200)
    throw new Error("Draft MIME nesting/part limit exceeded.");
  const separator = /\r?\n\r?\n/.exec(raw);
  if (!separator) throw new Error("Draft has no MIME header/body boundary.");
  const eol = separator[0].startsWith("\r") ? "\r\n" : "\n";
  const fields: Field[] = [];
  for (const line of raw.slice(0, separator.index).split(/\r?\n/)) {
    if (/[\r\0]/.test(line)) throw new Error("Malformed draft MIME header; editing refused.");
    if (/^[ \t]/.test(line) && fields.length) {
      fields[fields.length - 1].raw += eol + line;
      fields[fields.length - 1].value += " " + line.trim();
    } else {
      const m = /^([!#$%&'*+\-.^_`|~0-9A-Za-z]+):[ \t]*(.*)$/.exec(line);
      if (!m || /[\r\0]/.test(line))
        throw new Error("Malformed draft MIME header; editing refused.");
      fields.push({ name: m[1].toLowerCase(), value: m[2], raw: line });
    }
  }
  for (const name of [
    "from",
    "sender",
    "to",
    "cc",
    "bcc",
    "reply-to",
    "subject",
    "message-id",
    "content-type",
    "content-transfer-encoding",
    "content-disposition",
  ]) {
    if (fields.filter((f) => f.name === name).length > 1)
      throw new Error(`Ambiguous duplicate ${name} header.`);
  }
  if (fields.some((f) => /^(resent-|dkim-signature$|arc-|content-md5$)/.test(f.name))) {
    throw new Error("Signed or resent draft headers cannot be safely edited in this version.");
  }
  const ct = parseHeaderValue(fields.find((f) => f.name === "content-type")?.value || "text/plain");
  const cd = parseHeaderValue(
    fields.find((f) => f.name === "content-disposition")?.value || "inline"
  );
  const type = ct.value.toLowerCase();
  if (/^(multipart\/(signed|encrypted)|application\/(x-)?pkcs7-mime)$/.test(type)) {
    throw new Error("Signed/encrypted drafts cannot be edited.");
  }
  const filename = cd.params.filename || ct.params.name;
  const p: Part = {
    id,
    fields,
    body: raw.slice(separator.index + separator[0].length),
    eol,
    type,
    filename,
    attachment: cd.value.toLowerCase() === "attachment" || !!filename,
    cid: fields.find((f) => f.name === "content-id")?.value.replace(/^<|>$/g, ""),
  };
  if (type.startsWith("multipart/")) {
    if (
      !["multipart/mixed", "multipart/alternative", "multipart/related"].includes(type) ||
      p.attachment
    ) {
      throw new Error("Unsupported multipart draft structure.");
    }
    const b = ct.params.boundary;
    if (!b || b.length > 70 || /[\r\n\0]/.test(b)) throw new Error("Invalid MIME boundary.");
    p.boundary = b;
    const escaped = b.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const markers = [
      ...p.body.matchAll(new RegExp(`(^|\\n)--${escaped}(--)?[ \\t]*(\\r?\\n|$)`, "g")),
    ];
    if (
      markers.length < 2 ||
      markers[0][2] ||
      !markers.at(-1)?.[2] ||
      markers.slice(0, -1).some((m) => m[2])
    ) {
      throw new Error("Incomplete or ambiguous multipart draft.");
    }
    p.preamble = p.body.slice(0, markers[0].index! + markers[0][1].length);
    p.epilogue = p.body.slice(markers.at(-1)!.index! + markers.at(-1)![0].length);
    p.children = markers
      .slice(0, -1)
      .map((m, i) =>
        parse(
          p.body.slice(m.index! + m[0].length, markers[i + 1].index! + markers[i + 1][1].length),
          id === "0" ? String(i + 1) : `${id}.${i + 1}`,
          depth + 1,
          budget
        )
      );
  }
  return p;
}

function leaves(p: Part): Part[] {
  return p.children ? p.children.flatMap(leaves) : [p];
}
function headers(p: Part) {
  return parseHeaderBlock(
    decodeHeaderBytes(Buffer.from(p.fields.map((f) => f.raw).join(p.eol), "latin1"))
  );
}
function addresses(p: Part, name: string): string[] {
  const h = headers(p).headers.find((f) => f.name.toLowerCase() === name)?.value;
  if (!h) return [];
  const result = addressparser(h, { flatten: true }).map((a) => a.address);
  if (result.some((a) => !a || !/^[^\s@<>]+@[^\s@<>]+$/.test(a)))
    throw new Error(`Invalid draft ${name} address.`);
  return result;
}

function content(root: Part): SavedDraftContent {
  const bodyParts = leaves(root).filter((p) => !p.attachment);
  if (
    ["text/plain", "text/html"].some((type) => bodyParts.filter((p) => p.type === type).length > 1)
  ) {
    throw new Error("Ambiguous multiple body parts; editing refused.");
  }
  const raw = render(root);
  const text = extractTextBody(raw);
  const html = extractHtmlBody(raw);
  if (text === null && html === null)
    throw new Error("Draft body cannot be previewed; editing refused.");
  if ((text?.length ?? 0) > 100_000 || (html?.length ?? 0) > 100_000)
    throw new Error("Draft body exceeds the preview limit.");
  const from = addresses(root, "from");
  if (from.length !== 1) throw new Error("Draft must have exactly one From address.");
  const cids = cidReferences(html ?? "");
  return {
    from: from[0],
    to: addresses(root, "to"),
    cc: addresses(root, "cc"),
    bcc: addresses(root, "bcc"),
    subject: headers(root).subject ?? "",
    body: text ?? html ?? "",
    isHtml: text === null,
    ...(text !== null && html !== null ? { htmlBody: html } : {}),
    attachments: leaves(root)
      .filter((p) => p.attachment || !["text/plain", "text/html"].includes(p.type))
      .map((p) => ({
        partId: p.id,
        name: p.filename ?? "(unnamed)",
        mimeType: p.type,
        size: parseMimeAttachments(render(p))[0]?.size ?? Buffer.byteLength(p.body, "latin1"),
        removable: !p.cid || !cids.has(p.cid.toLowerCase()),
      })),
  };
}

export function previewSavedDraftMime(raw: Buffer): SavedDraftContent {
  return content(parse(raw.toString("latin1")));
}

function setFields(p: Part, replacement: Field[], names: string[]): void {
  p.fields = [
    ...p.fields.filter((f) => !names.includes(f.name)),
    ...replacement.filter((f) => names.includes(f.name)),
  ];
}
function rebuildMultipart(p: Part): void {
  p.body =
    (p.preamble ?? "") +
    p
      .children!.map((child) => {
        const raw = render(child);
        return `--${p.boundary}${p.eol}${raw}${raw.endsWith("\n") ? "" : p.eol}`;
      })
      .join("") +
    `--${p.boundary}--${p.eol}` +
    (p.epilogue ?? "");
}

async function attachmentPart(input: AttachmentInput): Promise<Part> {
  const file = typeof input === "string" ? resolveAttachmentReadPath(input) : undefined;
  if (file && statSync(file).size > MAX_INLINE_ATTACHMENT_BYTES)
    throw new Error("Attachment exceeds the 25 MiB size limit.");
  const filename = file ? basename(file) : (input as Exclude<AttachmentInput, string>).filename;
  const bytes = file
    ? readFileSync(file)
    : decodeInlineAttachment((input as Exclude<AttachmentInput, string>).contentBase64);
  const raw = await new MailComposer({
    attachments: [{ filename, content: bytes }],
    disableFileAccess: true,
    disableUrlAccess: true,
  })
    .compile()
    .build();
  const generated = parse(raw.toString("latin1"));
  const part = leaves(generated).find((p) => p.attachment);
  if (!part) throw new Error("Attachment could not be composed.");
  part.fields = part.fields.filter((f) => f.name.startsWith("content-"));
  return part;
}

/** Preserve every untouched header and encoded MIME part, including inline images. */
export async function patchSavedDraftMime(
  raw: Buffer,
  changes: SavedDraftChanges
): Promise<Buffer> {
  const root = parse(raw.toString("latin1"));
  const before = content(root);
  const bodyParts = leaves(root).filter(
    (p) => !p.attachment && ["text/plain", "text/html"].includes(p.type)
  );
  const plain = bodyParts.filter((p) => p.type === "text/plain");
  const html = bodyParts.filter((p) => p.type === "text/html");
  if (changes.body !== undefined || changes.htmlBody !== undefined) {
    if (
      plain.length > 1 ||
      html.length > 1 ||
      (changes.body !== undefined && plain.length !== 1) ||
      (changes.htmlBody !== undefined && html.length !== 1)
    ) {
      throw new Error("Body edit is ambiguous or targets a missing MIME alternative.");
    }
    if (
      plain.length &&
      html.length &&
      (changes.body === undefined || changes.htmlBody === undefined)
    ) {
      throw new Error("Replace both body and htmlBody so no stale MIME alternative survives.");
    }
    for (const [p, text] of [
      [plain[0], changes.body],
      [html[0], changes.htmlBody],
    ] as const) {
      if (!p || text === undefined) continue;
      setFields(
        p,
        [
          {
            name: "content-type",
            value: `${p.type}; charset=utf-8`,
            raw: `Content-Type: ${p.type}; charset=utf-8`,
          },
          {
            name: "content-transfer-encoding",
            value: "base64",
            raw: "Content-Transfer-Encoding: base64",
          },
        ],
        ["content-type", "content-transfer-encoding"]
      );
      p.body =
        (
          Buffer.from(text, "utf8")
            .toString("base64")
            .match(/.{1,76}/g) ?? [""]
        ).join(p.eol) + p.eol;
    }
  }
  const removals = new Set(changes.removeAttachments ?? []);
  for (const id of removals) {
    const att = before.attachments.find((a) => a.partId === id);
    if (!att || !att.removable || id === "0")
      throw new Error(`Attachment part ${id} is missing or cannot be removed safely.`);
  }
  const walk = (p: Part) => {
    if (!p.children) return;
    p.children = p.children.filter((child) => !removals.has(child.id));
    for (const child of p.children) walk(child);
    if (!p.children.length) throw new Error("Editing would leave an empty multipart.");
    if (changes.body !== undefined || changes.htmlBody !== undefined || removals.size)
      rebuildMultipart(p);
  };
  walk(root);
  const added: Part[] = [];
  for (const input of changes.addAttachments ?? []) added.push(await attachmentPart(input));
  if (added.length) {
    if (root.type !== "multipart/mixed") {
      const inner: Part = {
        ...root,
        fields: root.fields.filter((f) => f.name.startsWith("content-")),
      };
      root.fields = root.fields.filter((f) => !f.name.startsWith("content-"));
      root.boundary = `amcp_${randomUUID()}`;
      root.type = "multipart/mixed";
      root.children = [inner];
      root.preamble = root.epilogue = "";
      root.fields.push({
        name: "content-type",
        value: `multipart/mixed; boundary="${root.boundary}"`,
        raw: `Content-Type: multipart/mixed; boundary="${root.boundary}"`,
      });
    }
    root.children!.push(...added);
    rebuildMultipart(root);
  }
  const names = ["subject", "to", "cc", "bcc"] as const;
  const changed = names.filter((name) => changes[name] !== undefined);
  if (changed.length) {
    for (const name of changed) {
      const v = changes[name]!;
      const entries = typeof v === "string" ? [v] : v;
      if (entries.some((s) => /[\r\n\0]/.test(s)))
        throw new Error("Header edits cannot contain line breaks or NUL.");
      if (
        name !== "subject" &&
        entries.some((s) => {
          const a = addressparser(s, { flatten: true });
          return a.length !== 1 || !/^[^\s@<>]+@[^\s@<>]+$/.test(a[0]?.address ?? "");
        })
      ) {
        throw new Error("Each recipient must be one valid mailbox address.");
      }
    }
    const composer = new MailComposer({
      subject: changes.subject,
      to: changes.to,
      cc: changes.cc,
      bcc: changes.bcc,
      text: "",
      disableFileAccess: true,
      disableUrlAccess: true,
    }).compile();
    composer.keepBcc = true;
    const generated = parse((await composer.build()).toString("latin1"));
    setFields(root, generated.fields, changed);
  }
  const result = Buffer.from(render(root), "latin1");
  previewSavedDraftMime(result); // Do not store a revision that cannot be reviewed.
  return result;
}
