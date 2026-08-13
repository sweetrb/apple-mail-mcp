/**
 * Executable documentation — README.md's backslash-escaping rules.
 *
 * Sibling of `claudeMdEscaping.test.ts`, which does the same job for CLAUDE.md.
 * README.md needs its own guard for a reason that is easy to get backwards:
 * **README.md is listed in package.json `files[]`, so it ships in the npm
 * tarball. CLAUDE.md does not.** The guard that existed first covered only the
 * file that does not ship — and the file that does ship was the one carrying a
 * wrong instruction.
 *
 * The bug this suite exists to catch: README.md told agents to send
 * `C:\\\\Users\\\\` (four backslashes) to produce `C:\Users\`. A JSON string
 * literal containing four backslashes decodes to **two** literal backslashes,
 * so that instruction produced `C:\\Users\\` — while CLAUDE.md, three files
 * away, correctly said two. One repo, two contradictory instructions, and the
 * wrong one was the published one.
 *
 * What is enforced here:
 *
 *   a. every "common patterns" bullet (`- label: `A` → `B` in JSON`) is
 *      self-consistent — JSON-decoding `B` yields exactly `A`;
 *   b. every worked example decodes to the result the doc annotates it with
 *      (`→ arrives as: `…``); for a ```json fence the block is parsed as JSON
 *      and the `body`/`content` field is pulled out, rather than regexing the
 *      raw line;
 *   c. every "Incorrect" example genuinely is incorrect;
 *   d. neither README.md nor CLAUDE.md teaches escaping with a Windows path.
 *      These servers drive Apple Mail through AppleScript and are `os:
 *      ["darwin"]` — a `C:\Users\` example is boilerplate that was never
 *      localized, and it is where the four-backslash error lived.
 *
 * Each assertion also requires that it found something to check, so a doc
 * rewrite that changes the format fails loudly instead of passing vacuously.
 *
 * Pure file I/O — no server boot, no Mail.app, no network.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const README = readFileSync(new URL("../README.md", import.meta.url), "utf8");
const CLAUDE_MD = readFileSync(new URL("../CLAUDE.md", import.meta.url), "utf8");

const README_HEADING = "### Backslash Escaping (Important for AI Agents)";
const CLAUDE_HEADING = "## Critical: Backslash Escaping";

/** The body of a markdown section, up to the next heading at the same or a higher level. */
function section(doc: string, heading: string, label: string): string {
  const start = doc.indexOf(heading);
  expect(start, `${label} is missing the "${heading}" section`).toBeGreaterThan(-1);
  const hashes = /^#+/.exec(heading);
  const level = hashes ? hashes[0].length : 2;
  const rest = doc.slice(start + heading.length);
  const end = rest.search(new RegExp(`\\n#{1,${level}} `));
  return end === -1 ? rest : rest.slice(0, end);
}

/** JSON-decode a bare string body: what the JSON parser hands the server. */
function decodeJsonStringBody(body: string): string {
  return JSON.parse(`"${body}"`) as string;
}

/** A `body:` / `"content":` parameter carrying a JSON string literal, quotes included. */
const LITERAL = /(?:"(?:body|content)"|\b(?:body|content))\s*:\s*("(?:[^"\\]|\\.)*")/;

interface Example {
  kind: "Correct" | "Incorrect";
  heading: string;
  /** The fence language tag (`json`, `text`, …), or "" for a bare fence. */
  lang: string | null;
  /** The fenced block's contents. */
  block: string | null;
  /** The `→ arrives as: `…`` annotation that follows the fence, if any. */
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
    const fence = /```([a-zA-Z]*)\n([\s\S]*?)\n```/.exec(chunk);
    const annotation = /→ arrives as: `([^`]*)`/.exec(chunk);
    return {
      kind: hit.kind,
      heading: hit.heading,
      lang: fence ? fence[1] : null,
      block: fence ? fence[2] : null,
      arrivesAs: annotation ? annotation[1] : null,
    };
  });
}

/**
 * What the server actually receives for an example: a ```json fence is parsed
 * as JSON and its `body`/`content` field returned; any other fence has its
 * `body: "…"` string literal extracted and decoded. Throws when the payload is
 * not valid JSON — which is exactly what an "Incorrect" example should do.
 */
function decodeExample(ex: Example): string {
  expect(ex.block, `example "${ex.heading}" has no fenced code block`).not.toBeNull();
  const block = ex.block as string;

  if (ex.lang === "json") {
    const payload = JSON.parse(block) as Record<string, unknown>;
    const field = payload.body ?? payload.content;
    expect(
      typeof field,
      `example "${ex.heading}": the JSON payload has no string body/content field`
    ).toBe("string");
    return field as string;
  }

  const lit = LITERAL.exec(block);
  expect(lit, `example "${ex.heading}" has no body:/content: JSON string literal`).not.toBeNull();
  return JSON.parse((lit as RegExpExecArray)[1]) as string;
}

describe("README.md backslash-escaping rules are self-consistent", () => {
  const escaping = section(README, README_HEADING, "README.md");
  const examples = parseExamples(escaping);

  it("every common-patterns bullet decodes exactly as it claims", () => {
    const bullets = /^- ([^:\n]+): `([^`]*)` → `([^`]*)` in JSON\s*$/gm;
    const rows: { label: string; want: string; send: string }[] = [];
    for (let m = bullets.exec(escaping); m !== null; m = bullets.exec(escaping)) {
      rows.push({ label: m[1], want: m[2], send: m[3] });
    }

    expect(
      rows.length,
      'parsed no "- label: `A` → `B` in JSON" bullets out of the README escaping section — ' +
        "the list moved or the parser rotted"
    ).toBeGreaterThan(0);

    for (const row of rows) {
      let decoded: string;
      try {
        decoded = decodeJsonStringBody(row.send);
      } catch (err) {
        throw new Error(
          `README pattern "${row.label}": sending \`${row.send}\` is not a valid JSON ` +
            `string body (${(err as Error).message})`
        );
      }
      expect(
        decoded,
        `README pattern "${row.label}": the doc says send \`${row.send}\` to get ` +
          `\`${row.want}\`, but that actually yields ${JSON.stringify(decoded)}`
      ).toBe(row.want);
    }
  });

  it("every Correct example decodes to the result the doc annotates it with", () => {
    const correct = examples.filter((e) => e.kind === "Correct");
    expect(
      correct.length,
      "found no Correct example in the README escaping section"
    ).toBeGreaterThan(0);

    let checked = 0;
    for (const ex of correct) {
      expect(
        ex.arrivesAs,
        `Correct example "${ex.heading}" is missing its "→ arrives as: \`…\`" annotation — ` +
          `that annotation is what makes the example checkable; re-add it`
      ).not.toBeNull();

      let decoded: string;
      try {
        decoded = decodeExample(ex);
      } catch (err) {
        throw new Error(
          `Correct example "${ex.heading}" is not valid JSON: ${(err as Error).message}`
        );
      }
      expect(
        decoded,
        `Correct example "${ex.heading}": the payload arrives as ${JSON.stringify(decoded)}, ` +
          `but the doc says it arrives as ${JSON.stringify(ex.arrivesAs)}`
      ).toBe(ex.arrivesAs);
      checked++;
    }

    expect(
      checked,
      "no annotated Correct example was checked — the annotations were dropped"
    ).toBeGreaterThan(0);
  });

  it("every Incorrect example really is incorrect", () => {
    const incorrect = examples.filter((e) => e.kind === "Incorrect");
    expect(
      incorrect.length,
      "found no Incorrect example in the README escaping section"
    ).toBeGreaterThan(0);

    const correctResults = new Set(
      examples
        .filter((e) => e.kind === "Correct" && e.arrivesAs !== null)
        .map((e) => e.arrivesAs as string)
    );

    for (const ex of incorrect) {
      let decoded: string;
      try {
        decoded = decodeExample(ex);
      } catch {
        continue; // doesn't parse at all — incorrect, as advertised
      }
      expect(
        correctResults.has(decoded),
        `Incorrect example "${ex.heading}" is labelled as failing, but it parses cleanly and ` +
          `yields ${JSON.stringify(decoded)} — the same result as the Correct example. ` +
          `Either the label or the example is wrong`
      ).toBe(false);
    }
  });
});

describe("the escaping docs stay macOS-native", () => {
  // apple-mail-mcp is `os: ["darwin"]` and drives Mail.app through AppleScript.
  // A `C:\Users\` example is generic MCP boilerplate that was never localized —
  // and it is where the four-backslash error lived in both this repo and
  // apple-notes-mcp. The generic `\` → `\\` rule already covers every platform.
  const windowsPath = /[A-Za-z]:\\/;

  for (const [label, doc, heading] of [
    ["README.md", README, README_HEADING],
    ["CLAUDE.md", CLAUDE_MD, CLAUDE_HEADING],
    ["CLAUDE.md checklist", CLAUDE_MD, "## Testing Your Understanding"],
  ] as const) {
    it(`${label} teaches escaping without a Windows path`, () => {
      const escaping = section(doc, heading, label);
      const offender = escaping.split("\n").find((line) => windowsPath.test(line));
      expect(
        offender,
        `${label} still uses a Windows drive path as an escaping example ` +
          `(${JSON.stringify(offender)}). These servers are macOS-only; use a shell path with ` +
          `an escaped space or a regex instead.`
      ).toBeUndefined();
    });
  }
});
