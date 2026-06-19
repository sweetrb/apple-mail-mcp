import { describe, it, expect } from "vitest";
import { normalizeSubject, subjectFromGetMessage } from "@/tools/thread.js";

describe("normalizeSubject (B1)", () => {
  it("strips a single reply/forward prefix", () => {
    expect(normalizeSubject("Re: Lunch?")).toBe("Lunch?");
    expect(normalizeSubject("Fwd: Invoice 42")).toBe("Invoice 42");
    expect(normalizeSubject("FW: Status")).toBe("Status");
  });

  it("strips stacked and numbered prefixes", () => {
    expect(normalizeSubject("Re: Re: Fwd: Project plan")).toBe("Project plan");
    expect(normalizeSubject("RE[2]: Budget")).toBe("Budget");
  });

  it("strips localized prefixes (AW/WG/SV)", () => {
    expect(normalizeSubject("AW: Termin")).toBe("Termin");
    expect(normalizeSubject("WG: Bericht")).toBe("Bericht");
  });

  it("leaves a clean subject untouched and trims", () => {
    expect(normalizeSubject("  Quarterly review  ")).toBe("Quarterly review");
  });

  it("falls back to the original when stripping would empty it", () => {
    expect(normalizeSubject("Re:")).toBe("Re:");
  });
});

describe("subjectFromGetMessage (B1)", () => {
  it("extracts the subject line", () => {
    expect(subjectFromGetMessage("Subject: Hello there\n\nbody text")).toBe("Hello there");
  });
  it("returns null when absent", () => {
    expect(subjectFromGetMessage("no subject header here")).toBeNull();
  });
});
