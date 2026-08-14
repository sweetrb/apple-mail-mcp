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

  it("allows a regular file in an ordinary home-directory location", () => {
    const dir = mkdtempSync(join(homedir(), "amcp-read-policy-"));
    try {
      const file = join(dir, "private.txt");
      writeFileSync(file, "private");
      expect(resolveAttachmentReadPath(file)).toBe(realpathSync(file));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects hidden home-directory paths by default", () => {
    const dir = mkdtempSync(join(homedir(), ".amcp-read-policy-"));
    try {
      const file = join(dir, "selected.txt");
      writeFileSync(file, "secret");
      expect(() => resolveAttachmentReadPath(file)).toThrow(/protected location/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects application config files under the home Library", () => {
    const dir = mkdtempSync(join(homedir(), "Library", "Application Support", "amcp-read-policy-"));
    try {
      const file = join(dir, "config.json");
      writeFileSync(file, "{}");
      expect(() => resolveAttachmentReadPath(file)).toThrow(/protected location/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("authorizes an explicit absolute root outside the defaults", () => {
    const file = "/etc/hosts";
    expect(resolveAttachmentReadPath(file, { [ATTACHMENT_READ_ROOTS_ENV]: "/etc" })).toBe(
      realpathSync(file)
    );
  });

  it("rejects a symlink that resolves outside an allowed temporary root", () => {
    const allowed = mkdtempSync(join(tmpdir(), "amcp-read-policy-"));
    try {
      const link = join(allowed, "link.txt");
      symlinkSync("/etc/hosts", link);
      expect(() => resolveAttachmentReadPath(link)).toThrow(/outside the allowed read roots/);
    } finally {
      rmSync(allowed, { recursive: true, force: true });
    }
  });
});
