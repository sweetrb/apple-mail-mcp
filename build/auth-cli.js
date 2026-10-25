#!/usr/bin/env node
import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);

// src/services/fileConfig.ts
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
function fileConfigPath(env = process.env) {
  const override = env.APPLE_MAIL_MCP_CONFIG_FILE;
  if (override && override.trim()) return override.trim();
  return join(homedir(), "Library", "Application Support", "apple-mail-mcp", "config.json");
}
function loadFileConfig(env = process.env, path = fileConfigPath(env)) {
  const applied = [];
  try {
    if (!existsSync(path)) return applied;
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object") return applied;
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v !== "string") continue;
      if (env[k] === void 0 || env[k] === "") {
        env[k] = v;
        applied.push(k);
      }
    }
  } catch (e) {
    console.error(`Failed to load apple-mail-mcp config file ${path}: ${String(e)}`);
  }
  return applied;
}

// node_modules/.pnpm/oauth4webapi@3.8.8/node_modules/oauth4webapi/build/index.js
var USER_AGENT;
if (typeof navigator === "undefined" || !navigator.userAgent?.startsWith?.("Mozilla/5.0 ")) {
  const NAME = "oauth4webapi";
  const VERSION = "v3.8.8";
  USER_AGENT = `${NAME}/${VERSION}`;
}
function looseInstanceOf(input, expected) {
  if (input == null) {
    return false;
  }
  try {
    return input instanceof expected || Object.getPrototypeOf(input)[Symbol.toStringTag] === expected.prototype[Symbol.toStringTag];
  } catch {
    return false;
  }
}
var ERR_INVALID_ARG_VALUE = "ERR_INVALID_ARG_VALUE";
var ERR_INVALID_ARG_TYPE = "ERR_INVALID_ARG_TYPE";
function CodedTypeError(message, code, cause) {
  const err = new TypeError(message, { cause });
  Object.assign(err, { code });
  return err;
}
var allowInsecureRequests = /* @__PURE__ */ Symbol();
var clockSkew = /* @__PURE__ */ Symbol();
var clockTolerance = /* @__PURE__ */ Symbol();
var customFetch = /* @__PURE__ */ Symbol();
var jweDecrypt = /* @__PURE__ */ Symbol();
var jwksCache = /* @__PURE__ */ Symbol();
var encoder = new TextEncoder();
var decoder = new TextDecoder();
function buf(input) {
  if (typeof input === "string") {
    return encoder.encode(input);
  }
  return decoder.decode(input);
}
var encodeBase64Url;
if (Uint8Array.prototype.toBase64) {
  encodeBase64Url = (input) => {
    if (input instanceof ArrayBuffer) {
      input = new Uint8Array(input);
    }
    return input.toBase64({ alphabet: "base64url", omitPadding: true });
  };
} else {
  const CHUNK_SIZE = 32768;
  encodeBase64Url = (input) => {
    if (input instanceof ArrayBuffer) {
      input = new Uint8Array(input);
    }
    const arr = [];
    for (let i = 0; i < input.byteLength; i += CHUNK_SIZE) {
      arr.push(String.fromCharCode.apply(null, input.subarray(i, i + CHUNK_SIZE)));
    }
    return btoa(arr.join("")).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  };
}
var decodeBase64Url;
if (Uint8Array.fromBase64) {
  decodeBase64Url = (input) => {
    try {
      return Uint8Array.fromBase64(input, { alphabet: "base64url" });
    } catch (cause) {
      throw CodedTypeError("The input to be decoded is not correctly encoded.", ERR_INVALID_ARG_VALUE, cause);
    }
  };
} else {
  decodeBase64Url = (input) => {
    try {
      const binary = atob(input.replace(/-/g, "+").replace(/_/g, "/").replace(/\s/g, ""));
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      return bytes;
    } catch (cause) {
      throw CodedTypeError("The input to be decoded is not correctly encoded.", ERR_INVALID_ARG_VALUE, cause);
    }
  };
}
function b64u(input) {
  if (typeof input === "string") {
    return decodeBase64Url(input);
  }
  return encodeBase64Url(input);
}
var UnsupportedOperationError = class extends Error {
  code;
  constructor(message, options) {
    super(message, options);
    this.name = this.constructor.name;
    this.code = UNSUPPORTED_OPERATION;
    Error.captureStackTrace?.(this, this.constructor);
  }
};
var OperationProcessingError = class extends Error {
  code;
  constructor(message, options) {
    super(message, options);
    this.name = this.constructor.name;
    if (options?.code) {
      this.code = options?.code;
    }
    Error.captureStackTrace?.(this, this.constructor);
  }
};
function OPE(message, code, cause) {
  return new OperationProcessingError(message, { code, cause });
}
function isJsonObject(input) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return false;
  }
  return true;
}
function prepareHeaders(input) {
  if (looseInstanceOf(input, Headers)) {
    input = Object.fromEntries(input.entries());
  }
  const headers = new Headers(input ?? {});
  if (USER_AGENT && !headers.has("user-agent")) {
    headers.set("user-agent", USER_AGENT);
  }
  if (headers.has("authorization")) {
    throw CodedTypeError('"options.headers" must not include the "authorization" header name', ERR_INVALID_ARG_VALUE);
  }
  return headers;
}
function signal(url, value) {
  if (value !== void 0) {
    if (typeof value === "function") {
      value = value(url.href);
    }
    if (!(value instanceof AbortSignal)) {
      throw CodedTypeError('"options.signal" must return or be an instance of AbortSignal', ERR_INVALID_ARG_TYPE);
    }
    return value;
  }
  return void 0;
}
function assertNumber(input, allow0, it, code, cause) {
  try {
    if (typeof input !== "number" || !Number.isFinite(input)) {
      throw CodedTypeError(`${it} must be a number`, ERR_INVALID_ARG_TYPE, cause);
    }
    if (input > 0)
      return;
    if (allow0) {
      if (input !== 0) {
        throw CodedTypeError(`${it} must be a non-negative number`, ERR_INVALID_ARG_VALUE, cause);
      }
      return;
    }
    throw CodedTypeError(`${it} must be a positive number`, ERR_INVALID_ARG_VALUE, cause);
  } catch (err) {
    if (code) {
      throw OPE(err.message, code, cause);
    }
    throw err;
  }
}
function assertString(input, it, code, cause) {
  try {
    if (typeof input !== "string") {
      throw CodedTypeError(`${it} must be a string`, ERR_INVALID_ARG_TYPE, cause);
    }
    if (input.length === 0) {
      throw CodedTypeError(`${it} must not be empty`, ERR_INVALID_ARG_VALUE, cause);
    }
  } catch (err) {
    if (code) {
      throw OPE(err.message, code, cause);
    }
    throw err;
  }
}
function assertApplicationJson(response) {
  assertContentType(response, "application/json");
}
function notJson(response, ...types) {
  let msg = '"response" content-type must be ';
  if (types.length > 2) {
    const last = types.pop();
    msg += `${types.join(", ")}, or ${last}`;
  } else if (types.length === 2) {
    msg += `${types[0]} or ${types[1]}`;
  } else {
    msg += types[0];
  }
  return OPE(msg, RESPONSE_IS_NOT_JSON, response);
}
function assertContentTypes(response, ...types) {
  if (!types.includes(getContentType(response))) {
    throw notJson(response, ...types);
  }
}
function assertContentType(response, contentType) {
  if (getContentType(response) !== contentType) {
    throw notJson(response, contentType);
  }
}
function randomBytes() {
  return b64u(crypto.getRandomValues(new Uint8Array(32)));
}
function generateRandomCodeVerifier() {
  return randomBytes();
}
function generateRandomState() {
  return randomBytes();
}
function generateRandomNonce() {
  return randomBytes();
}
async function calculatePKCECodeChallenge(codeVerifier) {
  assertString(codeVerifier, "codeVerifier");
  return b64u(await crypto.subtle.digest("SHA-256", buf(codeVerifier)));
}
function getClockSkew(client) {
  const skew = client?.[clockSkew];
  return typeof skew === "number" && Number.isFinite(skew) ? skew : 0;
}
function getClockTolerance(client) {
  const tolerance = client?.[clockTolerance];
  return typeof tolerance === "number" && Number.isFinite(tolerance) && Math.sign(tolerance) !== -1 ? tolerance : 30;
}
function epochTime() {
  return Math.floor(Date.now() / 1e3);
}
function assertAs(as) {
  if (typeof as !== "object" || as === null) {
    throw CodedTypeError('"as" must be an object', ERR_INVALID_ARG_TYPE);
  }
  assertString(as.issuer, '"as.issuer"');
}
function assertClient(client) {
  if (typeof client !== "object" || client === null) {
    throw CodedTypeError('"client" must be an object', ERR_INVALID_ARG_TYPE);
  }
  assertString(client.client_id, '"client.client_id"');
}
function None() {
  return (_as, client, body, _headers) => {
    body.set("client_id", client.client_id);
  };
}
var URLParse = URL.parse ? (url, base) => URL.parse(url, base) : (url, base) => {
  try {
    return new URL(url, base);
  } catch {
    return null;
  }
};
function checkProtocol(url, enforceHttps) {
  if (enforceHttps && url.protocol !== "https:") {
    throw OPE("only requests to HTTPS are allowed", HTTP_REQUEST_FORBIDDEN, url);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw OPE("only HTTP and HTTPS requests are allowed", REQUEST_PROTOCOL_FORBIDDEN, url);
  }
}
function validateEndpoint(value, endpoint, useMtlsAlias, enforceHttps) {
  let url;
  if (typeof value !== "string" || !(url = URLParse(value))) {
    throw OPE(`authorization server metadata does not contain a valid ${useMtlsAlias ? `"as.mtls_endpoint_aliases.${endpoint}"` : `"as.${endpoint}"`}`, value === void 0 ? MISSING_SERVER_METADATA : INVALID_SERVER_METADATA, { attribute: useMtlsAlias ? `mtls_endpoint_aliases.${endpoint}` : endpoint });
  }
  checkProtocol(url, enforceHttps);
  return url;
}
function resolveEndpoint(as, endpoint, useMtlsAlias, enforceHttps) {
  if (useMtlsAlias && as.mtls_endpoint_aliases && endpoint in as.mtls_endpoint_aliases) {
    return validateEndpoint(as.mtls_endpoint_aliases[endpoint], endpoint, useMtlsAlias, enforceHttps);
  }
  return validateEndpoint(as[endpoint], endpoint, useMtlsAlias, enforceHttps);
}
var ResponseBodyError = class extends Error {
  cause;
  code;
  error;
  status;
  error_description;
  response;
  constructor(message, options) {
    super(message, options);
    this.name = this.constructor.name;
    this.code = RESPONSE_BODY_ERROR;
    this.cause = options.cause;
    this.error = options.cause.error;
    this.status = options.response.status;
    this.error_description = options.cause.error_description;
    Object.defineProperty(this, "response", { enumerable: false, value: options.response });
    Error.captureStackTrace?.(this, this.constructor);
  }
};
var AuthorizationResponseError = class extends Error {
  cause;
  code;
  error;
  error_description;
  constructor(message, options) {
    super(message, options);
    this.name = this.constructor.name;
    this.code = AUTHORIZATION_RESPONSE_ERROR;
    this.cause = options.cause;
    this.error = options.cause.get("error");
    this.error_description = options.cause.get("error_description") ?? void 0;
    Error.captureStackTrace?.(this, this.constructor);
  }
};
var WWWAuthenticateChallengeError = class extends Error {
  cause;
  code;
  response;
  status;
  constructor(message, options) {
    super(message, options);
    this.name = this.constructor.name;
    this.code = WWW_AUTHENTICATE_CHALLENGE;
    this.cause = options.cause;
    this.status = options.response.status;
    this.response = options.response;
    Object.defineProperty(this, "response", { enumerable: false });
    Error.captureStackTrace?.(this, this.constructor);
  }
};
var tokenMatch = "[a-zA-Z0-9!#$%&\\'\\*\\+\\-\\.\\^_`\\|~]+";
var token68Match = "[a-zA-Z0-9\\-\\._\\~\\+\\/]+={0,2}";
var quotedMatch = '"((?:[^"\\\\]|\\\\[\\s\\S])*)"';
var quotedParamMatcher = "(" + tokenMatch + ")\\s*=\\s*" + quotedMatch;
var paramMatcher = "(" + tokenMatch + ")\\s*=\\s*(" + tokenMatch + ")";
var schemeRE = new RegExp("^[,\\s]*(" + tokenMatch + ")");
var quotedParamRE = new RegExp("^[,\\s]*" + quotedParamMatcher + "[,\\s]*(.*)");
var unquotedParamRE = new RegExp("^[,\\s]*" + paramMatcher + "[,\\s]*(.*)");
var token68ParamRE = new RegExp("^(" + token68Match + ")(?:$|[,\\s])(.*)");
function parseWwwAuthenticateChallenges(response) {
  if (!looseInstanceOf(response, Response)) {
    throw CodedTypeError('"response" must be an instance of Response', ERR_INVALID_ARG_TYPE);
  }
  const header = response.headers.get("www-authenticate");
  if (header === null) {
    return void 0;
  }
  const challenges = [];
  let rest = header;
  while (rest) {
    let match = rest.match(schemeRE);
    const scheme = match?.["1"].toLowerCase();
    if (!scheme) {
      return void 0;
    }
    const afterScheme = rest.substring(match[0].length);
    if (afterScheme && !afterScheme.match(/^[\s,]/)) {
      return void 0;
    }
    const spaceMatch = afterScheme.match(/^\s+(.*)$/);
    const hasParameters = !!spaceMatch;
    rest = spaceMatch ? spaceMatch[1] : void 0;
    const parameters = {};
    let token68;
    if (hasParameters) {
      while (rest) {
        let key2;
        let value;
        if (match = rest.match(quotedParamRE)) {
          ;
          [, key2, value, rest] = match;
          if (value.includes("\\")) {
            value = value.replace(/\\([\s\S])/g, "$1");
          }
          parameters[key2.toLowerCase()] = value;
          continue;
        }
        if (match = rest.match(unquotedParamRE)) {
          ;
          [, key2, value, rest] = match;
          parameters[key2.toLowerCase()] = value;
          continue;
        }
        if (match = rest.match(token68ParamRE)) {
          if (Object.keys(parameters).length) {
            break;
          }
          ;
          [, token68, rest] = match;
          break;
        }
        return void 0;
      }
    } else {
      rest = afterScheme || void 0;
    }
    const challenge = { scheme, parameters };
    if (token68) {
      challenge.token68 = token68;
    }
    challenges.push(challenge);
  }
  if (!challenges.length) {
    return void 0;
  }
  return challenges;
}
async function parseOAuthResponseErrorBody(response) {
  if (response.status > 399 && response.status < 500) {
    assertReadableResponse(response);
    assertApplicationJson(response);
    try {
      const json = await response.clone().json();
      if (isJsonObject(json) && typeof json.error === "string" && json.error.length) {
        return json;
      }
    } catch {
    }
  }
  return void 0;
}
async function checkOAuthBodyError(response, expected, label) {
  if (response.status !== expected) {
    checkAuthenticationChallenges(response);
    let err;
    if (err = await parseOAuthResponseErrorBody(response)) {
      await response.body?.cancel();
      throw new ResponseBodyError("server responded with an error in the response body", {
        cause: err,
        response
      });
    }
    throw OPE(`"response" is not a conform ${label} response (unexpected HTTP status code)`, RESPONSE_IS_NOT_CONFORM, response);
  }
}
function assertDPoP(option) {
  if (!branded.has(option)) {
    throw CodedTypeError('"options.DPoP" is not a valid DPoPHandle', ERR_INVALID_ARG_VALUE);
  }
}
var jwksMap;
var jwksRequests;
var jwksKeys;
function setJwksCache(as, jwks, uat, cache) {
  jwksMap ||= /* @__PURE__ */ new WeakMap();
  jwksMap.set(as, {
    jwks,
    uat,
    get age() {
      return epochTime() - this.uat;
    }
  });
  if (cache) {
    Object.assign(cache, { jwks: structuredClone(jwks), uat });
  }
}
function isFreshJwksCache(input) {
  if (typeof input !== "object" || input === null) {
    return false;
  }
  if (!("uat" in input) || typeof input.uat !== "number" || epochTime() - input.uat >= 300) {
    return false;
  }
  if (!("jwks" in input) || !isJsonObject(input.jwks) || !Array.isArray(input.jwks.keys) || !Array.prototype.every.call(input.jwks.keys, isJsonObject)) {
    return false;
  }
  return true;
}
function clearJwksCache(as, cache) {
  jwksMap?.delete(as);
  delete cache?.jwks;
  delete cache?.uat;
}
async function getPublicSigKeyFromIssuerJwksUri(as, options, header) {
  const { alg, kid } = header;
  checkSupportedJwsAlg(header);
  if (!jwksMap?.has(as) && isFreshJwksCache(options?.[jwksCache])) {
    setJwksCache(as, options?.[jwksCache].jwks, options?.[jwksCache].uat);
  }
  let jwks;
  let age;
  if (jwksMap?.has(as)) {
    ;
    ({ jwks, age } = jwksMap.get(as));
    if (age >= 300) {
      clearJwksCache(as, options?.[jwksCache]);
      return getPublicSigKeyFromIssuerJwksUri(as, options, header);
    }
  } else {
    const downloaded = await jwksRequest(as, options);
    jwks = downloaded.jwks;
    age = epochTime() - downloaded.uat;
    setJwksCache(as, jwks, downloaded.uat, options?.[jwksCache]);
  }
  let kty;
  switch (alg.slice(0, 2)) {
    case "RS":
    case "PS":
      kty = "RSA";
      break;
    case "ES":
      kty = "EC";
      break;
    case "Ed":
      kty = "OKP";
      break;
    case "ML":
      kty = "AKP";
      break;
    default:
      throw new UnsupportedOperationError("unsupported JWS algorithm", { cause: { alg } });
  }
  const candidates = jwks.keys.filter((jwk2) => {
    if (jwk2.kty !== kty) {
      return false;
    }
    if (kid !== void 0 && kid !== jwk2.kid) {
      return false;
    }
    if (jwk2.alg !== void 0 && alg !== jwk2.alg) {
      return false;
    }
    if (jwk2.use !== void 0 && jwk2.use !== "sig") {
      return false;
    }
    if (jwk2.key_ops?.includes("verify") === false) {
      return false;
    }
    switch (true) {
      case (alg === "ES256" && jwk2.crv !== "P-256"):
      case (alg === "ES384" && jwk2.crv !== "P-384"):
      case (alg === "ES512" && jwk2.crv !== "P-521"):
      case (alg === "Ed25519" && jwk2.crv !== "Ed25519"):
      case (alg === "EdDSA" && jwk2.crv !== "Ed25519"):
        return false;
    }
    return true;
  });
  const { 0: jwk, length } = candidates;
  if (!length) {
    if (age >= 60) {
      clearJwksCache(as, options?.[jwksCache]);
      return getPublicSigKeyFromIssuerJwksUri(as, options, header);
    }
    throw OPE("error when selecting a JWT verification key, no applicable keys found", KEY_SELECTION, { header, candidates, jwks_uri: new URL(as.jwks_uri) });
  }
  if (length !== 1) {
    throw OPE('error when selecting a JWT verification key, multiple applicable keys found, a "kid" JWT Header Parameter is required', KEY_SELECTION, { header, candidates, jwks_uri: new URL(as.jwks_uri) });
  }
  jwksKeys ||= /* @__PURE__ */ new WeakMap();
  let keys = jwksKeys.get(jwk);
  if (!keys) {
    keys = /* @__PURE__ */ new Map();
    jwksKeys.set(jwk, keys);
  }
  let key2 = keys.get(alg);
  if (!key2) {
    key2 = importJwk(alg, jwk).catch((cause) => {
      keys.delete(alg);
      throw cause;
    });
    keys.set(alg, key2);
  }
  return key2;
}
function getContentType(input) {
  return input.headers.get("content-type")?.split(";")[0];
}
async function authenticatedRequest(as, client, clientAuthentication, url, body, headers, options) {
  await clientAuthentication(as, client, body, headers);
  headers.set("content-type", "application/x-www-form-urlencoded;charset=UTF-8");
  return (options?.[customFetch] || fetch)(url.href, {
    body,
    headers: Object.fromEntries(headers.entries()),
    method: "POST",
    redirect: "manual",
    signal: signal(url, options?.signal)
  });
}
async function tokenEndpointRequest(as, client, clientAuthentication, grantType, parameters, options) {
  const url = resolveEndpoint(as, "token_endpoint", client.use_mtls_endpoint_aliases, options?.[allowInsecureRequests] !== true);
  parameters.set("grant_type", grantType);
  const headers = prepareHeaders(options?.headers);
  headers.set("accept", "application/json");
  if (options?.DPoP !== void 0) {
    assertDPoP(options.DPoP);
    await options.DPoP.addProof(url, headers, "POST");
  }
  const response = await authenticatedRequest(as, client, clientAuthentication, url, parameters, headers, options);
  options?.DPoP?.cacheNonce(response, url);
  return response;
}
async function refreshTokenGrantRequest(as, client, clientAuthentication, refreshToken, options) {
  assertAs(as);
  assertClient(client);
  assertString(refreshToken, '"refreshToken"');
  const parameters = new URLSearchParams(options?.additionalParameters);
  parameters.set("refresh_token", refreshToken);
  return tokenEndpointRequest(as, client, clientAuthentication, "refresh_token", parameters, options);
}
var idTokenClaims = /* @__PURE__ */ new WeakMap();
var jwtRefs = /* @__PURE__ */ new WeakMap();
function getValidatedIdTokenClaims(ref2) {
  if (!ref2.id_token) {
    return void 0;
  }
  const claims = idTokenClaims.get(ref2);
  if (!claims) {
    throw CodedTypeError('"ref" was already garbage collected or did not resolve from the proper sources', ERR_INVALID_ARG_VALUE);
  }
  return claims;
}
async function validateApplicationLevelSignature(as, ref2, options) {
  assertAs(as);
  if (!jwtRefs.has(ref2)) {
    throw CodedTypeError('"ref" does not contain a processed JWT Response to verify the signature of', ERR_INVALID_ARG_VALUE);
  }
  const { 0: protectedHeader, 1: payload, 2: encodedSignature } = jwtRefs.get(ref2).split(".");
  const header = JSON.parse(buf(b64u(protectedHeader)));
  if (header.alg.startsWith("HS")) {
    throw new UnsupportedOperationError("unsupported JWS algorithm", { cause: { alg: header.alg } });
  }
  let key2;
  key2 = await getPublicSigKeyFromIssuerJwksUri(as, options, header);
  await validateJwsSignature(protectedHeader, payload, key2, b64u(encodedSignature));
}
async function processGenericAccessTokenResponse(as, client, response, additionalRequiredIdTokenClaims, decryptFn, recognizedTokenTypes) {
  assertAs(as);
  assertClient(client);
  if (!looseInstanceOf(response, Response)) {
    throw CodedTypeError('"response" must be an instance of Response', ERR_INVALID_ARG_TYPE);
  }
  await checkOAuthBodyError(response, 200, "Token Endpoint");
  assertReadableResponse(response);
  const json = await getResponseJsonBody(response);
  assertString(json.access_token, '"response" body "access_token" property', INVALID_RESPONSE, {
    body: json
  });
  assertString(json.token_type, '"response" body "token_type" property', INVALID_RESPONSE, {
    body: json
  });
  json.token_type = json.token_type.toLowerCase();
  if (json.expires_in !== void 0) {
    let expiresIn = typeof json.expires_in !== "number" ? parseFloat(json.expires_in) : json.expires_in;
    assertNumber(expiresIn, true, '"response" body "expires_in" property', INVALID_RESPONSE, {
      body: json
    });
    json.expires_in = expiresIn;
  }
  if (json.refresh_token !== void 0) {
    assertString(json.refresh_token, '"response" body "refresh_token" property', INVALID_RESPONSE, {
      body: json
    });
  }
  if (json.scope !== void 0 && typeof json.scope !== "string") {
    throw OPE('"response" body "scope" property must be a string', INVALID_RESPONSE, { body: json });
  }
  if (json.id_token !== void 0) {
    assertString(json.id_token, '"response" body "id_token" property', INVALID_RESPONSE, {
      body: json
    });
    const requiredClaims = [];
    if (client.require_auth_time === true) {
      requiredClaims.push("auth_time");
    }
    if (client.default_max_age !== void 0) {
      assertNumber(client.default_max_age, true, '"client.default_max_age"');
      requiredClaims.push("auth_time");
    }
    if (additionalRequiredIdTokenClaims?.length) {
      requiredClaims.push(...additionalRequiredIdTokenClaims);
    }
    const { claims, jwt } = await validateIdTokenClaims(as, client, json.id_token, requiredClaims, decryptFn);
    validateIdTokenAuthorizedParty(client, claims);
    validateIdTokenAuthTimeClaim(claims);
    jwtRefs.set(response, jwt);
    idTokenClaims.set(json, claims);
  }
  if (recognizedTokenTypes?.[json.token_type] !== void 0) {
    recognizedTokenTypes[json.token_type](response, json);
  } else if (json.token_type !== "dpop" && json.token_type !== "bearer") {
    throw new UnsupportedOperationError("unsupported `token_type` value", { cause: { body: json } });
  }
  return json;
}
function checkAuthenticationChallenges(response) {
  let challenges;
  if (challenges = parseWwwAuthenticateChallenges(response)) {
    throw new WWWAuthenticateChallengeError("server responded with a challenge in the WWW-Authenticate HTTP Header", { cause: challenges, response });
  }
}
async function processRefreshTokenResponse(as, client, response, options) {
  return processGenericAccessTokenResponse(as, client, response, void 0, options?.[jweDecrypt], options?.recognizedTokenTypes);
}
function validateAudience(expected, result) {
  if (Array.isArray(result.claims.aud)) {
    if (!result.claims.aud.includes(expected)) {
      throw OPE('unexpected JWT "aud" (audience) claim value', JWT_CLAIM_COMPARISON, {
        expected,
        claims: result.claims,
        claim: "aud"
      });
    }
  } else if (result.claims.aud !== expected) {
    throw OPE('unexpected JWT "aud" (audience) claim value', JWT_CLAIM_COMPARISON, {
      expected,
      claims: result.claims,
      claim: "aud"
    });
  }
  return result;
}
function validateIssuer(as, result) {
  const expected = as[_expectedIssuer]?.(result) ?? as.issuer;
  if (result.claims.iss !== expected) {
    throw OPE('unexpected JWT "iss" (issuer) claim value', JWT_CLAIM_COMPARISON, {
      expected,
      claims: result.claims,
      claim: "iss"
    });
  }
  return result;
}
var branded = /* @__PURE__ */ new WeakSet();
function brand(searchParams) {
  branded.add(searchParams);
  return searchParams;
}
var nopkce = /* @__PURE__ */ Symbol();
async function authorizationCodeGrantRequest(as, client, clientAuthentication, callbackParameters, redirectUri, codeVerifier, options) {
  assertAs(as);
  assertClient(client);
  if (!branded.has(callbackParameters)) {
    throw CodedTypeError('"callbackParameters" must be an instance of URLSearchParams obtained from "validateAuthResponse()", or "validateJwtAuthResponse()', ERR_INVALID_ARG_VALUE);
  }
  assertString(redirectUri, '"redirectUri"');
  const code = getURLSearchParameter(callbackParameters, "code");
  if (!code) {
    throw OPE('no authorization code in "callbackParameters"', INVALID_RESPONSE);
  }
  const parameters = new URLSearchParams(options?.additionalParameters);
  parameters.set("redirect_uri", redirectUri);
  parameters.set("code", code);
  if (codeVerifier !== nopkce) {
    assertString(codeVerifier, '"codeVerifier"');
    parameters.set("code_verifier", codeVerifier);
  }
  return tokenEndpointRequest(as, client, clientAuthentication, "authorization_code", parameters, options);
}
var jwtClaimNames = {
  aud: "audience",
  c_hash: "code hash",
  client_id: "client id",
  exp: "expiration time",
  iat: "issued at",
  iss: "issuer",
  jti: "jwt id",
  nonce: "nonce",
  s_hash: "state hash",
  sub: "subject",
  ath: "access token hash",
  htm: "http method",
  htu: "http uri",
  cnf: "confirmation",
  auth_time: "authentication time"
};
function validatePresence(required, result) {
  for (const claim of required) {
    if (result.claims[claim] === void 0) {
      throw OPE(`JWT "${claim}" (${jwtClaimNames[claim]}) claim missing`, INVALID_RESPONSE, {
        claims: result.claims
      });
    }
  }
  return result;
}
function validateStringClaim(claim, result) {
  if (typeof result.claims[claim] !== "string") {
    throw OPE(`unexpected JWT "${claim}" (${jwtClaimNames[claim]}) claim type`, INVALID_RESPONSE, {
      claims: result.claims
    });
  }
  return result;
}
function validateIdTokenClaims(as, client, idToken, requiredClaims, decryptFn) {
  return validateJwt(idToken, checkSigningAlgorithm.bind(void 0, client.id_token_signed_response_alg, as.id_token_signing_alg_values_supported, "RS256"), getClockSkew(client), getClockTolerance(client), decryptFn).then(validatePresence.bind(void 0, ["aud", "exp", "iat", "iss", "sub", ...requiredClaims])).then(validateIssuer.bind(void 0, as)).then(validateAudience.bind(void 0, client.client_id)).then(validateStringClaim.bind(void 0, "sub"));
}
function resolveIdTokenMaxAge(client, maxAge) {
  if (maxAge === skipAuthTimeCheck) {
    return maxAge;
  }
  const fromClient = maxAge === void 0;
  if (fromClient) {
    maxAge = client.default_max_age;
  }
  if (maxAge === void 0) {
    return skipAuthTimeCheck;
  }
  assertNumber(maxAge, true, fromClient ? '"client.default_max_age"' : '"maxAge" argument');
  return maxAge;
}
function validateIdTokenAuthTimeClaim(claims) {
  if (claims.auth_time !== void 0) {
    assertNumber(claims.auth_time, true, 'ID Token "auth_time" (authentication time)', INVALID_RESPONSE, { claims });
  }
}
function validateIdTokenAuthTime(client, claims, maxAge) {
  if (maxAge === skipAuthTimeCheck) {
    return;
  }
  const now = epochTime() + getClockSkew(client);
  const tolerance = getClockTolerance(client);
  if (claims.auth_time + maxAge < now - tolerance) {
    throw OPE("too much time has elapsed since the last End-User authentication", JWT_TIMESTAMP_CHECK, { claims, now, tolerance, claim: "auth_time" });
  }
}
function validateIdTokenNonce(claims, expectedNonce) {
  const expected = expectedNonce === expectNoNonce ? void 0 : expectedNonce;
  if (claims.nonce !== expected) {
    throw OPE('unexpected ID Token "nonce" claim value', JWT_CLAIM_COMPARISON, {
      expected,
      claims,
      claim: "nonce"
    });
  }
}
function validateIdTokenAuthorizedParty(client, claims) {
  if (Array.isArray(claims.aud) && claims.aud.length !== 1) {
    if (claims.azp === void 0) {
      throw OPE('ID Token "aud" (audience) claim includes additional untrusted audiences', JWT_CLAIM_COMPARISON, { claims, claim: "aud" });
    }
    if (claims.azp !== client.client_id) {
      throw OPE('unexpected ID Token "azp" (authorized party) claim value', JWT_CLAIM_COMPARISON, {
        expected: client.client_id,
        claims,
        claim: "azp"
      });
    }
  }
}
var expectNoNonce = /* @__PURE__ */ Symbol();
var skipAuthTimeCheck = /* @__PURE__ */ Symbol();
async function processAuthorizationCodeResponse(as, client, response, options) {
  if (typeof options?.expectedNonce === "string" || typeof options?.maxAge === "number" || options?.requireIdToken) {
    return processAuthorizationCodeOpenIDResponse(as, client, response, options.expectedNonce, options.maxAge, options[jweDecrypt], options.recognizedTokenTypes);
  }
  return processAuthorizationCodeOAuth2Response(as, client, response, options?.maxAge, options?.[jweDecrypt], options?.recognizedTokenTypes);
}
async function processAuthorizationCodeOpenIDResponse(as, client, response, expectedNonce, maxAge, decryptFn, recognizedTokenTypes) {
  const additionalRequiredClaims = [];
  switch (expectedNonce) {
    case void 0:
      expectedNonce = expectNoNonce;
      break;
    case expectNoNonce:
      break;
    default:
      assertString(expectedNonce, '"expectedNonce" argument');
      additionalRequiredClaims.push("nonce");
  }
  maxAge = resolveIdTokenMaxAge(client, maxAge);
  if (maxAge !== skipAuthTimeCheck) {
    additionalRequiredClaims.push("auth_time");
  }
  const result = await processGenericAccessTokenResponse(as, client, response, additionalRequiredClaims, decryptFn, recognizedTokenTypes);
  assertString(result.id_token, '"response" body "id_token" property', INVALID_RESPONSE, {
    body: result
  });
  const claims = getValidatedIdTokenClaims(result);
  validateIdTokenAuthTime(client, claims, maxAge);
  validateIdTokenNonce(claims, expectedNonce);
  return result;
}
async function processAuthorizationCodeOAuth2Response(as, client, response, maxAge, decryptFn, recognizedTokenTypes) {
  const result = await processGenericAccessTokenResponse(as, client, response, void 0, decryptFn, recognizedTokenTypes);
  const claims = getValidatedIdTokenClaims(result);
  if (claims) {
    validateIdTokenAuthTime(client, claims, resolveIdTokenMaxAge(client, maxAge));
    validateIdTokenNonce(claims, expectNoNonce);
  }
  return result;
}
var WWW_AUTHENTICATE_CHALLENGE = "OAUTH_WWW_AUTHENTICATE_CHALLENGE";
var RESPONSE_BODY_ERROR = "OAUTH_RESPONSE_BODY_ERROR";
var UNSUPPORTED_OPERATION = "OAUTH_UNSUPPORTED_OPERATION";
var AUTHORIZATION_RESPONSE_ERROR = "OAUTH_AUTHORIZATION_RESPONSE_ERROR";
var PARSE_ERROR = "OAUTH_PARSE_ERROR";
var INVALID_RESPONSE = "OAUTH_INVALID_RESPONSE";
var RESPONSE_IS_NOT_JSON = "OAUTH_RESPONSE_IS_NOT_JSON";
var RESPONSE_IS_NOT_CONFORM = "OAUTH_RESPONSE_IS_NOT_CONFORM";
var HTTP_REQUEST_FORBIDDEN = "OAUTH_HTTP_REQUEST_FORBIDDEN";
var REQUEST_PROTOCOL_FORBIDDEN = "OAUTH_REQUEST_PROTOCOL_FORBIDDEN";
var JWT_TIMESTAMP_CHECK = "OAUTH_JWT_TIMESTAMP_CHECK_FAILED";
var JWT_CLAIM_COMPARISON = "OAUTH_JWT_CLAIM_COMPARISON_FAILED";
var KEY_SELECTION = "OAUTH_KEY_SELECTION_FAILED";
var MISSING_SERVER_METADATA = "OAUTH_MISSING_SERVER_METADATA";
var INVALID_SERVER_METADATA = "OAUTH_INVALID_SERVER_METADATA";
function assertReadableResponse(response) {
  if (response.bodyUsed) {
    throw CodedTypeError('"response" body has been used already', ERR_INVALID_ARG_VALUE);
  }
}
async function jwksRequest(as, options) {
  assertAs(as);
  const url = resolveEndpoint(as, "jwks_uri", false, options?.[allowInsecureRequests] !== true);
  const headers = prepareHeaders(options?.headers);
  headers.set("accept", "application/json");
  headers.append("accept", "application/jwk-set+json");
  const requestHeaders = Object.fromEntries(headers.entries());
  const headersKey = JSON.stringify(requestHeaders);
  const fetcher = options?.[customFetch] || fetch;
  const requestSignal = signal(url, options?.signal);
  jwksRequests ||= /* @__PURE__ */ new WeakMap();
  const requests = jwksRequests.get(as) ?? /* @__PURE__ */ new Set();
  for (const pending2 of requests) {
    if (pending2.url === url.href && pending2.headers === headersKey && pending2.fetch === fetcher && pending2.signal === requestSignal) {
      return pending2.promise;
    }
  }
  const pending = {
    url: url.href,
    headers: headersKey,
    fetch: fetcher,
    signal: requestSignal,
    promise: Promise.resolve().then(() => fetcher(url.href, {
      body: void 0,
      headers: requestHeaders,
      method: "GET",
      redirect: "manual",
      signal: requestSignal
    })).then(processJwksResponse).then((jwks) => {
      const uat = epochTime();
      setJwksCache(as, jwks, uat);
      return { jwks, uat };
    }).finally(() => {
      requests.delete(pending);
      if (!requests.size) {
        jwksRequests.delete(as);
      }
    })
  };
  requests.add(pending);
  jwksRequests.set(as, requests);
  return pending.promise;
}
async function processJwksResponse(response) {
  if (!looseInstanceOf(response, Response)) {
    throw CodedTypeError('"response" must be an instance of Response', ERR_INVALID_ARG_TYPE);
  }
  if (response.status !== 200) {
    throw OPE('"response" is not a conform JSON Web Key Set response (unexpected HTTP status code)', RESPONSE_IS_NOT_CONFORM, response);
  }
  assertReadableResponse(response);
  const json = await getResponseJsonBody(response, (response2) => assertContentTypes(response2, "application/json", "application/jwk-set+json"));
  if (!Array.isArray(json.keys)) {
    throw OPE('"response" body "keys" property must be an array', INVALID_RESPONSE, { body: json });
  }
  if (!Array.prototype.every.call(json.keys, isJsonObject)) {
    throw OPE('"response" body "keys" property members must be JWK formatted objects', INVALID_RESPONSE, { body: json });
  }
  return json;
}
function supported(alg) {
  switch (alg) {
    case "PS256":
    case "ES256":
    case "RS256":
    case "PS384":
    case "ES384":
    case "RS384":
    case "PS512":
    case "ES512":
    case "RS512":
    case "Ed25519":
    case "EdDSA":
    case "ML-DSA-44":
    case "ML-DSA-65":
    case "ML-DSA-87":
      return true;
    default:
      return false;
  }
}
function checkSupportedJwsAlg(header) {
  if (!supported(header.alg)) {
    throw new UnsupportedOperationError('unsupported JWS "alg" identifier', {
      cause: { alg: header.alg }
    });
  }
}
function checkRsaKeyAlgorithm(key2) {
  const { algorithm } = key2;
  if (typeof algorithm.modulusLength !== "number" || algorithm.modulusLength < 2048) {
    throw new UnsupportedOperationError(`unsupported ${algorithm.name} modulusLength`, {
      cause: key2
    });
  }
}
function ecdsaHashName(key2) {
  const { algorithm } = key2;
  switch (algorithm.namedCurve) {
    case "P-256":
      return "SHA-256";
    case "P-384":
      return "SHA-384";
    case "P-521":
      return "SHA-512";
    default:
      throw new UnsupportedOperationError("unsupported ECDSA namedCurve", { cause: key2 });
  }
}
function keyToSubtle(key2) {
  switch (key2.algorithm.name) {
    case "ECDSA":
      return {
        name: key2.algorithm.name,
        hash: ecdsaHashName(key2)
      };
    case "RSA-PSS": {
      checkRsaKeyAlgorithm(key2);
      switch (key2.algorithm.hash.name) {
        case "SHA-256":
        case "SHA-384":
        case "SHA-512":
          return {
            name: key2.algorithm.name,
            saltLength: parseInt(key2.algorithm.hash.name.slice(-3), 10) >> 3
          };
        default:
          throw new UnsupportedOperationError("unsupported RSA-PSS hash name", { cause: key2 });
      }
    }
    case "RSASSA-PKCS1-v1_5":
      checkRsaKeyAlgorithm(key2);
      return key2.algorithm.name;
    case "ML-DSA-44":
    case "ML-DSA-65":
    case "ML-DSA-87":
    case "Ed25519":
      return key2.algorithm.name;
  }
  throw new UnsupportedOperationError("unsupported CryptoKey algorithm name", { cause: key2 });
}
async function validateJwsSignature(protectedHeader, payload, key2, signature) {
  const data = buf(`${protectedHeader}.${payload}`);
  const algorithm = keyToSubtle(key2);
  const verified = await crypto.subtle.verify(algorithm, key2, signature, data);
  if (!verified) {
    throw OPE("JWT signature verification failed", INVALID_RESPONSE, {
      key: key2,
      data,
      signature,
      algorithm
    });
  }
}
async function validateJwt(jws, checkAlg, clockSkew2, clockTolerance2, decryptJwt) {
  let { 0: protectedHeader, 1: payload, length } = jws.split(".");
  if (length === 5) {
    if (decryptJwt !== void 0) {
      jws = await decryptJwt(jws);
      ({ 0: protectedHeader, 1: payload, length } = jws.split("."));
    } else {
      throw new UnsupportedOperationError("JWE decryption is not configured", { cause: jws });
    }
  }
  if (length !== 3) {
    throw OPE("Invalid JWT", INVALID_RESPONSE, jws);
  }
  let header;
  try {
    header = JSON.parse(buf(b64u(protectedHeader)));
  } catch (cause) {
    throw OPE("failed to parse JWT Header body as base64url encoded JSON", PARSE_ERROR, cause);
  }
  if (!isJsonObject(header)) {
    throw OPE("JWT Header must be a top level object", INVALID_RESPONSE, jws);
  }
  checkAlg(header);
  if (header.crit !== void 0) {
    throw new UnsupportedOperationError('no JWT "crit" header parameter extensions are supported', {
      cause: { header }
    });
  }
  let claims;
  try {
    claims = JSON.parse(buf(b64u(payload)));
  } catch (cause) {
    throw OPE("failed to parse JWT Payload body as base64url encoded JSON", PARSE_ERROR, cause);
  }
  if (!isJsonObject(claims)) {
    throw OPE("JWT Payload must be a top level object", INVALID_RESPONSE, jws);
  }
  const now = epochTime() + clockSkew2;
  if (claims.exp !== void 0) {
    if (typeof claims.exp !== "number") {
      throw OPE('unexpected JWT "exp" (expiration time) claim type', INVALID_RESPONSE, { claims });
    }
    if (claims.exp <= now - clockTolerance2) {
      throw OPE('unexpected JWT "exp" (expiration time) claim value, expiration is past current timestamp', JWT_TIMESTAMP_CHECK, { claims, now, tolerance: clockTolerance2, claim: "exp" });
    }
  }
  if (claims.iat !== void 0) {
    if (typeof claims.iat !== "number") {
      throw OPE('unexpected JWT "iat" (issued at) claim type', INVALID_RESPONSE, { claims });
    }
  }
  if (claims.iss !== void 0) {
    if (typeof claims.iss !== "string") {
      throw OPE('unexpected JWT "iss" (issuer) claim type', INVALID_RESPONSE, { claims });
    }
  }
  if (claims.nbf !== void 0) {
    if (typeof claims.nbf !== "number") {
      throw OPE('unexpected JWT "nbf" (not before) claim type', INVALID_RESPONSE, { claims });
    }
    if (claims.nbf > now + clockTolerance2) {
      throw OPE('unexpected JWT "nbf" (not before) claim value', JWT_TIMESTAMP_CHECK, {
        claims,
        now,
        tolerance: clockTolerance2,
        claim: "nbf"
      });
    }
  }
  if (claims.aud !== void 0) {
    if (typeof claims.aud !== "string" && !Array.isArray(claims.aud)) {
      throw OPE('unexpected JWT "aud" (audience) claim type', INVALID_RESPONSE, { claims });
    }
  }
  return { header, claims, jwt: jws };
}
function checkSigningAlgorithm(client, issuer, fallback, header) {
  if (client !== void 0) {
    if (typeof client === "string" ? header.alg !== client : !client.includes(header.alg)) {
      throw OPE('unexpected JWT "alg" header parameter', INVALID_RESPONSE, {
        header,
        expected: client,
        reason: "client configuration"
      });
    }
    return;
  }
  if (Array.isArray(issuer)) {
    if (!issuer.includes(header.alg)) {
      throw OPE('unexpected JWT "alg" header parameter', INVALID_RESPONSE, {
        header,
        expected: issuer,
        reason: "authorization server metadata"
      });
    }
    return;
  }
  if (fallback !== void 0) {
    if (typeof fallback === "string" ? header.alg !== fallback : typeof fallback === "function" ? !fallback(header.alg) : !fallback.includes(header.alg)) {
      throw OPE('unexpected JWT "alg" header parameter', INVALID_RESPONSE, {
        header,
        expected: fallback,
        reason: "default value"
      });
    }
    return;
  }
  throw OPE('missing client or server configuration to verify used JWT "alg" header parameter', void 0, { client, issuer, fallback });
}
function getURLSearchParameter(parameters, name) {
  const { 0: value, length } = parameters.getAll(name);
  if (length > 1) {
    throw OPE(`"${name}" parameter must be provided only once`, INVALID_RESPONSE);
  }
  return value;
}
var skipStateCheck = /* @__PURE__ */ Symbol();
var expectNoState = /* @__PURE__ */ Symbol();
function validateAuthResponse(as, client, parameters, expectedState) {
  assertAs(as);
  assertClient(client);
  if (parameters instanceof URL) {
    parameters = parameters.searchParams;
  }
  if (!(parameters instanceof URLSearchParams)) {
    throw CodedTypeError('"parameters" must be an instance of URLSearchParams, or URL', ERR_INVALID_ARG_TYPE);
  }
  if (getURLSearchParameter(parameters, "response")) {
    throw OPE('"parameters" contains a JARM response, use validateJwtAuthResponse() instead of validateAuthResponse()', INVALID_RESPONSE, { parameters });
  }
  const iss = getURLSearchParameter(parameters, "iss");
  const state = getURLSearchParameter(parameters, "state");
  if (!iss && as.authorization_response_iss_parameter_supported) {
    throw OPE('response parameter "iss" (issuer) missing', INVALID_RESPONSE, { parameters });
  }
  if (iss && iss !== as.issuer) {
    throw OPE('unexpected "iss" (issuer) response parameter value', INVALID_RESPONSE, {
      expected: as.issuer,
      parameters
    });
  }
  switch (expectedState) {
    case void 0:
    case expectNoState:
      if (state !== void 0) {
        throw OPE('unexpected "state" response parameter encountered', INVALID_RESPONSE, {
          expected: void 0,
          parameters
        });
      }
      break;
    case skipStateCheck:
      break;
    default:
      assertString(expectedState, '"expectedState" argument');
      if (state !== expectedState) {
        throw OPE(state === void 0 ? 'response parameter "state" missing' : 'unexpected "state" response parameter value', INVALID_RESPONSE, { expected: expectedState, parameters });
      }
  }
  const error = getURLSearchParameter(parameters, "error");
  if (error) {
    throw new AuthorizationResponseError("authorization response from the server is an error", {
      cause: parameters
    });
  }
  const id_token = getURLSearchParameter(parameters, "id_token");
  const token = getURLSearchParameter(parameters, "token");
  if (id_token !== void 0 || token !== void 0) {
    throw new UnsupportedOperationError("implicit and hybrid flows are not supported");
  }
  return brand(new URLSearchParams(parameters));
}
function algToSubtle(alg) {
  switch (alg) {
    case "PS256":
    case "PS384":
    case "PS512":
      return { name: "RSA-PSS", hash: `SHA-${alg.slice(-3)}` };
    case "RS256":
    case "RS384":
    case "RS512":
      return { name: "RSASSA-PKCS1-v1_5", hash: `SHA-${alg.slice(-3)}` };
    case "ES256":
    case "ES384":
      return { name: "ECDSA", namedCurve: `P-${alg.slice(-3)}` };
    case "ES512":
      return { name: "ECDSA", namedCurve: "P-521" };
    case "EdDSA":
      return "Ed25519";
    case "Ed25519":
    case "ML-DSA-44":
    case "ML-DSA-65":
    case "ML-DSA-87":
      return alg;
    default:
      throw new UnsupportedOperationError("unsupported JWS algorithm", { cause: { alg } });
  }
}
async function importJwk(alg, jwk) {
  const { ext, key_ops, use, ...key2 } = jwk;
  return crypto.subtle.importKey("jwk", key2, algToSubtle(alg), true, ["verify"]);
}
async function getResponseJsonBody(response, check = assertApplicationJson) {
  let json;
  try {
    json = await response.json();
  } catch (cause) {
    check(response);
    throw OPE('failed to parse "response" body as JSON', PARSE_ERROR, cause);
  }
  if (!isJsonObject(json)) {
    throw OPE('"response" body must be a top level object', INVALID_RESPONSE, { body: json });
  }
  return json;
}
var _expectedIssuer = /* @__PURE__ */ Symbol();

// src/services/gmailOAuth.ts
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rename, unlink, rmdir } from "node:fs/promises";
import { homedir as homedir2 } from "node:os";
import { join as join2 } from "node:path";

// src/services/authErrors.ts
var AuthOperationError = class extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "AuthOperationError";
  }
  code;
};
function publicAuthFailure(error) {
  if (error instanceof AuthOperationError) {
    switch (error.code) {
      case "configuration":
        return "Configure a valid Google Desktop client ID and the expected account email.";
      case "keychain":
        return "Google credentials could not be accessed securely. Unlock the login Keychain and retry.";
      case "storage-busy":
        return "Google credential storage is busy. Stop mail MCP/auth processes and follow the stale-lock recovery instructions in docs/GMAIL-OAUTH.md.";
      case "authorization":
        return "Google authorization failed or was canceled. Check client registration, consent, and the selected account, then retry connect.";
      case "reconnect":
        return "Google credentials are unavailable or expired. Reconnect the account; no password fallback was attempted.";
    }
  }
  return "Google authorization operation failed. Check the account configuration and Keychain access; see docs/GMAIL-OAUTH.md for recovery.";
}

// src/services/gmailOAuth.ts
var SERVICE = "apple-mail-mcp.oauth.google.v1";
var GOOGLE_SCOPES = "openid email https://mail.google.com/";
var GOOGLE_SERVER = {
  issuer: "https://accounts.google.com",
  authorization_endpoint: "https://accounts.google.com/o/oauth2/v2/auth",
  token_endpoint: "https://oauth2.googleapis.com/token",
  jwks_uri: "https://www.googleapis.com/oauth2/v3/certs"
};
function key(ref2) {
  return createHash("sha256").update(`${ref2.clientId}
${ref2.email.toLowerCase()}`).digest("hex");
}
function checkRef(ref2) {
  if (ref2.provider !== "google" || !/^[\w.-]+\.apps\.googleusercontent\.com$/.test(ref2.clientId) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ref2.email)) {
    throw new AuthOperationError(
      "configuration",
      "Configure a Google Desktop client ID and the expected account email."
    );
  }
}
function security(args, input) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "/usr/bin/security",
      args,
      { encoding: "utf8", maxBuffer: 128 * 1024, timeout: 15e3 },
      (error, stdout) => error ? reject(new AuthOperationError("keychain", "OAuth Keychain operation failed.")) : resolve(stdout)
    );
    child.stdin?.end(input);
  });
}
function quote(value) {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
var KeychainGrantStore = class {
  constructor(stateDirectory = join2(
    homedir2(),
    "Library",
    "Application Support",
    "apple-mail-mcp",
    "oauth-state"
  )) {
    this.stateDirectory = stateDirectory;
  }
  stateDirectory;
  revisionPath(ref2) {
    return join2(this.stateDirectory, `${key(ref2)}.revision`);
  }
  async revision(ref2) {
    try {
      return await readFile(this.revisionPath(ref2), "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return "";
      throw new Error("OAuth revision storage is unavailable.");
    }
  }
  async locked(ref2, action) {
    await mkdir(this.stateDirectory, { recursive: true, mode: 448 });
    const lock = join2(this.stateDirectory, `${key(ref2)}.lock`);
    const deadline = Date.now() + 1e4;
    for (; ; ) {
      try {
        await mkdir(lock, { mode: 448 });
        break;
      } catch (error) {
        if (error.code !== "EEXIST")
          throw new Error("OAuth storage lock is unavailable.");
        if (Date.now() >= deadline)
          throw new AuthOperationError(
            "storage-busy",
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
  async advance(ref2) {
    const target = this.revisionPath(ref2);
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, randomUUID(), { encoding: "utf8", mode: 384, flag: "wx" });
      await rename(temporary, target);
    } finally {
      await unlink(temporary).catch(() => {
      });
    }
  }
  async read(ref2) {
    return this.locked(ref2, () => this.readUnlocked(ref2));
  }
  async snapshot(ref2) {
    return this.locked(ref2, async () => ({
      revision: await this.revision(ref2),
      grant: await this.readUnlocked(ref2)
    }));
  }
  async readUnlocked(ref2) {
    return new Promise((resolve, reject) => {
      execFile(
        "/usr/bin/security",
        ["find-generic-password", "-s", SERVICE, "-a", key(ref2), "-w"],
        { encoding: "utf8", maxBuffer: 128 * 1024, timeout: 15e3 },
        (error, stdout) => {
          if (error) {
            if (Number(error.code) === 44) resolve(null);
            else
              reject(
                new AuthOperationError(
                  "keychain",
                  "OAuth Keychain is unavailable; unlock it and retry."
                )
              );
            return;
          }
          try {
            const grant = JSON.parse(stdout);
            if (!grant.accessToken || !grant.refreshToken || !Number.isFinite(grant.expiresAt) || !grant.subject || grant.email !== ref2.email.toLowerCase())
              throw new Error();
            resolve(grant);
          } catch {
            reject(new Error("Stored OAuth credential is invalid; reconnect this account."));
          }
        }
      );
    });
  }
  async write(ref2, grant, expectedRevision) {
    await this.locked(ref2, async () => {
      if (await this.revision(ref2) !== expectedRevision)
        throw new Error("OAuth credentials changed in another process; retry the operation.");
      await this.advance(ref2);
      await security(
        ["-i"],
        `add-generic-password -U -s ${quote(SERVICE)} -a ${quote(key(ref2))} -w ${quote(JSON.stringify(grant))}
`
      );
      const saved = await this.readUnlocked(ref2);
      if (JSON.stringify(saved) !== JSON.stringify(grant))
        throw new Error("OAuth Keychain write could not be verified.");
    });
  }
  async remove(ref2) {
    await this.locked(ref2, async () => {
      await this.advance(ref2);
      if (await this.readUnlocked(ref2))
        await security(["delete-generic-password", "-s", SERVICE, "-a", key(ref2)]);
    });
  }
};
var openSystemBrowser = (url) => new Promise((resolve, reject) => {
  execFile(
    "/usr/bin/open",
    [url],
    (error) => error ? reject(new Error("Could not open the system browser.")) : resolve()
  );
});
var GmailOAuthManager = class {
  constructor(store = new KeychainGrantStore(), server = GOOGLE_SERVER, requestOptions = {}) {
    this.store = store;
    this.server = server;
    this.requestOptions = requestOptions;
  }
  store;
  server;
  requestOptions;
  active = /* @__PURE__ */ new Map();
  refreshes = /* @__PURE__ */ new Map();
  generations = /* @__PURE__ */ new Map();
  writes = /* @__PURE__ */ new Map();
  invalidators = /* @__PURE__ */ new Set();
  onDisconnect(callback) {
    this.invalidators.add(callback);
    return () => this.invalidators.delete(callback);
  }
  serial(id, operation) {
    const next = (this.writes.get(id) ?? Promise.resolve()).catch(() => {
    }).then(operation);
    this.writes.set(id, next);
    void next.finally(() => {
      if (this.writes.get(id) === next) this.writes.delete(id);
    }).catch(() => {
    });
    return next;
  }
  version(ref2) {
    return this.generations.get(key(ref2)) ?? 0;
  }
  connectionGuard(ref2) {
    const generation = this.version(ref2);
    return () => {
      if (generation !== this.version(ref2))
        throw new Error("Google account disconnected during connection.");
    };
  }
  assertCurrent(ref2, generation, signal2) {
    if (signal2.aborted || generation !== this.version(ref2))
      throw new Error("OAuth operation canceled.");
  }
  async status(ref2) {
    checkRef(ref2);
    const grant = await this.store.read(ref2);
    return {
      provider: "google",
      email: ref2.email,
      state: !grant ? "disconnected" : grant.expiresAt > Date.now() + 6e4 ? "connected" : "refresh-required"
    };
  }
  async disconnect(ref2) {
    checkRef(ref2);
    const id = key(ref2);
    this.generations.set(id, this.version(ref2) + 1);
    this.active.get(id)?.abort();
    for (const invalidate of this.invalidators) invalidate(ref2);
    await this.serial(id, () => this.store.remove(ref2));
  }
  async connect(ref2, options = {}) {
    checkRef(ref2);
    const id = key(ref2);
    if (this.active.has(id))
      throw new Error("An OAuth operation is already in progress for this account.");
    const controller2 = new AbortController();
    const signal2 = AbortSignal.any([
      controller2.signal,
      options.signal ?? new AbortController().signal,
      AbortSignal.timeout(Math.min(options.timeoutMs ?? 18e4, 3e5))
    ]);
    const generation = this.version(ref2);
    this.active.set(id, controller2);
    const client = { client_id: ref2.clientId, id_token_signed_response_alg: "RS256" };
    const state = generateRandomState();
    const nonce = generateRandomNonce();
    const verifier = generateRandomCodeVerifier();
    const server = createServer();
    let consumed = false;
    try {
      const revision = await this.store.revision(ref2);
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      if (!address || typeof address === "string") throw new Error();
      const redirect = `http://127.0.0.1:${address.port}/oauth/callback`;
      const callback = new Promise((resolve, reject) => {
        const abort = () => reject(new Error("OAuth operation canceled or timed out."));
        signal2.addEventListener("abort", abort, { once: true });
        if (signal2.aborted) abort();
        server.on("request", (req, res) => {
          res.setHeader("Cache-Control", "no-store");
          res.setHeader("Content-Security-Policy", "default-src 'none'");
          if (consumed || req.method !== "GET" || req.headers.host !== `127.0.0.1:${address.port}` || !req.url?.startsWith("/oauth/callback?")) {
            res.writeHead(404).end();
            return;
          }
          const url2 = new URL(req.url, redirect);
          if (url2.searchParams.getAll("state").length !== 1 || url2.searchParams.get("state") !== state) {
            res.writeHead(400).end("Invalid sign-in response.");
            return;
          }
          consumed = true;
          signal2.removeEventListener("abort", abort);
          res.end("Sign-in response received. Return to the terminal to check the result.");
          resolve(url2);
        });
      });
      void callback.catch(() => {
      });
      const url = new URL(this.server.authorization_endpoint);
      url.search = new URLSearchParams({
        client_id: ref2.clientId,
        redirect_uri: redirect,
        response_type: "code",
        scope: GOOGLE_SCOPES,
        state,
        nonce,
        access_type: "offline",
        prompt: "consent",
        login_hint: ref2.email,
        code_challenge_method: "S256",
        code_challenge: await calculatePKCECodeChallenge(verifier)
      }).toString();
      this.assertCurrent(ref2, generation, signal2);
      await (options.openBrowser ?? openSystemBrowser)(url.href);
      const parameters = validateAuthResponse(this.server, client, await callback, state);
      this.assertCurrent(ref2, generation, signal2);
      const response = await authorizationCodeGrantRequest(
        this.server,
        client,
        None(),
        parameters,
        redirect,
        verifier,
        { ...this.requestOptions, signal: signal2 }
      );
      const tokens = await processAuthorizationCodeResponse(this.server, client, response, {
        expectedNonce: nonce,
        requireIdToken: true
      });
      await validateApplicationLevelSignature(this.server, response, {
        ...this.requestOptions,
        signal: signal2
      });
      const claims = getValidatedIdTokenClaims(tokens);
      if (claims.email_verified !== true || typeof claims.email !== "string" || claims.email.toLowerCase() !== ref2.email.toLowerCase()) {
        throw new Error("Google signed in a different or unverified account.");
      }
      this.validateTokens(tokens, true);
      const grant = {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiresAt: Date.now() + tokens.expires_in * 1e3,
        subject: claims.sub,
        email: claims.email.toLowerCase()
      };
      await this.serial(id, async () => {
        this.assertCurrent(ref2, generation, signal2);
        await this.store.write(ref2, grant, revision);
      });
      this.assertCurrent(ref2, generation, signal2);
    } catch {
      throw new AuthOperationError(
        "authorization",
        "Google authorization failed or was canceled. Check the client registration, consent, and selected account; retry connect."
      );
    } finally {
      server.closeAllConnections();
      server.close();
      if (this.active.get(id) === controller2) this.active.delete(id);
    }
  }
  validateTokens(tokens, initial) {
    if (tokens.token_type.toLowerCase() !== "bearer" || !tokens.expires_in || tokens.expires_in <= 0 || initial && !tokens.refresh_token)
      throw new Error("Invalid Google grant.");
    const scopes = new Set(tokens.scope?.split(" "));
    if (scopes.has("https://www.googleapis.com/auth/userinfo.email")) scopes.add("email");
    if ((initial || tokens.scope !== void 0) && !GOOGLE_SCOPES.split(" ").every((s) => scopes.has(s))) {
      throw new Error("Google did not grant all required scopes.");
    }
  }
  async accessToken(ref2) {
    checkRef(ref2);
    const id = key(ref2);
    const running = this.refreshes.get(id);
    if (running) return running;
    const generation = this.version(ref2);
    const controller2 = new AbortController();
    if (this.active.has(id)) throw new Error("Google sign-in is in progress; retry afterward.");
    this.active.set(id, controller2);
    const signal2 = AbortSignal.any([controller2.signal, AbortSignal.timeout(3e4)]);
    const promise = (async () => {
      try {
        const { revision, grant } = await this.store.snapshot(ref2);
        this.assertCurrent(ref2, generation, signal2);
        if (!grant) throw new Error();
        if (grant.expiresAt > Date.now() + 6e4) return grant.accessToken;
        const client = { client_id: ref2.clientId, id_token_signed_response_alg: "RS256" };
        const response = await refreshTokenGrantRequest(
          this.server,
          client,
          None(),
          grant.refreshToken,
          { ...this.requestOptions, signal: signal2 }
        );
        const tokens = await processRefreshTokenResponse(this.server, client, response);
        this.validateTokens(tokens, false);
        if (tokens.id_token) {
          await validateApplicationLevelSignature(this.server, response, {
            ...this.requestOptions,
            signal: signal2
          });
          const claims = getValidatedIdTokenClaims(tokens);
          if (claims.sub !== grant.subject || claims.email !== void 0 && (claims.email !== grant.email || claims.email_verified !== true))
            throw new Error();
        }
        const updated = {
          ...grant,
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token ?? grant.refreshToken,
          expiresAt: Date.now() + tokens.expires_in * 1e3
        };
        await this.serial(id, async () => {
          this.assertCurrent(ref2, generation, signal2);
          await this.store.write(ref2, updated, revision);
        });
        this.assertCurrent(ref2, generation, signal2);
        return updated.accessToken;
      } catch {
        throw new AuthOperationError(
          "reconnect",
          "Google credential unavailable or expired. Reconnect this account; no password fallback was attempted."
        );
      } finally {
        if (this.active.get(id) === controller2) this.active.delete(id);
      }
    })();
    this.refreshes.set(id, promise);
    try {
      return await promise;
    } finally {
      if (this.refreshes.get(id) === promise) this.refreshes.delete(id);
    }
  }
};
var gmailOAuth = new GmailOAuthManager();

// src/auth-cli.ts
loadFileConfig();
var [command, email] = process.argv.slice(2);
var ref = {
  provider: "google",
  clientId: process.env.APPLE_MAIL_MCP_GOOGLE_CLIENT_ID ?? "",
  email: email ?? ""
};
var controller = new AbortController();
process.once("SIGINT", () => controller.abort());
process.once("SIGTERM", () => controller.abort());
try {
  switch (command) {
    case "connect":
    case "reconnect":
      console.error("Opening Google consent in your system browser. No mail will be sent.");
      await gmailOAuth.connect(ref, { signal: controller.signal });
      console.log(JSON.stringify(await gmailOAuth.status(ref)));
      break;
    case "status":
      console.log(JSON.stringify(await gmailOAuth.status(ref)));
      break;
    case "disconnect":
      await gmailOAuth.disconnect(ref);
      console.log(
        "Local Google credentials removed. Keep mail MCP instances stopped until this completes, then restart them. Revoke the app in your Google account to invalidate provider grants."
      );
      break;
    default:
      console.error(
        "Usage: apple-mail-auth connect|status|reconnect|disconnect account@example.com"
      );
      process.exitCode = 2;
  }
} catch (error) {
  console.error(publicAuthFailure(error));
  process.exitCode = 1;
}
