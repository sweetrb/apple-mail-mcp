import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KeychainGrantStore, type GoogleAccountBinding, type GoogleGrant } from "./gmailOAuth.js";

const mock = vi.hoisted(() => ({ run: vi.fn(), stdin: vi.fn() }));
vi.mock("node:child_process", () => ({ execFile: mock.run }));
const ref: GoogleAccountBinding = {
  provider: "google",
  clientId: "fixture.apps.googleusercontent.com",
  email: "person@example.com",
};
const grant: GoogleGrant = {
  accessToken: "ACCESS_CANARY",
  refreshToken: "REFRESH_CANARY",
  expiresAt: 1234,
  subject: "subject",
  email: ref.email,
};
let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "mail-oauth-test-"));
  mock.run.mockReset();
  mock.stdin.mockReset();
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

it("writes secrets only through stdin, verifies storage, and namespaces by client/account", async () => {
  mock.run.mockImplementation((_command, args, _options, callback) => {
    callback(null, args[0] === "find-generic-password" ? JSON.stringify(grant) : "");
    return { stdin: { end: mock.stdin } };
  });
  const store = new KeychainGrantStore(directory);
  await store.write(ref, grant, "");
  expect(mock.run.mock.calls[0][1]).toEqual(["-i"]);
  expect(mock.stdin.mock.calls[0][0]).toContain("REFRESH_CANARY");
  const safeArguments = JSON.stringify(mock.run.mock.calls.map((call) => call.slice(0, 3)));
  expect(safeArguments).not.toMatch(/ACCESS_CANARY|REFRESH_CANARY/);
  expect(safeArguments).toContain("apple-mail-mcp.oauth.google.v1");
  const originalKey = mock.run.mock.calls[1][1][4];
  await store.read({ ...ref, clientId: "another.apps.googleusercontent.com" });
  expect(mock.run.mock.calls[2][1][4]).not.toBe(originalKey);
  const files = await readdir(directory);
  expect(files).toHaveLength(1);
  expect(await readFile(join(directory, files[0]), "utf8")).not.toMatch(/CANARY|person@/);
  const other = new KeychainGrantStore(directory);
  await expect(other.write(ref, grant, "")).rejects.toThrow("changed in another process");
});

it("detects an interactive command that exits zero without saving the grant", async () => {
  mock.run.mockImplementation((_command, args, _options, callback) => {
    callback(args[0] === "find-generic-password" ? { code: 44 } : null, "");
    return { stdin: { end: mock.stdin } };
  });
  await expect(new KeychainGrantStore(directory).write(ref, grant, "")).rejects.toThrow(
    "could not be verified"
  );
});

it("does not confuse a locked Keychain with a missing grant or expose stderr", async () => {
  mock.run.mockImplementation((_command, _args, _options, callback) => {
    callback({ code: 36, message: "REFRESH_CANARY" }, "ACCESS_CANARY");
    return { stdin: { end: mock.stdin } };
  });
  await expect(new KeychainGrantStore(directory).read(ref)).rejects.toThrow("unlock it");
});

it.each(["write", "remove"] as const)(
  "takes atomic snapshots while another store is performing %s",
  async (operation) => {
    let persisted: GoogleGrant | null = grant;
    const replacement = { ...grant, accessToken: "REPLACEMENT_CANARY" };
    let begin!: () => void;
    const started = new Promise<void>((resolve) => {
      begin = resolve;
    });
    let release!: () => void;
    mock.run.mockImplementation((_command, args, _options, callback) => {
      if (args[0] === "-i" || args[0] === "delete-generic-password") {
        release = () => {
          persisted = operation === "write" ? replacement : null;
          callback(null, "");
        };
        begin();
      } else callback(persisted ? null : { code: 44 }, persisted ? JSON.stringify(persisted) : "");
      return { stdin: { end: mock.stdin } };
    });
    const writer = new KeychainGrantStore(directory);
    const reader = new KeychainGrantStore(directory);
    const mutation =
      operation === "write" ? writer.write(ref, replacement, "") : writer.remove(ref);
    await started;
    const callsBeforeSnapshot = mock.run.mock.calls.length;
    const snapshot = reader.snapshot(ref);
    // The reader is queued behind the actual Keychain mutation, not merely its
    // published revision. It must not read the old grant/new revision window.
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(mock.run.mock.calls).toHaveLength(callsBeforeSnapshot);
    release();
    await mutation;
    const result = await snapshot;
    expect(result.grant).toEqual(operation === "write" ? replacement : null);
    expect(result.revision).toBe(await writer.revision(ref));
  }
);
