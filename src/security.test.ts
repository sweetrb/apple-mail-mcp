/**
 * Tests for security hardening: input validation schemas and path traversal prevention.
 */

import { describe, it, expect } from "vitest";
import { resolve, isAbsolute } from "path";
import { homedir } from "os";
import { existsSync } from "fs";
import { escapeForAppleScript, escapeForAppleScriptBody } from "@/services/appleMailManager.js";
import {
  ATTACHMENTS_SCHEMA,
  BATCH_IDS_SCHEMA,
  DATE_FILTER_SCHEMA,
  MESSAGE_ID_SCHEMA,
} from "@/schemas.js";

describe("MESSAGE_ID_SCHEMA", () => {
  it("accepts valid numeric IDs", () => {
    expect(MESSAGE_ID_SCHEMA.parse("12345")).toBe("12345");
    expect(MESSAGE_ID_SCHEMA.parse("0")).toBe("0");
    expect(MESSAGE_ID_SCHEMA.parse("999999999")).toBe("999999999");
  });

  it("accepts injection-safe IMAP ids", () => {
    expect(MESSAGE_ID_SCHEMA.parse("imap:YWJjXzEyMw")).toBe("imap:YWJjXzEyMw");
  });

  it("rejects non-numeric IDs", () => {
    expect(() => MESSAGE_ID_SCHEMA.parse("abc")).toThrow();
    expect(() => MESSAGE_ID_SCHEMA.parse("123abc")).toThrow();
    expect(() => MESSAGE_ID_SCHEMA.parse("")).toThrow();
  });

  it("rejects AppleScript injection attempts", () => {
    expect(() => MESSAGE_ID_SCHEMA.parse('1" & do shell script "rm -rf /')).toThrow();
    expect(() => MESSAGE_ID_SCHEMA.parse("1; drop table")).toThrow();
    expect(() => MESSAGE_ID_SCHEMA.parse("-1")).toThrow();
  });

  it("rejects template-style IDs (tmpl_N format)", () => {
    expect(() => MESSAGE_ID_SCHEMA.parse("tmpl_1")).toThrow();
  });
});

describe("BATCH_IDS_SCHEMA", () => {
  it("accepts valid batch of numeric IDs", () => {
    const result = BATCH_IDS_SCHEMA.parse(["1", "2", "3"]);
    expect(result).toEqual(["1", "2", "3"]);
  });

  it("accepts a batch of IMAP ids", () => {
    expect(BATCH_IDS_SCHEMA.parse(["imap:YWJj", "imap:ZGVm"])).toEqual(["imap:YWJj", "imap:ZGVm"]);
  });

  it("rejects empty array", () => {
    expect(() => BATCH_IDS_SCHEMA.parse([])).toThrow("At least one message ID");
  });

  it("rejects more than 100 IDs", () => {
    const ids = Array.from({ length: 101 }, (_, i) => String(i));
    expect(() => BATCH_IDS_SCHEMA.parse(ids)).toThrow("Cannot process more than 100");
  });

  it("accepts exactly 100 IDs", () => {
    const ids = Array.from({ length: 100 }, (_, i) => String(i));
    expect(BATCH_IDS_SCHEMA.parse(ids)).toHaveLength(100);
  });

  it("rejects batch containing non-numeric IDs", () => {
    expect(() => BATCH_IDS_SCHEMA.parse(["123", "abc", "456"])).toThrow();
  });
});

describe("DATE_FILTER_SCHEMA", () => {
  it("accepts valid date strings", () => {
    expect(DATE_FILTER_SCHEMA.parse("January 1, 2026")).toBe("January 1, 2026");
    expect(DATE_FILTER_SCHEMA.parse("March 15, 2026")).toBe("March 15, 2026");
    expect(DATE_FILTER_SCHEMA.parse("2026-03-15")).toBe("2026-03-15");
    expect(DATE_FILTER_SCHEMA.parse("3/15/2026")).toBe("3/15/2026");
  });

  it("accepts undefined (optional)", () => {
    expect(DATE_FILTER_SCHEMA.parse(undefined)).toBeUndefined();
  });

  it("rejects strings with quotes (AppleScript injection)", () => {
    expect(() => DATE_FILTER_SCHEMA.parse('"January 1" & do shell script "evil"')).toThrow();
  });

  it("rejects strings with backslashes", () => {
    expect(() => DATE_FILTER_SCHEMA.parse("January\\1")).toThrow();
  });

  it("rejects strings with parentheses", () => {
    expect(() => DATE_FILTER_SCHEMA.parse("date(2026)")).toThrow();
  });

  it("rejects non-parseable date strings", () => {
    expect(() => DATE_FILTER_SCHEMA.parse("31")).toThrow();
    expect(() => DATE_FILTER_SCHEMA.parse("abc")).toThrow();
    expect(() => DATE_FILTER_SCHEMA.parse("1234567890")).toThrow();
  });
});

describe("saveAttachment input validation", () => {
  // Test the validation logic that lives in appleMailManager.saveAttachment
  // by checking the same regex/logic used there

  const isInvalidAttachmentName = (name: string): boolean => {
    return /[/\\\0]/.test(name) || name.includes("..");
  };

  it("blocks forward slash in attachment name", () => {
    expect(isInvalidAttachmentName("../../etc/passwd")).toBe(true);
    expect(isInvalidAttachmentName("path/to/file.txt")).toBe(true);
  });

  it("blocks backslash in attachment name", () => {
    expect(isInvalidAttachmentName("file\\name.txt")).toBe(true);
  });

  it("blocks null bytes in attachment name", () => {
    expect(isInvalidAttachmentName("file\0name.txt")).toBe(true);
  });

  it("blocks directory traversal in attachment name", () => {
    expect(isInvalidAttachmentName("..")).toBe(true);
    expect(isInvalidAttachmentName("../secret")).toBe(true);
  });

  it("allows normal attachment names", () => {
    expect(isInvalidAttachmentName("report.pdf")).toBe(false);
    expect(isInvalidAttachmentName("Q1 Budget (Final).xlsx")).toBe(false);
    expect(isInvalidAttachmentName("résumé.docx")).toBe(false);
  });

  const isAllowedPath = (savePath: string): boolean => {
    const resolvedPath = resolve(savePath);
    const allowedPrefixes = [homedir(), "/tmp", "/private/tmp", "/Volumes"];
    return allowedPrefixes.some((prefix: string) => resolvedPath.startsWith(prefix));
  };

  it("allows paths under home directory", () => {
    expect(isAllowedPath(`${homedir()}/Downloads`)).toBe(true);
  });

  it("allows /tmp", () => {
    expect(isAllowedPath("/tmp")).toBe(true);
    expect(isAllowedPath("/tmp/attachments")).toBe(true);
  });

  it("blocks traversal out of allowed directories", () => {
    expect(isAllowedPath("/tmp/../../etc")).toBe(false);
  });

  it("blocks /etc directly", () => {
    expect(isAllowedPath("/etc")).toBe(false);
  });

  it("blocks /usr paths", () => {
    expect(isAllowedPath("/usr/local")).toBe(false);
  });
});

describe("buildAttachmentCommands validation", () => {
  // Mirror the logic from appleMailManager.ts buildAttachmentCommands()
  // to test the validation in isolation without needing real files.

  function escapeForAppleScript(text: string): string {
    if (!text) return "";
    return text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }

  function buildAttachmentCommands(attachments?: string[]): string {
    if (!attachments || attachments.length === 0) return "";
    for (const filePath of attachments) {
      if (!isAbsolute(filePath)) {
        throw new Error(`Attachment path must be absolute: "${filePath}"`);
      }
      if (!existsSync(filePath)) {
        throw new Error(`Attachment file not found: "${filePath}"`);
      }
    }
    let commands = "";
    for (const filePath of attachments) {
      const safePath = escapeForAppleScript(filePath);
      commands += `make new attachment with properties {file name:POSIX file "${safePath}"} at after the last paragraph\n`;
    }
    return commands;
  }

  it("returns empty string for undefined", () => {
    expect(buildAttachmentCommands(undefined)).toBe("");
  });

  it("returns empty string for empty array", () => {
    expect(buildAttachmentCommands([])).toBe("");
  });

  it("rejects relative paths", () => {
    expect(() => buildAttachmentCommands(["relative/path.pdf"])).toThrow("must be absolute");
  });

  it("rejects paths starting with ./", () => {
    expect(() => buildAttachmentCommands(["./file.pdf"])).toThrow("must be absolute");
  });

  it("rejects nonexistent files", () => {
    expect(() => buildAttachmentCommands(["/nonexistent/file.pdf"])).toThrow("not found");
  });

  it("generates correct AppleScript for valid files", () => {
    // Use a file we know exists
    const testFile = "/usr/bin/env";
    const result = buildAttachmentCommands([testFile]);
    expect(result).toContain("make new attachment");
    expect(result).toContain("POSIX file");
    expect(result).toContain(testFile);
  });

  it("escapes double quotes in file paths", () => {
    // Test the escaping function directly since we can't easily mock existsSync
    const escaped = escapeForAppleScript('/Users/test/file "name".pdf');
    expect(escaped).toContain('file \\"name\\"');
  });

  it("handles multiple attachments", () => {
    const testFile = "/usr/bin/env";
    const result = buildAttachmentCommands([testFile, testFile]);
    const matches = result.match(/make new attachment/g);
    expect(matches).toHaveLength(2);
  });

  it("rejects more than 20 attachments at schema level", () => {
    const paths = Array.from({ length: 21 }, (_, i) => `/tmp/file${i}.pdf`);
    expect(() => ATTACHMENTS_SCHEMA.parse(paths)).toThrow("Cannot attach more than 20");
  });

  it("accepts exactly 20 attachments at schema level", () => {
    const paths = Array.from({ length: 20 }, (_, i) => `/tmp/file${i}.pdf`);
    expect(ATTACHMENTS_SCHEMA.parse(paths)).toHaveLength(20);
  });
});

describe("escapeForAppleScript vs escapeForAppleScriptBody (audit #10 + body newlines)", () => {
  // These test the REAL exported functions from appleMailManager.ts, not a
  // local mirror. The single-line variant strips control chars entirely; the
  // body variant converts line breaks to the two-character AppleScript escape
  // sequence `\n` so paragraph breaks survive without any raw control
  // character ever entering the emitted literal.

  it("body: newlines survive as the \\n escape sequence", () => {
    const body = "Paragraph one.\n\nParagraph two.\nLine three.";
    const escaped = escapeForAppleScriptBody(body);
    expect(escaped).toBe("Paragraph one.\\n\\nParagraph two.\\nLine three.");
    // No raw control characters in the emitted literal
    // eslint-disable-next-line no-control-regex
    expect(escaped).not.toMatch(/[\x00-\x1f\x7f]/);
  });

  it("body: CRLF and lone CR normalize to \\n", () => {
    expect(escapeForAppleScriptBody("a\r\nb\rc\nd")).toBe("a\\nb\\nc\\nd");
  });

  it("body: tabs become the \\t escape sequence", () => {
    expect(escapeForAppleScriptBody("col1\tcol2")).toBe("col1\\tcol2");
  });

  it("body: injection combining quotes and raw newlines cannot escape the literal", () => {
    const attack = '"\ntell application "Finder" to delete every file\n"';
    const escaped = escapeForAppleScriptBody(attack);
    // Quotes are escaped, newlines are the two-char sequence — the payload
    // stays inside the AppleScript string literal.
    expect(escaped).toBe('\\"\\ntell application \\"Finder\\" to delete every file\\n\\"');
    // eslint-disable-next-line no-control-regex
    expect(escaped).not.toMatch(/[\x00-\x1f\x7f]/);
  });

  it("body: backslash escaped before quote/newline (no double-escape confusion)", () => {
    // A literal backslash followed by the letter n must NOT collapse into a
    // linefeed escape ambiguity: input \n (two chars) → \\n (three chars out).
    expect(escapeForAppleScriptBody("\\n")).toBe("\\\\n");
    // And a real newline after a backslash: \ + LF → \\ + \n
    expect(escapeForAppleScriptBody("\\\n")).toBe("\\\\\\n");
  });

  it("body: strips remaining control characters (NUL, ESC, DEL)", () => {
    expect(escapeForAppleScriptBody("a\x00b\x1bc\x7fd")).toBe("abcd");
  });

  it("single-line: still strips ALL control chars including newlines", () => {
    expect(escapeForAppleScript("Subject\nline\r\ntwo\ttabbed\x00")).toBe("Subjectlinetwotabbed");
  });

  it("single-line: quote/backslash escaping unchanged", () => {
    expect(escapeForAppleScript('say "hi" \\ bye')).toBe('say \\"hi\\" \\\\ bye');
  });

  it("both: empty and falsy input yield empty string", () => {
    expect(escapeForAppleScript("")).toBe("");
    expect(escapeForAppleScriptBody("")).toBe("");
  });
});
