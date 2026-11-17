import { afterEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ scripts: [] as string[], output: "" }));

vi.mock("@/utils/applescript.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/utils/applescript.js")>();
  return {
    ...actual,
    executeAppleScript: (script: string) => {
      h.scripts.push(script);
      return { success: true, output: h.output };
    },
  };
});

import { AppleMailManager } from "@/services/appleMailManager.js";
import {
  WRITABLE_ACCOUNT_SETTINGS,
  buildAccountSettingsReadScript,
  buildAccountSettingsWriteScript,
  describeAccountSettings,
  parseAccountSettings,
  splitAppliedSettings,
  validateAccountSettingsChanges,
} from "@/utils/accountSettings.js";

const FS = "\x1f";
const RS = "\x1e";

afterEach(() => {
  h.scripts.length = 0;
  h.output = "";
});

function manager(): AppleMailManager {
  const mgr = new AppleMailManager();
  vi.spyOn(
    mgr as unknown as { getCachedAccounts: () => unknown },
    "getCachedAccounts"
  ).mockReturnValue([{ name: "Nopuedomas", email: "jap@nopuedomas.example", enabled: true }]);
  return mgr;
}

describe("account settings scripts", () => {
  it("never reads, writes or names a password", () => {
    const read = buildAccountSettingsReadScript("Work");
    const write = buildAccountSettingsWriteScript("Work", { enabled: true, fullName: "A" });
    expect(read.toLowerCase()).not.toContain("password");
    expect(write.toLowerCase()).not.toContain("password");
    expect(Object.values(WRITABLE_ACCOUNT_SETTINGS).join(" ")).not.toMatch(
      /password|server name|port|user name|email addresses|authentication/
    );
  });

  it("escapes the account name", () => {
    expect(buildAccountSettingsReadScript('My "Mail" \\ box')).toContain(
      'account "My \\"Mail\\" \\\\ box"'
    );
  });

  it("writes only the settings given, guarding each one", () => {
    const script = buildAccountSettingsWriteScript("Work", { enabled: false, fullName: 'J "A"' });
    expect(script).toContain("set enabled of a to false");
    expect(script).toContain('set full name of a to "J \\"A\\""');
    expect(script).not.toContain("include when getting new mail");
    expect(script.match(/on error errMsg/g)).toHaveLength(2);
  });

  it("strips control characters from a written value", () => {
    const script = buildAccountSettingsWriteScript("Work", { fullName: `A${RS}B\nC${FS}D` });
    expect(script).toContain('set full name of a to "ABCD"');
  });

  it("parses booleans and the address list", () => {
    const out = [
      `enabled${FS}true`,
      `usesSsl${FS}false`,
      `emailAddresses${FS}a@x.com, b@x.com`,
      `serverName${FS}imap.x.com`,
      `port${FS}993`,
    ].join(RS);
    expect(parseAccountSettings(out)).toEqual({
      enabled: true,
      usesSsl: false,
      emailAddresses: ["a@x.com", "b@x.com"],
      serverName: "imap.x.com",
      port: "993",
    });
  });
});

describe("describeAccountSettings and splitAppliedSettings", () => {
  it("shows one line per setting, lists joined", () => {
    expect(describeAccountSettings({ enabled: true, emailAddresses: ["a@x", "b@x"] })).toBe(
      "  enabled: true\n  emailAddresses: a@x, b@x"
    );
  });

  it("tells which requested settings Mail took and which it refused", () => {
    const changes = { enabled: false, emptyTrashOnQuit: true, fullName: undefined };
    expect(splitAppliedSettings(changes, ["emptyTrashOnQuit: not supported"])).toEqual({
      applied: ["enabled"],
      refusedKeys: ["emptyTrashOnQuit"],
    });
    expect(splitAppliedSettings({ enabled: true }, ["enabled: no"]).applied).toEqual([]);
  });
});

describe("validateAccountSettingsChanges", () => {
  it("refuses an empty change", () => {
    expect(() => validateAccountSettingsChanges({})).toThrow(/Nothing to change/);
    expect(() => validateAccountSettingsChanges({ enabled: undefined })).toThrow(
      /Nothing to change/
    );
  });

  it("refuses settings that are not changeable here", () => {
    for (const key of ["password", "serverName", "port", "userName", "emailAddresses"]) {
      expect(() => validateAccountSettingsChanges({ [key]: "x" })).toThrow(/cannot be changed/);
    }
  });

  it("wants booleans, and text for fullName", () => {
    expect(() => validateAccountSettingsChanges({ enabled: "yes" })).toThrow(/true or false/);
    expect(() => validateAccountSettingsChanges({ fullName: true })).toThrow(/fullName/);
    expect(() => validateAccountSettingsChanges({ enabled: true, fullName: "J" })).not.toThrow();
  });
});

describe("AppleMailManager account settings", () => {
  it("refuses an unknown account without running AppleScript", () => {
    expect(() => manager().getAccountSettings("Nope")).toThrow(/does not match any Mail account/);
    expect(() => manager().setAccountSettings("Nope", { enabled: true })).toThrow(/does not match/);
    expect(h.scripts).toHaveLength(0);
  });

  it("refuses a name that two accounts share, by name or by address", () => {
    const mgr = new AppleMailManager();
    vi.spyOn(
      mgr as unknown as { getCachedAccounts: () => unknown },
      "getCachedAccounts"
    ).mockReturnValue([
      { name: "Work", email: "a@work.example", enabled: true },
      { name: "Work", email: "b@work.example", enabled: true },
    ]);
    for (const wanted of ["Work", "b@work.example"]) {
      expect(() => mgr.getAccountSettings(wanted)).toThrow(/ambiguous/);
      expect(() => mgr.setAccountSettings(wanted, { enabled: true })).toThrow(/ambiguous/);
    }
    expect(h.scripts).toHaveLength(0);
  });

  it("reads the account list again after a change, so a send sees the new state", () => {
    const mgr = new AppleMailManager();
    const accounts = [{ name: "Nopuedomas", email: "jap@nopuedomas.example", enabled: true }];
    const fetch = vi
      .spyOn(mgr as unknown as { fetchAccounts: () => unknown }, "fetchAccounts")
      .mockReturnValue(accounts);
    h.output = `enabled${FS}true`;
    mgr.getAccountSettings("Nopuedomas");
    expect(fetch).toHaveBeenCalledTimes(1);
    mgr.setAccountSettings("Nopuedomas", { enabled: false });
    // the read-back after the write needed a fresh list
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("accepts the address and reads the settings", () => {
    h.output = `enabled${FS}true`;
    const result = manager().getAccountSettings("JAP@nopuedomas.example");
    expect(result).toEqual({ account: "Nopuedomas", settings: { enabled: true } });
    expect(h.scripts[0]).toContain('account "Nopuedomas"');
  });

  it("validates before touching Mail, and reports what Mail refused", () => {
    expect(() => manager().setAccountSettings("Nopuedomas", {})).toThrow(/Nothing to change/);
    expect(h.scripts).toHaveLength(0);

    h.output = `emptyTrashOnQuit: not supported${RS}`;
    const refused = manager().setAccountSettings("Nopuedomas", { emptyTrashOnQuit: true });
    expect(refused.refused).toEqual(["emptyTrashOnQuit: not supported"]);
  });
});
