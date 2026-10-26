import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { renderAuthoredBody } from "../scripts/render-authored-body.mjs";

const script = fileURLToPath(new URL("../scripts/render-authored-body.mjs", import.meta.url));

test("preserves explicit blank paragraphs, including an empty body", () => {
  assert.equal(
    renderAuthoredBody({ body: "First\n\nSecond\n" }),
    '<div style="font-size: inherit;">First</div>' +
      '<div style="font-size: inherit;"><br></div>' +
      '<div style="font-size: inherit;">Second</div>' +
      '<div style="font-size: inherit;"><br></div>'
  );
  assert.equal(renderAuthoredBody({ body: "" }), '<div style="font-size: inherit;"><br></div>');
});

test("escapes authored HTML, attributes, quotes, and ampersands as inert text", () => {
  const html = renderAuthoredBody({
    body: '<blockquote onclick="x">A&B\'s</blockquote><script>x</script>',
  });
  assert.ok(
    html.includes("&lt;blockquote onclick=&quot;x&quot;&gt;A&amp;B&#39;s&lt;/blockquote&gt;")
  );
  assert.ok(html.includes("&lt;script&gt;x&lt;/script&gt;"));
  assert.doesNotMatch(html, /<blockquote|<script|<b>|<strong>/i);
});

test("normalizes Unicode to NFC and CRLF or CR to paragraph boundaries", () => {
  const html = renderAuthoredBody({ body: "Joa\u0303o\r\n中文 — œ\rFim" });
  assert.equal(html, html.normalize("NFC"));
  assert.ok(html.includes("João"));
  assert.ok(html.includes("中文 — œ"));
  assert.ok(html.endsWith(">Fim</div>"));
  assert.equal((html.match(/<div /g) || []).length, 3);
  assert.ok(!html.includes("\r"));
});

test("preserves literal dollar replacement sequences as authored text", () => {
  assert.equal(
    renderAuthoredBody({ body: "$& $$ $` $'" }),
    '<div style="font-size: inherit;">$&amp; $$ $` $&#39;</div>'
  );
});

test("inherits the native font size without choosing a font or restyling prose", () => {
  const html = renderAuthoredBody({ body: "Ordinary prose" });
  assert.match(html, /font-size: inherit/);
  assert.doesNotMatch(
    html,
    /font-size:\s*(?:[\d.]|medium)|font-family|font-weight|font-style|<font\b|<b>|<strong>/i
  );
});

test("requires a string body", () => {
  for (const body of [undefined, null, 12, {}, []]) {
    assert.throws(() => renderAuthoredBody({ body }), TypeError);
  }
  assert.throws(() => renderAuthoredBody(), TypeError);
  assert.throws(() => renderAuthoredBody(null), TypeError);
});

test("CLI emits only the rendered fragment on stdout", () => {
  const input = { body: "João\n\nA&B" };
  const result = spawnSync(process.execPath, [script], {
    input: JSON.stringify(input),
    encoding: "utf8",
  });
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout, renderAuthoredBody(input));
});

test("CLI rejects malformed JSON without echoing the input", () => {
  const result = spawnSync(process.execPath, [script], {
    input: "private-message-not-json",
    encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /stdin must contain valid UTF-8 JSON/);
  assert.ok(!result.stderr.includes("private-message-not-json"));
});

test("CLI rejects a nonstring body without producing partial output", () => {
  const result = spawnSync(process.execPath, [script], {
    input: JSON.stringify({ body: 42 }),
    encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /body must be a string/);
});

test("CLI rejects malformed UTF-8 rather than replacing supplied characters", () => {
  const result = spawnSync(process.execPath, [script], {
    input: Buffer.concat([Buffer.from('{"body":"'), Buffer.from([0xff]), Buffer.from('"}')]),
    encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /stdin must contain valid UTF-8 JSON/);
});
