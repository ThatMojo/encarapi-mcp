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

const upstream = [];
const fakeFetch = async (url, init = {}) => {
  const u = new URL(url);
  const key = init.headers?.["x-api-key"];
  upstream.push({ url: u, key });
  if (key === "down_key") throw new Error("network down");
  if (key !== "good_key" && key !== "good_cn_key" && key !== "legacy_key") {
    return { status: 403, ok: false, text: async () => JSON.stringify({ error: "Invalid or inactive API key." }) };
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
    assert.equal((await ok.json()).result.tools.length, 10);
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
  assert.equal(upstream.length, before + 1, "exactly one upstream request");
  assert.equal(upstream.at(-1).url.pathname, "/api/model-search");

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
  assert.equal((await list.json()).result.tools.length, 10);

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
console.log(`encarapi-mcp oauth tests: OK (${steps} steps)`);
process.exit(0);
