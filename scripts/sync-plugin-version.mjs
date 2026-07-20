import fs from "node:fs";
import path from "node:path";

// Syncs every plugin manifest's version to package.json's version.
// With --check: writes nothing — exits 0 silently when every manifest already
// matches, exits 1 listing the mismatched files (used by CI to catch drift).
const root = process.cwd();
const checkMode = process.argv.includes("--check");
const packageJson = readJson("package.json");
const version = packageJson.version;
const mismatches = [];

updateJson(".claude-plugin/plugin.json", (data) => {
  data.version = version;
});

updateJson("codex/.codex-plugin/plugin.json", (data) => {
  data.version = version;
});

updateJson(".claude-plugin/marketplace.json", (data) => {
  data.version = version;
  for (const plugin of data.plugins ?? []) {
    if (plugin.name === "apple-mail") {
      plugin.version = version;
    }
  }
});

updateJson(".agents/plugins/marketplace.json", (data) => {
  for (const plugin of data.plugins ?? []) {
    if (plugin.name === "apple-mail") {
      plugin.version = version;
    }
  }
});

updateJson(".antigravity-plugin/plugin.json", (data) => {
  data.version = version;
});

updateJson(".antigravity-plugin/marketplace.json", (data) => {
  for (const plugin of data.plugins ?? []) {
    if (plugin.name === "apple-mail") {
      plugin.version = version;
    }
  }
});

if (checkMode && mismatches.length > 0) {
  console.error(
    `Plugin manifest version(s) do not match package.json (${version}) — run: node scripts/sync-plugin-version.mjs`,
  );
  for (const m of mismatches) {
    console.error(`  ${m}`);
  }
  process.exit(1);
}

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), "utf8"));
}

function updateJson(relativePath, update) {
  const fullPath = path.join(root, relativePath);
  const original = fs.readFileSync(fullPath, "utf8");
  const data = JSON.parse(original);
  update(data);
  const next = `${JSON.stringify(data, null, 2)}\n`;
  if (checkMode) {
    if (next !== original) {
      mismatches.push(relativePath);
    }
    return;
  }
  fs.writeFileSync(fullPath, next);
}
