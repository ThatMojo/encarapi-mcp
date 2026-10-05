// Request handler of the hosted MCP endpoint (Streamable HTTP, stateless).
//
// /mcp accepts, in this order:
//   1. an OAuth access token issued by this server (only if MCP_OAUTH_SECRET is set),
//   2. a raw EnCarAPI key: "Authorization: Bearer <key>", "x-api-key: <key>" or
//      "?key=<key>" for clients that only accept a URL.
// Optional "x-china-key" / "?china_key=" for a separate ChinaCarAPI key.
// Nothing is stored server-side.
//
// One process can serve several public hosts (MCP_PUBLIC_URLS, e.g.
// mcp.encarapi.com and mcp.chinacarapi.com). The Host header picks the OAuth
// issuer and the branding; tokens are bound to their host's /mcp resource. On a
// ChinaCarAPI host a raw key without x-china-key counts as a ChinaCarAPI key.
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer, VERSION } from "./server.js";
import { createOAuth, ACCESS_TOKEN_PREFIX } from "./oauth.js";
import { brandFor } from "./brand.js";

const MAX_BODY = 1024 * 1024;

function bearerFrom(req) {
  const auth = req.headers.authorization || "";
  return auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
}

function keysFrom(req, url, brand) {
  const key = bearerFrom(req) || req.headers["x-api-key"] || url.searchParams.get("key") || undefined;
  const chinaKey = req.headers["x-china-key"] || url.searchParams.get("china_key") || undefined;
  if (brand.id === "china" && !chinaKey) return { apiKey: undefined, chinaKey: key };
  return { apiKey: key, chinaKey };
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("body too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined);
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

const send = (res, status, body, headers = {}) => {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
};

// Browser-based MCP clients need to read the 401 challenge and send custom headers.
const MCP_CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Expose-Headers": "WWW-Authenticate, Mcp-Session-Id, Mcp-Protocol-Version",
};
const MCP_PREFLIGHT = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "Authorization, Content-Type, Accept, Mcp-Protocol-Version, Mcp-Session-Id, Last-Event-ID, x-api-key, x-china-key",
  "Access-Control-Max-Age": "86400",
};

/** Public origins from MCP_PUBLIC_URLS (comma-separated) or MCP_PUBLIC_URL; the first is the default. */
export function publicUrls(env) {
  const list = String(env.MCP_PUBLIC_URLS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return list.length ? list : [env.MCP_PUBLIC_URL || "https://mcp.encarapi.com"];
}

// Host header without port, lower case. Traefik and Cloudflare pass the original
// Host through, so X-Forwarded-Host is not needed (and not trusted).
const hostOf = (req) =>
  String(req.headers.host || "")
    .trim()
    .toLowerCase()
    .replace(/:\d+$/, "");

/**
 * Builds the HTTP request listener. `env.MCP_OAUTH_SECRET` enables the OAuth
 * endpoints; without it the server only accepts keys sent by the client.
 * `fetchImpl` and `now` are for tests.
 */
export function createHandler({ env = process.env, fetchImpl, now } = {}) {
  async function handleMcp(req, res, { apiKey, chinaKey, brand }) {
    let body;
    try {
      body = await readJson(req);
    } catch {
      return send(res, 400, { jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null });
    }

    const server = createServer({ apiKey, chinaKey, fetchImpl, transport: "hosted", brand: brand.id });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (e) {
      console.error("mcp request failed:", e?.message);
      if (!res.headersSent) send(res, 500, { jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
    }
  }

  // One entry per public host: { brand, oauth }. Unknown hosts get the first one.
  const sites = new Map();
  for (const publicUrl of publicUrls(env)) {
    const host = new URL(publicUrl).hostname.toLowerCase();
    const brand = brandFor(publicUrl);
    const oauth = env.MCP_OAUTH_SECRET
      ? createOAuth({
          secret: env.MCP_OAUTH_SECRET,
          publicUrl,
          brand,
          handleMcp: (req, res, keys) => handleMcp(req, res, { ...keys, brand }),
          fetchImpl,
          now,
        })
      : null;
    if (!sites.has(host)) sites.set(host, { brand, oauth });
  }
  const fallback = sites.values().next().value;

  return async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const { brand, oauth } = sites.get(hostOf(req)) || fallback;

    if (url.pathname === "/health") return send(res, 200, { ok: true, version: VERSION });
    if (url.pathname === "/" && req.method === "GET") {
      res.writeHead(302, { Location: "https://github.com/ThatMojo/encarapi-mcp" });
      return res.end();
    }
    if (oauth?.owns(url.pathname)) return oauth.app(req, res);
    if (url.pathname !== "/mcp") return send(res, 404, { error: "Not found. MCP endpoint: /mcp" });

    if (oauth) {
      if (req.method === "OPTIONS") {
        res.writeHead(204, MCP_PREFLIGHT);
        return res.end();
      }
      for (const [k, v] of Object.entries(MCP_CORS)) res.setHeader(k, v);
    }

    // Stateless mode: no sessions, so GET (SSE stream) and DELETE are not offered.
    if (req.method !== "POST") {
      res.writeHead(405, { Allow: "POST" });
      return res.end();
    }

    // 1. OAuth access token issued by this server (verified, audience-bound, 401 when invalid or expired).
    if (oauth && bearerFrom(req).startsWith(ACCESS_TOKEN_PREFIX)) return oauth.app(req, res);

    // 2. Key sent by the client.
    const { apiKey, chinaKey } = keysFrom(req, url, brand);
    if (!apiKey && !chinaKey) {
      return send(
        res,
        401,
        {
          jsonrpc: "2.0",
          error: { code: -32001, message: `API key required: Authorization: Bearer <key> (get one at ${brand.signupUrl})` },
          id: null,
        },
        oauth ? { "WWW-Authenticate": oauth.wwwAuthenticate, "Cache-Control": "no-store" } : {}
      );
    }
    return handleMcp(req, res, { apiKey, chinaKey, brand });
  };
}
