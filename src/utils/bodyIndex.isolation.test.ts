/**
 * A message that makes the parser throw is recorded as unreadable and indexing
 * carries on past it. The parser has no input known to make it throw (it was
 * fuzzed), so this file stands one in for it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { plainMessage, sqlite, writeEmlx } from "@/utils/envelopeIndex.testFixture.js";

vi.mock("@/utils/emlx.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/utils/emlx.js")>();
  return {
    ...real,
    messageText: (source: string, html?: string | null) => {
      if (source.includes("PARSER-BOMB")) throw new RangeError("Maximum call stack size exceeded");
      return real.messageText(source, html);
    },
  };
});

const { BodyIndexWriter, DocState } = await import("@/utils/bodyIndex.js");

describe.skipIf(!sqlite)("a message the parser throws on", () => {
  let root: string;
  let store: string;
  let w: InstanceType<typeof BodyIndexWriter>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "bodyidx-throw-"));
    store = join(root, "V10");
    for (let id = 1; id <= 5; id++) {
      writeEmlx(
        store,
        "ACC",
        "INBOX",
        id,
        plainMessage("s", id === 3 ? "PARSER-BOMB" : `word${id}`)
      );
    }
    const opened = BodyIndexWriter.open(store, join(root, "support", "body.db"), sqlite!);
    if ("reason" in opened) throw new Error(opened.reason);
    w = opened;
  });
  afterEach(() => {
    w.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("is recorded as unreadable, and the rest of the batch is indexed", () => {
    w.startWalk();
    while (!w.walkStep(60_000));
    expect(w.indexStep(60_000)).toBe(5);
    expect(w.indexStep(60_000)).toBe(0); // nothing left to retry in a loop
    expect(w.state().counts).toMatchObject({ indexed: 4, unreadable: 1, queued: 0 });
    expect(Number(w.db.prepare("SELECT state FROM docs WHERE id = 3").get()!.state)).toBe(
      DocState.unreadable
    );
    expect(w.state().meta.lastError).toContain("parse error");
  });
});
