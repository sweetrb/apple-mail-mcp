import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { TextDecoder } from "node:util";

const entities = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Render new prose only; the native editor retains signatures and history. */
export function renderAuthoredBody({ body } = {}) {
  if (typeof body !== "string") throw new TypeError("body must be a string");
  return body
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => {
      const text = line.replace(/[&<>"']/g, (character) => entities[character]);
      return `<div style="font-size: inherit;">${text || "<br>"}</div>`;
    })
    .join("");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    let input;
    try {
      input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(0)));
    } catch {
      throw new TypeError("stdin must contain valid UTF-8 JSON");
    }
    process.stdout.write(renderAuthoredBody(input));
  } catch (error) {
    process.stderr.write(`Cannot render authored body: ${error.message}\n`);
    process.exitCode = 1;
  }
}
