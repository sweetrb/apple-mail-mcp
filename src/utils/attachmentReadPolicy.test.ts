import { describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
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
  it("canonicalizes to the on-disk spelling so a respelled segment cannot dodge a deny root", () => {
    // fs.realpathSync resolves symlinks but preserves the CALLER's casing; only
    // fs.realpathSync.native returns the true on-disk name. On a case-insensitive
    // volume (APFS default) that difference is a policy bypass: the deny roots are
    // written in exact case, so `~/library/keychains/...` opens the same file as
    // `~/Library/Keychains/...` while matching no deny root.
    const dir = mkdtempSync(join(homedir(), "AmcpCase-"));
    try {
      mkdirSync(join(dir, "Mixed"));
      const trueCased = join(dir, "Mixed", "Report.txt");
      writeFileSync(trueCased, "payload");

      const respelled = join(dir, "mixed", "report.txt");
      if (!existsSync(respelled)) return; // case-sensitive volume: respelling cannot exist

      // The policy must report the on-disk spelling, not the caller's.
      expect(resolveAttachmentReadPath(respelled)).toBe(realpathSync.native(trueCased));
      expect(resolveAttachmentReadPath(respelled)).not.toBe(respelled);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("denies a sensitive root under every spelling the filesystem accepts", () => {
    const keychain = join(homedir(), "Library", "Keychains", "login.keychain-db");
    if (!existsSync(keychain)) return; // not present on this host

    for (const variant of [
      keychain,
      join(homedir(), "library", "keychains", "login.keychain-db"),
      join(homedir(), "Library", "keychains", "login.keychain-db"),
    ]) {
      if (!existsSync(variant)) continue;
      expect(() => resolveAttachmentReadPath(variant)).toThrow(/protected location/);
    }
  });
});
