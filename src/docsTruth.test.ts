/**
 * Executable documentation — every example, knob and tool name in the docs
 * describes something that actually exists.
 *
 * Sibling of `readmeEscaping.test.ts` / `claudeMdEscaping.test.ts`, which prove
 * one *section* of one doc is internally consistent. This file proves the whole
 * doc set agrees with the *code*, which is the failure mode those two cannot
 * see. Two shipped defects motivate it, and nothing mechanical caught either:
 *
 *   • README.md's backslash-escaping instructions were wrong while CLAUDE.md,
 *     three files away, said the opposite — one repo, two contradictory
 *     instructions, and the published one was the wrong one. Nothing compared
 *     a doc to reality.
 *   • apple-notes-mcp's CLAUDE.md kept asserting "the default account is
 *     iCloud" after the code stopped assuming that name. A behaviour change
 *     shipped; the sentence describing it did not move.
 *
 * What is enforced:
 *
 *   A(a) Every ```json fence in README.md, CLAUDE.md and docs/*.md parses as
 *        JSON. A malformed JSON example in setup docs actively breaks the user
 *        who copies it. Deliberate FRAGMENTS are retagged ```text — honestly
 *        not-JSON — rather than allowlisted, because an allowlist is exactly
 *        how a guard becomes decorative. ```jsonc is accepted only when the
 *        block really does carry a comment; otherwise it is plain JSON wearing
 *        a tag that dodges this check, and it belongs under ```json.
 *   A(b) Every `APPLE_*` environment variable named in those docs exists
 *        somewhere under `src/` (excluding tests — a knob referenced only by a
 *        test is not a knob). Catches a doc still advertising a renamed or
 *        deleted setting.
 *   B    README.md's "## Tool Reference" documents EXACTLY the tools the built
 *        server advertises, in BOTH directions: nothing advertised is
 *        undocumented (a tool shipped without docs — which is how
 *        `resolve-message-id`, added in 2.8.0, had no Tool Reference entry
 *        through 2.10.13), and nothing documented is absent from the server (a
 *        renamed or removed tool whose docs stayed behind).
 *
 * Every assertion also requires that it found something to check, so deleting
 * the inputs makes the suite FAIL rather than pass on an empty set.
 *
 * ── Why this file lives in src/ ────────────────────────────────────────────
 * `vitest.config.ts` includes `src/**\/*.test.ts` and is what `pnpm test` /
 * `pnpm run test:coverage` run — the job behind the REQUIRED branch-protection
 * contexts `test (22)` and `test (24)`. The integration config is invoked in
 * ci.yml by explicitly named file, so a new file dropped in `test/` would never
 * run. A guard that is not in the required job is not a guard.
 *
 * Guard B boots the committed bundle, and ci.yml runs `test:coverage` BEFORE
 * its `build` step — which is fine, and deliberately not papered over with a
 * skip-if-missing branch: `build/index.js` is git-tracked (`.gitignore`
 * re-includes it), so it is present from checkout, and the later "Verify
 * committed build/ matches source" step fails the same job if that committed
 * bundle does not match `src/`. So the bundle this test interrogates is
 * provably the bundle users receive. If it is ever missing, this fails loudly.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SERVER = join(ROOT, "build", "index.js");

/**
 * Tripwires against a "make it pass" regression. Both are floors well below
 * today's counts (16 JSON fences, 29 env tokens), so ordinary doc edits never
 * trip them — but retagging every fence, or gutting the docs, does.
 */
const MIN_JSON_FENCES = 8;
const MIN_ENV_TOKENS = 10;

/** README.md, CLAUDE.md and every docs/*.md — discovered, never hardcoded. */
const DOC_FILES: string[] = (() => {
  const docsDir = join(ROOT, "docs");
  const extra = existsSync(docsDir)
    ? readdirSync(docsDir)
        .filter((f) => f.endsWith(".md"))
        .sort()
        .map((f) => join("docs", f))
    : [];
  return ["README.md", "CLAUDE.md", ...extra];
})();

const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");

interface Fence {
  file: string;
  /** 1-based line of the opening fence. */
  line: number;
  /** Lowercased info string (`json`, `jsonc`, `bash`, …); "" for a bare fence. */
  lang: string;
  body: string;
}

/**
 * Fenced code blocks, indent- and length-aware: a fence may be indented inside
 * a list item, and it closes on a backtick run at least as long as the opener.
 */
function fences(file: string, text: string): Fence[] {
  const lines = text.split("\n");
  const out: Fence[] = [];
  let i = 0;
  while (i < lines.length) {
    const open = /^(\s*)(`{3,})[ \t]*([^`\s]*)/.exec(lines[i]);
    if (!open) {
      i++;
      continue;
    }
    const [, indent, ticks, info] = open;
    const close = new RegExp(`^\\s{0,${indent.length + 3}}\`{${ticks.length},}\\s*$`);
    let j = i + 1;
    while (j < lines.length && !close.test(lines[j])) j++;
    out.push({
      file,
      line: i + 1,
      lang: info.toLowerCase(),
      body: lines.slice(i + 1, j).join("\n"),
    });
    i = j + 1;
  }
  return out;
}

/**
 * The same text with every fenced block's contents blanked, line count
 * preserved. Headings and env-var tokens are read from this so a markdown
 * EXAMPLE inside a code sample is never mistaken for the document's own.
 */
function withoutFences(file: string, text: string): string {
  const lines = text.split("\n");
  for (const f of fences(file, text)) {
    const bodyLines = f.body === "" ? 0 : f.body.split("\n").length;
    for (let k = f.line - 1; k < f.line + bodyLines + 1 && k < lines.length; k++) lines[k] = "";
  }
  return lines.join("\n");
}

const ALL_FENCES: Fence[] = DOC_FILES.flatMap((f) => fences(f, read(f)));

const preview = (body: string): string =>
  body
    .split("\n")
    .slice(0, 12)
    .map((l) => `    ${l}`)
    .join("\n");

describe("Guard A(a): every documented JSON example really is JSON", () => {
  const jsonFences = ALL_FENCES.filter((f) => f.lang === "json");

  it("parses every ```json block in README.md, CLAUDE.md and docs/*.md", () => {
    const failures: string[] = [];
    for (const f of jsonFences) {
      try {
        JSON.parse(f.body);
      } catch (err) {
        failures.push(`${f.file}:${f.line} — ${(err as Error).message}\n${preview(f.body)}`);
      }
    }
    expect(
      failures,
      `these \`\`\`json blocks do not parse. A user who copies one gets a broken config or a ` +
        `rejected tool call. If the block is a deliberate FRAGMENT, retag it \`\`\`text so it is ` +
        `honestly not-JSON; if it is meant to be valid JSON, it is a real bug — fix it:\n` +
        failures.join("\n")
    ).toEqual([]);
  });

  it("checked a real population of JSON blocks", () => {
    // Retagging every fence to dodge the parser would leave the assertion above
    // trivially green. This is the tripwire for that, and for a docs wipe.
    expect(
      jsonFences.length,
      `only ${jsonFences.length} \`\`\`json block(s) found across ${DOC_FILES.join(", ")} — ` +
        `expected at least ${MIN_JSON_FENCES}. Either the docs lost their examples or the ` +
        `fences were retagged en masse to make the parse check vacuous.`
    ).toBeGreaterThanOrEqual(MIN_JSON_FENCES);
  });

  it("no ```jsonc block is plain JSON wearing a comment-tolerant tag", () => {
    // ```jsonc is the one honest escape hatch from the parse check, so it must
    // be earned: a block with no comment in it is ordinary JSON, and tagging it
    // jsonc buys nothing but exemption from being checked.
    const hasComment = (body: string): boolean => /(^|[^:])\/\/|\/\*/.test(body);
    const offenders = ALL_FENCES.filter((f) => f.lang === "jsonc" && !hasComment(f.body)).map(
      (f) => `${f.file}:${f.line}`
    );
    expect(
      offenders,
      `these \`\`\`jsonc blocks contain no comment, so they are plain JSON and the tag only ` +
        `exempts them from the parse check above. Retag them \`\`\`json: ${offenders.join(", ")}`
    ).toEqual([]);
  });
});

describe("Guard A(b): every environment variable the docs name exists in src/", () => {
  /**
   * `APPLE_…` in SCREAMING_SNAKE_CASE. Deliberately wider than
   * `APPLE_MAIL_MCP_*`: this repo also ships `APPLE_MAIL_MAX_SEARCH_MAILBOX`,
   * which the narrower family pattern would silently skip. A trailing
   * underscore is captured on purpose — it is what marks a family name.
   */
  const ENV_TOKEN = /\bAPPLE_[A-Z0-9_]+/g;

  function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
      const p = join(dir, entry);
      return statSync(p).isDirectory() ? walk(p) : [p];
    });
  }

  // Tests excluded: a knob that exists only in a test does not exist for users,
  // and a doc naming it is still wrong.
  const srcTokens = new Set<string>();
  for (const file of walk(join(ROOT, "src")).filter((p) => !/\.test\.ts$/.test(p))) {
    for (const m of readFileSync(file, "utf8").matchAll(ENV_TOKEN)) srcTokens.add(m[0]);
  }

  /**
   * Structural, not an allowlist. A token is real if `src/` names it verbatim,
   * or — for a token written with a trailing underscore, i.e. a FAMILY named in
   * prose ("the …_IMAP_ settings") — if some real variable starts with it. A
   * renamed, typo'd or deleted knob is a strict prefix of nothing and still
   * fails, so nothing here is softened by knowing which strings happen to
   * appear today.
   */
  function existsInSrc(token: string): boolean {
    if (srcTokens.has(token)) return true;
    if (!token.endsWith("_")) return false;
    for (const real of srcTokens) {
      if (real.length > token.length && real.startsWith(token)) return true;
    }
    return false;
  }

  // Raw text on purpose — the copy-pasteable `env` blocks live inside fences,
  // and a phantom variable there is the most harmful kind.
  const documented = new Map<string, Set<string>>();
  for (const file of DOC_FILES) {
    for (const m of read(file).matchAll(ENV_TOKEN)) {
      if (!documented.has(m[0])) documented.set(m[0], new Set());
      (documented.get(m[0]) as Set<string>).add(file);
    }
  }

  it("names no environment variable that src/ does not define", () => {
    const phantom = [...documented.entries()]
      .filter(([token]) => !existsInSrc(token))
      .map(([token, where]) => `${token} (documented in ${[...where].sort().join(", ")})`)
      .sort();
    expect(
      phantom,
      `the docs advertise environment variables that appear nowhere under src/. Either the ` +
        `knob was renamed or removed and the doc was not updated, or the doc has a typo — ` +
        `users will set these and nothing will happen:\n  ${phantom.join("\n  ")}`
    ).toEqual([]);
  });

  it("checked a real population of environment variables", () => {
    expect(
      documented.size,
      `only ${documented.size} APPLE_* token(s) found in the docs — expected at least ` +
        `${MIN_ENV_TOKENS}. The configuration documentation was gutted, or the extractor rotted.`
    ).toBeGreaterThanOrEqual(MIN_ENV_TOKENS);
  });
});

describe("Guard B: README Tool Reference == the tool surface the server advertises", () => {
  const TOOL_REFERENCE = "## Tool Reference";

  /** Documented tool names: backticked kebab tokens in the section's `####` headings. */
  const documented: string[] = (() => {
    const readme = withoutFences("README.md", read("README.md")).split("\n");
    const start = readme.findIndex((l) => l.trim() === TOOL_REFERENCE);
    if (start === -1) return [];
    let end = readme.length;
    for (let i = start + 1; i < readme.length; i++) {
      if (/^## /.test(readme[i])) {
        end = i;
        break;
      }
    }
    const names = new Set<string>();
    for (let i = start + 1; i < end; i++) {
      const heading = /^#### (.+)$/.exec(readme[i]);
      if (!heading) continue;
      // One heading may cover a pair, e.g. `mark-as-read` / `mark-as-unread`.
      for (const m of heading[1].matchAll(/`([a-z][a-z0-9-]*)`/g)) names.add(m[1]);
    }
    return [...names].sort();
  })();

  let client: Client | undefined;
  let advertised: string[] = [];

  beforeAll(async () => {
    if (!existsSync(SERVER)) {
      throw new Error(
        `${SERVER} is missing. The bundle is git-tracked (.gitignore re-includes build/index.js), ` +
          `so it is present from checkout in CI and this should be unreachable. Run ` +
          `\`pnpm run build\` — do NOT make this test skip itself, which would pass vacuously forever.`
      );
    }
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [SERVER],
      env: { ...process.env } as Record<string, string>,
    });
    client = new Client({ name: "docs-truth-test", version: "0.0.0" });
    await client.connect(transport);
    advertised = (await client.listTools()).tools.map((t) => t.name).sort();
  }, 60_000);

  afterAll(async () => {
    await client?.close();
  });

  it("the built server advertises tools, and the README has a Tool Reference", () => {
    // Both halves of the comparison must be non-empty, or the two set
    // assertions below would agree perfectly about nothing.
    expect(advertised.length, "the built server advertised no tools over stdio").toBeGreaterThan(0);
    expect(
      documented.length,
      `README.md's "${TOOL_REFERENCE}" section documented no tools. Either the section was ` +
        `removed/renamed, or its "#### \`tool-name\`" heading convention changed and this guard ` +
        `is now reading nothing.`
    ).toBeGreaterThan(0);
  });

  it("documents every tool the server advertises", () => {
    const undocumented = advertised.filter((t) => !documented.includes(t));
    expect(
      undocumented,
      `these tools are advertised over the wire but have no "${TOOL_REFERENCE}" entry, so users ` +
        `and agents cannot discover their parameters: ${undocumented.join(", ")}`
    ).toEqual([]);
  });

  it("documents no tool the server does not advertise", () => {
    const phantom = documented.filter((t) => !advertised.includes(t));
    expect(
      phantom,
      `these tools have a "${TOOL_REFERENCE}" entry but the server does not advertise them — a ` +
        `renamed or removed tool whose docs stayed behind. Calling one fails: ${phantom.join(", ")}`
    ).toEqual([]);
  });
});
