/**
 * Executable documentation — CLAUDE.md's backslash-escaping rules.
 *
 * CLAUDE.md is the instruction sheet an AI agent reads before it calls these
 * tools, so a wrong example there is a live defect: the agent copies it and the
 * recipient gets the wrong bytes. A sibling repo (apple-notes-mcp) carried a
 * Windows-path example that contradicted the escaping table three lines above
 * it for a long time, because nothing ever checked the doc's examples against
 * the doc's own rules.
 *
 * This test reads CLAUDE.md off disk and enforces exactly that:
 *
 *   a. the "You want | Send in JSON parameter" table is self-consistent —
 *      JSON-decoding the right cell yields the left cell, literally;
 *   b. every "Correct" example decodes to the result the doc annotates it with
 *      (`→ arrives as: \`…\``), so the promised bytes are the real bytes;
 *   c. every "Incorrect" example genuinely is incorrect — it either fails to
 *      parse as JSON or decodes to something other than the correct result. A
 *      doc that labels a working string "will fail" is its own kind of wrong;
 *   d. the "Testing Your Understanding" checklist agrees with (a).
 *
 * Pure file I/O — no server boot, no Mail.app, no network.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const CLAUDE_MD = new URL("../CLAUDE.md", import.meta.url);
const DOC = readFileSync(CLAUDE_MD, "utf8");

const ESCAPING_HEADING = "## Critical: Backslash Escaping";
const CHECKLIST_HEADING = "## Testing Your Understanding";

/** The body of a `## ` section, up to the next `## ` heading. */
function section(heading: string): string {
  const start = DOC.indexOf(heading);
  expect(start, `CLAUDE.md is missing the "${heading}" section`).toBeGreaterThan(-1);
  const rest = DOC.slice(start + heading.length);
  const end = rest.search(/\n## /);
  return end === -1 ? rest : rest.slice(0, end);
}

/** Contents of a markdown code span, or null when the cell isn't one. */
function codeSpan(cell: string): string | null {
  const m = /^`(.*)`$/.exec(cell.trim());
  return m ? m[1] : null;
}

/** JSON-decode a bare string body: what the JSON parser hands the server. */
function decodeJsonStringBody(body: string): string {
  return JSON.parse(`"${body}"`) as string;
}

interface Example {
  kind: "Correct" | "Incorrect";
  heading: string;
  /** The raw `"…"` JSON string literal from the fenced block, quotes included. */
  literal: string | null;
  /** The `→ arrives as: \`…\`` annotation that follows the fence, if any. */
  arrivesAs: string | null;
}

/**
 * Split a section into its **Correct:** / **Incorrect:** examples. Each marker
 * owns the text up to the next marker, so a fence and its annotation can never
 * be attributed to the wrong example.
 */
function parseExamples(text: string): Example[] {
  const marker = /\*\*(Correct|Incorrect)\b[^\n]*\*\*/g;
  const hits: { kind: "Correct" | "Incorrect"; heading: string; at: number }[] = [];
  for (let m = marker.exec(text); m !== null; m = marker.exec(text)) {
    hits.push({ kind: m[1] as "Correct" | "Incorrect", heading: m[0], at: m.index });
  }
  return hits.map((hit, i) => {
    const chunk = text.slice(hit.at, i + 1 < hits.length ? hits[i + 1].at : text.length);
    const fence = /```[a-zA-Z]*\n([\s\S]*?)\n```/.exec(chunk);
    // A `body:` / `content:` parameter carrying a JSON string literal.
    const lit = fence ? /\b(?:body|content)\s*:\s*("(?:[^"\\]|\\.)*")/.exec(fence[1]) : null;
    const annotation = /→ arrives as: `([^`]*)`/.exec(chunk);
    return {
      kind: hit.kind,
      heading: hit.heading,
      literal: lit ? lit[1] : null,
      arrivesAs: annotation ? annotation[1] : null,
    };
  });
}

describe("CLAUDE.md backslash-escaping rules are self-consistent", () => {
  const escaping = section(ESCAPING_HEADING);
  const examples = parseExamples(escaping);

  it("the escaping table decodes exactly as it claims", () => {
    const rows: { want: string; send: string }[] = [];
    for (const line of escaping.split("\n")) {
      const t = line.trim();
      if (!t.startsWith("|") || !t.endsWith("|")) continue;
      const cells = t.slice(1, -1).split("|");
      if (cells.length !== 2) continue;
      const want = codeSpan(cells[0]);
      const send = codeSpan(cells[1]);
      // Header ("You want") and separator ("---") rows aren't code spans.
      if (want === null || send === null) continue;
      rows.push({ want, send });
    }

    expect(
      rows.length,
      "parsed no rows out of the escaping table — the table moved or the parser rotted"
    ).toBeGreaterThan(0);

    for (const row of rows) {
      let decoded: string;
      try {
        decoded = decodeJsonStringBody(row.send);
      } catch (err) {
        throw new Error(
          `escaping table row \`${row.want}\` | \`${row.send}\`: the "send" cell is ` +
            `not a valid JSON string body (${(err as Error).message})`
        );
      }
      expect(
        decoded,
        `escaping table row \`${row.want}\` | \`${row.send}\`: sending \`${row.send}\` ` +
          `actually yields ${JSON.stringify(decoded)}, not ${JSON.stringify(row.want)}`
      ).toBe(row.want);
    }
  });

  it("every Correct example decodes to the result the doc annotates it with", () => {
    const correct = examples.filter((e) => e.kind === "Correct");
    expect(correct.length, "found no Correct example in the escaping section").toBeGreaterThan(0);

    let checked = 0;
    for (const ex of correct) {
      expect(
        ex.literal,
        `Correct example "${ex.heading}" has no body:/content: JSON string literal`
      ).not.toBeNull();
      expect(
        ex.arrivesAs,
        `Correct example "${ex.heading}" is missing its "→ arrives as: \`…\`" annotation — ` +
          `that annotation is what makes the example checkable; re-add it`
      ).not.toBeNull();

      let decoded: string;
      try {
        decoded = JSON.parse(ex.literal as string) as string;
      } catch (err) {
        throw new Error(
          `Correct example "${ex.heading}" is not valid JSON: ${(err as Error).message}`
        );
      }
      expect(
        decoded,
        `Correct example "${ex.heading}": ${ex.literal} arrives as ${JSON.stringify(decoded)}, ` +
          `but the doc says it arrives as ${JSON.stringify(ex.arrivesAs)}`
      ).toBe(ex.arrivesAs);
      checked++;
    }

    // Guards against a doc rewrite that drops every annotation and leaves this
    // suite passing vacuously.
    expect(
      checked,
      "no annotated Correct example was checked — the annotations were dropped"
    ).toBeGreaterThan(0);
  });

  it("every Incorrect example really is incorrect", () => {
    const incorrect = examples.filter((e) => e.kind === "Incorrect");
    expect(incorrect.length, "found no Incorrect example in the escaping section").toBeGreaterThan(
      0
    );

    const correctResults = new Set(
      examples
        .filter((e) => e.kind === "Correct" && e.arrivesAs !== null)
        .map((e) => e.arrivesAs as string)
    );

    for (const ex of incorrect) {
      expect(
        ex.literal,
        `Incorrect example "${ex.heading}" has no body:/content: JSON string literal`
      ).not.toBeNull();

      let decoded: string | null = null;
      try {
        decoded = JSON.parse(ex.literal as string) as string;
      } catch {
        continue; // doesn't parse at all — incorrect, as advertised
      }
      expect(
        correctResults.has(decoded),
        `Incorrect example "${ex.heading}" is labelled as failing, but ${ex.literal} parses ` +
          `cleanly and yields ${JSON.stringify(decoded)} — the same result as the Correct ` +
          `example. Either the label or the example is wrong`
      ).toBe(false);
    }
  });

  it('the "Testing Your Understanding" checklist agrees with the escaping table', () => {
    const checklist = section(CHECKLIST_HEADING);

    const needs = /^- `([^`]*)` - Needs escaping: `([^`]*)`$/gm;
    let claims = 0;
    for (let m = needs.exec(checklist); m !== null; m = needs.exec(checklist)) {
      const [, want, send] = m;
      const decoded = decodeJsonStringBody(send);
      expect(
        decoded,
        `checklist claims \`${want}\` needs escaping as \`${send}\`, but that decodes to ` +
          `${JSON.stringify(decoded)}`
      ).toBe(want);
      claims++;
    }
    expect(claims, "parsed no escaping claims out of the checklist").toBeGreaterThan(0);

    const none = /^- `([^`]*)` - No escaping needed/gm;
    for (let m = none.exec(checklist); m !== null; m = none.exec(checklist)) {
      expect(
        m[1].includes("\\"),
        `checklist says \`${m[1]}\` needs no escaping, but it contains a backslash`
      ).toBe(false);
    }
  });
});
