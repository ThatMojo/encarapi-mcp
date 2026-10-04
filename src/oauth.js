// OAuth 2.1 authorization server + protected resource metadata for the hosted
// endpoint, per the MCP authorization spec. Enabled only when MCP_OAUTH_SECRET
// is set.
//
// Stateless by design (single container, no database): client ids,
// authorization codes, access tokens and refresh tokens are AES-256-GCM sealed
// blobs. The API key the user pasted on /authorize travels inside the code and
// the tokens and is only readable by this server. The only in-memory state is
// best-effort and lost on restart: the used-code set, the used-refresh-token
// set and the rate-limit counters.
//
// Protocol plumbing (parameter validation, redirect_uri matching, PKCE check,
// client authentication, metadata documents, CORS, bearer check) comes from
// the MCP SDK's server/auth handlers; this file supplies the stateless provider
// and the key form.
import crypto from "node:crypto";
import express from "express";
import encarapi from "encarapi";
import { authorizationHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/authorize.js";
import { tokenHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/token.js";
import { clientRegistrationHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/register.js";
import { metadataHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/metadata.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import {
  createOAuthMetadata,
  mcpAuthMetadataRouter,
  getOAuthProtectedResourceMetadataUrl,
} from "@modelcontextprotocol/sdk/server/auth/router.js";
import {
  InvalidClientMetadataError,
  InvalidGrantError,
  InvalidTargetError,
  InvalidTokenError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";

const { KoreaClient, ChinaClient } = encarapi;

export const ACCESS_TOKEN_PREFIX = "emat_";
const REFRESH_TOKEN_PREFIX = "emrt_";
const CODE_PREFIX = "emac_";
const CLIENT_PREFIX = "emc_";

const CODE_TTL = 5 * 60;
const ACCESS_TTL = 60 * 60;
const REFRESH_TTL = 90 * 24 * 60 * 60;
const CSRF_TTL = 30 * 60;
// A rotated refresh token stays usable for this long, so a client that lost the
// response (or refreshes from two workers at once) is not logged out.
const REFRESH_REUSE_GRACE = 60;

const KEY_CHECK_MAX = 10;
const KEY_CHECK_WINDOW = 10 * 60;
const KEY_CHECK_TIMEOUT_MS = 10000;

const MAX_REDIRECT_URIS = 10;
const MAX_REDIRECT_URI_LENGTH = 500;
const MAX_KEY_LENGTH = 256;
const MAX_TRACKED = 50000;

const CSRF_COOKIE = "encarapi_mcp_csrf";
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

const b64 = (buf) => Buffer.from(buf).toString("base64url");
const sha = (text) => crypto.createHash("sha256").update(text).digest();
const stripSlash = (s) => String(s).replace(/#.*$/, "").replace(/\/$/, "");

/** AES-256-GCM with one HKDF-derived key per purpose, so blobs cannot be swapped between roles. */
function makeSealer(secret) {
  const keys = new Map();
  const keyFor = (purpose) => {
    if (!keys.has(purpose)) {
      keys.set(purpose, Buffer.from(crypto.hkdfSync("sha256", secret, "encarapi-mcp-oauth", purpose, 32)));
    }
    return keys.get(purpose);
  };
  return {
    seal(purpose, data) {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv("aes-256-gcm", keyFor(purpose), iv);
      const ct = Buffer.concat([cipher.update(JSON.stringify(data), "utf8"), cipher.final()]);
      return b64(Buffer.concat([iv, ct, cipher.getAuthTag()]));
    },
    open(purpose, blob) {
      try {
        const raw = Buffer.from(String(blob), "base64url");
        if (raw.length < 29) return null;
        const decipher = crypto.createDecipheriv("aes-256-gcm", keyFor(purpose), raw.subarray(0, 12));
        decipher.setAuthTag(raw.subarray(raw.length - 16));
        const pt = Buffer.concat([decipher.update(raw.subarray(12, raw.length - 16)), decipher.final()]);
        return JSON.parse(pt.toString("utf8"));
      } catch {
        return null;
      }
    },
  };
}

/** Map of id -> expiry (seconds) that forgets expired entries and stays bounded. */
function makeTtlMap(now) {
  const map = new Map();
  const prune = () => {
    const t = now();
    for (const [k, v] of map) if (v.exp <= t) map.delete(k);
    while (map.size > MAX_TRACKED) map.delete(map.keys().next().value);
  };
  return {
    get: (k) => {
      const v = map.get(k);
      return v && v.exp > now() ? v : undefined;
    },
    set: (k, v) => {
      if (map.size >= 1000) prune();
      map.set(k, v);
    },
  };
}

/** Caller IP: Cloudflare's header first, then the proxy chain, then the socket. */
export function clientIp(req) {
  const cf = req.headers["cf-connecting-ip"];
  if (cf) return String(cf).trim();
  const xff = req.headers["x-forwarded-for"];
  if (xff) return String(xff).split(",")[0].trim();
  return req.socket?.remoteAddress || "unknown";
}

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function redirectHost(uri) {
  try {
    const u = new URL(uri);
    return u.host || u.protocol.replace(/:$/, "");
  } catch {
    return "the client";
  }
}

function renderPage({ nonce, clientName, host, hidden, error }) {
  const fields = Object.entries(hidden)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
    .join("\n      ");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="color-scheme" content="dark">
<title>Connect EnCarAPI</title>
<style nonce="${nonce}">
  *, *::before, *::after { box-sizing: border-box; }
  html { background: #030712; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    padding: 24px 16px; background: #030712; color: #f8fafc;
    font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  main { width: 100%; max-width: 420px; background: #0a0f1a; border: 1px solid #1d283a; border-radius: 14px; padding: 32px 28px; }
  .brand { font-size: 13px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; color: #94a3b8; margin: 0 0 20px; }
  h1 { font-size: 22px; line-height: 1.25; font-weight: 600; letter-spacing: -.01em; margin: 0 0 10px; }
  p { margin: 0; }
  .who { color: #94a3b8; margin-bottom: 24px; overflow-wrap: anywhere; }
  .who strong { color: #f8fafc; font-weight: 600; }
  label { display: block; font-size: 13px; font-weight: 500; margin: 0 0 6px; }
  label span { color: #94a3b8; font-weight: 400; }
  input[type=password] {
    display: block; width: 100%; height: 44px; padding: 0 12px; margin: 0 0 18px;
    background: #030712; color: #f8fafc; border: 1px solid #1d283a; border-radius: 10px;
    font: inherit; font-size: 16px; outline: none;
  }
  input[type=password]:focus-visible { border-color: #f8fafc; box-shadow: 0 0 0 3px rgba(248, 250, 252, .14); }
  button {
    display: block; width: 100%; height: 44px; margin: 6px 0 0; border: 0; border-radius: 10px;
    background: #ffffff; color: #030712; font: inherit; font-weight: 600; cursor: pointer;
  }
  button:hover { background: #e2e8f0; }
  button:focus-visible { outline: 2px solid #f8fafc; outline-offset: 3px; }
  .error { border: 1px solid #f87171; border-radius: 10px; padding: 10px 12px; margin: 0 0 20px; color: #fca5a5; font-size: 14px; }
  .error strong { display: block; color: #f87171; font-weight: 600; }
  .hint { color: #94a3b8; font-size: 14px; margin-top: 20px; }
  .note { color: #64748b; font-size: 12.5px; margin-top: 14px; }
  a { color: #f8fafc; text-underline-offset: 3px; }
</style>
</head>
<body>
  <main>
    <p class="brand">EnCarAPI</p>
    <h1>Connect EnCarAPI</h1>
    <p class="who"><strong>${esc(clientName)}</strong> wants to use EnCarAPI with your key. After connecting you return to <strong>${esc(host)}</strong>.</p>
    ${error ? `<div class="error" role="alert"><strong>${esc(error.title)}</strong>${esc(error.text)}</div>` : ""}
    <form method="post" action="/authorize" autocomplete="off">
      ${fields}
      <label for="encarapi_key">EnCarAPI key</label>
      <input type="password" id="encarapi_key" name="encarapi_key" maxlength="${MAX_KEY_LENGTH}" autocomplete="off" autocapitalize="off" spellcheck="false" autofocus>
      <label for="chinacarapi_key">ChinaCarAPI key <span>(optional)</span></label>
      <input type="password" id="chinacarapi_key" name="chinacarapi_key" maxlength="${MAX_KEY_LENGTH}" autocomplete="off" autocapitalize="off" spellcheck="false">
      <button type="submit">Connect</button>
    </form>
    <p class="hint">No key yet? Get one at <a href="https://encarapi.com" target="_blank" rel="noopener noreferrer">https://encarapi.com</a></p>
    <p class="note">The second field is only needed for a separate ChinaCarAPI key. Keys are checked once and are not stored on this server: they are encrypted into the access token issued to this client.</p>
  </main>
</body>
</html>`;
}

/**
 * Checks the pasted keys with one cheap request each. Returns
 * { ok: true } | { ok: false, reason: "rejected" | "unavailable", product }.
 */
async function checkKeys({ apiKey, chinaKey }, fetchImpl) {
  const base = fetchImpl || fetch;
  const timed = (url, init) => base(url, { ...init, signal: AbortSignal.timeout(KEY_CHECK_TIMEOUT_MS) });
  const probe = async (product, fn) => {
    try {
      await fn();
      return null;
    } catch (e) {
      const rejected = e?.status === 401 || e?.status === 403;
      return { ok: false, reason: rejected ? "rejected" : "unavailable", product };
    }
  };
  if (apiKey) {
    const bad = await probe("EnCarAPI", () => new KoreaClient(apiKey, { fetch: timed }).modelSearch("k5", { limit: 1 }));
    if (bad) return bad;
  }
  if (chinaKey) {
    const bad = await probe("ChinaCarAPI", () => new ChinaClient(chinaKey, { fetch: timed }).catalog({ limit: 1 }));
    if (bad) return bad;
  }
  return { ok: true };
}

/**
 * @param {object} o
 * @param {string} o.secret     MCP_OAUTH_SECRET (at least 32 characters)
 * @param {string} o.publicUrl  public origin, e.g. https://mcp.encarapi.com
 * @param {Function} o.handleMcp (req, res, { apiKey, chinaKey }) for an authenticated /mcp request
 * @param {Function} [o.fetchImpl] fetch used for the key check (tests)
 * @param {Function} [o.now]    clock in ms (tests)
 */
export function createOAuth({ secret, publicUrl, handleMcp, fetchImpl, now: nowMs = Date.now }) {
  if (typeof secret !== "string" || secret.length < 32) {
    throw new Error("MCP_OAUTH_SECRET must be at least 32 characters (e.g. openssl rand -base64 48)");
  }
  const issuerUrl = new URL(publicUrl);
  if (issuerUrl.pathname !== "/" || issuerUrl.search || issuerUrl.hash) {
    throw new Error("MCP_PUBLIC_URL must be an origin without path, e.g. https://mcp.encarapi.com");
  }
  const resourceUrl = new URL("/mcp", issuerUrl);
  const resource = resourceUrl.href;
  const secure = issuerUrl.protocol === "https:";
  const now = () => Math.floor(nowMs() / 1000);
  const { seal, open } = makeSealer(secret);

  const usedCodes = makeTtlMap(now);
  const usedRefresh = makeTtlMap(now);
  const keyChecks = new Map(); // ip -> [timestamps]

  const clientRef = (clientId) => b64(sha(clientId).subarray(0, 16));
  const unwrap = (purpose, prefix, value) =>
    typeof value === "string" && value.startsWith(prefix) ? open(purpose, value.slice(prefix.length)) : null;

  const assertResource = (requested) => {
    if (requested && stripSlash(requested.href ?? requested) !== stripSlash(resource)) {
      throw new InvalidTargetError(`Unknown resource. This server issues tokens for ${resource} only`);
    }
  };

  const clientsStore = {
    getClient(clientId) {
      const c = unwrap("client", CLIENT_PREFIX, clientId);
      if (!c || !Array.isArray(c.r)) return undefined;
      return {
        client_id: clientId,
        client_id_issued_at: c.t,
        redirect_uris: c.r,
        client_name: c.n,
        client_uri: c.u,
        token_endpoint_auth_method: c.m,
        client_secret: c.s,
        client_secret_expires_at: c.s ? 0 : undefined,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      };
    },
    registerClient(meta) {
      const uris = meta.redirect_uris || [];
      if (!uris.length || uris.length > MAX_REDIRECT_URIS) {
        throw new InvalidClientMetadataError(`redirect_uris must contain 1 to ${MAX_REDIRECT_URIS} entries`);
      }
      for (const uri of uris) {
        const u = new URL(uri);
        if (uri.length > MAX_REDIRECT_URI_LENGTH || u.hash) {
          throw new InvalidClientMetadataError("redirect_uris must be short and must not contain a fragment");
        }
        if (u.protocol === "http:" && !LOOPBACK.has(u.hostname)) {
          throw new InvalidClientMetadataError("redirect_uris must use https (http is allowed for localhost only)");
        }
      }
      const issuedAt = now();
      const method = meta.token_endpoint_auth_method === "none" ? "none" : "client_secret_post";
      const clientId =
        CLIENT_PREFIX +
        seal("client", {
          r: uris,
          n: meta.client_name ? String(meta.client_name).slice(0, 80) : undefined,
          u: meta.client_uri ? String(meta.client_uri).slice(0, 200) : undefined,
          m: method,
          s: method === "none" ? undefined : meta.client_secret,
          t: issuedAt,
        });
      return {
        ...meta,
        client_id: clientId,
        client_id_issued_at: issuedAt,
        token_endpoint_auth_method: method,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      };
    },
  };

  function issueTokens(grant) {
    const t = now();
    const base = { k: grant.k, c: grant.c, cid: grant.cid, aud: resource, iat: t };
    return {
      access_token: ACCESS_TOKEN_PREFIX + seal("access", { ...base, exp: t + ACCESS_TTL }),
      token_type: "Bearer",
      expires_in: ACCESS_TTL,
      refresh_token:
        REFRESH_TOKEN_PREFIX + seal("refresh", { ...base, exp: t + REFRESH_TTL, jti: b64(crypto.randomBytes(12)) }),
    };
  }

  function openCode(client, code) {
    const c = unwrap("code", CODE_PREFIX, code);
    if (!c || c.exp <= now() || c.cid !== clientRef(client.client_id)) {
      throw new InvalidGrantError("Invalid or expired authorization code");
    }
    return c;
  }

  function keyCheckAllowed(ip) {
    const t = now();
    if (keyChecks.size > MAX_TRACKED) keyChecks.clear();
    const recent = (keyChecks.get(ip) || []).filter((x) => x > t - KEY_CHECK_WINDOW);
    if (recent.length >= KEY_CHECK_MAX) {
      keyChecks.set(ip, recent);
      return false;
    }
    recent.push(t);
    keyChecks.set(ip, recent);
    return true;
  }

  // Binds the form to the authorization request it was rendered for.
  const csrfBinding = (client, params) =>
    b64(sha([client.client_id, params.redirectUri, params.codeChallenge, params.state ?? ""].join("\n")));

  function sendForm(res, client, params, { status = 200, error } = {}) {
    const req = res.req;
    const src = req.method === "POST" ? req.body || {} : req.query || {};
    const cookieNonce = b64(crypto.randomBytes(18));
    const styleNonce = b64(crypto.randomBytes(16));
    const csrf = seal("csrf", { n: cookieNonce, b: csrfBinding(client, params), exp: now() + CSRF_TTL });
    res.status(status);
    res.setHeader(
      "Set-Cookie",
      `${CSRF_COOKIE}=${cookieNonce}; Path=/authorize; Max-Age=${CSRF_TTL}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`
    );
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader(
      "Content-Security-Policy",
      `default-src 'none'; style-src 'nonce-${styleNonce}'; base-uri 'none'; frame-ancestors 'none'`
    );
    res.end(
      renderPage({
        nonce: styleNonce,
        clientName: client.client_name || "An MCP client",
        host: redirectHost(params.redirectUri),
        error,
        hidden: {
          csrf,
          client_id: client.client_id,
          redirect_uri: params.redirectUri,
          response_type: "code",
          code_challenge: params.codeChallenge,
          code_challenge_method: "S256",
          state: params.state,
          scope: typeof src.scope === "string" ? src.scope : undefined,
          resource: params.resource?.href,
        },
      })
    );
  }

  function csrfValid(req, client, params) {
    const token = open("csrf", req.body.csrf);
    if (!token || token.exp <= now() || token.b !== csrfBinding(client, params)) return false;
    const cookie = String(req.headers.cookie || "")
      .split(";")
      .map((p) => p.trim())
      .find((p) => p.startsWith(CSRF_COOKIE + "="));
    const value = Buffer.from(cookie ? cookie.slice(CSRF_COOKIE.length + 1) : "");
    const expected = Buffer.from(String(token.n));
    return value.length === expected.length && crypto.timingSafeEqual(value, expected);
  }

  const provider = {
    clientsStore,

    // Called by the SDK handler after client_id, redirect_uri and the PKCE
    // parameters are validated - for the initial GET and for the form POST
    // (the form carries the original parameters, so they are validated again).
    async authorize(client, params, res) {
      assertResource(params.resource);
      const req = res.req;
      const body = req.method === "POST" ? req.body || {} : null;
      if (!body || typeof body.csrf !== "string") return sendForm(res, client, params);

      if (!csrfValid(req, client, params)) {
        return sendForm(res, client, params, {
          status: 400,
          error: { title: "This form expired.", text: "Please enter your key again." },
        });
      }
      const clean = (v) => (typeof v === "string" ? v.trim().slice(0, MAX_KEY_LENGTH) : "");
      const apiKey = clean(body.encarapi_key);
      const chinaKey = clean(body.chinacarapi_key);
      if (!apiKey && !chinaKey) {
        return sendForm(res, client, params, {
          status: 400,
          error: { title: "A key is required.", text: "Paste your EnCarAPI key to connect." },
        });
      }
      if (!keyCheckAllowed(clientIp(req))) {
        return sendForm(res, client, params, {
          status: 429,
          error: { title: "Too many attempts.", text: "Please wait a few minutes and try again." },
        });
      }
      const check = await checkKeys({ apiKey, chinaKey }, fetchImpl);
      if (!check.ok) {
        return sendForm(res, client, params, {
          status: check.reason === "rejected" ? 400 : 503,
          error:
            check.reason === "rejected"
              ? { title: `This ${check.product} key was not accepted.`, text: "Check the key and that your plan is active." }
              : { title: `${check.product} could not be reached.`, text: "The key was not checked. Please try again in a moment." },
        });
      }

      const code =
        CODE_PREFIX +
        seal("code", {
          k: apiKey || undefined,
          c: chinaKey || undefined,
          cid: clientRef(client.client_id),
          ru: params.redirectUri,
          cc: params.codeChallenge,
          exp: now() + CODE_TTL,
          jti: b64(crypto.randomBytes(12)),
        });
      const target = new URL(params.redirectUri);
      target.searchParams.set("code", code);
      if (params.state !== undefined) target.searchParams.set("state", params.state);
      target.searchParams.set("iss", oauthMetadata.issuer);
      res.setHeader("Set-Cookie", `${CSRF_COOKIE}=; Path=/authorize; Max-Age=0; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`);
      res.setHeader("Referrer-Policy", "no-referrer");
      res.redirect(302, target.href);
    },

    async challengeForAuthorizationCode(client, code) {
      return openCode(client, code).cc;
    },

    // The SDK handler has verified the PKCE code_verifier against the challenge before this runs.
    async exchangeAuthorizationCode(client, code, _verifier, redirectUri, requestedResource) {
      const c = openCode(client, code);
      if (redirectUri !== undefined && redirectUri !== c.ru) {
        throw new InvalidGrantError("redirect_uri does not match the authorization request");
      }
      assertResource(requestedResource);
      if (usedCodes.get(c.jti)) throw new InvalidGrantError("Authorization code was already used");
      usedCodes.set(c.jti, { exp: c.exp });
      return issueTokens(c);
    },

    async exchangeRefreshToken(client, refreshToken, _scopes, requestedResource) {
      const r = unwrap("refresh", REFRESH_TOKEN_PREFIX, refreshToken);
      if (!r || r.exp <= now() || r.cid !== clientRef(client.client_id) || r.aud !== resource) {
        throw new InvalidGrantError("Invalid or expired refresh token");
      }
      assertResource(requestedResource);
      const used = usedRefresh.get(r.jti);
      if (used && now() - used.at > REFRESH_REUSE_GRACE) {
        throw new InvalidGrantError("Refresh token was already used");
      }
      if (!used) usedRefresh.set(r.jti, { exp: r.exp, at: now() });
      return issueTokens(r);
    },

    async verifyAccessToken(token) {
      const a = unwrap("access", ACCESS_TOKEN_PREFIX, token);
      if (!a) throw new InvalidTokenError("Invalid access token");
      if (a.exp <= now()) throw new InvalidTokenError("Token has expired");
      return {
        token,
        clientId: a.cid,
        scopes: [],
        expiresAt: a.exp,
        resource: new URL(a.aud),
        extra: { apiKey: a.k, chinaKey: a.c },
      };
    },
  };

  const oauthMetadata = {
    ...createOAuthMetadata({
      provider,
      issuerUrl,
      serviceDocumentationUrl: new URL("https://github.com/ThatMojo/encarapi-mcp"),
    }),
    authorization_response_iss_parameter_supported: true,
  };
  const resourceName = "EnCarAPI MCP server";
  const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(resourceUrl);
  const wwwAuthenticate = `Bearer resource_metadata="${resourceMetadataUrl}"`;

  // The SDK's per-IP limits, keyed by the real caller instead of the proxy. Token and
  // registration limits are generous because hosted clients share egress addresses.
  const limit = (max) => ({ max, keyGenerator: (req) => clientIp(req), validate: false });

  const app = express();
  app.disable("x-powered-by");
  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    next();
  });
  app.use("/authorize", authorizationHandler({ provider, rateLimit: limit(100) }));
  app.use("/token", tokenHandler({ provider, rateLimit: limit(600) }));
  app.use(
    "/register",
    clientRegistrationHandler({ clientsStore, clientSecretExpirySeconds: 0, clientIdGeneration: false, rateLimit: limit(300) })
  );
  app.use("/.well-known", (_req, res, next) => {
    res.setHeader("Cache-Control", "public, max-age=300");
    next();
  });
  // /.well-known/oauth-authorization-server and /.well-known/oauth-protected-resource/mcp
  app.use(
    mcpAuthMetadataRouter({
      oauthMetadata,
      resourceServerUrl: resourceUrl,
      resourceName,
      serviceDocumentationUrl: new URL("https://github.com/ThatMojo/encarapi-mcp"),
    })
  );
  // Root variant for clients that do not append the resource path.
  app.use(
    "/.well-known/oauth-protected-resource",
    metadataHandler({
      resource,
      authorization_servers: [oauthMetadata.issuer],
      resource_name: resourceName,
      resource_documentation: "https://github.com/ThatMojo/encarapi-mcp",
    })
  );
  app.post(
    "/mcp",
    requireBearerAuth({ verifier: provider, resourceMetadataUrl, expectedResource: resourceUrl }),
    (req, res) => handleMcp(req, res, { apiKey: req.auth.extra.apiKey, chinaKey: req.auth.extra.chinaKey })
  );
  app.use((_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.status(404).json({ error: "Not found. MCP endpoint: /mcp" });
  });
  app.use((err, _req, res, _next) => {
    const status = err?.status >= 400 && err?.status < 500 ? err.status : 500;
    if (!res.headersSent) res.status(status).json({ error: status === 500 ? "server_error" : "invalid_request" });
  });

  return {
    app,
    provider,
    resource,
    resourceMetadataUrl,
    wwwAuthenticate,
    owns: (pathname) =>
      pathname === "/authorize" || pathname === "/token" || pathname === "/register" || pathname.startsWith("/.well-known/oauth-"),
  };
}
