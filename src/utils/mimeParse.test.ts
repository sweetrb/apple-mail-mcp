import { describe, it, expect } from "vitest";
import {
  parseMimeAttachments,
  extractMimeAttachment,
  extractHtmlBody,
  extractRfcMessageIdFromSource,
} from "./mimeParse.js";

describe("extractRfcMessageIdFromSource", () => {
  it("extracts a Message-ID header and strips angle brackets", () => {
    const src = "From: a@b.com\r\nMessage-ID: <abc123@mail.example.com>\r\nSubject: Hi\r\n\r\nBody";
    expect(extractRfcMessageIdFromSource(src)).toBe("abc123@mail.example.com");
  });

  it("matches the Message-Id casing variant", () => {
    const src = "Message-Id: <XYZ@host>\r\n\r\nbody";
    expect(extractRfcMessageIdFromSource(src)).toBe("XYZ@host");
  });

  it("returns empty string when there is no Message-ID header", () => {
    expect(extractRfcMessageIdFromSource("Subject: Hi\r\n\r\nbody")).toBe("");
  });

  it("returns empty string for a subject+body blob with no header block", () => {
    expect(extractRfcMessageIdFromSource("Subject: Hello\n\nsome body text")).toBe("");
  });

  it("ignores a Message-ID-looking line in the body", () => {
    const src = "Subject: Hi\r\n\r\nMessage-ID: <notheader@x.com>";
    expect(extractRfcMessageIdFromSource(src)).toBe("");
  });

  it("returns empty string for empty input", () => {
    expect(extractRfcMessageIdFromSource("")).toBe("");
  });
});

const MIME_WITH_PDF = `Content-Type: multipart/mixed;
\tboundary="_004_TEST"
MIME-Version: 1.0

--_004_TEST
Content-Type: text/plain; charset="us-ascii"
Content-Transfer-Encoding: quoted-printable

Hello world

--_004_TEST
Content-Type: application/pdf; name="report.pdf"
Content-Description: report.pdf
Content-Disposition: attachment;
\tfilename="report.pdf"; size=100;
\tcreation-date="Mon, 14 Apr 2026 12:10:46 GMT";
\tmodification-date="Mon, 14 Apr 2026 12:10:46 GMT"
Content-Transfer-Encoding: base64

JVBERi0xLjAKMSAwIG9iago=

--_004_TEST--`;

const MIME_TEXT_ONLY = `Content-Type: text/plain; charset="us-ascii"
MIME-Version: 1.0

Just a plain text email with no attachments.`;

const MIME_MULTI_ATTACH = `Content-Type: multipart/mixed;
\tboundary="_004_MULTI"

--_004_MULTI
Content-Type: text/plain; charset="us-ascii"

Body text

--_004_MULTI
Content-Type: application/pdf; name="doc1.pdf"
Content-Disposition: attachment; filename="doc1.pdf"; size=50
Content-Transfer-Encoding: base64

AAAA

--_004_MULTI
Content-Type: application/vnd.openxmlformats-officedocument.wordprocessingml.document; name="doc2.docx"
Content-Disposition: attachment; filename="doc2.docx"; size=75
Content-Transfer-Encoding: base64

BBBB

--_004_MULTI--`;

const MIME_WITH_INLINE = `Content-Type: multipart/mixed;
\tboundary="_004_INLINE"

--_004_INLINE
Content-Type: text/html; charset="us-ascii"

<html><body>Hi</body></html>

--_004_INLINE
Content-Type: image/png; name="image001.png"
Content-Disposition: inline; filename="image001.png"
Content-Transfer-Encoding: base64

iVBORw0KGgo=

--_004_INLINE
Content-Type: application/pdf; name="actual-doc.pdf"
Content-Disposition: attachment; filename="actual-doc.pdf"; size=200
Content-Transfer-Encoding: base64

JVBERi0xLjAK

--_004_INLINE--`;

describe("parseMimeAttachments", () => {
  it("extracts attachment metadata from MIME source", () => {
    const result = parseMimeAttachments(MIME_WITH_PDF);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("report.pdf");
    expect(result[0].mimeType).toBe("application/pdf");
    expect(result[0].size).toBe(100);
  });

  it("returns empty array for text-only messages", () => {
    const result = parseMimeAttachments(MIME_TEXT_ONLY);
    expect(result).toHaveLength(0);
  });

  it("extracts multiple attachments", () => {
    const result = parseMimeAttachments(MIME_MULTI_ATTACH);
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe("doc1.pdf");
    expect(result[1].name).toBe("doc2.docx");
  });

  it("skips inline dispositions", () => {
    const result = parseMimeAttachments(MIME_WITH_INLINE);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("actual-doc.pdf");
  });

  it("returns empty array for empty input", () => {
    expect(parseMimeAttachments("")).toHaveLength(0);
    expect(parseMimeAttachments("   ")).toHaveLength(0);
  });

  it("estimates size from base64 when size header missing", () => {
    const noSizeMime = `Content-Type: multipart/mixed;
\tboundary="_004_NOSIZE"

--_004_NOSIZE
Content-Type: application/pdf; name="test.pdf"
Content-Disposition: attachment; filename="test.pdf"
Content-Transfer-Encoding: base64

AAAAAAAAAAAAAAAA

--_004_NOSIZE--`;
    const result = parseMimeAttachments(noSizeMime);
    expect(result).toHaveLength(1);
    expect(result[0].size).toBeGreaterThan(0);
  });
});

describe("extractMimeAttachment", () => {
  it("decodes base64 content for a named attachment", () => {
    const result = extractMimeAttachment(MIME_WITH_PDF, "report.pdf");
    expect(result).not.toBeNull();
    expect(result!.name).toBe("report.pdf");
    expect(result!.data).toBeInstanceOf(Buffer);
    expect(result!.data.length).toBeGreaterThan(0);
  });

  it("returns null for non-existent attachment", () => {
    const result = extractMimeAttachment(MIME_WITH_PDF, "nope.pdf");
    expect(result).toBeNull();
  });

  it("extracts the correct attachment from multiple", () => {
    const result = extractMimeAttachment(MIME_MULTI_ATTACH, "doc2.docx");
    expect(result).not.toBeNull();
    expect(result!.name).toBe("doc2.docx");
  });

  it("returns null for empty input", () => {
    expect(extractMimeAttachment("", "test.pdf")).toBeNull();
    expect(extractMimeAttachment("   ", "test.pdf")).toBeNull();
  });
});

// Nested multipart: mixed container with alternative (text+html) as one child
// and the attachment as a sibling. This is the most common real-world shape.
const MIME_NESTED_MULTIPART = `Content-Type: multipart/mixed;
\tboundary="_outer_"

--_outer_
Content-Type: multipart/alternative;
\tboundary="_inner_"

--_inner_
Content-Type: text/plain; charset="us-ascii"

Plain body

--_inner_
Content-Type: text/html; charset="us-ascii"

<html><body>HTML body</body></html>

--_inner_--

--_outer_
Content-Type: application/pdf; name="nested.pdf"
Content-Disposition: attachment; filename="nested.pdf"; size=42
Content-Transfer-Encoding: base64

JVBERi0xLjAK

--_outer_--`;

// Attachment nested inside multipart/related (common for HTML emails
// with inline images that also carry a real file attachment).
const MIME_DEEPLY_NESTED = `Content-Type: multipart/mixed;
\tboundary="_L1_"

--_L1_
Content-Type: multipart/related;
\tboundary="_L2_"

--_L2_
Content-Type: text/html

<html>body</html>

--_L2_
Content-Type: application/pdf; name="deep.pdf"
Content-Disposition: attachment; filename="deep.pdf"
Content-Transfer-Encoding: base64

JVBERi0xLjAK

--_L2_--

--_L1_--`;

describe("parseMimeAttachments — nested multipart", () => {
  it("finds attachments alongside a nested multipart/alternative", () => {
    const result = parseMimeAttachments(MIME_NESTED_MULTIPART);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("nested.pdf");
  });

  it("descends into multipart/related to find attachments", () => {
    const result = parseMimeAttachments(MIME_DEEPLY_NESTED);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("deep.pdf");
  });
});

describe("extractMimeAttachment — nested multipart", () => {
  it("extracts a nested attachment by name", () => {
    const result = extractMimeAttachment(MIME_NESTED_MULTIPART, "nested.pdf");
    expect(result).not.toBeNull();
    expect(result!.name).toBe("nested.pdf");
    expect(result!.data.length).toBeGreaterThan(0);
  });

  it("extracts an attachment from deeply nested multipart/related", () => {
    const result = extractMimeAttachment(MIME_DEEPLY_NESTED, "deep.pdf");
    expect(result).not.toBeNull();
    expect(result!.name).toBe("deep.pdf");
  });
});

// Quoted-printable and raw (7bit/8bit) encoded attachments.
// "Hello=0A" decodes to "Hello\n".
const MIME_QP_ATTACH = `Content-Type: multipart/mixed;
\tboundary="_QP_"

--_QP_
Content-Type: text/plain; name="note.txt"
Content-Disposition: attachment; filename="note.txt"
Content-Transfer-Encoding: quoted-printable

Hello=0Aworld=21

--_QP_--`;

const MIME_7BIT_ATTACH = `Content-Type: multipart/mixed;
\tboundary="_7B_"

--_7B_
Content-Type: text/csv; name="data.csv"
Content-Disposition: attachment; filename="data.csv"
Content-Transfer-Encoding: 7bit

id,name
1,alice
2,bob

--_7B_--`;

describe("extractMimeAttachment — transfer encodings", () => {
  it("decodes quoted-printable content", () => {
    const result = extractMimeAttachment(MIME_QP_ATTACH, "note.txt");
    expect(result).not.toBeNull();
    expect(result!.data.toString("utf8")).toBe("Hello\nworld!");
  });

  it("returns raw bytes for 7bit content", () => {
    const result = extractMimeAttachment(MIME_7BIT_ATTACH, "data.csv");
    expect(result).not.toBeNull();
    expect(result!.data.toString("utf8")).toContain("id,name");
    expect(result!.data.toString("utf8")).toContain("alice");
  });
});

describe("parseMimeAttachments — transfer encodings", () => {
  it("lists quoted-printable attachments", () => {
    const result = parseMimeAttachments(MIME_QP_ATTACH);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("note.txt");
  });

  it("lists 7bit attachments", () => {
    const result = parseMimeAttachments(MIME_7BIT_ATTACH);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("data.csv");
  });
});

describe("extractHtmlBody (#32)", () => {
  it("extracts the text/html part from a multipart/alternative message", () => {
    const src = `Content-Type: multipart/alternative;
\tboundary="alt-bound"
MIME-Version: 1.0

--alt-bound
Content-Type: text/plain; charset="utf-8"
Content-Transfer-Encoding: 7bit

Hello in plain text

--alt-bound
Content-Type: text/html; charset="utf-8"
Content-Transfer-Encoding: 7bit

<html><body><p>Hello in <b>HTML</b></p></body></html>

--alt-bound--`;
    expect(extractHtmlBody(src)).toBe("<html><body><p>Hello in <b>HTML</b></p></body></html>");
  });

  it("decodes a quoted-printable HTML part", () => {
    const src = `Content-Type: multipart/alternative; boundary="b"
MIME-Version: 1.0

--b
Content-Type: text/html; charset="utf-8"
Content-Transfer-Encoding: quoted-printable

<p>Caf=C3=A9 =26 tea</p>

--b--`;
    expect(extractHtmlBody(src)).toBe("<p>Café & tea</p>");
  });

  it("handles a non-multipart text/html message", () => {
    const src = `Content-Type: text/html; charset="utf-8"
Content-Transfer-Encoding: 7bit

<h1>Direct HTML</h1>`;
    expect(extractHtmlBody(src)).toBe("<h1>Direct HTML</h1>");
  });

  it("returns null for a plain-text-only message", () => {
    const src = `Content-Type: text/plain; charset="utf-8"

just text, no html`;
    expect(extractHtmlBody(src)).toBeNull();
  });

  it("returns null for empty input", () => {
    expect(extractHtmlBody("")).toBeNull();
  });
});

// Build a multipart/mixed tree nested `levels` deep, with a single PDF
// attachment as the innermost leaf. Each level uses a distinct boundary.
function buildNestedMime(levels: number): string {
  let inner = `Content-Type: application/pdf; name="bottom.pdf"
Content-Disposition: attachment; filename="bottom.pdf"
Content-Transfer-Encoding: base64

JVBERi0xLjAK
`;
  for (let i = levels; i >= 1; i--) {
    const b = `_d${i}_`;
    inner = `Content-Type: multipart/mixed;
\tboundary="${b}"

--${b}
${inner}
--${b}--
`;
  }
  return inner;
}

describe("parseMimeAttachments — recursion depth cap (#defense-in-depth)", () => {
  it("finds an attachment nested within the depth bound", () => {
    // 5 levels of nesting is well under the 20-level cap.
    const result = parseMimeAttachments(buildNestedMime(5));
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("bottom.pdf");
  });

  it("does not throw or overflow on pathologically deep nesting", () => {
    // 200 levels far exceeds the cap; the parser must stop descending and
    // return what it parsed rather than recursing without bound.
    const deep = buildNestedMime(200);
    expect(() => parseMimeAttachments(deep)).not.toThrow();
    // The bottom attachment is below the cap, so it is not surfaced — the
    // point is that the call completes safely.
    const result = parseMimeAttachments(deep);
    expect(Array.isArray(result)).toBe(true);
  });
});
