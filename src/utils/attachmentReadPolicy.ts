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

/**
 * Inbound side of the same boundary: where `save-attachment` (and every other
 * `savePath` caller) may CREATE files. Email content is attacker-authored input
 * to the model, so a save path is untrusted too. Until 2.20.54 any directory
 * under the home folder was accepted and the protected-path rules below were
 * applied to reads only, so an injected call could plant a new
 * ~/Library/LaunchAgents plist, a ~/.zshenv, or this server's own config.json.
 * Saves now go only to ordinary document folders plus roots the user names.
 */
export const ATTACHMENT_SAVE_ROOTS_ENV = "APPLE_MAIL_MCP_ATTACHMENT_SAVE_ROOTS";

function defaultAttachmentSaveRoots(): string[] {
  const home = homedir();
  return [
    join(home, "Downloads"),
    join(home, "Desktop"),
    join(home, "Documents"),
    join(home, "Library", "Mobile Documents", "com~apple~CloudDocs"),
    join(home, "Library", "CloudStorage"),
    tmpdir(),
    "/tmp",
    "/private/tmp",
  ];
}

const DEFAULT_ATTACHMENT_READ_ROOTS = [homedir(), "/Volumes", tmpdir(), "/tmp", "/private/tmp"];

const SENSITIVE_HOME_ROOTS = [
  join(homedir(), ".ssh"),
  join(homedir(), ".aws"),
  join(homedir(), ".config", "gh"),
  join(homedir(), "Library", "Keychains"),
];

/**
 * Canonicalize with the platform call, not the JS emulation.
 *
 * `fs.realpathSync` resolves symlinks but preserves whatever casing the caller
 * supplied; only `fs.realpathSync.native` returns the true on-disk name. macOS
 * APFS is case-insensitive by default, so without the native call a denied path
 * is reachable by respelling one segment — `~/library/keychains/login.keychain-db`
 * opens the same file as `~/Library/Keychains/...` but matches no deny root.
 *
 * Normalizing both the candidate and the roots this way keeps exact comparison
 * correct on case-sensitive volumes too, where the respelling simply does not
 * exist and canonicalization throws.
 */
function canonicalize(path: string): string {
  return realpathSync.native(path);
}

/** Deny roots in their true on-disk spelling; unresolvable entries keep their literal form. */
function sensitiveRoots(): string[] {
  return SENSITIVE_HOME_ROOTS.map((root) => {
    try {
      return canonicalize(root);
    } catch {
      return root;
    }
  });
}

/** The home directory in its on-disk spelling, or undefined when it cannot be resolved. */
function homeCanonical(): string | undefined {
  try {
    return canonicalize(homedir());
  } catch {
    return undefined;
  }
}

function isWithinRoot(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(root + sep);
}

function hasHiddenPathSegment(candidate: string): boolean {
  return candidate.split(sep).some((segment) => segment.startsWith(".") && segment.length > 1);
}

/**
 * Folders under a user Library that hold ordinary user documents: iCloud Drive
 * itself (not the per-app iCloud containers beside it) and File Provider
 * clouds such as Dropbox or Google Drive. Everything else under a Library is
 * app state — Mail and Messages stores, browser cookies and logins,
 * LaunchAgents — and is neither read nor written.
 */
const LIBRARY_DOCUMENT_FOLDERS = [["mobile documents", "com~apple~clouddocs"], ["cloudstorage"]];

/**
 * The lower-cased segments below a user Library in `candidate`, or undefined
 * when it is not inside one. Matches the live home's Library and any
 * `…/Users/<name>/Library` — the same stores on a clone, a backup or another
 * Data volume under /Volumes — whatever casing or HOME value the caller used.
 */
function userLibraryTail(candidate: string): string[] | undefined {
  const segments = candidate.split(sep).filter(Boolean);
  const lower = segments.map((segment) => segment.toLowerCase());
  // `Users` sits at the top of a volume: the boot volume, another volume under
  // /Volumes, or the Data volume. A `users/x/library` deeper down is just a folder.
  const volumeTops = [
    0,
    lower[0] === "volumes" ? 2 : -1,
    lower.slice(0, 3).join("/") === "system/volumes/data" ? 3 : -1,
  ];
  for (const i of volumeTops) {
    if (i >= 0 && lower[i] === "users" && lower[i + 2] === "library") return lower.slice(i + 3);
  }

  const home = homeCanonical() ?? resolve(homedir());
  if (home === sep || !isWithinRoot(candidate, home)) return undefined;
  const relative = candidate.slice(home.length).split(sep).filter(Boolean);
  if (relative[0]?.toLowerCase() !== "library") return undefined;
  return relative.slice(1).map((segment) => segment.toLowerCase());
}

function isLibraryDocument(tail: string[]): boolean {
  return LIBRARY_DOCUMENT_FOLDERS.some((folder) => folder.every((name, i) => tail[i] === name));
}

/**
 * True for a path that must never be attached or written: hidden segments,
 * credential roots, and any user Library outside its document folders.
 * `exemptRoots` (canonical) lift only the Library rule — for the server's own
 * temporary directory and for roots the user named explicitly.
 */
export function isProtectedPath(candidate: string, exemptRoots: string[] = []): boolean {
  if (hasHiddenPathSegment(candidate)) return true;
  if (sensitiveRoots().some((root) => isWithinRoot(candidate, root))) return true;

  const tail = userLibraryTail(candidate);
  if (!tail || isLibraryDocument(tail)) return false;
  // A root that holds the whole home directory would lift the rule for every app's
  // config and store (this server's own config.json among them): it cannot.
  const home = homeCanonical();
  return !exemptRoots.some(
    (root) => isWithinRoot(candidate, root) && !(home && isWithinRoot(home, root))
  );
}

/** Canonical temporary directory, which the server itself writes to (attachment staging). */
export function canonicalTmpdir(): string[] {
  try {
    return [canonicalize(tmpdir())];
  } catch {
    return [];
  }
}

/**
 * Canonicalize roots, dropping the ones that do not exist and the filesystem
 * root itself: an empty or "/" HOME must not turn "the home directory" into
 * "everything".
 */
export function canonicalRoots(requested: string[]): string[] {
  const resolved: string[] = [];
  for (const root of requested) {
    try {
      const canonical = canonicalize(resolve(root));
      if (canonical !== sep && !resolved.includes(canonical)) resolved.push(canonical);
    } catch {
      // A default user directory may not exist yet. It cannot authorize a
      // file until it exists, so skip it and let the candidate check fail.
    }
  }
  return resolved;
}

function explicitRoots(env: NodeJS.ProcessEnv, variable = ATTACHMENT_READ_ROOTS_ENV): string[] {
  const raw = env[variable];
  const extraRoots =
    raw === undefined
      ? []
      : raw
          .split(delimiter)
          .map((root) => root.trim())
          .filter(Boolean);
  for (const root of extraRoots) {
    if (!isAbsolute(root)) {
      throw new Error(`${variable} entries must be absolute paths.`);
    }
  }
  return canonicalRoots(extraRoots);
}

/**
 * Resolve and authorize one existing regular attachment file.
 *
 * The returned canonical path is what callers should pass to a downstream
 * reader. Symlinks are resolved before the root check, so a link inside an
 * allowed directory cannot escape to a sensitive location; the protected-path
 * rules also apply to the path as given, so a hidden link to an ordinary file
 * is refused too.
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
    canonical = canonicalize(filePath);
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

  // Both spellings are judged: the one the caller typed too, not only the target
  // it resolves to. A hidden path that is a symlink to a visible file (a dotfile
  // manager's `~/.npmrc` -> `~/dotfiles/npmrc`) names a credential location all
  // the same, and the target alone looks ordinary.
  const explicit = explicitRoots(env);
  const exempt = [...explicit, ...canonicalTmpdir()];
  if (isProtectedPath(canonical, exempt) || isProtectedPath(resolve(filePath), exempt)) {
    throw new Error(
      `Attachment path is in a protected location: "${filePath}". ` +
        "Hidden files, credential locations and user Library folders (except iCloud Drive and CloudStorage) " +
        `cannot be sent as attachments unless ${ATTACHMENT_READ_ROOTS_ENV} names a root for them.`
    );
  }

  const roots = [...canonicalRoots(DEFAULT_ATTACHMENT_READ_ROOTS), ...explicit];
  if (!roots.some((root) => isWithinRoot(canonical, root))) {
    throw new Error(
      `Attachment path is outside the allowed read roots: "${filePath}". ` +
        `Use an ordinary home-directory, /Volumes, or temporary path, or configure ${ATTACHMENT_READ_ROOTS_ENV} for an additional explicit root.`
    );
  }

  return canonical;
}

/** Canonical roots a save may write under: the document-folder defaults plus explicit ones. */
export function attachmentSaveRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  return [
    ...canonicalRoots(defaultAttachmentSaveRoots()),
    ...explicitRoots(env, ATTACHMENT_SAVE_ROOTS_ENV),
  ];
}

/** True when `candidate` is one of the save roots or strictly inside one. */
export function isWithinSaveRoots(
  candidate: string,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return attachmentSaveRoots(env).some((root) => isWithinRoot(candidate, root));
}

/**
 * True when a save to `candidate` must be refused by the protected-path rules:
 * hidden segments, credential roots, and user Library folders other than
 * iCloud Drive / CloudStorage. Explicit save roots lift only the Library rule,
 * exactly as explicit read roots do, and never one that contains the home folder.
 */
export function isProtectedSaveTarget(
  candidate: string,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return isProtectedPath(candidate, [
    ...explicitRoots(env, ATTACHMENT_SAVE_ROOTS_ENV),
    ...canonicalTmpdir(),
  ]);
}
