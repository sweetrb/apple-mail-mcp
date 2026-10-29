import { beforeEach, describe, expect, it, vi } from "vitest";
import { runInNewContext } from "node:vm";

const h = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("node:child_process", () => ({ spawnSync: h.run }));

import {
  insertNativeAuthoredBody,
  nativeEditorPreflight,
  renderNativeAuthoredBody,
} from "./nativeMailComposer.js";
import {
  MAX_NATIVE_CLIPBOARD_SNAPSHOT_BYTES,
  MAX_NATIVE_EDITOR_OUTPUT_BYTES,
  recoverNativeClipboard,
} from "./nativeClipboardRecovery.js";

const input = {
  messageId: 42,
  markerSubject: "native-compose-unique-marker",
  expectedSender: "owner@example.com",
  body: "Private prose — ã, ç, œ, 中文\n\nNext paragraph.",
};

beforeEach(() => {
  h.run.mockReset();
  h.run.mockReturnValue({ status: 0, stdout: '{"success":true}', stderr: "" });
});

describe("native authored HTML", () => {
  it("escapes markup, normalizes NFC and line endings, and preserves blank paragraphs", () => {
    expect(renderNativeAuthoredBody("a\u0303 & <b>\"'\r\n\r\n中文 œ $&")).toBe(
      '<div style="font-size: inherit;">ã &amp; &lt;b&gt;&quot;&#39;</div>' +
        '<div style="font-size: inherit;"><br></div>' +
        '<div style="font-size: inherit;">中文 œ $&amp;</div>'
    );
  });

  it("does not inject a fixed size, font, quotation, or signature", () => {
    const html = renderNativeAuthoredBody("One\n");
    expect(html).not.toMatch(/px|pt|blockquote|font-family|AppleMailSignature/);
    expect(html).toBe(
      '<div style="font-size: inherit;">One</div><div style="font-size: inherit;"><br></div>'
    );
  });
});

describe("native editor process contract (no live UI)", () => {
  it.each([false, true])(
    "starts stopped System Events without prompting and bounds startup (unavailable=%s)",
    (unavailable) => {
      nativeEditorPreflight();
      const script = h.run.mock.calls[0][1][3];
      const launch = vi.fn();
      const wait = vi.fn();
      let checks = 0;
      const output = runInNewContext(script, {
        ObjC: { import: () => undefined, bindFunction: () => undefined },
        Ref: () => "error-reference",
        delay: wait,
        $: {
          AXIsProcessTrusted: () => true,
          AEDeterminePermissionToAutomateTarget: (id: string) => {
            if (id === "com.apple.mail") return 0;
            checks++;
            return unavailable || checks < 3 ? -600 : 0;
          },
          NSRunningApplication: { runningApplicationsWithBundleIdentifier: () => ({ count: 0 }) },
          NSWorkspace: {
            sharedWorkspace: {
              URLForApplicationWithBundleIdentifier: (id: string) => id,
              launchApplicationAtURLOptionsConfigurationError: launch,
            },
          },
          NSWorkspaceLaunchWithoutActivation: 512,
          NSDictionary: { dictionary: {} },
          NSAppleEventDescriptor: {
            descriptorWithBundleIdentifier: (id: string) => ({ aeDesc: id }),
          },
          NSFileHandle: { fileHandleWithStandardInput: { readDataToEndOfFile: "stdin" } },
          NSString: {
            alloc: { initWithDataEncoding: () => ({ js: '{"operation":"preflight"}' }) },
          },
          NSUTF8StringEncoding: 4,
        },
      });
      expect(JSON.parse(output)).toEqual(
        unavailable
          ? { success: false, code: "automation-unavailable", stage: "preflight" }
          : { success: true }
      );
      expect(launch).toHaveBeenCalledOnce();
      expect(launch).toHaveBeenCalledWith("com.apple.systemevents", 512, {}, "error-reference");
      expect(checks).toBe(unavailable ? 12 : 3);
      expect(wait).toHaveBeenCalledTimes(unavailable ? 11 : 2);
    }
  );

  it.each([
    { trusted: false, permission: 0, code: "accessibility" },
    { trusted: true, permission: -1743, code: "automation" },
    { trusted: true, permission: -1744, code: "automation" },
    { trusted: true, permission: -600, code: "automation-unavailable" },
    { trusted: true, permission: 0, code: undefined },
  ])(
    "executes permission gates before any application/UI access: $code",
    ({ trusted, permission, code }) => {
      nativeEditorPreflight();
      const script = h.run.mock.calls[0][1][3];
      const application = vi.fn(() => {
        throw new Error("Unexpected UI access");
      });
      const permissionCheck = vi.fn(() => permission);
      const output = runInNewContext(script, {
        ObjC: { import: () => undefined, bindFunction: () => undefined },
        $: {
          AXIsProcessTrusted: () => trusted,
          AEDeterminePermissionToAutomateTarget: permissionCheck,
          NSRunningApplication: { runningApplicationsWithBundleIdentifier: () => ({ count: 1 }) },
          NSAppleEventDescriptor: {
            descriptorWithBundleIdentifier: (id: string) => ({ aeDesc: id }),
          },
          NSFileHandle: { fileHandleWithStandardInput: { readDataToEndOfFile: "stdin" } },
          NSString: {
            alloc: { initWithDataEncoding: () => ({ js: '{"operation":"preflight"}' }) },
          },
          NSUTF8StringEncoding: 4,
        },
        Application: application,
      });
      expect(JSON.parse(output)).toEqual(
        code ? { success: false, code, stage: "preflight" } : { success: true }
      );
      expect(application).not.toHaveBeenCalled();
      if (trusted) {
        expect(permissionCheck).toHaveBeenCalledWith(
          "com.apple.mail",
          0x636f7265,
          0x67657464,
          false
        );
      }
    }
  );

  it("preflights without an insertion payload and without requesting permissions", () => {
    expect(nativeEditorPreflight()).toEqual({ success: true });
    const [command, argv, options] = h.run.mock.calls[0];
    expect(command).toBe("/usr/bin/osascript");
    expect(argv.slice(0, 3)).toEqual(["-l", "JavaScript", "-e"]);
    expect(JSON.parse(options.input)).toEqual({ operation: "preflight" });
    expect(argv[3]).toContain("$.AXIsProcessTrusted()");
    expect(argv[3]).toContain("0x636f7265, 0x67657464, false");
    expect(argv[3]).toContain("if (input.operation === 'preflight') return;");
    expect(argv[3]).not.toContain("AXIsProcessTrustedWithOptions");
  });

  it("passes caller prose only on stdin and bounds the single subprocess attempt", () => {
    expect(insertNativeAuthoredBody(input)).toEqual({ success: true });
    expect(h.run).toHaveBeenCalledTimes(1);
    const [, argv, options] = h.run.mock.calls[0];
    expect(JSON.stringify(argv)).not.toContain(input.body);
    expect(JSON.stringify(argv)).not.toContain(input.expectedSender);
    expect(options).toMatchObject({
      timeout: 15000,
      killSignal: "SIGKILL",
      maxBuffer: MAX_NATIVE_EDITOR_OUTPUT_BYTES,
    });
    expect(MAX_NATIVE_EDITOR_OUTPUT_BYTES).toBeGreaterThan(MAX_NATIVE_CLIPBOARD_SNAPSHOT_BYTES);
    expect(JSON.parse(options.input)).toEqual({
      ...input,
      operation: "insert",
      recoveryToken: expect.any(String),
      html: renderNativeAuthoredBody(input.body),
    });
  });

  it("pins identity, unique body targeting, focus, clipboard ownership, and readback gates", () => {
    insertNativeAuthoredBody(input);
    const script = h.run.mock.calls[0][1][3];
    expect(script).toContain("m.id() === input.messageId");
    expect(script).toContain("messages[0].subject() !== input.markerSubject");
    expect(script).toContain("address(messages[0].sender()) !== address(input.expectedSender)");
    expect(script).toContain("windows.length !== 1");
    expect(script).toContain("return window.name() === input.markerSubject");
    expect(script).toContain("bodies.length === 1");
    expect(script).toContain("=== 'AXWebArea'");
    expect(script).toContain("=== 'message body'");
    expect(script).toContain("$.CGEventCreateMouseEvent(null, 1, point, 0)");
    expect(script).toContain("position[0] + size[0] / 2");
    expect(script).toContain("org.nspasteboard.TransientType");
    expect(script).toContain("org.nspasteboard.AutoGeneratedType");
    expect(script).toContain("attr(process, 'AXFocusedUIElement')");
    expect(script).toContain("attr(focusedWindow, 'AXTitle') !== input.markerSubject");
    expect(script).toContain("focusAttempt < 3");
    expect(script).toContain("delay(0.1)");
    expect(script).toContain("stage('pre-cmd-up')");
    expect(script).toContain("stage('post-cmd-up')");
    expect(script).toContain("if (Number(clipboard.changeCount) !== ownedCount) fail('clipboard')");
    expect(script).toContain("item.dataForType(type)");
    expect(script).toContain("verifiedInsertion(beforeText, bodyText(body), input.body)");
    expect(script.match(/events\.keyCode\(9,/g)).toHaveLength(1);
    expect(script).not.toMatch(/\.send\(|set content|keyCode\(48|click\(\{/);
  });

  it("waits for the uniquely marked window, subject, and body to appear before returning", () => {
    insertNativeAuthoredBody(input);
    const script = h.run.mock.calls[0][1][3];
    const helper = script.slice(
      script.indexOf("function findMarkedComposer"),
      script.indexOf("function normalized")
    );
    const subject = { AXIdentifier: "Mail.subjectField", AXValue: input.markerSubject };
    const body = { AXRole: "AXWebArea", AXDescription: "message body" };
    const win = (elements: unknown[]) => ({ name: () => input.markerSubject, elements });
    const finalWindow = win([subject, body]);
    const observations = [[], [win([])], [win([subject])], [finalWindow]];
    let current = 0;
    const checkMessage = vi.fn();
    const delay = vi.fn();
    const result = runInNewContext(`${helper}\nfindMarkedComposer(process, input, checkMessage);`, {
      process: { windows: () => observations[current++] },
      input,
      checkMessage,
      delay,
      stage: vi.fn(),
      descendants: (window: { elements: unknown[] }) => window.elements,
      attr: (element: Record<string, unknown>, key: string) => element[key] ?? null,
      fail: (code: string) => {
        throw new Error(code);
      },
      targetFailure: null,
    });
    expect(result.window).toBe(finalWindow);
    expect(result.subject).toBe(subject);
    expect(result.body).toBe(body);
    expect(checkMessage).toHaveBeenCalledTimes(4);
    expect(delay).toHaveBeenCalledTimes(3);
  });

  it.each([
    "window-missing",
    "window-ambiguous",
    "subject-missing",
    "subject-ambiguous",
    "body-missing",
    "body-ambiguous",
  ])("fails closed after bounded observations when the target is %s", (reason) => {
    insertNativeAuthoredBody(input);
    const script = h.run.mock.calls[0][1][3];
    const helper = script.slice(
      script.indexOf("function findMarkedComposer"),
      script.indexOf("function normalized")
    );
    const subject = { AXIdentifier: "Mail.subjectField", AXValue: input.markerSubject };
    const body = { AXRole: "AXWebArea", AXDescription: "message body" };
    const elements =
      reason === "subject-missing"
        ? []
        : reason === "subject-ambiguous"
          ? [subject, subject]
          : reason === "body-missing"
            ? [subject]
            : reason === "body-ambiguous"
              ? [subject, body, body]
              : [subject, body];
    const window = { name: () => input.markerSubject, elements };
    const windows =
      reason === "window-missing"
        ? []
        : reason === "window-ambiguous"
          ? [window, window]
          : [window];
    const checkMessage = vi.fn();
    const delay = vi.fn();
    const context = {
      process: { windows: () => windows },
      input,
      checkMessage,
      delay,
      stage: vi.fn(),
      descendants: (item: { elements: unknown[] }) => item.elements,
      attr: (element: Record<string, unknown>, key: string) => element[key] ?? null,
      fail: (code: string) => {
        throw new Error(code);
      },
      targetFailure: null as string | null,
    };
    expect(() =>
      runInNewContext(`${helper}\nfindMarkedComposer(process, input, checkMessage);`, context)
    ).toThrow("target");
    expect(context.targetFailure).toBe(reason);
    expect(checkMessage).toHaveBeenCalledTimes(20);
    expect(delay).toHaveBeenCalledTimes(19);
  });

  it("stops waiting if the outgoing message identity changes", () => {
    insertNativeAuthoredBody(input);
    const script = h.run.mock.calls[0][1][3];
    const helper = script.slice(
      script.indexOf("function findMarkedComposer"),
      script.indexOf("function normalized")
    );
    const checkMessage = vi
      .fn()
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => {
        throw new Error("identity");
      });
    expect(() =>
      runInNewContext(`${helper}\nfindMarkedComposer(process, input, checkMessage);`, {
        process: { windows: () => [] },
        input,
        checkMessage,
        delay: vi.fn(),
        stage: vi.fn(),
        targetFailure: null,
      })
    ).toThrow("identity");
    expect(checkMessage).toHaveBeenCalledTimes(2);
  });

  it.each([
    { position: [100, 200], size: [600, 400], expected: { x: 400, y: 400 } },
    { position: [-1200, 50], size: [800, 600], expected: { x: -800, y: 350 } },
    { position: [0, 0], size: [20, 20], expected: { x: 10, y: 10 } },
  ])(
    "focuses the verified body interior instead of its top-left affordance: $position",
    (fixture) => {
      nativeEditorPreflight();
      const script = h.run.mock.calls[0][1][3];
      const geometry = script.slice(
        script.indexOf("  var position = attr(body, 'AXPosition')"),
        script.indexOf("  var down = $.CGEventCreateMouseEvent")
      );
      const point = runInNewContext(geometry + "\npoint;", {
        body: {},
        window: {},
        process: { frontmost: () => true },
        attr: (_element: unknown, name: string) =>
          name === "AXPosition" ? fixture.position : name === "AXSize" ? fixture.size : true,
        fail: (code: string) => {
          throw new Error(code);
        },
      });
      expect(point).toEqual(fixture.expected);
      expect(point.x).toBeGreaterThan(fixture.position[0]);
      expect(point.x).toBeLessThan(fixture.position[0] + fixture.size[0]);
      expect(point.y).toBeGreaterThan(fixture.position[1]);
      expect(point.y).toBeLessThan(fixture.position[1] + fixture.size[1]);
      // Centering must not change the insertion destination or paste ordering.
      expect(script.indexOf("events.keyCode(126, {using: ['command down']})")).toBeLessThan(
        script.indexOf("events.keyCode(9, {using: ['command down']})")
      );
    }
  );

  it.skipIf(process.platform !== "darwin")(
    "round-trips real pasteboard items through the production ObjC array helper",
    async () => {
      // Named, disposable pasteboard only. Never reads/writes generalPasteboard,
      // launches Mail, or requires computer-control permissions.
      nativeEditorPreflight();
      const script = h.run.mock.calls[0][1][3];
      const helper = script.slice(
        script.indexOf("function writeItems"),
        script.indexOf("function main")
      );
      const program = `ObjC.import('AppKit');
${helper}
var board = $.NSPasteboard.pasteboardWithName('org.apple-mail-mcp.tests.' + ObjC.unwrap($.NSUUID.UUID.UUIDString));
var result;
try {
  var first = $.NSPasteboardItem.alloc.init;
  first.setStringForType('ã ç œ 中文 $&', $.NSPasteboardTypeString);
  first.setStringForType('<div>ã ç œ 中文 $&amp;</div>', $.NSPasteboardTypeHTML);
  var second = $.NSPasteboardItem.alloc.init;
  second.setDataForType($.NSData.alloc.initWithBase64EncodedStringOptions('AAECA/8=', 0), 'org.apple-mail-mcp.tests.binary');
  board.clearContents;
  var accepted = writeItems(board, [first, second]);
  var items = board.pasteboardItems;
  result = {
    accepted: Boolean(accepted), count: Number(items.count),
    textMatches: ObjC.unwrap(board.stringForType($.NSPasteboardTypeString)) === 'ã ç œ 中文 $&',
    htmlMatches: ObjC.unwrap(board.stringForType($.NSPasteboardTypeHTML)) === '<div>ã ç œ 中文 $&amp;</div>',
    binaryMatches: Number(items.count) === 2 && ObjC.unwrap(items.objectAtIndex(1).dataForType('org.apple-mail-mcp.tests.binary').base64EncodedStringWithOptions(0)) === 'AAECA/8='
  };
} finally { board.releaseGlobally; }
JSON.stringify(result);`;
      const { execFileSync } =
        await vi.importActual<typeof import("node:child_process")>("node:child_process");
      const output = execFileSync("/usr/bin/osascript", ["-l", "JavaScript", "-e", program], {
        encoding: "utf8",
        timeout: 10000,
      });
      expect(JSON.parse(output)).toEqual({
        accepted: true,
        count: 2,
        textMatches: true,
        htmlMatches: true,
        binaryMatches: true,
      });
    }
  );

  it.each([
    ["expected HTML", "expected text", false],
    [null, null, true],
    ["wrong HTML", "expected text", true],
    ["expected HTML", "wrong text", true],
  ])("executes production immediate clipboard readback guard", (html, text, shouldFail) => {
    nativeEditorPreflight();
    const script = h.run.mock.calls[0][1][3];
    const guard = script.slice(
      script.indexOf("    if (ObjC.unwrap(clipboard.stringForType"),
      script.indexOf("    stage('pre-cmd-up')")
    );
    expect(guard).toContain("fail('clipboard')");
    const run = () =>
      runInNewContext(guard, {
        ObjC: { unwrap: (value: unknown) => value },
        $: { NSPasteboardTypeHTML: "html", NSPasteboardTypeString: "text" },
        clipboard: { stringForType: (type: string) => (type === "html" ? html : text) },
        input: { html: "expected HTML", body: "expected text" },
        fail: (code: string) => {
          throw new Error(code);
        },
      });
    if (shouldFail) expect(run).toThrow("clipboard");
    else expect(run).not.toThrow();
  });

  it.skipIf(process.platform !== "darwin")(
    "recovers a screenshot-sized, multi-flavor snapshot on a disposable named pasteboard",
    async () => {
      nativeEditorPreflight();
      const script = h.run.mock.calls[0][1][3];
      const helper = script.slice(
        script.indexOf("function writeItems"),
        script.indexOf("function main")
      );
      const { execFileSync, spawnSync } =
        await vi.importActual<typeof import("node:child_process")>("node:child_process");
      const name = `org.apple-mail-mcp.tests.large.${crypto.randomUUID()}`;
      const board = `$.NSPasteboard.pasteboardWithName(${JSON.stringify(name)})`;
      const execute = (program: string) =>
        execFileSync("/usr/bin/osascript", ["-l", "JavaScript", "-e", program], {
          encoding: "utf8",
          timeout: 10000,
          maxBuffer: MAX_NATIVE_EDITOR_OUTPUT_BYTES,
        });
      try {
        const output = execute(`ObjC.import('AppKit');
${helper}
function fail(code) { throw new Error(code); }
var board = ${board};
var item = $.NSPasteboardItem.alloc.init;
item.setDataForType($.NSMutableData.dataWithLength(888084), 'public.png');
item.setStringForType('file:///synthetic-fixture.png', 'public.file-url');
board.clearContents;
if (!writeItems(board, [item])) fail('fixture');
var recovery = snapshotClipboard(board, 'test-token');
var records = [recovery];
board.clearContents;
records.push({kind: 'clipboard-cleared', count: Number(board.changeCount)});
var authored = $.NSPasteboardItem.alloc.init;
authored.setStringForType('test-token', 'org.apple-mail-mcp.native-composition');
if (!writeItems(board, [authored])) fail('fixture');
records.push({kind: 'clipboard-owned', count: Number(board.changeCount)});
records.map(function (record) { return JSON.stringify(record); }).join('\\n');`);
        expect(Buffer.byteLength(output)).toBeGreaterThan(1048576);
        // Execute the unchanged production recovery against only our named
        // board. Fixture bytes stay in memory/stdin, never argv or temp files.
        h.run.mockImplementation((command, argv, options) =>
          spawnSync(
            command,
            argv.map((value: string) => value.replace("$.NSPasteboard.generalPasteboard", board)),
            options
          )
        );
        expect(recoverNativeClipboard(output, "test-token")).toBe(true);
        const verified = execute(`ObjC.import('AppKit');
var board = ${board}, items = board.pasteboardItems, item = items.objectAtIndex(0);
var bytes = item.dataForType('public.png');
JSON.stringify({count: Number(items.count), types: ObjC.deepUnwrap(item.types).sort(),
  binaryMatches: Boolean(bytes.isEqualToData($.NSMutableData.dataWithLength(888084))),
  urlMatches: ObjC.unwrap(item.stringForType('public.file-url')) === 'file:///synthetic-fixture.png'});`);
        expect(JSON.parse(verified)).toEqual({
          count: 1,
          types: ["public.file-url", "public.png"],
          binaryMatches: true,
          urlMatches: true,
        });
      } finally {
        execute(`ObjC.import('AppKit'); ${board}.releaseGlobally; 'released';`);
      }
    }
  );

  it.each([
    { bytes: 888084, encodedCalls: 2, fails: false, label: "ordinary screenshot" },
    {
      bytes: MAX_NATIVE_CLIPBOARD_SNAPSHOT_BYTES,
      encodedCalls: 0,
      fails: true,
      label: "oversized single flavor",
    },
    {
      bytes: 30 * 1024 * 1024,
      encodedCalls: 1,
      fails: true,
      label: "oversized aggregate across flavors",
    },
  ])(
    "bounds production snapshot encoding before allocating base64: $label",
    ({ bytes, encodedCalls, fails }) => {
      nativeEditorPreflight();
      const script = h.run.mock.calls[0][1][3];
      const helper = script.slice(
        script.indexOf("function snapshotClipboard"),
        script.indexOf("function main")
      );
      const encoded = Buffer.alloc(888084).toString("base64");
      const encode = vi.fn(() => encoded);
      const data = {
        length: bytes,
        base64EncodedStringWithOptions: encode,
      };
      const clipboard = {
        changeCount: 2,
        pasteboardItems: {
          count: 1,
          objectAtIndex: () => ({
            types: { count: 2, objectAtIndex: (i: number) => ["public.png", "test/ã"][i] },
            dataForType: () => data,
          }),
        },
      };
      const run = () =>
        runInNewContext(helper + "\nsnapshotClipboard(clipboard, 'test-token')", {
          clipboard,
          ObjC: { unwrap: (value: unknown) => value },
          $: Object.assign(
            (text: string) => ({
              lengthOfBytesUsingEncoding: () => Buffer.byteLength(text, "utf8"),
            }),
            {
              NSUTF8StringEncoding: 4,
              NSPasteboardItem: { alloc: { init: { setDataForType: () => true } } },
            }
          ),
          fail: (code: string) => {
            throw new Error(code);
          },
        });
      if (fails) {
        expect(run).toThrow("clipboard");
      } else {
        const recovery = run();
        expect(Buffer.byteLength(JSON.stringify(recovery))).toBeGreaterThan(1048576);
        expect(recovery.items[0]).toEqual([
          { type: "public.png", data: encoded },
          { type: "test/ã", data: encoded },
        ]);
      }
      expect(encode).toHaveBeenCalledTimes(encodedCalls);
    }
  );

  it.each([
    ["Old history", "New prose\nOld history", "New prose", true],
    ["New prose already quoted", "New prose already quoted", "New prose", false],
    ["Old history", "New prose", "New prose", false],
    ["Old history", "New prose\nNew prose\nOld history", "New prose", false],
    ["Old history", "New prose\nDifferent history", "New prose", false],
    ["Old history", "Old history\nNew prose", "New prose", false],
    ["", "New prose", "New prose", true],
  ])(
    "verifies exact authored prefix and unchanged native suffix",
    (before, after, authored, expected) => {
      insertNativeAuthoredBody(input);
      const script = h.run.mock.calls[0][1][3];
      const logic = script.slice(
        script.indexOf("function normalized"),
        script.indexOf("function address")
      );
      expect(
        runInNewContext(logic + ";verifiedInsertion(before, after, authored)", {
          before,
          after,
          authored,
        })
      ).toBe(expected);
    }
  );

  it.each(["", "   \n"])("leaves native history untouched when a forward has no prose", (body) => {
    insertNativeAuthoredBody(input);
    const script = h.run.mock.calls[0][1][3];
    const start = script.indexOf("if (!normalized(input.body)) return;");
    const guard = script.slice(start, script.indexOf("var beforeText", start));
    expect(start).toBeGreaterThan(script.indexOf("checkFocus();"));
    expect(start).toBeLessThan(script.indexOf("stage('clipboard-snapshot')"));
    const result = runInNewContext(`(function(){${guard}; return 'would-insert';})()`, {
      input: { body },
      normalized: (s: string) => s.trim(),
    });
    expect(result).toBeUndefined();
  });

  it.each([
    "accessibility",
    "automation",
    "automation-unavailable",
    "identity",
    "target",
    "focus",
    "clipboard",
    "restore",
    "readback",
  ])("returns sanitized %s errors without fallback or retry", (code) => {
    h.run.mockReturnValue({ status: 0, stdout: JSON.stringify({ success: false, code }) });
    const result = insertNativeAuthoredBody(input);
    expect(result.success).toBe(false);
    expect(result.error).not.toContain(input.body);
    expect(result.error).not.toContain(input.expectedSender);
    expect(h.run).toHaveBeenCalledTimes(1);
  });

  it.each([
    { status: null, error: new Error("private body"), stdout: "" },
    { status: 1, stdout: "", stderr: "private body" },
    { status: 0, stdout: "not JSON private body" },
    { status: 0, stdout: '{"success":false,"code":"private body"}' },
  ])("fails closed for process and protocol failures", (result) => {
    h.run.mockReturnValue(result);
    expect(insertNativeAuthoredBody(input)).toEqual({
      success: false,
      error:
        "Native Mail composition failed; nothing was sent. Inspect the marked draft and clipboard before retrying.",
    });
    expect(h.run).toHaveBeenCalledTimes(1);
  });

  it("reports sanitized runtime stage and number without arbitrary exception details", () => {
    h.run.mockReturnValue({
      status: 0,
      stdout: JSON.stringify({
        success: false,
        code: "bridge",
        stage: "focus",
        runtime: -1728,
        privateDetail: input.body,
      }),
    });
    const result = insertNativeAuthoredBody(input);
    expect(result.error).toContain("[stage=focus; runtime=-1728]");
    expect(result.error).not.toContain(input.body);
  });

  it("reports only enumerated focus failures without echoing arbitrary content", () => {
    h.run.mockReturnValue({
      status: 0,
      stdout: JSON.stringify({
        success: false,
        code: "focus",
        stage: "post-cmd-up",
        focus: "role",
      }),
    });
    expect(insertNativeAuthoredBody(input).error).toContain("[stage=post-cmd-up; focus=role]");
    h.run.mockReturnValue({
      status: 0,
      stdout: JSON.stringify({
        success: false,
        code: "focus",
        stage: "post-cmd-up",
        focus: input.body,
      }),
    });
    expect(insertNativeAuthoredBody(input).error).not.toContain(input.body);
  });

  it("reports only enumerated target failures without echoing arbitrary content", () => {
    h.run.mockReturnValue({
      status: 0,
      stdout: JSON.stringify({
        success: false,
        code: "target",
        stage: "target-window",
        target: "subject-missing",
      }),
    });
    expect(insertNativeAuthoredBody(input).error).toContain(
      "[stage=target-window; target=subject-missing]"
    );
    h.run.mockReturnValue({
      status: 0,
      stdout: JSON.stringify({
        success: false,
        code: "target",
        stage: "target-window",
        target: input.body,
      }),
    });
    expect(insertNativeAuthoredBody(input).error).not.toContain(input.body);
  });

  it("distinguishes a timeout using only validated fixed-stage telemetry", () => {
    h.run.mockReturnValue({
      status: null,
      error: Object.assign(new Error(input.body), { code: "ETIMEDOUT" }),
      stdout: "",
      stderr: "NATIVE_STAGE:identity\nNATIVE_STAGE:target-window\nprivate contents",
    });
    const result = insertNativeAuthoredBody(input);
    expect(result.error).toContain("[stage=target-window; runtime=timeout]");
    expect(result.error).not.toContain("private contents");
    expect(h.run).toHaveBeenCalledOnce();
  });

  it("rejects invalid message targeting before starting a subprocess", () => {
    expect(insertNativeAuthoredBody({ ...input, messageId: Number.NaN }).success).toBe(false);
    expect(insertNativeAuthoredBody({ ...input, markerSubject: "" }).success).toBe(false);
    expect(insertNativeAuthoredBody({ ...input, expectedSender: "" }).success).toBe(false);
    expect(h.run).not.toHaveBeenCalled();
  });
});
