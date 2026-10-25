/** Explicit, local Google desktop authorization. Importing this module performs no I/O. */
import * as oauth from "oauth4webapi";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rename, unlink, rmdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface GoogleCredentialRef {
  provider: "google";
  clientId: string;
  email: string;
}
export interface GoogleGrant {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  subject: string;
  email: string;
}
export interface GrantStore {
  revision(ref: GoogleCredentialRef): Promise<string>;
  snapshot(ref: GoogleCredentialRef): Promise<{ revision: string; grant: GoogleGrant | null }>;
  read(ref: GoogleCredentialRef): Promise<GoogleGrant | null>;
  write(ref: GoogleCredentialRef, grant: GoogleGrant, expectedRevision: string): Promise<void>;
  remove(ref: GoogleCredentialRef): Promise<void>;
}
const SERVICE = "apple-mail-mcp.oauth.google.v1";
export const GOOGLE_SCOPES = "openid email https://mail.google.com/";
export const GOOGLE_SERVER: oauth.AuthorizationServer = {
  issuer: "https://accounts.google.com",
  authorization_endpoint: "https://accounts.google.com/o/oauth2/v2/auth",
  token_endpoint: "https://oauth2.googleapis.com/token",
  jwks_uri: "https://www.googleapis.com/oauth2/v3/certs",
};
function key(ref: GoogleCredentialRef): string {
  return createHash("sha256").update(`${ref.clientId}\n${ref.email.toLowerCase()}`).digest("hex");
}
function checkRef(ref: GoogleCredentialRef): void {
  if (
    ref.provider !== "google" ||
    !/^[\w.-]+\.apps\.googleusercontent\.com$/.test(ref.clientId) ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ref.email)
  ) {
    throw new Error("Configure a Google Desktop client ID and the expected account email.");
  }
}
function security(args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "/usr/bin/security",
      args,
      { encoding: "utf8", maxBuffer: 128 * 1024, timeout: 15_000 },
      (error, stdout) =>
        error ? reject(new Error("OAuth Keychain operation failed.")) : resolve(stdout)
    );
    // security's interactive parser receives secrets over a pipe, never argv or a shell.
    child.stdin?.end(input);
  });
}
function quote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
export class KeychainGrantStore implements GrantStore {
  constructor(
    private readonly stateDirectory = join(
      homedir(),
      "Library",
      "Application Support",
      "apple-mail-mcp",
      "oauth-state"
    )
  ) {}
  private revisionPath(ref: GoogleCredentialRef): string {
    return join(this.stateDirectory, `${key(ref)}.revision`);
  }
  async revision(ref: GoogleCredentialRef): Promise<string> {
    try {
      return await readFile(this.revisionPath(ref), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
      throw new Error("OAuth revision storage is unavailable.");
    }
  }
  private async locked<T>(ref: GoogleCredentialRef, action: () => Promise<T>): Promise<T> {
    await mkdir(this.stateDirectory, { recursive: true, mode: 0o700 });
    const lock = join(this.stateDirectory, `${key(ref)}.lock`);
    const deadline = Date.now() + 10_000;
    for (;;) {
      try {
        await mkdir(lock, { mode: 0o700 });
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST")
          throw new Error("OAuth storage lock is unavailable.");
        if (Date.now() >= deadline)
          throw new Error(
            `OAuth storage is busy. If a process crashed, stop all mail MCP/auth processes before removing the empty lock directory: ${lock}`
          );
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    try {
      return await action();
    } finally {
      await rmdir(lock);
    }
  }
  private async advance(ref: GoogleCredentialRef): Promise<void> {
    const target = this.revisionPath(ref);
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      // This file contains only an opaque revision, never a token or account address.
      await writeFile(temporary, randomUUID(), { encoding: "utf8", mode: 0o600, flag: "wx" });
      await rename(temporary, target);
    } finally {
      await unlink(temporary).catch(() => {});
    }
  }
  async read(ref: GoogleCredentialRef): Promise<GoogleGrant | null> {
    // Readers must not bind an in-progress revision to the previous Keychain
    // value. A separate revision read can be stale, which safely fails CAS,
    // but the grant itself must never be observed during a mutation.
    return this.locked(ref, () => this.readUnlocked(ref));
  }
  async snapshot(
    ref: GoogleCredentialRef
  ): Promise<{ revision: string; grant: GoogleGrant | null }> {
    return this.locked(ref, async () => ({
      revision: await this.revision(ref),
      grant: await this.readUnlocked(ref),
    }));
  }
  private async readUnlocked(ref: GoogleCredentialRef): Promise<GoogleGrant | null> {
    // A missing item is distinct from an inaccessible/locked Keychain.
    return new Promise((resolve, reject) => {
      execFile(
        "/usr/bin/security",
        ["find-generic-password", "-s", SERVICE, "-a", key(ref), "-w"],
        { encoding: "utf8", maxBuffer: 128 * 1024, timeout: 15_000 },
        (error, stdout) => {
          if (error) {
            if (Number(error.code) === 44) resolve(null);
            else reject(new Error("OAuth Keychain is unavailable; unlock it and retry."));
            return;
          }
          try {
            const grant = JSON.parse(stdout) as GoogleGrant;
            if (
              !grant.accessToken ||
              !grant.refreshToken ||
              !Number.isFinite(grant.expiresAt) ||
              !grant.subject ||
              grant.email !== ref.email.toLowerCase()
            )
              throw new Error();
            resolve(grant);
          } catch {
            reject(new Error("Stored OAuth credential is invalid; reconnect this account."));
          }
        }
      );
    });
  }
  async write(
    ref: GoogleCredentialRef,
    grant: GoogleGrant,
    expectedRevision: string
  ): Promise<void> {
    await this.locked(ref, async () => {
      if ((await this.revision(ref)) !== expectedRevision)
        throw new Error("OAuth credentials changed in another process; retry the operation.");
      await this.advance(ref);
      await security(
        ["-i"],
        `add-generic-password -U -s ${quote(SERVICE)} -a ${quote(key(ref))} -w ${quote(JSON.stringify(grant))}\n`
      );
      // Interactive security can exit successfully even when its command failed.
      const saved = await this.readUnlocked(ref);
      if (JSON.stringify(saved) !== JSON.stringify(grant))
        throw new Error("OAuth Keychain write could not be verified.");
    });
  }
  async remove(ref: GoogleCredentialRef): Promise<void> {
    await this.locked(ref, async () => {
      await this.advance(ref);
      if (await this.readUnlocked(ref))
        await security(["delete-generic-password", "-s", SERVICE, "-a", key(ref)]);
    });
  }
}
export type OpenBrowser = (url: string) => Promise<void>;
export const openSystemBrowser: OpenBrowser = (url) =>
  new Promise((resolve, reject) => {
    execFile("/usr/bin/open", [url], (error) =>
      error ? reject(new Error("Could not open the system browser.")) : resolve()
    );
  });

/** Dependency injection is for fixtures; production uses fixed Google HTTPS endpoints. */
export class GmailOAuthManager {
  private readonly active = new Map<string, AbortController>();
  private readonly refreshes = new Map<string, Promise<string>>();
  private readonly generations = new Map<string, number>();
  private readonly writes = new Map<string, Promise<unknown>>();
  private readonly invalidators = new Set<(ref: GoogleCredentialRef) => void>();
  constructor(
    private readonly store: GrantStore = new KeychainGrantStore(),
    private readonly server: oauth.AuthorizationServer = GOOGLE_SERVER,
    private readonly requestOptions: oauth.TokenEndpointRequestOptions &
      oauth.ValidateSignatureOptions = {}
  ) {}

  onDisconnect(callback: (ref: GoogleCredentialRef) => void): () => void {
    this.invalidators.add(callback);
    return () => this.invalidators.delete(callback);
  }
  private serial<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const next = (this.writes.get(id) ?? Promise.resolve()).catch(() => {}).then(operation);
    this.writes.set(id, next);
    void next
      .finally(() => {
        if (this.writes.get(id) === next) this.writes.delete(id);
      })
      .catch(() => {});
    return next;
  }
  private version(ref: GoogleCredentialRef): number {
    return this.generations.get(key(ref)) ?? 0;
  }
  connectionGuard(ref: GoogleCredentialRef): () => void {
    const generation = this.version(ref);
    return () => {
      if (generation !== this.version(ref))
        throw new Error("Google account disconnected during connection.");
    };
  }
  private assertCurrent(ref: GoogleCredentialRef, generation: number, signal: AbortSignal): void {
    if (signal.aborted || generation !== this.version(ref))
      throw new Error("OAuth operation canceled.");
  }
  async status(ref: GoogleCredentialRef): Promise<{
    provider: "google";
    email: string;
    state: "connected" | "refresh-required" | "disconnected";
  }> {
    checkRef(ref);
    const grant = await this.store.read(ref);
    return {
      provider: "google",
      email: ref.email,
      state: !grant
        ? "disconnected"
        : grant.expiresAt > Date.now() + 60_000
          ? "connected"
          : "refresh-required",
    };
  }
  async disconnect(ref: GoogleCredentialRef): Promise<void> {
    checkRef(ref);
    const id = key(ref);
    this.generations.set(id, this.version(ref) + 1);
    this.active.get(id)?.abort();
    for (const invalidate of this.invalidators) invalidate(ref);
    await this.serial(id, () => this.store.remove(ref));
  }
  async connect(
    ref: GoogleCredentialRef,
    options: { openBrowser?: OpenBrowser; signal?: AbortSignal; timeoutMs?: number } = {}
  ): Promise<void> {
    checkRef(ref);
    const id = key(ref);
    if (this.active.has(id))
      throw new Error("An OAuth operation is already in progress for this account.");
    const controller = new AbortController();
    const signal = AbortSignal.any([
      controller.signal,
      options.signal ?? new AbortController().signal,
      AbortSignal.timeout(Math.min(options.timeoutMs ?? 180_000, 300_000)),
    ]);
    const generation = this.version(ref);
    this.active.set(id, controller);
    const client: oauth.Client = { client_id: ref.clientId, id_token_signed_response_alg: "RS256" };
    const state = oauth.generateRandomState();
    const nonce = oauth.generateRandomNonce();
    const verifier = oauth.generateRandomCodeVerifier();
    const server = createServer();
    let consumed = false;
    try {
      const revision = await this.store.revision(ref);
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      if (!address || typeof address === "string") throw new Error();
      const redirect = `http://127.0.0.1:${address.port}/oauth/callback`;
      const callback = new Promise<URL>((resolve, reject) => {
        const abort = () => reject(new Error("OAuth operation canceled or timed out."));
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
        server.on("request", (req, res) => {
          res.setHeader("Cache-Control", "no-store");
          res.setHeader("Content-Security-Policy", "default-src 'none'");
          if (
            consumed ||
            req.method !== "GET" ||
            req.headers.host !== `127.0.0.1:${address.port}` ||
            !req.url?.startsWith("/oauth/callback?")
          ) {
            res.writeHead(404).end();
            return;
          }
          const url = new URL(req.url, redirect);
          if (
            url.searchParams.getAll("state").length !== 1 ||
            url.searchParams.get("state") !== state
          ) {
            res.writeHead(400).end("Invalid sign-in response.");
            return;
          }
          consumed = true;
          signal.removeEventListener("abort", abort);
          res.end("Sign-in response received. Return to the terminal to check the result.");
          resolve(url);
        });
      });
      // Attach a handler before opening the browser so cancellation cannot create an unhandled rejection.
      void callback.catch(() => {});
      const url = new URL(this.server.authorization_endpoint!);
      url.search = new URLSearchParams({
        client_id: ref.clientId,
        redirect_uri: redirect,
        response_type: "code",
        scope: GOOGLE_SCOPES,
        state,
        nonce,
        access_type: "offline",
        prompt: "consent",
        login_hint: ref.email,
        code_challenge_method: "S256",
        code_challenge: await oauth.calculatePKCECodeChallenge(verifier),
      }).toString();
      this.assertCurrent(ref, generation, signal);
      await (options.openBrowser ?? openSystemBrowser)(url.href);
      const parameters = oauth.validateAuthResponse(this.server, client, await callback, state);
      this.assertCurrent(ref, generation, signal);
      const response = await oauth.authorizationCodeGrantRequest(
        this.server,
        client,
        oauth.None(),
        parameters,
        redirect,
        verifier,
        { ...this.requestOptions, signal }
      );
      const tokens = await oauth.processAuthorizationCodeResponse(this.server, client, response, {
        expectedNonce: nonce,
        requireIdToken: true,
      });
      await oauth.validateApplicationLevelSignature(this.server, response, {
        ...this.requestOptions,
        signal,
      });
      const claims = oauth.getValidatedIdTokenClaims(tokens)!;
      if (
        claims.email_verified !== true ||
        typeof claims.email !== "string" ||
        claims.email.toLowerCase() !== ref.email.toLowerCase()
      ) {
        throw new Error("Google signed in a different or unverified account.");
      }
      this.validateTokens(tokens, true);
      const grant: GoogleGrant = {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token!,
        expiresAt: Date.now() + tokens.expires_in! * 1000,
        subject: claims.sub,
        email: claims.email.toLowerCase(),
      };
      await this.serial(id, async () => {
        this.assertCurrent(ref, generation, signal);
        await this.store.write(ref, grant, revision);
      });
      this.assertCurrent(ref, generation, signal);
    } catch {
      throw new Error(
        "Google authorization failed or was canceled. Check the client registration, consent, and selected account; retry connect."
      );
    } finally {
      server.closeAllConnections();
      server.close();
      if (this.active.get(id) === controller) this.active.delete(id);
    }
  }
  private validateTokens(tokens: oauth.TokenEndpointResponse, initial: boolean): void {
    if (
      tokens.token_type.toLowerCase() !== "bearer" ||
      !tokens.expires_in ||
      tokens.expires_in <= 0 ||
      (initial && !tokens.refresh_token)
    )
      throw new Error("Invalid Google grant.");
    // Refresh responses may omit scope, retaining the original grant (RFC 6749).
    const scopes = new Set(tokens.scope?.split(" "));
    if (scopes.has("https://www.googleapis.com/auth/userinfo.email")) scopes.add("email");
    if (
      (initial || tokens.scope !== undefined) &&
      !GOOGLE_SCOPES.split(" ").every((s) => scopes.has(s))
    ) {
      throw new Error("Google did not grant all required scopes.");
    }
  }
  async accessToken(ref: GoogleCredentialRef): Promise<string> {
    checkRef(ref);
    const id = key(ref);
    const running = this.refreshes.get(id);
    if (running) return running;
    const generation = this.version(ref);
    const controller = new AbortController();
    if (this.active.has(id)) throw new Error("Google sign-in is in progress; retry afterward.");
    this.active.set(id, controller);
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]);
    const promise = (async () => {
      try {
        const { revision, grant } = await this.store.snapshot(ref);
        this.assertCurrent(ref, generation, signal);
        if (!grant) throw new Error();
        if (grant.expiresAt > Date.now() + 60_000) return grant.accessToken;
        const client = { client_id: ref.clientId, id_token_signed_response_alg: "RS256" };
        const response = await oauth.refreshTokenGrantRequest(
          this.server,
          client,
          oauth.None(),
          grant.refreshToken,
          { ...this.requestOptions, signal }
        );
        const tokens = await oauth.processRefreshTokenResponse(this.server, client, response);
        this.validateTokens(tokens, false);
        if (tokens.id_token) {
          await oauth.validateApplicationLevelSignature(this.server, response, {
            ...this.requestOptions,
            signal,
          });
          const claims = oauth.getValidatedIdTokenClaims(tokens)!;
          if (
            claims.sub !== grant.subject ||
            (claims.email !== undefined &&
              (claims.email !== grant.email || claims.email_verified !== true))
          )
            throw new Error();
        }
        const updated = {
          ...grant,
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token ?? grant.refreshToken,
          expiresAt: Date.now() + tokens.expires_in! * 1000,
        };
        await this.serial(id, async () => {
          this.assertCurrent(ref, generation, signal);
          await this.store.write(ref, updated, revision);
        });
        this.assertCurrent(ref, generation, signal);
        return updated.accessToken;
      } catch {
        throw new Error(
          "Google credential unavailable or expired. Reconnect this account; no password fallback was attempted."
        );
      } finally {
        if (this.active.get(id) === controller) this.active.delete(id);
      }
    })();
    this.refreshes.set(id, promise);
    try {
      return await promise;
    } finally {
      if (this.refreshes.get(id) === promise) this.refreshes.delete(id);
    }
  }
}
export const gmailOAuth = new GmailOAuthManager();
