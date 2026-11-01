import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import { MAX_FETCH_ATTACHMENT_BYTES } from "@/utils/attachmentLimits.js";

vi.mock("fs", async (original) => {
  const fs = await original<typeof import("fs")>();
  return {
    ...fs,
    openSync: vi.fn(fs.openSync),
    fstatSync: vi.fn(fs.fstatSync),
    readSync: vi.fn(fs.readSync),
    closeSync: vi.fn(fs.closeSync),
  };
});

import { AppleMailManager } from "@/services/appleMailManager.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("native inline attachment descriptor", () => {
  it("opens once without following links, then stats, reads and closes that descriptor", () => {
    const mgr = new AppleMailManager();
    const save = vi.spyOn(mgr, "saveAttachment").mockImplementation((_id, name, directory) => {
      writeFileSync(join(directory, name), "payload");
      return true;
    });
    const result = mgr.getAttachmentBase64("1", "fixture.txt");
    expect(result).toMatchObject({
      success: true,
      base64: Buffer.from("payload").toString("base64"),
    });
    const calls = vi
      .mocked(openSync)
      .mock.calls.filter(([path]) => String(path).endsWith("/fixture.txt"));
    expect(calls).toHaveLength(1);
    const flags = calls[0][1] as number;
    expect(flags & constants.O_NOFOLLOW).not.toBe(0);
    expect(flags & constants.O_NONBLOCK).not.toBe(0);
    const index = vi.mocked(openSync).mock.calls.indexOf(calls[0]);
    const fd = vi.mocked(openSync).mock.results[index].value;
    expect(fstatSync).toHaveBeenCalledWith(fd);
    expect(vi.mocked(readSync).mock.calls.every(([readFd]) => readFd === fd)).toBe(true);
    expect(readSync).toHaveBeenCalled();
    expect(closeSync).toHaveBeenCalledWith(fd);
    expect(existsSync(save.mock.calls[0][2])).toBe(false);
  });

  it.each([0, MAX_FETCH_ATTACHMENT_BYTES, MAX_FETCH_ATTACHMENT_BYTES + 1, 4 * 1024 * 1024])(
    "enforces the native decoded boundary at %i bytes",
    (size) => {
      const mgr = new AppleMailManager();
      const save = vi.spyOn(mgr, "saveAttachment").mockImplementation((_id, name, directory) => {
        writeFileSync(join(directory, name), Buffer.alloc(size, 0x61));
        return true;
      });
      const result = mgr.getAttachmentBase64("1", "fixture.bin");
      if (size <= MAX_FETCH_ATTACHMENT_BYTES) {
        expect(result).toMatchObject({ success: true, bytes: size });
        expect(Buffer.from(result.base64!, "base64").length).toBe(size);
      } else {
        expect(result).toMatchObject({
          success: false,
          error: expect.stringContaining("save-attachment"),
        });
        expect(result.base64).toBeUndefined();
      }
      expect(existsSync(save.mock.calls[0][2])).toBe(false);
    }
  );

  it("refuses a final-path symlink without reading its target", () => {
    const mgr = new AppleMailManager();
    const save = vi.spyOn(mgr, "saveAttachment").mockImplementation((_id, name, directory) => {
      symlinkSync("/etc/hosts", join(directory, name));
      return true;
    });
    const result = mgr.getAttachmentBase64("1", "fixture.txt");
    expect(result.success).toBe(false);
    expect(result.base64).toBeUndefined();
    expect(readSync).not.toHaveBeenCalled();
    expect(existsSync(save.mock.calls[0][2])).toBe(false);
  });

  it.each(["directory", "fifo"])("refuses a non-regular %s without blocking", (kind) => {
    const mgr = new AppleMailManager();
    const save = vi.spyOn(mgr, "saveAttachment").mockImplementation((_id, name, directory) => {
      const target = join(directory, name);
      if (kind === "fifo") execFileSync("mkfifo", [target]);
      else mkdirSync(target);
      return true;
    });
    const real = vi.importActual<typeof import("fs")>("fs");
    return real.then((fs) => {
      vi.mocked(openSync).mockImplementationOnce((path, flags, mode) => {
        if ((Number(flags) & constants.O_NONBLOCK) === 0) throw new Error("missing O_NONBLOCK");
        return fs.openSync(path, flags, mode);
      });
      const result = mgr.getAttachmentBase64("1", "special");
      expect(result).toMatchObject({ success: false, error: "Attachment is not a regular file." });
      expect(readSync).not.toHaveBeenCalled();
      expect(existsSync(save.mock.calls[0][2])).toBe(false);
    });
  });

  it("rejects growth after fstat, closes the descriptor and cleans the staging directory", async () => {
    const fs = await vi.importActual<typeof import("fs")>("fs");
    const mgr = new AppleMailManager();
    let target = "";
    const save = vi.spyOn(mgr, "saveAttachment").mockImplementation((_id, name, directory) => {
      target = join(directory, name);
      writeFileSync(target, "a");
      return true;
    });
    vi.mocked(fstatSync).mockImplementationOnce((fd) => {
      const stat = fs.fstatSync(fd);
      appendFileSync(target, Buffer.alloc(MAX_FETCH_ATTACHMENT_BYTES));
      return stat;
    });
    const result = mgr.getAttachmentBase64("1", "growing.bin");
    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining("save-attachment"),
    });
    const fd = vi.mocked(fstatSync).mock.calls[0][0];
    expect(vi.mocked(readSync).mock.calls.every(([readFd]) => readFd === fd)).toBe(true);
    expect(closeSync).toHaveBeenCalledWith(fd);
    expect(existsSync(save.mock.calls[0][2])).toBe(false);
  });
});
