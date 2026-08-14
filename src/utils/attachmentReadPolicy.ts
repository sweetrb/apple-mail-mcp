/**
 * Filesystem boundary for outbound attachments.
 *
 * Attachment paths are read by either Mail.app or Nodemailer. Keep those
 * reads inside ordinary user-content roots by default so an absolute path
 * supplied by an untrusted caller cannot turn `send-email` or `create-draft`
 * into an arbitrary local-file disclosure primitive. Hidden files and known
 * credential/configuration locations remain denied even under the home root.
 * Extra roots require an explicit APPLE_MAIL_MCP_ATTACHMENT_READ_ROOTS setting.
 */
import { realpathSync, statSync } from "fs";
import { homedir, tmpdir } from "os";
import { delimiter, isAbsolute, join, resolve, sep } from "path";

export const ATTACHMENT_READ_ROOTS_ENV = "APPLE_MAIL_MCP_ATTACHMENT_READ_ROOTS";

const DEFAULT_ATTACHMENT_READ_ROOTS = [homedir(), "/Volumes", tmpdir(), "/tmp", "/private/tmp"];

const SENSITIVE_HOME_ROOTS = [
  join(homedir(), ".ssh"),
  join(homedir(), ".aws"),
  join(homedir(), ".config", "gh"),
  join(homedir(), "Library", "Keychains"),
];

function isWithinRoot(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(root + sep);
}

function hasHiddenPathSegment(candidate: string): boolean {
  return candidate.split(sep).some((segment) => segment.startsWith(".") && segment.length > 1);
}

function isProtectedPath(candidate: string): boolean {
  if (hasHiddenPathSegment(candidate)) return true;
  if (SENSITIVE_HOME_ROOTS.some((root) => isWithinRoot(candidate, root))) return true;

  const home = resolve(homedir());
  if (!isWithinRoot(candidate, home)) return false;
  const relative = candidate.slice(home.length).split(sep).filter(Boolean);
  return (
    relative.length >= 4 &&
    relative[0].toLowerCase() === "library" &&
    relative[1].toLowerCase() === "application support" &&
    relative.at(-1)?.toLowerCase() === "config.json"
  );
}

function configuredRoots(env: NodeJS.ProcessEnv): string[] {
  const raw = env[ATTACHMENT_READ_ROOTS_ENV];
  const extraRoots =
    raw === undefined
      ? []
      : raw
          .split(delimiter)
          .map((root) => root.trim())
          .filter(Boolean);
  const requested = [...DEFAULT_ATTACHMENT_READ_ROOTS, ...extraRoots];

  for (const root of requested) {
    if (!isAbsolute(root)) {
      throw new Error(`${ATTACHMENT_READ_ROOTS_ENV} entries must be absolute paths.`);
    }
  }

  const resolved: string[] = [];
  for (const root of requested) {
    try {
      const canonical = realpathSync(resolve(root));
      if (!resolved.includes(canonical)) resolved.push(canonical);
    } catch {
      // A default user directory may not exist yet. It cannot authorize a
      // file until it exists, so skip it and let the candidate check fail.
    }
  }
  return resolved;
}

/**
 * Resolve and authorize one existing regular attachment file.
 *
 * The returned canonical path is what callers should pass to a downstream
 * reader. Symlinks are resolved before the root check, so a link inside an
 * allowed directory cannot escape to a sensitive location.
 */
export function resolveAttachmentReadPath(
  filePath: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  if (!isAbsolute(filePath)) {
    throw new Error(`Attachment path must be absolute: "${filePath}"`);
  }

  let canonical: string;
  try {
    canonical = realpathSync(filePath);
  } catch {
    throw new Error(`Attachment file not found: "${filePath}"`);
  }

  try {
    if (!statSync(canonical).isFile()) {
      throw new Error(`Attachment path is not a regular file: "${filePath}"`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes("not a regular file")) throw error;
    throw new Error(`Attachment file not found: "${filePath}"`);
  }

  if (isProtectedPath(canonical)) {
    throw new Error(
      `Attachment path is in a protected location: "${filePath}". ` +
        "Hidden files and credential/configuration locations cannot be sent as attachments."
    );
  }

  if (!configuredRoots(env).some((root) => isWithinRoot(canonical, root))) {
    throw new Error(
      `Attachment path is outside the allowed read roots: "${filePath}". ` +
        `Use an ordinary home-directory, /Volumes, or temporary path, or configure ${ATTACHMENT_READ_ROOTS_ENV} for an additional explicit root.`
    );
  }

  return canonical;
}
