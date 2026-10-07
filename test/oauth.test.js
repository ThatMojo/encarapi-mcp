// Offline test of the hosted endpoint: OAuth flow, legacy key auth, OAuth disabled.
// Real HTTP against a local listener; the upstream API is a fake fetch.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import { createHandler } from "../src/app.js";

const PUBLIC = "https://mcp.example.test";
const RESOURCE = `${PUBLIC}/mcp`;
const SECRET = "test-secret-test-secret-test-secret-0123456789";
const REDIRECT = "https://client.example/callback";

// good_key / legacy_key: EnCarAPI keys with the China add-on (accepted by both APIs).
// good_cn_key: ChinaCarAPI key. old_cn_key: ChinaCarAPI key on an API without /api/me.
const upstream = [];
const fakeFetch = async (url, init = {}) => {
  const u = new URL(url);
  const key = init.headers?.["x-api-key"];
  upstream.push({ url: u, key });
  if (key === "down_key") throw new Error("network down");
  const china = u.hostname === "api.chinacarapi.com";
  const valid =
    key === "good_key" || key === "legacy_key" || (china && (key === "good_cn_key" || key === "old_cn_key" || key === "busy_key"));
  if (!valid) {
    return { status: 403, ok: false, text: async () => JSON.stringify({ error: "Invalid or inactive API key." }) };
  }
  if (u.pathname === "/api/me") {
    if (key === "busy_key") return { status: 503, ok: false, text: async () => JSON.stringify({ error: "Auth backend unavailable, retry shortly." }) };
    if (key === "old_cn_key") return { status: 404, ok: false, text: async () => JSON.stringify({ error: "Not found" }) };
    const product = key === "good_cn_key" ? "chinacarapi" : "encarapi-addon";
    return { status: 200, ok: true, text: async () => JSON.stringify({ product, plan: "trial" }) };
  }
  const payload = u.pathname === "/api/catalog" ? { Count: 0, total: 0, SearchResults: [], results: [] } : [];
  return { status: 200, ok: true, text: async () => JSON.stringify(payload) };
};

let clockOffset = 0;
const now = () => Date.now() + clockOffset;

async function listen(env) {
  const server = http.createServer(createHandler({ env, fetchImpl: fakeFetch, now }));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

const form = (data) => new URLSearchParams(Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined)));
const rpc = (method, params = {}) => JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
const mcpPost = (base, headers, body = rpc("tools/list"), path = "/mcp") =>
  fetch(base + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
    body,
  });
const pkce = () => {
  const verifier = crypto.randomBytes(32).toString("base64url");
  return { verifier, challenge: crypto.createHash("sha256").update(verifier).digest("base64url") };
};
const hiddenFields = (html) =>
  Object.fromEntries(
    [...html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)].map((m) => [
      m[1],
      m[2].replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">"),
    ])
  );

let steps = 0;
async function step(name, fn) {
  try {
    await fn();
    steps++;
  } catch (e) {
    console.error(`FAILED: ${name}`);
    throw e;
  }
}

// ---------------------------------------------------------------------------
// OAuth disabled: behaves like 1.0.x
// ---------------------------------------------------------------------------
{
  const { server, base } = await listen({});
  await step("disabled: no OAuth endpoints, plain 401, key auth works", async () => {
    for (const path of ["/.well-known/oauth-authorization-server", "/.well-known/oauth-protected-resource/mcp", "/authorize", "/register", "/token"]) {
      assert.equal((await fetch(base + path)).status, 404, path);
    }
    const unauth = await mcpPost(base, {});
    assert.equal(unauth.status, 401);
    assert.equal(unauth.headers.get("www-authenticate"), null);
    assert.equal(unauth.headers.get("access-control-allow-origin"), null);
    assert.equal((await unauth.json()).error.code, -32001);
    assert.equal((await fetch(base + "/mcp", { method: "OPTIONS" })).status, 405);

    const ok = await mcpPost(base, { "x-api-key": "legacy_key" });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).result.tools.length, 11);
  });
  server.close();
}

await step("secret too short is refused at startup", () => {
  assert.throws(() => createHandler({ env: { MCP_OAUTH_SECRET: "short" } }), /at least 32/);
});

// ---------------------------------------------------------------------------
// OAuth enabled
// ---------------------------------------------------------------------------
const { server, base } = await listen({ MCP_OAUTH_SECRET: SECRET, MCP_PUBLIC_URL: PUBLIC });

await step("metadata documents", async () => {
  const as = await fetch(base + "/.well-known/oauth-authorization-server");
  assert.equal(as.status, 200);
  assert.equal(as.headers.get("access-control-allow-origin"), "*");
  const meta = await as.json();
  assert.equal(meta.issuer, PUBLIC + "/");
  assert.equal(meta.authorization_endpoint, PUBLIC + "/authorize");
  assert.equal(meta.token_endpoint, PUBLIC + "/token");
  assert.equal(meta.registration_endpoint, PUBLIC + "/register");
  assert.deepEqual(meta.response_types_supported, ["code"]);
  assert.deepEqual(meta.code_challenge_methods_supported, ["S256"]);
  assert.deepEqual(meta.grant_types_supported, ["authorization_code", "refresh_token"]);
  assert.ok(meta.token_endpoint_auth_methods_supported.includes("none"));
  assert.equal(meta.authorization_response_iss_parameter_supported, true);

  for (const path of ["/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-protected-resource"]) {
    const res = await fetch(base + path);
    assert.equal(res.status, 200, path);
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
    const prm = await res.json();
    assert.equal(prm.resource, RESOURCE);
    assert.deepEqual(prm.authorization_servers, [PUBLIC + "/"]);
  }
  assert.equal((await fetch(base + "/.well-known/oauth-protected-resource/other")).status, 404);
});

await step("401 challenge on /mcp without credentials", async () => {
  const res = await mcpPost(base, {});
  assert.equal(res.status, 401);
  assert.equal(res.headers.get("www-authenticate"), `Bearer resource_metadata="${PUBLIC}/.well-known/oauth-protected-resource/mcp"`);
  assert.match(res.headers.get("access-control-expose-headers"), /WWW-Authenticate/);
  assert.equal((await res.json()).error.code, -32001);
  const pre = await fetch(base + "/mcp", { method: "OPTIONS", headers: { Origin: "https://app.example", "Access-Control-Request-Method": "POST" } });
  assert.equal(pre.status, 204);
  assert.match(pre.headers.get("access-control-allow-headers"), /Authorization/);
});

async function register(meta = {}) {
  const res = await fetch(base + "/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ redirect_uris: [REDIRECT], client_name: "Test <Client>", token_endpoint_auth_method: "none", ...meta }),
  });
  return { res, body: await res.json() };
}

let client;
await step("dynamic client registration (stateless client_id)", async () => {
  const { res, body } = await register();
  assert.equal(res.status, 201);
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
  assert.match(body.client_id, /^emc_/);
  assert.equal(body.client_secret, undefined);
  assert.deepEqual(body.redirect_uris, [REDIRECT]);
  client = body;

  const confidential = await register({ token_endpoint_auth_method: "client_secret_post" });
  assert.equal(confidential.res.status, 201);
  assert.ok(confidential.body.client_secret);
  assert.equal(confidential.body.client_secret_expires_at, 0);

  assert.equal((await register({ redirect_uris: ["http://evil.example/cb"] })).res.status, 400);
  assert.equal((await register({ redirect_uris: ["javascript:alert(1)"] })).res.status, 400);
  assert.equal((await register({ redirect_uris: [] })).res.status, 400);
  assert.equal((await register({ redirect_uris: ["http://localhost:1234/cb"] })).res.status, 201);
});

const authParams = (challenge, extra = {}) =>
  form({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "st&ate=1",
    resource: RESOURCE,
    ...extra,
  });

/** GET the form, then POST it with the given keys. Returns the POST response. */
async function submit({ challenge, keys, ip = "198.51.100.1", extra, mutate, cookie = true }) {
  const page = await fetch(`${base}/authorize?${authParams(challenge, extra)}`, { redirect: "manual" });
  assert.equal(page.status, 200);
  const html = await page.text();
  const fields = hiddenFields(html);
  if (mutate) mutate(fields);
  const setCookie = page.headers.get("set-cookie") || "";
  const res = await fetch(base + "/authorize", {
    method: "POST",
    redirect: "manual",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "CF-Connecting-IP": ip,
      ...(cookie ? { Cookie: setCookie.split(";")[0] } : {}),
    },
    body: form({ ...fields, ...keys }),
  });
  return { res, html, setCookie };
}

async function authorizeCode(keys = { encarapi_key: "good_key" }, ip) {
  const { verifier, challenge } = pkce();
  const { res } = await submit({ challenge, keys, ip });
  assert.equal(res.status, 302);
  const loc = new URL(res.headers.get("location"));
  return { code: loc.searchParams.get("code"), verifier, loc };
}

const token = async (data) => {
  const res = await fetch(base + "/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form(data) });
  return { res, body: await res.json() };
};
const exchange = (code, verifier, extra = {}) =>
  token({ grant_type: "authorization_code", client_id: client.client_id, code, code_verifier: verifier, redirect_uri: REDIRECT, resource: RESOURCE, ...extra });

await step("authorize page: form, client name, redirect host, security headers", async () => {
  const { challenge } = pkce();
  const page = await fetch(`${base}/authorize?${authParams(challenge)}`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type"), /text\/html/);
  assert.equal(page.headers.get("cache-control"), "no-store");
  assert.match(page.headers.get("content-security-policy"), /default-src 'none'/);
  assert.equal(page.headers.get("x-frame-options"), "DENY");
  const cookie = page.headers.get("set-cookie");
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Secure/);
  const html = await page.text();
  assert.match(html, /<title>Connect EnCarAPI<\/title>/);
  assert.match(html, /Test &lt;Client&gt;/, "client name is shown, HTML-escaped");
  assert.match(html, /client\.example/, "redirect host is shown");
  assert.match(html, /type="password"[^>]*name="encarapi_key"/);
  assert.match(html, /type="password"[^>]*name="chinacarapi_key"/);
  assert.match(html, /No key yet\? Get one at <a href="https:\/\/encarapi\.com"/);
  assert.match(html, /<form method="post" action="\/authorize"/);
  assert.doesNotMatch(html, /<script|<link|<img|src=|url\(|@import/, "no scripts, no external assets");
  assert.doesNotMatch(html, /[–—→]/, "no long dashes or arrows");
  const fields = hiddenFields(html);
  assert.equal(fields.state, "st&ate=1");
  assert.equal(fields.redirect_uri, REDIRECT);
  assert.ok(fields.csrf);
});

await step("authorize rejects unknown client, unregistered redirect_uri, missing PKCE, foreign resource", async () => {
  const { challenge } = pkce();
  const get = (extra) => fetch(`${base}/authorize?${authParams(challenge, extra)}`, { redirect: "manual" });

  const wrongRedirect = await get({ redirect_uri: "https://evil.example/callback" });
  assert.equal(wrongRedirect.status, 400);
  assert.equal(wrongRedirect.headers.get("location"), null);
  assert.equal((await get({ redirect_uri: REDIRECT + "/extra" })).status, 400);

  assert.equal((await get({ client_id: "emc_AAAA" })).status, 400);
  const tampered = client.client_id.slice(0, -3) + (client.client_id.endsWith("AAA") ? "BBB" : "AAA");
  assert.equal((await get({ client_id: tampered })).status, 400);

  const noPkce = await get({ code_challenge: undefined });
  assert.equal(noPkce.status, 302);
  assert.equal(new URL(noPkce.headers.get("location")).searchParams.get("error"), "invalid_request");
  const plain = await get({ code_challenge_method: "plain" });
  assert.equal(new URL(plain.headers.get("location")).searchParams.get("error"), "invalid_request");

  const foreign = await get({ resource: "https://other.example/mcp" });
  assert.equal(foreign.status, 302);
  assert.equal(new URL(foreign.headers.get("location")).searchParams.get("error"), "invalid_target");
});

await step("wrong key shows an inline error instead of redirecting", async () => {
  const { challenge } = pkce();
  const before = upstream.length;
  const { res } = await submit({ challenge, keys: { encarapi_key: "bad_key" }, ip: "198.51.100.2" });
  assert.equal(res.status, 400);
  assert.equal(res.headers.get("location"), null);
  const html = await res.text();
  assert.match(html, /This EnCarAPI key was not accepted\./);
  assert.doesNotMatch(html, /bad_key/, "the key is not echoed back");
  assert.deepEqual(
    upstream.slice(before).map((r) => r.url.host + r.url.pathname),
    ["api.encarapi.com/api/model-search", "api.chinacarapi.com/api/me"],
    "Korea first, then China, one request each"
  );

  const empty = await submit({ challenge, keys: {}, ip: "198.51.100.2" });
  assert.equal(empty.res.status, 400);
  assert.match(await empty.res.text(), /A key is required\./);

  const down = await submit({ challenge, keys: { encarapi_key: "down_key" }, ip: "198.51.100.2" });
  assert.equal(down.res.status, 503);
  assert.match(await down.res.text(), /could not be reached/);

  const badChina = await submit({ challenge, keys: { encarapi_key: "good_key", chinacarapi_key: "nope" }, ip: "198.51.100.2" });
  assert.equal(badChina.res.status, 400);
  assert.match(await badChina.res.text(), /This ChinaCarAPI key was not accepted\./);
});

await step("form CSRF protection", async () => {
  const { challenge } = pkce();
  const before = upstream.length;
  const noCookie = await submit({ challenge, keys: { encarapi_key: "good_key" }, cookie: false });
  assert.equal(noCookie.res.status, 400);
  assert.match(await noCookie.res.text(), /This form expired\./);

  const forged = await submit({ challenge, keys: { encarapi_key: "good_key" }, mutate: (f) => (f.csrf = "AAAA") });
  assert.equal(forged.res.status, 400);

  // A token rendered for one authorization request does not work for another one.
  const other = await submit({ challenge, keys: { encarapi_key: "good_key" }, mutate: (f) => (f.state = "different") });
  assert.equal(other.res.status, 400);

  // Changing the redirect target in the form is caught by the redirect_uri check.
  const moved = await submit({ challenge, keys: { encarapi_key: "good_key" }, mutate: (f) => (f.redirect_uri = "https://evil.example/cb") });
  assert.equal(moved.res.status, 400);
  assert.equal(moved.res.headers.get("location"), null);
  assert.equal(upstream.length, before, "no key check without a valid form token");
});

let tokens;
await step("full flow: authorize -> code -> token -> /mcp", async () => {
  const { code, verifier, loc } = await authorizeCode();
  assert.equal(loc.origin + loc.pathname, REDIRECT);
  assert.equal(loc.searchParams.get("state"), "st&ate=1");
  assert.equal(loc.searchParams.get("iss"), PUBLIC + "/");
  assert.match(code, /^emac_/);
  assert.doesNotMatch(loc.href, /good_key/);

  const wrongVerifier = await exchange(code, pkce().verifier);
  assert.equal(wrongVerifier.res.status, 400);
  assert.equal(wrongVerifier.body.error, "invalid_grant");

  const wrongRedirect = await exchange(code, verifier, { redirect_uri: "https://client.example/other" });
  assert.equal(wrongRedirect.res.status, 400);
  assert.equal(wrongRedirect.body.error, "invalid_grant");

  const wrongResource = await exchange(code, verifier, { resource: "https://other.example/mcp" });
  assert.equal(wrongResource.body.error, "invalid_target");

  const otherClient = (await register({ client_name: "Other" })).body;
  const stolen = await exchange(code, verifier, { client_id: otherClient.client_id });
  assert.equal(stolen.body.error, "invalid_grant");

  const ok = await exchange(code, verifier);
  assert.equal(ok.res.status, 200);
  assert.equal(ok.res.headers.get("cache-control"), "no-store");
  assert.equal(ok.body.token_type.toLowerCase(), "bearer");
  assert.equal(ok.body.expires_in, 3600);
  assert.match(ok.body.access_token, /^emat_/);
  assert.match(ok.body.refresh_token, /^emrt_/);
  assert.doesNotMatch(JSON.stringify(ok.body), /good_key/, "the key is not readable in the tokens");
  tokens = ok.body;

  const replay = await exchange(code, verifier);
  assert.equal(replay.res.status, 400);
  assert.equal(replay.body.error, "invalid_grant");

  const list = await mcpPost(base, { Authorization: `Bearer ${tokens.access_token}` });
  assert.equal(list.status, 200);
  assert.equal((await list.json()).result.tools.length, 11);

  const call = await mcpPost(
    base,
    { Authorization: `Bearer ${tokens.access_token}` },
    rpc("tools/call", { name: "search_korean_cars", arguments: { manufacturer: "Kia" } })
  );
  assert.equal(call.status, 200);
  assert.equal((await call.json()).result.isError, undefined);
  assert.equal(upstream.at(-1).key, "good_key", "the tool call uses the key from the token");
  assert.equal(upstream.at(-1).url.hostname, "api.encarapi.com");
});

await step("separate ChinaCarAPI key travels in the token", async () => {
  const { code, verifier } = await authorizeCode({ chinacarapi_key: "good_cn_key" }, "198.51.100.3");
  const { body } = await exchange(code, verifier);
  const cn = await mcpPost(base, { Authorization: `Bearer ${body.access_token}` }, rpc("tools/call", { name: "search_chinese_cars", arguments: {} }));
  assert.equal((await cn.json()).result.isError, undefined);
  assert.equal(upstream.at(-1).key, "good_cn_key");
  assert.equal(upstream.at(-1).url.hostname, "api.chinacarapi.com");
  const kr = await mcpPost(base, { Authorization: `Bearer ${body.access_token}` }, rpc("tools/call", { name: "search_korean_cars", arguments: {} }));
  assert.equal((await kr.json()).result.isError, true, "no Korean key in this token");
});

await step("tampered and foreign tokens are rejected with a 401 challenge", async () => {
  const at = tokens.access_token;
  const flipped = at.slice(0, 20) + (at[20] === "A" ? "B" : "A") + at.slice(21);
  for (const bad of [flipped, at.slice(0, -4), "emat_", "emat_" + tokens.refresh_token.slice(5)]) {
    const res = await mcpPost(base, { Authorization: `Bearer ${bad}` });
    assert.equal(res.status, 401);
    assert.match(res.headers.get("www-authenticate"), /^Bearer error="invalid_token".*resource_metadata="https:\/\/mcp\.example\.test\/\.well-known\/oauth-protected-resource\/mcp"/);
  }
  // An access token is not a refresh token and a refresh token is not a code.
  const asRefresh = await token({ grant_type: "refresh_token", client_id: client.client_id, refresh_token: "emrt_" + at.slice(5) });
  assert.equal(asRefresh.body.error, "invalid_grant");
  const asCode = await exchange("emac_" + tokens.refresh_token.slice(5), pkce().verifier);
  assert.equal(asCode.body.error, "invalid_grant");

  // A token sealed with another secret (another deployment) does not work here.
  const foreign = await listen({ MCP_OAUTH_SECRET: SECRET.replace("test", "tset"), MCP_PUBLIC_URL: PUBLIC });
  assert.equal((await mcpPost(foreign.base, { Authorization: `Bearer ${at}` })).status, 401);
  foreign.server.close();
  // Same secret but another public URL: the audience does not match.
  const moved = await listen({ MCP_OAUTH_SECRET: SECRET, MCP_PUBLIC_URL: "https://other.example.test" });
  assert.equal((await mcpPost(moved.base, { Authorization: `Bearer ${at}` })).status, 401);
  moved.server.close();
});

await step("refresh rotation", async () => {
  const refresh = (rt, extra = {}) => token({ grant_type: "refresh_token", client_id: client.client_id, refresh_token: rt, resource: RESOURCE, ...extra });
  const first = await refresh(tokens.refresh_token);
  assert.equal(first.res.status, 200);
  assert.notEqual(first.body.refresh_token, tokens.refresh_token);
  assert.notEqual(first.body.access_token, tokens.access_token);
  assert.equal((await mcpPost(base, { Authorization: `Bearer ${first.body.access_token}` })).status, 200);

  // Retry within the grace period still works (lost response), later reuse does not.
  assert.equal((await refresh(tokens.refresh_token)).res.status, 200);
  clockOffset += 2 * 60 * 1000;
  const reuse = await refresh(tokens.refresh_token);
  assert.equal(reuse.res.status, 400);
  assert.equal(reuse.body.error, "invalid_grant");

  const otherClient = (await register({ client_name: "Other" })).body;
  assert.equal((await refresh(first.body.refresh_token, { client_id: otherClient.client_id })).body.error, "invalid_grant");
  assert.equal((await refresh(first.body.refresh_token, { resource: "https://other.example/mcp" })).body.error, "invalid_target");
  assert.equal((await refresh(first.body.refresh_token.slice(0, -2) + "xx")).body.error, "invalid_grant");

  const second = await refresh(first.body.refresh_token);
  assert.equal(second.res.status, 200);
  tokens = second.body;
});

await step("expired code, access token and refresh token are rejected", async () => {
  const { code, verifier } = await authorizeCode({ encarapi_key: "good_key" }, "198.51.100.4");
  clockOffset += 6 * 60 * 1000;
  const late = await exchange(code, verifier);
  assert.equal(late.res.status, 400);
  assert.equal(late.body.error, "invalid_grant");

  assert.equal((await mcpPost(base, { Authorization: `Bearer ${tokens.access_token}` })).status, 200);
  clockOffset += 61 * 60 * 1000;
  const expired = await mcpPost(base, { Authorization: `Bearer ${tokens.access_token}` });
  assert.equal(expired.status, 401);
  assert.match(expired.headers.get("www-authenticate"), /error="invalid_token"/);

  const stillGood = await token({ grant_type: "refresh_token", client_id: client.client_id, refresh_token: tokens.refresh_token });
  assert.equal(stillGood.res.status, 200);
  clockOffset += 91 * 24 * 60 * 60 * 1000;
  const dead = await token({ grant_type: "refresh_token", client_id: client.client_id, refresh_token: stillGood.body.refresh_token });
  assert.equal(dead.body.error, "invalid_grant");
});

await step("key check is rate limited per IP", async () => {
  const { challenge } = pkce();
  const ip = "203.0.113.9";
  for (let i = 0; i < 10; i++) {
    const { res } = await submit({ challenge, keys: { encarapi_key: "bad_key" }, ip });
    assert.equal(res.status, 400);
  }
  const before = upstream.length;
  const blocked = await submit({ challenge, keys: { encarapi_key: "good_key" }, ip });
  assert.equal(blocked.res.status, 429);
  assert.match(await blocked.res.text(), /Too many attempts\./);
  assert.equal(upstream.length, before, "no upstream request once limited");
  const otherIp = await submit({ challenge, keys: { encarapi_key: "good_key" }, ip: "203.0.113.10" });
  assert.equal(otherIp.res.status, 302);
});

await step("legacy key auth is unchanged with OAuth enabled", async () => {
  const cases = [
    [{ Authorization: "Bearer legacy_key" }, "/mcp"],
    [{ "x-api-key": "legacy_key" }, "/mcp"],
    [{}, "/mcp?key=legacy_key"],
  ];
  for (const [headers, path] of cases) {
    const res = await mcpPost(base, headers, rpc("tools/call", { name: "find_korean_models", arguments: { search: "k5" } }), path);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).result.isError, undefined);
    assert.equal(upstream.at(-1).key, "legacy_key");
  }
  const cn = await mcpPost(base, { "x-china-key": "good_cn_key" }, rpc("tools/call", { name: "search_chinese_cars", arguments: {} }));
  assert.equal(upstream.at(-1).key, "good_cn_key");
  assert.equal(cn.status, 200);
  assert.equal((await fetch(base + "/health")).status, 200);
  assert.equal((await fetch(base + "/mcp")).status, 405);
});

server.close();

// ---------------------------------------------------------------------------
// Two public hosts in one process (MCP_PUBLIC_URLS)
// ---------------------------------------------------------------------------
const CN_PUBLIC = "https://mcp.chinacarapi.test";
const CN_RESOURCE = `${CN_PUBLIC}/mcp`;
const KR_HOST = new URL(PUBLIC).host;
const CN_HOST = new URL(CN_PUBLIC).host;
const multi = await listen({ MCP_OAUTH_SECRET: SECRET, MCP_PUBLIC_URLS: ` ${PUBLIC} , ${CN_PUBLIC}` });

// fetch() cannot set the Host header, so these requests go through node:http.
function hostFetch(host, path, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(multi.base + path, { method, headers: { ...headers, Host: host } }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({
          status: res.statusCode,
          headers: { get: (name) => res.headers[name.toLowerCase()] ?? null },
          text: async () => text,
          json: async () => JSON.parse(text),
        });
      });
    });
    req.on("error", reject);
    if (body) req.write(String(body));
    req.end();
  });
}
const hostMcp = (host, headers, body = rpc("tools/list")) =>
  hostFetch(host, "/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
    body,
  });
const hostRegister = async (host) =>
  (
    await hostFetch(host, "/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ redirect_uris: [REDIRECT], client_name: "Multi", token_endpoint_auth_method: "none" }),
    })
  ).json();
const hostToken = async (host, data) => {
  const res = await hostFetch(host, "/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form(data),
  });
  return { res, body: await res.json() };
};

/** Full browser step on one host: GET the form, POST the keys. Returns the POST response and the PKCE pair. */
async function hostSubmit(host, cl, resource, keys, ip) {
  const { verifier, challenge } = pkce();
  const q = form({ response_type: "code", client_id: cl.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256", state: "s", resource });
  const page = await hostFetch(host, `/authorize?${q}`);
  assert.equal(page.status, 200);
  const html = await page.text();
  const res = await hostFetch(host, "/authorize", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "CF-Connecting-IP": ip,
      Cookie: String(page.headers.get("set-cookie")).split(";")[0],
    },
    body: form({ ...hiddenFields(html), ...keys }),
  });
  return { res, verifier, html };
}

const cnClient = await hostRegister(CN_HOST);
const krClient = await hostRegister(KR_HOST);

/** Connects on a host and returns the token response body. */
async function hostConnect(host, cl, resource, keys, ip) {
  const { res, verifier } = await hostSubmit(host, cl, resource, keys, ip);
  assert.equal(res.status, 302, await res.text());
  const loc = new URL(res.headers.get("location"));
  const code = loc.searchParams.get("code");
  const { body } = await hostToken(host, { grant_type: "authorization_code", client_id: cl.client_id, code, code_verifier: verifier, redirect_uri: REDIRECT, resource });
  assert.ok(body.access_token, JSON.stringify(body));
  return { ...body, code, verifier, iss: loc.searchParams.get("iss") };
}
const callTool = async (host, headers, name, args = {}) =>
  (await (await hostMcp(host, headers, rpc("tools/call", { name, arguments: args }))).json()).result;

await step("multi-host: discovery, issuer and 401 per Host header", async () => {
  for (const [host, origin, name] of [
    [CN_HOST, CN_PUBLIC, "ChinaCarAPI MCP server"],
    [`${CN_HOST}:443`, CN_PUBLIC, "ChinaCarAPI MCP server"],
    [KR_HOST, PUBLIC, "EnCarAPI MCP server"],
    ["unknown.example", PUBLIC, "EnCarAPI MCP server"],
  ]) {
    const as = await (await hostFetch(host, "/.well-known/oauth-authorization-server")).json();
    assert.equal(as.issuer, origin + "/", host);
    assert.equal(as.authorization_endpoint, origin + "/authorize");
    assert.equal(as.token_endpoint, origin + "/token");
    const prm = await (await hostFetch(host, "/.well-known/oauth-protected-resource/mcp")).json();
    assert.equal(prm.resource, origin + "/mcp");
    assert.deepEqual(prm.authorization_servers, [origin + "/"]);
    assert.equal(prm.resource_name, name);
  }
  const cn401 = await hostMcp(CN_HOST, {});
  assert.equal(cn401.status, 401);
  assert.equal(cn401.headers.get("www-authenticate"), `Bearer resource_metadata="${CN_PUBLIC}/.well-known/oauth-protected-resource/mcp"`);
  assert.match((await cn401.json()).error.message, /https:\/\/chinacarapi\.com/);
  const kr401 = await hostMcp(KR_HOST, {});
  assert.match((await kr401.json()).error.message, /get one at https:\/\/encarapi\.com\)/);
});

await step("multi-host: ChinaCarAPI form, EnCarAPI form unchanged", async () => {
  const { challenge } = pkce();
  const q = (cl, resource) => form({ response_type: "code", client_id: cl.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256", resource });
  const cn = await (await hostFetch(CN_HOST, `/authorize?${q(cnClient, CN_RESOURCE)}`)).text();
  assert.match(cn, /<title>Connect ChinaCarAPI<\/title>/);
  assert.match(cn, /<h1>Connect ChinaCarAPI<\/h1>/);
  assert.match(cn, /<label for="chinacarapi_key">ChinaCarAPI key<\/label>\s*<input type="password" id="chinacarapi_key" name="chinacarapi_key"[^>]*autofocus>/);
  assert.match(cn, /EnCarAPI key <span>\(optional\)<\/span>/);
  assert.match(cn, /<a href="https:\/\/chinacarapi\.com\/\?utm_source=mcp(&amp;|&)utm_medium=signin#pricing"[^>]*>chinacarapi\.com<\/a>/);
  assert.match(cn, /separate EnCarAPI key/);
  assert.doesNotMatch(cn, /[–—→]/);
  const kr = await (await hostFetch(KR_HOST, `/authorize?${q(krClient, RESOURCE)}`)).text();
  assert.match(kr, /<title>Connect EnCarAPI<\/title>/);
  assert.match(kr, /<label for="encarapi_key">EnCarAPI key<\/label>/);
  assert.match(kr, /ChinaCarAPI key <span>\(optional\)<\/span>/);
});

let cnTokens;
await step("china host: a ChinaCarAPI key in the main field is detected with one /api/me call", async () => {
  const before = upstream.length;
  cnTokens = await hostConnect(CN_HOST, cnClient, CN_RESOURCE, { chinacarapi_key: "good_cn_key" }, "192.0.2.1");
  assert.equal(cnTokens.iss, CN_PUBLIC + "/");
  assert.deepEqual(upstream.slice(before).map((r) => r.url.host + r.url.pathname), ["api.chinacarapi.com/api/me"]);
  const auth = { Authorization: `Bearer ${cnTokens.access_token}` };
  const list = await (await hostMcp(CN_HOST, auth)).json();
  assert.equal(list.result.tools[0].name, "search_chinese_cars", "China tools first on the China host");
  assert.equal((await callTool(CN_HOST, auth, "search_chinese_cars")).isError, undefined);
  assert.equal(upstream.at(-1).key, "good_cn_key");
  assert.equal((await callTool(CN_HOST, auth, "search_korean_cars")).isError, true, "stored as ChinaCarAPI key");
});

await step("china host: an EnCarAPI key in the main field falls back to Korea", async () => {
  const before = upstream.length;
  const t = await hostConnect(CN_HOST, cnClient, CN_RESOURCE, { chinacarapi_key: "legacy_key" }, "192.0.2.2");
  // The fake China API accepts legacy_key as an EnCarAPI key with the add-on: /api/me says "encarapi-addon".
  assert.deepEqual(upstream.slice(before).map((r) => r.url.pathname), ["/api/me"]);
  const auth = { Authorization: `Bearer ${t.access_token}` };
  assert.equal((await callTool(CN_HOST, auth, "search_korean_cars")).isError, undefined);
  assert.equal(upstream.at(-1).key, "legacy_key");
  assert.equal(upstream.at(-1).url.hostname, "api.encarapi.com");
});

await step("china host: a wrong key is tried against China, then Korea", async () => {
  const before = upstream.length;
  const { res } = await hostSubmit(CN_HOST, cnClient, CN_RESOURCE, { chinacarapi_key: "bad_key" }, "192.0.2.3");
  assert.equal(res.status, 400);
  assert.match(await res.text(), /This ChinaCarAPI key was not accepted\./);
  assert.deepEqual(
    upstream.slice(before).map((r) => r.url.host + r.url.pathname),
    ["api.chinacarapi.com/api/me", "api.encarapi.com/api/model-search"],
    "China first, then Korea"
  );
});

await step("china host: a 503 from /api/me is 'could not be reached', not 'rejected'", async () => {
  const { res } = await hostSubmit(CN_HOST, cnClient, CN_RESOURCE, { chinacarapi_key: "busy_key" }, "192.0.2.12");
  assert.equal(res.status, 503);
  assert.match(await res.text(), /ChinaCarAPI could not be reached\./);
});

await step("china host: API without /api/me (404) falls back to the catalog probe", async () => {
  const before = upstream.length;
  const t = await hostConnect(CN_HOST, cnClient, CN_RESOURCE, { chinacarapi_key: "old_cn_key" }, "192.0.2.4");
  assert.deepEqual(upstream.slice(before).map((r) => r.url.pathname), ["/api/me", "/api/catalog"]);
  assert.equal((await callTool(CN_HOST, { Authorization: `Bearer ${t.access_token}` }, "search_chinese_cars")).isError, undefined);
  assert.equal(upstream.at(-1).key, "old_cn_key");
});

await step("default host: a ChinaCarAPI key in the main field is detected after Korea", async () => {
  const before = upstream.length;
  const t = await hostConnect(KR_HOST, krClient, RESOURCE, { encarapi_key: "good_cn_key" }, "192.0.2.5");
  assert.deepEqual(upstream.slice(before).map((r) => r.url.host + r.url.pathname), ["api.encarapi.com/api/model-search", "api.chinacarapi.com/api/me"]);
  const auth = { Authorization: `Bearer ${t.access_token}` };
  assert.equal((await callTool(KR_HOST, auth, "search_chinese_cars")).isError, undefined);
  assert.equal(upstream.at(-1).key, "good_cn_key");
  assert.equal((await callTool(KR_HOST, auth, "search_korean_cars")).isError, true);
});

await step("default host: an EnCarAPI key is checked once against Korea only (unchanged)", async () => {
  const before = upstream.length;
  const t = await hostConnect(KR_HOST, krClient, RESOURCE, { encarapi_key: "good_key" }, "192.0.2.6");
  assert.deepEqual(upstream.slice(before).map((r) => r.url.pathname), ["/api/model-search"]);
  assert.equal(t.iss, PUBLIC + "/");
});

await step("both keys: main field detected, second field for the other product", async () => {
  const t = await hostConnect(CN_HOST, cnClient, CN_RESOURCE, { chinacarapi_key: "good_cn_key", encarapi_key: "good_key" }, "192.0.2.7");
  const auth = { Authorization: `Bearer ${t.access_token}` };
  await callTool(CN_HOST, auth, "search_chinese_cars");
  assert.equal(upstream.at(-1).key, "good_cn_key");
  await callTool(CN_HOST, auth, "search_korean_cars");
  assert.equal(upstream.at(-1).key, "good_key");

  const kr = await hostConnect(KR_HOST, krClient, RESOURCE, { encarapi_key: "good_key", chinacarapi_key: "good_cn_key" }, "192.0.2.8");
  const krAuth = { Authorization: `Bearer ${kr.access_token}` };
  await callTool(KR_HOST, krAuth, "search_chinese_cars");
  assert.equal(upstream.at(-1).key, "good_cn_key");
  await callTool(KR_HOST, krAuth, "search_korean_cars");
  assert.equal(upstream.at(-1).key, "good_key");

  const bad = await hostSubmit(CN_HOST, cnClient, CN_RESOURCE, { chinacarapi_key: "good_cn_key", encarapi_key: "nope" }, "192.0.2.9");
  assert.equal(bad.res.status, 400);
  assert.match(await bad.res.text(), /This EnCarAPI key was not accepted\./);
});

await step("tokens, codes and clients of one host are refused on the other", async () => {
  // Access token
  assert.equal((await hostMcp(CN_HOST, { Authorization: `Bearer ${cnTokens.access_token}` })).status, 200);
  const cross = await hostMcp(KR_HOST, { Authorization: `Bearer ${cnTokens.access_token}` });
  assert.equal(cross.status, 401);
  assert.match(cross.headers.get("www-authenticate"), /error="invalid_token"/);
  const kr = await hostConnect(KR_HOST, krClient, RESOURCE, { encarapi_key: "good_key" }, "192.0.2.10");
  assert.equal((await hostMcp(CN_HOST, { Authorization: `Bearer ${kr.access_token}` })).status, 401);

  // Refresh token (also with the client registered on the other host)
  for (const cl of [cnClient, krClient]) {
    const r = await hostToken(KR_HOST, { grant_type: "refresh_token", client_id: cl.client_id, refresh_token: cnTokens.refresh_token });
    assert.equal(r.res.status, 400);
  }

  // Authorization code redeemed at the other host's token endpoint, without a resource parameter
  const { res, verifier } = await hostSubmit(CN_HOST, cnClient, CN_RESOURCE, { chinacarapi_key: "good_cn_key" }, "192.0.2.11");
  const code = new URL(res.headers.get("location")).searchParams.get("code");
  const stolen = await hostToken(KR_HOST, { grant_type: "authorization_code", client_id: cnClient.client_id, code, code_verifier: verifier, redirect_uri: REDIRECT });
  assert.equal(stolen.res.status, 400);
  const own = await hostToken(CN_HOST, { grant_type: "authorization_code", client_id: cnClient.client_id, code, code_verifier: verifier, redirect_uri: REDIRECT });
  assert.equal(own.res.status, 200, "the same code still works on its own host");

  // A client registered on one host is unknown on the other
  const { challenge } = pkce();
  const q = form({ response_type: "code", client_id: cnClient.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256" });
  assert.equal((await hostFetch(KR_HOST, `/authorize?${q}`)).status, 400);
  assert.equal((await hostFetch(CN_HOST, `/authorize?${q}`)).status, 200);
});

await step("china host: a raw key counts as ChinaCarAPI key unless x-china-key is sent", async () => {
  for (const headers of [{ Authorization: "Bearer good_cn_key" }, { "x-api-key": "good_cn_key" }]) {
    assert.equal((await callTool(CN_HOST, headers, "search_chinese_cars")).isError, undefined);
    assert.equal(upstream.at(-1).key, "good_cn_key");
    assert.equal(upstream.at(-1).url.hostname, "api.chinacarapi.com");
    assert.equal((await callTool(CN_HOST, headers, "search_korean_cars")).isError, true);
  }
  const both = { Authorization: "Bearer good_key", "x-china-key": "good_cn_key" };
  await callTool(CN_HOST, both, "search_korean_cars");
  assert.equal(upstream.at(-1).key, "good_key");
  await callTool(CN_HOST, both, "search_chinese_cars");
  assert.equal(upstream.at(-1).key, "good_cn_key");
  // Default host: a raw key stays an EnCarAPI key.
  await callTool(KR_HOST, { Authorization: "Bearer legacy_key" }, "search_korean_cars");
  assert.equal(upstream.at(-1).key, "legacy_key");
  assert.equal(upstream.at(-1).url.hostname, "api.encarapi.com");
});

multi.server.close();
console.log(`encarapi-mcp oauth tests: OK (${steps} steps)`);
process.exit(0);
