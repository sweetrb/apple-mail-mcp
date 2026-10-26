import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, parse, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync, inflateSync } from "node:zlib";

const pluginFiles = [
  "plugin.json",
  "mcp.json",
  ".codex-plugin/plugin.json",
  ".mcp.json",
  "assets/icon.png",
  "assets/icon.svg",
  "assets/screenshot.png",
  "assets/screenshot.svg",
  "skills/apple-mail/SKILL.md",
];

function readRegularFile(root, relative, maxBytes = Infinity) {
  let current = root;
  for (const part of relative.split("/")) {
    current = join(current, part);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error(`Symlinked input: ${relative}`);
  }
  const fd = openSync(current, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error(`Not a regular file: ${relative}`);
    if (stat.size > maxBytes) throw new Error("Icon exceeds the 4 MiB limit");
    if (Number.isFinite(maxBytes)) {
      const bytes = Buffer.alloc(maxBytes + 1);
      let length = 0;
      let count;
      while ((count = readSync(fd, bytes, length, bytes.length - length, null)) > 0) {
        length += count;
        if (length > maxBytes) throw new Error("Icon exceeds the 4 MiB limit");
      }
      return bytes.subarray(0, length);
    }
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

const jsonBytes = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);

// Validate local artwork without fetching assets or trusting its extension.
function readIcon(path) {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  const png = readRegularFile(root, absolute.slice(root.length), 4 * 1024 * 1024);
  const invalid = () => {
    throw new Error("Icon must be a valid square PNG (48–2,048 pixels)");
  };
  if (!png.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) invalid();
  let offset = 8;
  let width, depth, channels, color;
  let ended = false;
  let palette = false;
  let dataEnded = false;
  const data = [];
  while (offset + 12 <= png.length) {
    const length = png.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > png.length) invalid();
    const type = png.toString("ascii", offset + 4, offset + 8);
    if (!/^[A-Za-z]{4}$/.test(type) || type[2] !== type[2].toUpperCase()) invalid();
    if (/^[A-Z]/.test(type) && !["IHDR", "PLTE", "IDAT", "IEND"].includes(type)) invalid();
    let crc = 0xffffffff;
    for (const byte of png.subarray(offset + 4, end - 4)) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    if ((crc ^ 0xffffffff) >>> 0 !== png.readUInt32BE(end - 4)) invalid();
    if (offset === 8) {
      if (type !== "IHDR" || length !== 13) invalid();
      width = png.readUInt32BE(offset + 8);
      const height = png.readUInt32BE(offset + 12);
      depth = png[offset + 16];
      color = png[offset + 17];
      channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[color];
      const depths = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
      if (
        width < 48 ||
        width > 2048 ||
        width !== height ||
        !depths[color]?.includes(depth) ||
        png[offset + 18] !== 0 ||
        png[offset + 19] !== 0 ||
        png[offset + 20] !== 0
      )
        invalid();
    } else if (type === "IHDR") invalid();
    if (type === "PLTE") {
      if (
        palette ||
        data.length ||
        color === 0 ||
        color === 4 ||
        !length ||
        length % 3 ||
        length > 768 ||
        (color === 3 && length / 3 > 2 ** depth)
      )
        invalid();
      palette = true;
    }
    if (type === "IDAT") {
      if (dataEnded || (color === 3 && !palette)) invalid();
      data.push(png.subarray(offset + 8, end - 4));
    } else if (data.length) dataEnded = true;
    if (type === "IEND") {
      if (length || end !== png.length) invalid();
      ended = true;
      break;
    }
    offset = end;
  }
  if (!ended || !data.length) invalid();
  const stride = Math.ceil((width * channels * depth) / 8) + 1;
  let pixels;
  try {
    pixels = inflateSync(Buffer.concat(data), { maxOutputLength: stride * width });
  } catch {
    invalid();
  }
  if (pixels.length !== stride * width) invalid();
  for (let row = 0; row < width; row++) if (pixels[row * stride] > 4) invalid();
  return png;
}

// Fixed ordering, modes, owners, and timestamps make identical inputs produce
// identical archives on macOS and Linux without a platform-specific tar CLI.
function tarEntry(name, contents) {
  if (Buffer.byteLength(name) > 100 || !/^[.a-zA-Z0-9_/-]+$/.test(name)) {
    throw new Error("Unsupported archive path");
  }
  const header = Buffer.alloc(512);
  const octal = (value, offset, width) =>
    header.write(`${value.toString(8).padStart(width - 1, "0")}\0`, offset, width, "ascii");
  header.write(name, 0, 100, "utf8");
  octal(0o644, 100, 8);
  octal(0, 108, 8);
  octal(0, 116, 8);
  octal(contents.length, 124, 12);
  octal(0, 136, 12);
  header.fill(0x20, 148, 156);
  header.write("0", 156);
  header.write("ustar\0", 257);
  header.write("00", 263);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return [header, contents, Buffer.alloc((512 - (contents.length % 512)) % 512)];
}

export function packageCodexPlugin({ root, output, icon }) {
  root = resolve(root);
  output = resolve(output);
  if (realpathSync(root) !== root || realpathSync(dirname(output)) !== dirname(output)) {
    throw new Error("Repository and output directory must use real, nonsymlinked paths");
  }
  if (!output.endsWith(".tar.gz")) throw new Error("Output must end in .tar.gz");
  const pkg = JSON.parse(readRegularFile(root, "package.json"));
  const files = new Map(pluginFiles.map((name) => [name, readRegularFile(root, `codex/${name}`)]));
  const portable = JSON.parse(files.get("plugin.json"));
  const legacy = JSON.parse(files.get(".codex-plugin/plugin.json"));
  if (
    pkg.name !== "apple-mail-mcp" ||
    portable.name !== "apple-mail" ||
    legacy.name !== portable.name ||
    !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(pkg.version) ||
    portable.version !== pkg.version ||
    legacy.version !== pkg.version
  ) {
    throw new Error("Plugin identity or release version mismatch");
  }
  if (icon !== undefined) {
    const path = "./skills/apple-mail/assets/custom-icon.png";
    files.set(path.slice(2), readIcon(icon));
    for (const ui of [portable.extensions["com.openai"].interface, legacy.interface]) {
      for (const field of ["logo", "logoDark", "composerIcon", "composerIconDark"])
        ui[field] = path;
    }
    files.set("plugin.json", jsonBytes(portable));
    files.set(".codex-plugin/plugin.json", jsonBytes(legacy));
  }
  for (const name of ["mcp.json", ".mcp.json"]) {
    const config = JSON.parse(files.get(name));
    const expected = { command: "npx", args: ["-y", `apple-mail-mcp@${pkg.version}`] };
    if (name === "mcp.json") expected.type = "stdio";
    const server = config.mcpServers?.["apple-mail"];
    if (
      Object.keys(config.mcpServers ?? {}).join() !== "apple-mail" ||
      !server ||
      Object.keys(server).length !== Object.keys(expected).length ||
      Object.entries(expected).some(
        ([key, value]) => JSON.stringify(server[key]) !== JSON.stringify(value)
      )
    ) {
      throw new Error(`Unexpected launcher configuration: ${name}`);
    }
    config.mcpServers["apple-mail"] = {
      ...(name === "mcp.json" ? { type: "stdio" } : {}),
      command: "node",
      args: ["${PLUGIN_ROOT}/server/index.js"],
    };
    files.set(name, jsonBytes(config));
  }
  files.set("server/index.js", readRegularFile(root, "build/index.js"));
  files.set("LICENSE", readRegularFile(root, "LICENSE"));
  files.set(
    "package.json",
    jsonBytes({
      name: pkg.name,
      version: pkg.version,
      type: "module",
      license: pkg.license,
      engines: { node: ">=20.0.0" },
      os: ["darwin"],
    })
  );
  const blocks = [...files.entries()]
    .sort(([a], [b]) => a.localeCompare(b, "en"))
    .flatMap(([name, bytes]) => tarEntry(name, bytes));
  const archive = gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]), { level: 9 });
  // Exclusive creation never follows or overwrites an existing file/symlink.
  writeFileSync(output, archive, { flag: "wx", mode: 0o600 });
  return { output, version: pkg.version, files: [...files.keys()].sort(), bytes: archive.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3 && !(process.argv.length === 5 && process.argv[3] === "--icon")) {
    console.error("Usage: node scripts/package-codex-plugin.mjs output.tar.gz [--icon local.png]");
    process.exitCode = 1;
  } else {
    try {
      console.log(
        JSON.stringify(
          packageCodexPlugin({
            root: process.cwd(),
            output: process.argv[2],
            icon: process.argv[4],
          })
        )
      );
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}
