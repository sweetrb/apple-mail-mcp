import { describe, expect, it } from "vitest";
import { AuthOperationError, publicAuthFailure, type AuthFailureCode } from "./authErrors.js";
import { googleReference } from "./googleAccount.js";

describe("public authentication diagnostics", () => {
  it.each<AuthFailureCode>([
    "configuration",
    "keychain",
    "storage-busy",
    "authorization",
    "reconnect",
  ])("renders %s only from fixed text, never the exception payload", (code) => {
    const error = new AuthOperationError(
      code,
      "ACCESS_TOKEN_CANARY REFRESH_TOKEN_CANARY secret-provider-body"
    );
    error.stack = "STACK_CANARY";
    const result = publicAuthFailure(error);
    expect(result).not.toMatch(/CANARY|secret-provider-body/);
    expect(result.length).toBeGreaterThan(30);
  });
  it("never reads or stringifies arbitrary provider/subprocess errors", () => {
    const error = {
      get message(): never {
        throw new Error("read secret message");
      },
      toString(): never {
        throw new Error("stringified secret");
      },
    };
    expect(publicAuthFailure(error)).toContain("operation failed");
    expect(publicAuthFailure(new Error("TOKEN_CANARY"))).not.toContain("TOKEN_CANARY");
  });
  it("constructs public account bindings independently of token resolution", () => {
    const binding = googleReference(
      "google",
      "person@example.com",
      "fixture.apps.googleusercontent.com"
    );
    expect(binding).toEqual({
      provider: "google",
      email: "person@example.com",
      clientId: "fixture.apps.googleusercontent.com",
    });
    expect(Object.keys(binding!).sort()).toEqual(["clientId", "email", "provider"]);
    expect(googleReference("password", "person@example.com", undefined)).toBeUndefined();
  });
});
