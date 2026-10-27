import { beforeEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { runInNewContext } from "node:vm";
import {
  MAX_NATIVE_CLIPBOARD_SNAPSHOT_BYTES,
  MAX_NATIVE_EDITOR_OUTPUT_BYTES,
  recoverNativeClipboard,
} from "./nativeClipboardRecovery.js";

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));
const run = vi.mocked(spawnSync);
const snapshot = JSON.stringify({
  kind: "clipboard-recovery",
  token: "test-token",
  originalCount: 40,
  items: [[{ type: "public.utf8-plain-text", data: "cHJpdmF0ZQ==" }]],
});

describe("native clipboard timeout recovery", () => {
  beforeEach(() => {
    run.mockReset();
    run.mockReturnValue({ status: 0, stdout: '{"success":true}', stderr: "" } as ReturnType<
      typeof spawnSync
    >);
  });
  it("does nothing when the compose child never reached clipboard mutation", () => {
    expect(recoverNativeClipboard("", "test-token")).toBe(true);
    expect(run).not.toHaveBeenCalled();
  });
  it("retains snapshot and owned counts after a timeout, without putting clipboard data in argv", () => {
    expect(
      recoverNativeClipboard(
        snapshot +
          '\n{"kind":"clipboard-cleared","count":41}\n{"kind":"clipboard-owned","count":42}\n',
        "test-token"
      )
    ).toBe(true);
    const [, argv, options] = run.mock.calls[0];
    expect(JSON.stringify(argv)).not.toContain("cHJpdmF0ZQ==");
    expect(JSON.parse(options!.input as string)).toMatchObject({
      ownedCount: 42,
      clearedCount: 41,
      token: "test-token",
    });
    expect(String(argv)).toContain("Number(pasteboard.changeCount) !== count");
    expect(String(argv)).toContain("ObjC.unwrap(marker) === input.token");
  });
  it("covers termination between clearing and flushing the ownership record", () => {
    expect(recoverNativeClipboard(snapshot, "test-token")).toBe(true);
    expect(JSON.parse(run.mock.calls[0][2]!.input as string)).toMatchObject({
      clearedCount: 41,
      ownedCount: null,
    });
  });
  it("ignores a different operation's clipboard snapshot", () => {
    expect(recoverNativeClipboard(snapshot, "different-token")).toBe(true);
    expect(run).not.toHaveBeenCalled();
  });
  it("reports a failed recovery rather than claiming preservation", () => {
    run.mockReturnValue({ status: 1, stdout: "", stderr: "" } as ReturnType<typeof spawnSync>);
    expect(recoverNativeClipboard(snapshot, "test-token")).toBe(false);
  });

  it("accepts a complete maximum-sized snapshot with ownership/result records and recovery-input headroom", () => {
    const empty = JSON.stringify({
      kind: "clipboard-recovery",
      token: "test-token",
      originalCount: 40,
      items: [[{ type: "public.png", data: "" }]],
    });
    const large = empty.replace(
      '"data":""',
      '"data":"' + "A".repeat(MAX_NATIVE_CLIPBOARD_SNAPSHOT_BYTES - Buffer.byteLength(empty)) + '"'
    );
    expect(Buffer.byteLength(large)).toBe(MAX_NATIVE_CLIPBOARD_SNAPSHOT_BYTES);
    expect(
      recoverNativeClipboard(
        large +
          '\n{"kind":"clipboard-cleared","count":41}\n{"kind":"clipboard-owned","count":42}\n{"success":true}\n',
        "test-token"
      )
    ).toBe(true);
    const options = run.mock.calls[0][2]!;
    expect(Buffer.byteLength(options.input as string)).toBeLessThanOrEqual(
      MAX_NATIVE_CLIPBOARD_SNAPSHOT_BYTES + 4096
    );
    expect(JSON.parse(options.input as string)).toMatchObject({ clearedCount: 41, ownedCount: 42 });
    expect(options.maxBuffer).toBe(4096); // Recovery emits status only, never snapshot bytes.
  });

  it("rejects oversized protocol output before parsing or starting restoration", () => {
    expect(
      recoverNativeClipboard("x".repeat(MAX_NATIVE_EDITOR_OUTPUT_BYTES + 1), "test-token")
    ).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  function executeRecovery(
    marker: string | null,
    count: number,
    options: { writeFails?: boolean; dataFails?: boolean; changeDuringRebuild?: boolean } = {}
  ) {
    let currentCount = count;
    const clear = vi.fn(() => currentCount++);
    const writtenItems: Array<Array<{ type: string; bytes: Buffer }>> = [];
    const write = vi.fn((items: Array<Array<{ type: string; bytes: Buffer }>>) => {
      writtenItems.push(...items);
      return !options.writeFails;
    });
    const pasteboard = {
      get changeCount() {
        return currentCount;
      },
      get clearContents() {
        clear();
        return currentCount;
      },
      stringForType: () => marker,
      pasteboardItems: { count: marker ? 1 : 0 },
      writeObjects: write,
    };

    run.mockImplementation((_command, argv, spawnOptions) => {
      const script = (argv as string[])[3];
      const input = String(spawnOptions!.input);
      const output = runInNewContext(script, {
        ObjC: { import: () => undefined, unwrap: (value: unknown) => value },
        $: {
          NSFileHandle: { fileHandleWithStandardInput: { readDataToEndOfFile: input } },
          NSString: { alloc: { initWithDataEncoding: () => ({ js: input }) } },
          NSUTF8StringEncoding: 4,
          NSPasteboard: { generalPasteboard: pasteboard },
          NSPasteboardItem: {
            alloc: {
              get init() {
                const types: Array<{ type: string; bytes: Buffer }> = [];
                return {
                  types,
                  setDataForType(bytes: Buffer, type: string) {
                    if (options.changeDuringRebuild) currentCount++;
                    types.push({ type, bytes });
                    return !options.dataFails;
                  },
                };
              },
            },
          },
          NSData: {
            alloc: {
              initWithBase64EncodedStringOptions: (data: string) => Buffer.from(data, "base64"),
            },
          },
          NSMutableArray: {
            alloc: {
              get init() {
                const values: Array<Array<{ type: string; bytes: Buffer }>> = [];
                return {
                  addObject: (item: { types: Array<{ type: string; bytes: Buffer }> }) =>
                    values.push(item.types),
                  // Unwrap the native-array stand-in at the pasteboard boundary.
                  values,
                };
              },
            },
          },
        },
      });
      return { status: 0, stdout: output, stderr: "" } as ReturnType<typeof spawnSync>;
    });

    // The production program passes an NSMutableArray, not a JavaScript array.
    pasteboard.writeObjects = vi.fn((objects: unknown) =>
      write((objects as { values: Array<Array<{ type: string; bytes: Buffer }>> }).values)
    );
    const success = recoverNativeClipboard(
      snapshot +
        '\n{"kind":"clipboard-cleared","count":41}\n{"kind":"clipboard-owned","count":42}\n',
      "test-token"
    );
    return { success, clear, write, writtenItems };
  }

  it.each([
    { marker: "test-token", count: 42, label: "token-owned clipboard" },
    { marker: null, count: 41, label: "empty clipboard after initial clear" },
  ])("executes restoration for $label", ({ marker, count }) => {
    const result = executeRecovery(marker, count);
    expect(result.success).toBe(true);
    expect(result.clear).toHaveBeenCalledOnce();
    expect(result.write).toHaveBeenCalledOnce();
    expect(result.writtenItems).toEqual([
      [{ type: "public.utf8-plain-text", bytes: Buffer.from("private", "utf8") }],
    ]);
  });

  it.each([
    { marker: "foreign-token", count: 42, label: "foreign owner" },
    { marker: "test-token", count: 43, label: "newer token-bearing clipboard" },
    { marker: null, count: 44, label: "newer empty clipboard" },
  ])("executes ownership checks without overwriting $label", ({ marker, count }) => {
    const result = executeRecovery(marker, count);
    expect(result.success).toBe(true);
    expect(result.clear).not.toHaveBeenCalled();
    expect(result.write).not.toHaveBeenCalled();
  });

  it("fails before clearing if ownership changes while rebuilding items", () => {
    const result = executeRecovery("test-token", 42, { changeDuringRebuild: true });
    expect(result.success).toBe(false);
    expect(result.clear).not.toHaveBeenCalled();
    expect(result.write).not.toHaveBeenCalled();
  });

  it.each([{ dataFails: true }, { writeFails: true }])(
    "returns false when the executed restoration fails: %j",
    (options) => {
      expect(executeRecovery("test-token", 42, options).success).toBe(false);
    }
  );
});
