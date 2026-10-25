import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { generateKeyPairSync, sign, createHash } from "node:crypto";
import * as oauth from "oauth4webapi";
import {
  GmailOAuthManager,
  GOOGLE_SCOPES,
  type GoogleAccountBinding,
  type GoogleGrant,
  type GrantStore,
} from "./gmailOAuth.js";
import { resolveCredential, validateOAuthTransport } from "./credentials.js";

const ref: GoogleAccountBinding = {
  provider: "google",
  clientId: "fixture.apps.googleusercontent.com",
  email: "person@example.com",
};
class MemoryStore implements GrantStore {
  currentRevision = 0;
  revision = vi.fn(async () => String(this.currentRevision));
  snapshot = vi.fn(async () => ({ revision: String(this.currentRevision), grant: this.grant }));
  grant: GoogleGrant | null = null;
  read = vi.fn(async () => this.grant);
  write = vi.fn(
    async (_ref: GoogleAccountBinding, grant: GoogleGrant, expectedRevision: string) => {
      if (expectedRevision !== String(this.currentRevision))
        throw new Error("Stale credential write");
      this.currentRevision++;
      this.grant = grant;
    }
  );
  remove = vi.fn(async () => {
    this.currentRevision++;
    this.grant = null;
  });
}
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function fixture(overrides: Record<string, unknown> = {}) {
  const store = new MemoryStore();
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "fixture", alg: "RS256", use: "sig" };
  let authorization: URL;
  let tokenCalls = 0;
  let refreshCalls = 0;
  let refreshError = false;
  let pauseRefresh: Promise<void> | undefined;
  const requests: URLSearchParams[] = [];
  const server = createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/jwks") {
      res.end(JSON.stringify({ keys: [jwk] }));
      return;
    }
    if (req.url !== "/token") {
      res.writeHead(404).end();
      return;
    }
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = new URLSearchParams(raw);
    requests.push(body);
    tokenCalls++;
    if (body.get("grant_type") === "refresh_token") {
      refreshCalls++;
      await pauseRefresh;
      if (refreshError) {
        res
          .writeHead(400)
          .end(JSON.stringify({ error: "invalid_grant", error_description: "secret-canary" }));
        return;
      }
      res.end(
        JSON.stringify({
          access_token: "refreshed-access",
          refresh_token: "rotated-refresh",
          token_type: "Bearer",
          expires_in: 3600,
        })
      );
      return;
    }
    const challenge = createHash("sha256")
      .update(body.get("code_verifier") ?? "")
      .digest("base64url");
    if (
      challenge !== authorization.searchParams.get("code_challenge") ||
      body.get("redirect_uri") !== authorization.searchParams.get("redirect_uri") ||
      body.get("code") !== "fixture-code"
    ) {
      res.writeHead(400).end(JSON.stringify({ error: "invalid_grant" }));
      return;
    }
    const now = Math.floor(Date.now() / 1000);
    const claims = {
      iss: origin,
      aud: ref.clientId,
      sub: "fixture-subject",
      iat: now,
      exp: now + 3600,
      nonce: authorization.searchParams.get("nonce"),
      email: ref.email,
      email_verified: true,
      ...overrides,
    };
    const payload = [
      Buffer.from(JSON.stringify({ alg: "RS256", kid: "fixture" })).toString("base64url"),
      Buffer.from(JSON.stringify(claims)).toString("base64url"),
    ].join(".");
    const idToken = `${payload}.${sign("RSA-SHA256", Buffer.from(payload), privateKey).toString("base64url")}`;
    res.end(
      JSON.stringify({
        access_token: "fixture-access",
        refresh_token: "fixture-refresh",
        token_type: "Bearer",
        expires_in: 3600,
        scope: GOOGLE_SCOPES,
        id_token: idToken,
      })
    );
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error();
  const origin = `http://127.0.0.1:${address.port}`;
  const manager = new GmailOAuthManager(
    store,
    {
      issuer: origin,
      authorization_endpoint: `${origin}/authorize`,
      token_endpoint: `${origin}/token`,
      jwks_uri: `${origin}/jwks`,
    },
    { [oauth.allowInsecureRequests]: true }
  );
  const openBrowser = async (url: string) => {
    authorization = new URL(url);
    expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorization.searchParams.get("scope")).toBe(GOOGLE_SCOPES);
    const callback = new URL(authorization.searchParams.get("redirect_uri")!);
    callback.search = new URLSearchParams({
      code: "fixture-code",
      state: authorization.searchParams.get("state")!,
    }).toString();
    expect((await fetch(callback)).status).toBe(200);
  };
  return {
    manager,
    store,
    openBrowser,
    requests,
    counts: () => ({ tokenCalls, refreshCalls }),
    setRefreshError: () => {
      refreshError = true;
    },
    pauseRefresh: (p: Promise<void>) => {
      pauseRefresh = p;
    },
  };
}

describe("Google OAuth production HTTP flow", () => {
  it("performs PKCE, signed OIDC validation, isolated storage, single-flight refresh and rotation", async () => {
    const f = await fixture();
    expect((await f.manager.status(ref)).state).toBe("disconnected");
    await f.manager.connect(ref, { openBrowser: f.openBrowser });
    expect((await f.manager.status(ref)).state).toBe("connected");
    expect(await f.manager.accessToken(ref)).toBe("fixture-access");
    expect(f.counts().tokenCalls).toBe(1);
    f.store.grant!.expiresAt = 0;
    expect(await Promise.all(Array.from({ length: 8 }, () => f.manager.accessToken(ref)))).toEqual(
      Array(8).fill("refreshed-access")
    );
    expect(f.counts().refreshCalls).toBe(1);
    expect(f.store.grant!.refreshToken).toBe("rotated-refresh");
    expect(f.requests.every((r) => !r.has("client_secret"))).toBe(true);
    const invalidated = vi.fn();
    f.manager.onDisconnect(invalidated);
    await f.manager.disconnect(ref);
    expect(invalidated).toHaveBeenCalledWith(ref);
    expect((await f.manager.status(ref)).state).toBe("disconnected");
    await expect(f.manager.accessToken(ref)).rejects.toThrow("Reconnect");
  });
  it.each([
    { email: "other@example.com" },
    { email_verified: false },
    { nonce: "wrong" },
    { iss: "https://wrong.example" },
    { aud: "other-client" },
    { exp: 1 },
  ])("rejects invalid claims %j", async (claims) => {
    const f = await fixture(claims);
    await expect(f.manager.connect(ref, { openBrowser: f.openBrowser })).rejects.toThrow(
      "authorization failed"
    );
    expect(f.store.write).not.toHaveBeenCalled();
  });
  it("ignores wrong state, rejects wrong callback path, consumes the callback only once", async () => {
    const f = await fixture();
    await f.manager.connect(ref, {
      openBrowser: async (url) => {
        const auth = new URL(url);
        const callback = new URL(auth.searchParams.get("redirect_uri")!);
        callback.search = "code=secret-canary&state=wrong";
        expect((await fetch(callback)).status).toBe(400);
        callback.pathname = "/wrong";
        expect((await fetch(callback)).status).toBe(404);
        await f.openBrowser(url);
        callback.pathname = "/oauth/callback";
        callback.searchParams.set("state", auth.searchParams.get("state")!);
        expect((await fetch(callback)).status).toBe(404);
      },
    });
    expect(f.counts().tokenCalls).toBe(1);
  });
  it("cancels the loopback listener without persisting credentials", async () => {
    const f = await fixture();
    const controller = new AbortController();
    let callback = "";
    await expect(
      f.manager.connect(ref, {
        signal: controller.signal,
        openBrowser: async (url) => {
          callback = new URL(url).searchParams.get("redirect_uri")!;
          controller.abort();
        },
      })
    ).rejects.toThrow("canceled");
    await expect(fetch(callback)).rejects.toThrow();
    expect(f.store.write).not.toHaveBeenCalled();
  });
  it("does not resurrect a grant when disconnect races a refresh", async () => {
    const f = await fixture();
    await f.manager.connect(ref, { openBrowser: f.openBrowser });
    f.store.grant!.expiresAt = 0;
    let release!: () => void;
    f.pauseRefresh(
      new Promise<void>((resolve) => {
        release = resolve;
      })
    );
    const pending = f.manager.accessToken(ref);
    const rejected = expect(pending).rejects.toThrow("Reconnect");
    await vi.waitFor(() => expect(f.counts().refreshCalls).toBe(1));
    await f.manager.disconnect(ref);
    release();
    await rejected;
    expect(f.store.grant).toBeNull();
  });
  it("does not resurrect credentials when a separate manager disconnects during refresh", async () => {
    const f = await fixture();
    await f.manager.connect(ref, { openBrowser: f.openBrowser });
    f.store.grant!.expiresAt = 0;
    let release!: () => void;
    f.pauseRefresh(
      new Promise<void>((resolve) => {
        release = resolve;
      })
    );
    const pending = f.manager.accessToken(ref);
    const rejected = expect(pending).rejects.toThrow("Reconnect");
    await vi.waitFor(() => expect(f.counts().refreshCalls).toBe(1));
    await new GmailOAuthManager(f.store).disconnect(ref);
    release();
    await rejected;
    expect(f.store.grant).toBeNull();
  });
  it("does not overwrite a newer grant committed by another manager", async () => {
    const f = await fixture();
    await f.manager.connect(ref, { openBrowser: f.openBrowser });
    f.store.grant!.expiresAt = 0;
    let release!: () => void;
    f.pauseRefresh(
      new Promise<void>((resolve) => {
        release = resolve;
      })
    );
    const pending = f.manager.accessToken(ref);
    const rejected = expect(pending).rejects.toThrow("Reconnect");
    await vi.waitFor(() => expect(f.counts().refreshCalls).toBe(1));
    await f.store.write(
      ref,
      { ...f.store.grant!, accessToken: "newer-grant" },
      await f.store.revision()
    );
    release();
    await rejected;
    expect(f.store.grant!.accessToken).toBe("newer-grant");
  });
  it("redacts provider errors and reports only safe status fields", async () => {
    const f = await fixture();
    await f.manager.connect(ref, { openBrowser: f.openBrowser });
    f.store.grant!.expiresAt = 0;
    f.setRefreshError();
    const error = await f.manager.accessToken(ref).catch((e) => e as Error);
    expect(String(error)).not.toMatch(/secret-canary|fixture-refresh|fixture-access/);
    expect(Object.keys(await f.manager.status(ref)).sort()).toEqual(["email", "provider", "state"]);
  });
});

describe("credential transport boundaries", () => {
  const cfg = {
    user: ref.email,
    pass: "must-not-be-used",
    googleAccount: ref,
    host: "imap.gmail.com",
    port: 993,
    secure: true,
  };
  it("retains password credentials", async () => {
    expect(await resolveCredential({ ...cfg, googleAccount: undefined }, "imap")).toEqual({
      user: ref.email,
      pass: "must-not-be-used",
    });
  });
  it.each([
    { host: "attacker.example" },
    { allowPlaintext: true },
    { secure: false },
    { port: 143 },
    { user: "other@example.com" },
  ])("rejects unsafe OAuth transport %j before any credential access", (changes) => {
    expect(() => validateOAuthTransport({ ...cfg, ...changes }, "imap")).toThrow("TLS-only");
  });
});
