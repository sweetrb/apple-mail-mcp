import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { spawn, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createInterface } from "node:readline";
import { deflateSync } from "node:zlib";
import { packageCodexPlugin } from "../scripts/package-codex-plugin.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
function fixture(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "apple-mail-package-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function sourceFixture(t) {
  const dir = fixture(t);
  for (const item of ["codex", "build", "package.json", "LICENSE"]) {
    cpSync(join(root, item), join(dir, item), { recursive: true });
  }
  return dir;
}

// Original synthetic artwork, not a system or third-party icon.
function pngIcon(width = 48, height = width, compressed) {
  function chunk(type, bytes) {
    const block = Buffer.alloc(bytes.length + 12);
    block.writeUInt32BE(bytes.length);
    block.write(type, 4);
    bytes.copy(block, 8);
    let crc = 0xffffffff;
    for (const byte of block.subarray(4, -4)) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    block.writeUInt32BE((crc ^ 0xffffffff) >>> 0, block.length - 4);
    return block;
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    chunk("IHDR", header),
    chunk("IDAT", compressed ?? deflateSync(Buffer.alloc((width * 4 + 1) * height))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

test("produces a deterministic, self-contained archive with unchanged source launchers", async (t) => {
  const dir = fixture(t);
  const original = readFileSync(join(root, "codex/mcp.json"));
  const first = packageCodexPlugin({ root, output: join(dir, "first.tar.gz") });
  packageCodexPlugin({ root, output: join(dir, "second.tar.gz") });
  assert.deepEqual(readFileSync(first.output), readFileSync(join(dir, "second.tar.gz")));
  assert.deepEqual(readFileSync(join(root, "codex/mcp.json")), original);
  const extract = join(dir, "extracted");
  mkdirSync(extract);
  const untar = spawnSync("tar", ["-xzf", first.output, "-C", extract], { encoding: "utf8" });
  assert.equal(untar.status, 0, untar.stderr);
  const listing = spawnSync("tar", ["-tzf", first.output], { encoding: "utf8" });
  assert.equal(listing.status, 0, listing.stderr);
  assert.deepEqual(listing.stdout.trim().split("\n").sort(), first.files);
  for (const config of ["mcp.json", ".mcp.json"]) {
    const server = JSON.parse(readFileSync(join(extract, config))).mcpServers["apple-mail"];
    assert.equal(server.command, "node");
    assert.deepEqual(server.args, ["${PLUGIN_ROOT}/server/index.js"]);
  }
  const pkg = JSON.parse(readFileSync(join(extract, "package.json")));
  assert.equal(pkg.version, first.version);
  assert.equal(pkg.type, "module");
  assert.equal(pkg.dependencies, undefined);
  assert.equal(pkg.scripts, undefined);
  assert.deepEqual(
    readFileSync(join(extract, "server/index.js")),
    readFileSync(join(root, "build/index.js"))
  );
  assert.equal(existsSync(join(extract, "node_modules")), false);
  for (const manifest of ["plugin.json", ".codex-plugin/plugin.json"]) {
    assert.deepEqual(
      readFileSync(join(extract, manifest)),
      readFileSync(join(root, "codex", manifest))
    );
  }
  assert.equal(first.files.includes("skills/apple-mail/assets/custom-icon.png"), false);
  const requests = [
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "archive-test", version: "1" },
      },
    },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
  ];
  const child = spawn(process.execPath, [join(extract, "server/index.js")], {
    cwd: extract,
    env: {
      PATH: process.env.PATH,
      APPLE_MAIL_MCP_CONFIG_FILE: join(dir, "no-config.json"),
      APPLE_MAIL_MCP_IMAP_IDLE: "0",
    },
  });
  const responses = await new Promise((resolve, reject) => {
    const received = [];
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Packaged MCP startup timed out"));
    }, 15000);
    const lines = createInterface({ input: child.stdout });
    child.stderr.resume();
    child.once("error", reject);
    child.once("exit", () => {
      clearTimeout(timer);
      lines.close();
      if (received.some((response) => response.id === 2)) resolve(received);
      else reject(new Error("Packaged MCP exited before returning tools"));
    });
    lines.on("line", (line) => {
      try {
        const response = JSON.parse(line);
        received.push(response);
        if (response.id === 1) {
          child.stdin.write(`${JSON.stringify(requests[1])}\n${JSON.stringify(requests[2])}\n`);
        }
        if (response.id === 2) child.kill();
      } catch (error) {
        child.kill();
        reject(error);
      }
    });
    child.stdin.write(`${JSON.stringify(requests[0])}\n`);
  });
  assert.equal(
    responses.find((response) => response.id === 1).result.serverInfo.version,
    first.version
  );
  assert.equal(responses.find((response) => response.id === 2).result.tools.length, 52);
});

test("optionally bundles local artwork and changes only generated manifest icon fields", (t) => {
  const dir = fixture(t);
  const icon = join(dir, "personal.png");
  const artwork = pngIcon();
  writeFileSync(icon, artwork);
  const output = join(dir, "personal.tar.gz");
  const command = spawnSync(
    process.execPath,
    [join(root, "scripts/package-codex-plugin.mjs"), output, "--icon", icon],
    { cwd: root, encoding: "utf8" }
  );
  assert.equal(command.status, 0, command.stderr);
  const read = (file) => {
    const result = spawnSync("tar", ["-xOf", output, file], { maxBuffer: 10 * 1024 * 1024 });
    assert.equal(result.status, 0, result.stderr.toString());
    return result.stdout;
  };
  assert.deepEqual(read("skills/apple-mail/assets/custom-icon.png"), artwork);
  for (const file of ["plugin.json", ".codex-plugin/plugin.json"]) {
    const expected = JSON.parse(readFileSync(join(root, "codex", file)));
    const ui =
      file === "plugin.json" ? expected.extensions["com.openai"].interface : expected.interface;
    for (const key of ["logo", "logoDark", "composerIcon", "composerIconDark"]) {
      ui[key] = "./skills/apple-mail/assets/custom-icon.png";
    }
    assert.deepEqual(JSON.parse(read(file)), expected);
  }
  assert.deepEqual(read("server/index.js"), readFileSync(join(root, "build/index.js")));
  assert.deepEqual(read("assets/icon.png"), readFileSync(join(root, "codex/assets/icon.png")));
  const again = packageCodexPlugin({ root, output: join(dir, "again.tar.gz"), icon });
  assert.deepEqual(readFileSync(output), readFileSync(again.output));
});

test("rejects malformed, nonsquare, oversized, and symlinked custom icons before output", (t) => {
  const dir = fixture(t);
  const icon = join(dir, "invalid.png");
  const badCrc = pngIcon();
  badCrc[20] ^= 1;
  for (const bytes of [
    Buffer.from("not PNG"),
    pngIcon(48, 49),
    pngIcon(47),
    pngIcon().subarray(0, -1),
    badCrc,
    pngIcon(48, 48, Buffer.from("invalid deflate")),
    pngIcon(2049),
    Buffer.alloc(4 * 1024 * 1024 + 1),
  ]) {
    writeFileSync(icon, bytes);
    const output = join(dir, "rejected.tar.gz");
    assert.throws(() => packageCodexPlugin({ root, output, icon }), /PNG|4 MiB/);
    assert.equal(existsSync(output), false);
  }
  writeFileSync(icon, pngIcon());
  const link = join(dir, "linked.png");
  symlinkSync(icon, link);
  assert.throws(
    () => packageCodexPlugin({ root, output: join(dir, "link.tar.gz"), icon: link }),
    /Symlinked input/
  );
  assert.throws(
    () => packageCodexPlugin({ root, output: join(dir, "directory.tar.gz"), icon: dir }),
    /regular file/
  );
  const invalidFlag = spawnSync(process.execPath, [
    join(root, "scripts/package-codex-plugin.mjs"),
    join(dir, "bad-flag.tar.gz"),
    "--fetch-icon",
    icon,
  ]);
  assert.equal(invalidFlag.status, 1);
  assert.equal(existsSync(join(dir, "bad-flag.tar.gz")), false);
});

test("rejects a named pipe icon without waiting for a writer", (t) => {
  if (process.platform === "win32")
    return t.skip("Named pipes use a different interface on Windows");
  const dir = fixture(t);
  const icon = join(dir, "pipe.png");
  const created = spawnSync("mkfifo", [icon]);
  assert.equal(created.status, 0, created.stderr.toString());
  const output = join(dir, "pipe.tar.gz");
  const result = spawnSync(
    process.execPath,
    [join(root, "scripts/package-codex-plugin.mjs"), output, "--icon", icon],
    { cwd: root, encoding: "utf8", timeout: 5000 }
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Not a regular file/);
  assert.equal(existsSync(output), false);
});

test("excludes private configuration and files outside the allowlist", (t) => {
  const dir = sourceFixture(t);
  writeFileSync(join(dir, "codex/.env"), "SECRET=not-for-distribution");
  writeFileSync(join(dir, "codex/config.json"), '{"password":"not-for-distribution"}');
  const result = packageCodexPlugin({ root: dir, output: join(dir, "plugin.tar.gz") });
  assert.equal(
    result.files.some((file) => /\.env|config\.json/.test(file)),
    false
  );
});

test("reads the validated descriptor even if its pathname is replaced", (t) => {
  const dir = sourceFixture(t);
  const icon = join(dir, "codex/assets/icon.svg");
  const original = readFileSync(icon);
  const identity = fs.statSync(icon);
  const originalFstat = fs.fstatSync;
  let replaced = false;
  fs.fstatSync = (fd, options) => {
    const stat = originalFstat(fd, options);
    if (!replaced && stat.dev === identity.dev && stat.ino === identity.ino) {
      replaced = true;
      fs.renameSync(icon, `${icon}.original`);
      writeFileSync(icon, "replaced after descriptor validation");
    }
    return stat;
  };
  syncBuiltinESMExports();
  let archive;
  try {
    archive = packageCodexPlugin({ root: dir, output: join(dir, "plugin.tar.gz") });
  } finally {
    fs.fstatSync = originalFstat;
    syncBuiltinESMExports();
  }
  assert.equal(replaced, true);
  const extracted = spawnSync("tar", ["-xOf", archive.output, "assets/icon.svg"]);
  assert.equal(extracted.status, 0, extracted.stderr.toString());
  assert.deepEqual(extracted.stdout, original);
});

test("rejects symlinked inputs and output directories", (t) => {
  const dir = sourceFixture(t);
  const icon = join(dir, "codex/assets/icon.svg");
  rmSync(icon);
  symlinkSync(join(root, "codex/assets/icon.svg"), icon);
  assert.throws(
    () => packageCodexPlugin({ root: dir, output: join(dir, "plugin.tar.gz") }),
    /Symlinked input/
  );
  const parent = fixture(t);
  symlinkSync(dir, join(parent, "linked"));
  assert.throws(
    () => packageCodexPlugin({ root, output: join(parent, "linked/plugin.tar.gz") }),
    /nonsymlinked/
  );
});

test("never overwrites existing output or follows an output symlink", (t) => {
  const dir = fixture(t);
  const output = join(dir, "plugin.tar.gz");
  writeFileSync(output, "preserve");
  assert.throws(() => packageCodexPlugin({ root, output }), /EEXIST/);
  assert.equal(readFileSync(output, "utf8"), "preserve");
  const link = join(dir, "linked.tar.gz");
  symlinkSync(output, link);
  assert.throws(() => packageCodexPlugin({ root, output: link }), /EEXIST/);
  assert.equal(readFileSync(output, "utf8"), "preserve");
});

test("rejects release drift and unexpected launcher credentials or commands", (t) => {
  const dir = sourceFixture(t);
  const file = join(dir, "codex/mcp.json");
  const config = JSON.parse(readFileSync(file));
  config.mcpServers["apple-mail"].env = { PASSWORD: "private" };
  writeFileSync(file, JSON.stringify(config));
  assert.throws(
    () => packageCodexPlugin({ root: dir, output: join(dir, "plugin.tar.gz") }),
    /Unexpected launcher/
  );
  const manifestFile = join(dir, "codex/plugin.json");
  const manifest = JSON.parse(readFileSync(manifestFile));
  manifest.version = "0.0.0";
  writeFileSync(manifestFile, JSON.stringify(manifest));
  assert.throws(
    () => packageCodexPlugin({ root: dir, output: join(dir, "plugin.tar.gz") }),
    /version mismatch/
  );
});
