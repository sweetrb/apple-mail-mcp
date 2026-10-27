import { spawnSync } from "node:child_process";

// One bounded, in-memory protocol: the child must finish emitting its entire
// snapshot before it can mutate the clipboard. Reserve room for count/result
// records so Node never truncates a valid snapshot after mutation starts.
export const MAX_NATIVE_CLIPBOARD_SNAPSHOT_BYTES = 64 * 1024 * 1024;
export const MAX_NATIVE_EDITOR_OUTPUT_BYTES = MAX_NATIVE_CLIPBOARD_SNAPSHOT_BYTES + 64 * 1024;
const MAX_RECOVERY_INPUT_BYTES = MAX_NATIVE_CLIPBOARD_SNAPSHOT_BYTES + 4096;

// The compose child sends this snapshot before touching the clipboard. Keep it
// in memory only; clipboard contents must never reach logs or temporary files.
const RESTORE = String.raw`
ObjC.import('AppKit');
try {
  var bytes = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
  var input = JSON.parse($.NSString.alloc.initWithDataEncoding(bytes, $.NSUTF8StringEncoding).js);
  var pasteboard = $.NSPasteboard.generalPasteboard;
  var count = Number(pasteboard.changeCount);
  var marker = pasteboard.stringForType('org.apple-mail-mcp.native-composition');
  var ownsWritten = marker && ObjC.unwrap(marker) === input.token &&
    (input.ownedCount === null || count === input.ownedCount);
  var ownsCleared = !marker && Number(pasteboard.pasteboardItems.count) === 0 &&
    count === input.clearedCount;
  if (ownsWritten || ownsCleared) {
    var saved = input.items.map(function (types) {
      var item = $.NSPasteboardItem.alloc.init;
      types.forEach(function (entry) {
        var data = $.NSData.alloc.initWithBase64EncodedStringOptions(entry.data, 0);
        if (!data || !item.setDataForType(data, entry.type)) throw new Error('invalid snapshot');
      });
      return item;
    });
    // Never overwrite a newer clipboard owner while rebuilding the snapshot.
    if (Number(pasteboard.changeCount) !== count) throw new Error('ownership changed');
    pasteboard.clearContents;
    var objects = $.NSMutableArray.alloc.init;
    saved.forEach(function (item) { objects.addObject(item); });
    if (saved.length && !pasteboard.writeObjects(objects)) throw new Error('restore failed');
  }
  JSON.stringify({success: true});
} catch (_) { JSON.stringify({success: false}); }
`;

/** Recover after a killed compose process, only while its clipboard ownership remains. */
export function recoverNativeClipboard(output: string, token: unknown): boolean {
  if (typeof token !== "string" || !token) return true;
  try {
    if (Buffer.byteLength(output, "utf8") > MAX_NATIVE_EDITOR_OUTPUT_BYTES) return false;
    const records = output.split("\n").flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
    const snapshot = records.find((r) => r.kind === "clipboard-recovery" && r.token === token);
    if (!snapshot) return true; // No mutation can precede the snapshot.
    if (!Array.isArray(snapshot.items) || !Number.isSafeInteger(snapshot.originalCount))
      return false;
    const cleared = records.find((r) => r.kind === "clipboard-cleared");
    const owned = records.find((r) => r.kind === "clipboard-owned");
    const input = JSON.stringify({
      token,
      items: snapshot.items,
      // clearContents increments once; cover termination before the clear record flushes.
      clearedCount: cleared?.count ?? snapshot.originalCount + 1,
      ownedCount: owned?.count ?? null,
    });
    if (Buffer.byteLength(input, "utf8") > MAX_RECOVERY_INPUT_BYTES) return false;
    const restored = spawnSync("/usr/bin/osascript", ["-l", "JavaScript", "-e", RESTORE], {
      input,
      encoding: "utf8",
      timeout: 10000,
      maxBuffer: 4096,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return (
      !restored.error &&
      restored.status === 0 &&
      JSON.parse(restored.stdout.trim()).success === true
    );
  } catch {
    return false;
  }
}
