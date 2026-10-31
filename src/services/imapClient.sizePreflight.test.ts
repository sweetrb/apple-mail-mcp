import { describe, expect, it } from "vitest";
import { decodedSizeWithoutBody } from "@/services/imapClient.js";

describe("encoded attachment size preflight", () => {
  it("marks wrapped base64 as an estimate, not a hard decoded limit", () => {
    expect(decodedSizeWithoutBody({ encodedSize: 104, encoding: "base64" }).exact).toBe(false);
  });

  it("marks quoted-printable encoded bytes as an upper bound", () => {
    expect(decodedSizeWithoutBody({ encodedSize: 200, encoding: "quoted-printable" })).toEqual({
      size: 200,
      exact: false,
    });
  });

  it("preserves exact declared and unencoded sizes", () => {
    expect(
      decodedSizeWithoutBody({ encodedSize: 500, encoding: "base64", declaredSize: 50 })
    ).toEqual({
      size: 50,
      exact: true,
    });
    expect(decodedSizeWithoutBody({ encodedSize: 50, encoding: "7bit" })).toEqual({
      size: 50,
      exact: true,
    });
  });
});
