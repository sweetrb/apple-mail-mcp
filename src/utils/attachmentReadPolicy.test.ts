import { describe, expect, it } from "vitest";
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";
import {
  ATTACHMENT_READ_ROOTS_ENV,
  resolveAttachmentReadPath,
} from "@/utils/attachmentReadPolicy.js";

describe("outbound attachment read policy", () => {
  it("allows a regular file in the default temporary root", () => {
    const dir = mkdtempSync(join(tmpdir(), "amcp-read-policy-"));
    try {
      const file = join(dir, "report.pdf");
      writeFileSync(file, "pdf");
      expect(resolveAttachmentReadPath(file)).toBe(realpathSync(file));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a regular file in an unconfigured home-directory location", () => {
    const dir = mkdtempSync(join(homedir(), ".amcp-read-policy-"));
    try {
      const file = join(dir, "private.txt");
      writeFileSync(file, "private");
      expect(() => resolveAttachmentReadPath(file)).toThrow(/outside the allowed read roots/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("authorizes an explicit absolute root without widening the default policy", () => {
    const dir = mkdtempSync(join(homedir(), ".amcp-read-policy-"));
    try {
      const file = join(dir, "selected.txt");
      writeFileSync(file, "selected");
      expect(resolveAttachmentReadPath(file, { [ATTACHMENT_READ_ROOTS_ENV]: dir })).toBe(
        realpathSync(file)
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a symlink that resolves outside an allowed temporary root", () => {
    const allowed = mkdtempSync(join(tmpdir(), "amcp-read-policy-"));
    const outside = mkdtempSync(join(homedir(), ".amcp-read-policy-"));
    try {
      const secret = join(outside, "secret.txt");
      const link = join(allowed, "link.txt");
      writeFileSync(secret, "secret");
      symlinkSync(secret, link);
      expect(() => resolveAttachmentReadPath(link)).toThrow(/outside the allowed read roots/);
    } finally {
      rmSync(allowed, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
