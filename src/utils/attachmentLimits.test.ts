import { describe, expect, it } from "vitest";
import {
  decodeInlineAttachment,
  MAX_INLINE_ATTACHMENT_BASE64_CHARS,
  MAX_INLINE_ATTACHMENT_BASE64_INPUT_CHARS,
  MAX_INLINE_ATTACHMENT_BYTES,
} from "@/utils/attachmentLimits.js";

describe("inline attachment size limits", () => {
  it("decodes content below the limit", () => {
    expect(decodeInlineAttachment(Buffer.from("payload").toString("base64")).toString()).toBe(
      "payload"
    );
  });

  it("rejects encoded input above the limit before decoding", () => {
    const oversized = new Proxy(
      {},
      {
        get: (_target, property) =>
          property === "length" ? MAX_INLINE_ATTACHMENT_BASE64_INPUT_CHARS + 1 : undefined,
      }
    ) as string;

    expect(() => decodeInlineAttachment(oversized)).toThrow(/25 MiB decoded size limit/);
  });

  it("defines the base64 ceiling from the decoded byte ceiling", () => {
    expect(MAX_INLINE_ATTACHMENT_BYTES).toBe(25 * 1024 * 1024);
    expect(MAX_INLINE_ATTACHMENT_BASE64_CHARS).toBe(Math.ceil(MAX_INLINE_ATTACHMENT_BYTES / 3) * 4);
    expect(MAX_INLINE_ATTACHMENT_BASE64_INPUT_CHARS).toBe(MAX_INLINE_ATTACHMENT_BASE64_CHARS * 2);
  });

  it("accepts RFC-2045-wrapped base64 near the decoded limit", () => {
    const byteLength = Math.floor(MAX_INLINE_ATTACHMENT_BYTES * 0.98);
    const encoded = Buffer.alloc(byteLength, 0x61).toString("base64");
    const wrapped = encoded.replace(/.{76}/g, "$&\r\n");

    expect(wrapped.length).toBeGreaterThan(MAX_INLINE_ATTACHMENT_BASE64_CHARS);
    const decoded = decodeInlineAttachment(wrapped);
    expect(decoded.length).toBe(byteLength);
    expect(decoded[0]).toBe(0x61);
    expect(decoded[decoded.length - 1]).toBe(0x61);
  });
});
