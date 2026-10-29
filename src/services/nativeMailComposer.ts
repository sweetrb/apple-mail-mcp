import { spawnSync } from "node:child_process";
import {
  MAX_NATIVE_CLIPBOARD_SNAPSHOT_BYTES,
  MAX_NATIVE_EDITOR_OUTPUT_BYTES,
  recoverNativeClipboard,
} from "./nativeClipboardRecovery.js";
import { randomUUID } from "node:crypto";

export interface NativeEditorResult {
  success: boolean;
  error?: string;
}

export interface NativeAuthoredBody {
  messageId: number;
  markerSubject: string;
  body: string;
  expectedSender: string;
}

/** New prose only: Mail owns the signature, quotation, and reply headers. */
export function renderNativeAuthoredBody(body: string): string {
  const entities: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  };
  return body
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map(
      (line) =>
        `<div style="font-size: inherit;">${line.replace(/[&<>"']/g, (c) => entities[c]) || "<br>"}</div>`
    )
    .join("");
}

// A fixed program, never caller-interpolated code. Payloads travel on stdin,
// not argv, shell commands, temporary files, or debug logs. No send command is
// present: the manager alone owns save/send after this bridge succeeds.
const NATIVE_EDITOR_SCRIPT = String.raw`
ObjC.import('AppKit');
ObjC.import('ApplicationServices');
ObjC.import('CoreServices');
ObjC.bindFunction('AEDeterminePermissionToAutomateTarget', ['int', ['void *', 'unsigned int', 'unsigned int', 'bool']]);
var currentStage = 'startup', focusFailure = null, targetFailure = null;
function stage(value) { currentStage = value; console.log('NATIVE_STAGE:' + value); }
function emit(record) {
  var data = $(JSON.stringify(record) + '\n').dataUsingEncoding($.NSUTF8StringEncoding);
  $.NSFileHandle.fileHandleWithStandardOutput.writeData(data);
}
function fail(code) { throw new Error(code); }
function preflight() {
  if (!$.AXIsProcessTrusted()) fail('accessibility');
  ['com.apple.mail', 'com.apple.systemevents'].forEach(function (id) {
    if (id === 'com.apple.systemevents' &&
        Number($.NSRunningApplication.runningApplicationsWithBundleIdentifier(id).count) === 0) {
      // LaunchServices launch is not an Apple Event and does not request TCC
      // permission. A stopped System Events otherwise reports procNotFound,
      // which must not be misreported as denied Automation permission.
      try {
        var workspace = $.NSWorkspace.sharedWorkspace;
        workspace.launchApplicationAtURLOptionsConfigurationError(
          workspace.URLForApplicationWithBundleIdentifier(id),
          $.NSWorkspaceLaunchWithoutActivation, $.NSDictionary.dictionary, Ref());
      } catch (_) { fail('automation-unavailable'); }
    }
    var target = $.NSAppleEventDescriptor.descriptorWithBundleIdentifier(id);
    // core/getd, askUserIfNeeded=false: never display an authorization prompt.
    var status;
    for (var attempt = 0; attempt < 12; attempt++) {
      status = $.AEDeterminePermissionToAutomateTarget(target.aeDesc, 0x636f7265, 0x67657464, false);
      if (status !== -600 || id !== 'com.apple.systemevents') break;
      if (attempt < 11) delay(0.15);
    }
    if (status === -1743 || status === -1744) fail('automation');
    if (status !== 0) fail('automation-unavailable');
  });
}
function attr(element, name) {
  try { return element.attributes.byName(name).value(); } catch (_) { return null; }
}
function descendants(root) {
  var result = [], pending = [root];
  while (pending.length) {
    var element = pending.shift();
    result.push(element);
    if (result.length > 2000) fail('target');
    try { pending = pending.concat(element.uiElements()); } catch (_) {}
  }
  return result;
}
function findMarkedComposer(process, input, checkMessage) {
  // Mail can publish the marked outgoing message before its accessibility
  // window, subject, and editor have all caught up. Retry only observations;
  // never create, click, paste, or select an unmarked or ambiguous composer.
  for (var attempt = 0; attempt < 20; attempt++) {
    checkMessage();
    stage('target-window');
    var windows = process.windows().filter(function (window) {
      // Never walk the main mailbox tree: it may contain thousands of rows.
      return window.name() === input.markerSubject;
    });
    if (windows.length !== 1) {
      targetFailure = windows.length === 0 ? 'window-missing' : 'window-ambiguous';
    } else {
      var window = windows[0], elements = descendants(window);
      var subjects = elements.filter(function (element) {
        return attr(element, 'AXIdentifier') === 'Mail.subjectField' &&
          attr(element, 'AXValue') === input.markerSubject;
      });
      if (subjects.length !== 1) {
        targetFailure = subjects.length === 0 ? 'subject-missing' : 'subject-ambiguous';
      } else {
        stage('target-body');
        var bodies = elements.filter(function (element) {
          return attr(element, 'AXRole') === 'AXWebArea' &&
            attr(element, 'AXDescription') === 'message body';
        });
        if (bodies.length === 1) {
          targetFailure = null;
          return {window: window, subject: subjects[0], body: bodies[0]};
        }
        targetFailure = bodies.length === 0 ? 'body-missing' : 'body-ambiguous';
      }
    }
    if (attempt < 19) delay(0.1);
  }
  fail('target');
}
function normalized(value) { return String(value).normalize('NFC').replace(/\s+/g, ' ').trim(); }
function verifiedInsertion(before, after, authored) {
  var oldText = normalized(before), newText = normalized(after), added = normalized(authored);
  return added.length > 0 && newText.length > oldText.length &&
    newText === normalized(added + '\n' + oldText);
}
function bodyText(body) {
  var direct = attr(body, 'AXValue');
  if (typeof direct === 'string' && direct.length) return direct;
  return descendants(body).filter(function (element) {
    var role = attr(element, 'AXRole');
    return role === 'AXStaticText' || role === 'AXTextArea';
  }).map(function (element) {
    var value = attr(element, 'AXValue');
    if (typeof value !== 'string') fail('readback');
    return value;
  }).join('\n');
}
function address(value) {
  var text = String(value).trim(), match = text.match(/<([^<>]+)>$/);
  return (match ? match[1] : text).toLowerCase();
}
function writeItems(clipboard, items) {
  var array = $.NSMutableArray.alloc.init;
  items.forEach(function (item) { array.addObject(item); });
  return clipboard.writeObjects(array);
}
function snapshotClipboard(clipboard, token) {
  var limit = ${MAX_NATIVE_CLIPBOARD_SNAPSHOT_BYTES};
  function bytes(value) { return Number($(JSON.stringify(value)).lengthOfBytesUsingEncoding($.NSUTF8StringEncoding)); }
  var originalCount = Number(clipboard.changeCount);
  var recovery = {kind: 'clipboard-recovery', items: [], originalCount: originalCount, token: token};
  var size = bytes(recovery), items = clipboard.pasteboardItems;
  for (var i = 0; i < Number(items.count); i++) {
    var item = items.objectAtIndex(i), types = item.types, recoveryTypes = [];
    var saved = $.NSPasteboardItem.alloc.init;
    size += 2 + (i ? 1 : 0); // Item brackets and comma, inside the existing [].
    if (size > limit) fail('clipboard');
    for (var j = 0; j < Number(types.count); j++) {
      var type = types.objectAtIndex(j), data = item.dataForType(type);
      // Preserve every flavor, including binary data; never silently drop a
      // lazy/unrepresentable flavor. Account for base64 before allocating it.
      if (!data) fail('clipboard');
      var entry = {type: ObjC.unwrap(type), data: ''};
      size += bytes(entry) + 4 * Math.ceil(Number(data.length) / 3) + (j ? 1 : 0);
      if (size > limit) fail('clipboard');
      if (!saved.setDataForType(data, type)) fail('clipboard');
      entry.data = ObjC.unwrap(data.base64EncodedStringWithOptions(0));
      recoveryTypes.push(entry);
    }
    recovery.items.push(recoveryTypes);
  }
  if (Number(clipboard.changeCount) !== originalCount || bytes(recovery) > limit) fail('clipboard');
  return recovery;
}
function main(input) {
  stage('preflight');
  preflight();
  if (input.operation === 'preflight') return;
  var mail = Application('com.apple.mail');
  var events = Application('com.apple.systemevents');
  var process = events.processes.byName('Mail');
  function checkMessage() {
    var messages = mail.outgoingMessages().filter(function (m) {
      return m.id() === input.messageId;
    });
    if (messages.length !== 1 || messages[0].subject() !== input.markerSubject ||
        address(messages[0].sender()) !== address(input.expectedSender)) fail('identity');
  }
  stage('identity');
  checkMessage();
  var target = findMarkedComposer(process, input, checkMessage);
  var window = target.window, subject = target.subject, body = target.body;
  stage('focus');
  process.frontmost = true;
  window.attributes.byName('AXMain').value = true;
  for (var ready = 0; ready < 20; ready++) {
    if (process.frontmost() && attr(window, 'AXMain') === true) break;
    delay(0.1);
  }
  // Mail reports AXFocused=false on the editor even when it owns focus.
  // Click the exact AX element, then inspect the application's focused element.
  // AXPress on Mail's WebArea is a no-op on some macOS versions. Click inside
  // the verified editor's live bounds, then verify actual keyboard focus.
  // Empty composers can place a floating Siri writing control at the body's
  // top-left corner. Focus at the center; Cmd+Up below sets insertion to start.
  var position = attr(body, 'AXPosition'), size = attr(body, 'AXSize');
  if (!position || !size || size[0] < 20 || size[1] < 20 ||
      !process.frontmost() || attr(window, 'AXMain') !== true) fail('focus');
  var point = {x: position[0] + size[0] / 2, y: position[1] + size[1] / 2};
  var down = $.CGEventCreateMouseEvent(null, 1, point, 0);
  var up = $.CGEventCreateMouseEvent(null, 2, point, 0);
  $.CGEventPost(0, down);
  $.CGEventPost(0, up);
  function checkFocus() {
    checkMessage();
    // AX updates are asynchronous. Retry the read-only coherent snapshot, not
    // clicks, key events, clipboard writes, or insertion.
    for (var focusAttempt = 0; focusAttempt < 3; focusAttempt++) {
      var focused = attr(process, 'AXFocusedUIElement');
      var focusedWindow = focused ? attr(focused, 'AXWindow') : null;
      focusFailure = !process.frontmost() ? 'foreground'
        : attr(window, 'AXMain') !== true ? 'main-window'
        : !focused ? 'missing-element'
        : attr(focused, 'AXRole') !== 'AXWebArea' ? 'role'
        : attr(focused, 'AXDescription') !== 'message body' ? 'description'
        : !focusedWindow || attr(focusedWindow, 'AXTitle') !== input.markerSubject ? 'focused-window'
        : JSON.stringify(attr(focused, 'AXPosition')) !== JSON.stringify(attr(body, 'AXPosition')) ? 'position'
        : JSON.stringify(attr(focused, 'AXSize')) !== JSON.stringify(attr(body, 'AXSize')) ? 'size'
        : window.name() !== input.markerSubject ? 'window-title'
        : attr(subject, 'AXValue') !== input.markerSubject ? 'subject' : null;
      if (!focusFailure) return;
      if (focusAttempt < 2) delay(0.1);
    }
    console.log('NATIVE_FOCUS:' + focusFailure);
    fail('focus');
  }
  checkFocus();
  if (!normalized(input.body)) return;
  var beforeText = bodyText(body);
  stage('clipboard-snapshot');
  var clipboard = $.NSPasteboard.generalPasteboard;
  var recovery = snapshotClipboard(clipboard, input.recoveryToken);
  var originalCount = recovery.originalCount;
  emit(recovery);
  var ownedCount = null;
  {
    stage('clipboard-write');
    var authored = $.NSPasteboardItem.alloc.init;
    if (!authored.setStringForType(input.html, $.NSPasteboardTypeHTML) ||
        !authored.setStringForType(input.body, $.NSPasteboardTypeString) ||
        !authored.setStringForType('', 'org.nspasteboard.TransientType') ||
        !authored.setStringForType('', 'org.nspasteboard.AutoGeneratedType') ||
        !authored.setStringForType(input.recoveryToken, 'org.apple-mail-mcp.native-composition')) fail('clipboard');
    if (Number(clipboard.changeCount) !== originalCount) fail('clipboard');
    clipboard.clearContents;
    ownedCount = Number(clipboard.changeCount);
    emit({kind: 'clipboard-cleared', count: ownedCount});
    var wrote = writeItems(clipboard, [authored]);
    ownedCount = Number(clipboard.changeCount);
    emit({kind: 'clipboard-owned', count: ownedCount});
    if (!wrote) fail('clipboard');
    if (ObjC.unwrap(clipboard.stringForType($.NSPasteboardTypeHTML)) !== input.html ||
        ObjC.unwrap(clipboard.stringForType($.NSPasteboardTypeString)) !== input.body) fail('clipboard');
    stage('pre-cmd-up');
    checkFocus();
    events.keyCode(126, {using: ['command down']});
    stage('post-cmd-up');
    checkFocus();
    if (Number(clipboard.changeCount) !== ownedCount) fail('clipboard');
    stage('paste');
    events.keyCode(9, {using: ['command down']});
    // UI dispatch may finish before AX updates. Wait once, never paste twice.
    delay(0.3);
    stage('readback');
    checkFocus();
    if (Number(clipboard.changeCount) !== ownedCount) fail('clipboard');
    if (!verifiedInsertion(beforeText, bodyText(body), input.body)) fail('readback');
  }
  // The parent owns restoration, including after a timeout. A child cannot
  // safely recover from being killed halfway through its own restoration.
}
try {
  var data = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
  var text = $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding).js;
  main(JSON.parse(text));
  JSON.stringify({success: true});
} catch (error) {
  var allowed = ['accessibility', 'automation', 'automation-unavailable', 'identity', 'target', 'focus', 'clipboard', 'restore', 'readback', 'paste-unavailable'];
  JSON.stringify({success: false, code: allowed.indexOf(error.message) >= 0 ? error.message : 'bridge',
    stage: currentStage, focus: focusFailure || undefined, target: targetFailure || undefined,
    runtime: typeof error.errorNumber === 'number' ? error.errorNumber : undefined});
}
`;

const ERRORS: Record<string, string> = {
  accessibility:
    "Native Mail composition requires existing Accessibility permission for this runtime; no permission was requested.",
  automation:
    "Native Mail composition requires existing Automation permission for Mail and System Events; no permission was requested.",
  "automation-unavailable":
    "Native Mail composition could not contact Mail or start System Events; this does not establish a permission denial. Nothing was sent.",
  identity: "Native Mail composition refused an unexpected message, subject, or sender.",
  target:
    "Native Mail composition could not identify exactly one marked composer and message body.",
  focus: "Native Mail composition lost the verified composer or body focus; nothing was sent.",
  clipboard:
    "Native Mail composition stopped because the clipboard could not be preserved or changed unexpectedly.",
  restore: "Native Mail composition could not restore the previous clipboard; nothing was sent.",
  "paste-unavailable":
    "Mail's Paste command is unavailable for the verified editor; nothing was sent.",
  readback: "Native Mail composition could not verify the inserted prose; nothing was sent.",
  bridge:
    "Native Mail composition failed; nothing was sent. Inspect the marked draft and clipboard before retrying.",
};

function runNativeEditor(payload: Record<string, unknown>): NativeEditorResult {
  try {
    const result = spawnSync(
      "/usr/bin/osascript",
      ["-l", "JavaScript", "-e", NATIVE_EDITOR_SCRIPT],
      {
        input: JSON.stringify(payload),
        encoding: "utf8",
        timeout: 15000,
        killSignal: "SIGKILL",
        maxBuffer: MAX_NATIVE_EDITOR_OUTPUT_BYTES,
        stdio: ["pipe", "pipe", "pipe"],
      }
    );
    if (!recoverNativeClipboard(result.stdout ?? "", payload.recoveryToken)) {
      return { success: false, error: ERRORS.restore };
    }
    if (result.error || result.status !== 0) {
      const stages = [...(result.stderr ?? "").matchAll(/NATIVE_STAGE:([a-z-]+)/g)];
      const stage = stages.at(-1)?.[1];
      const timedOut = result.error && "code" in result.error && result.error.code === "ETIMEDOUT";
      return {
        success: false,
        error: ERRORS.bridge + diagnostic(stage, timedOut ? "timeout" : undefined),
      };
    }
    const response = JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "");
    return response.success === true
      ? { success: true }
      : {
          success: false,
          error:
            (ERRORS[response.code] ?? ERRORS.bridge) +
            diagnostic(response.stage, response.runtime, response.focus, response.target),
        };
  } catch {
    return { success: false, error: ERRORS.bridge };
  }
}

function diagnostic(stage: unknown, runtime: unknown, focus?: unknown, target?: unknown): string {
  const stages = [
    "startup",
    "preflight",
    "identity",
    "target-window",
    "target-body",
    "focus",
    "clipboard-snapshot",
    "clipboard-write",
    "pre-cmd-up",
    "post-cmd-up",
    "paste",
    "readback",
    "clipboard-restore",
  ];
  if (typeof stage !== "string" || !stages.includes(stage)) return "";
  const detail =
    runtime === "timeout" || (typeof runtime === "number" && Number.isInteger(runtime))
      ? `; runtime=${runtime}`
      : "";
  const focusDetail =
    typeof focus === "string" &&
    [
      "foreground",
      "main-window",
      "missing-element",
      "role",
      "description",
      "focused-window",
      "position",
      "size",
      "window-title",
      "subject",
    ].includes(focus)
      ? `; focus=${focus}`
      : "";
  const targetDetail =
    typeof target === "string" &&
    [
      "window-missing",
      "window-ambiguous",
      "subject-missing",
      "subject-ambiguous",
      "body-missing",
      "body-ambiguous",
    ].includes(target)
      ? `; target=${target}`
      : "";
  return ` [stage=${stage}${detail}${focusDetail}${targetDetail}]`;
}

export function nativeEditorPreflight(): NativeEditorResult {
  return runNativeEditor({ operation: "preflight" });
}

export function insertNativeAuthoredBody(input: NativeAuthoredBody): NativeEditorResult {
  if (
    !Number.isSafeInteger(input.messageId) ||
    input.messageId < 0 ||
    typeof input.markerSubject !== "string" ||
    !input.markerSubject ||
    typeof input.expectedSender !== "string" ||
    !input.expectedSender ||
    typeof input.body !== "string"
  ) {
    return { success: false, error: ERRORS.identity };
  }
  const body = input.body.normalize("NFC").replace(/\r\n?/g, "\n");
  return runNativeEditor({
    ...input,
    body,
    recoveryToken: randomUUID(),
    operation: "insert",
    html: renderNativeAuthoredBody(body),
  });
}
