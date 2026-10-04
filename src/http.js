#!/usr/bin/env node
// Hosted MCP endpoint (Streamable HTTP, stateless). Each request brings its own
// key: "Authorization: Bearer <key>", "x-api-key: <key>" or "?key=<key>" for
// clients that only accept a URL. Optional "x-china-key" for a separate
// ChinaCarAPI key. Nothing is stored server-side.
import http from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer, VERSION } from "./server.js";

const PORT = Number(process.env.PORT || 3000);
const MAX_BODY = 1024 * 1024;

function keysFrom(req, url) {
  const auth = req.headers.authorization || "";
  const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  return {
    apiKey: bearer || req.headers["x-api-key"] || url.searchParams.get("key") || undefined,
    chinaKey: req.headers["x-china-key"] || url.searchParams.get("china_key") || undefined,
  };
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

const send = (res, status, body) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

const httpServer = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");

  if (url.pathname === "/health") return send(res, 200, { ok: true, version: VERSION });
  if (url.pathname === "/" && req.method === "GET") {
    res.writeHead(302, { Location: "https://github.com/ThatMojo/encarapi-mcp" });
    return res.end();
  }
  if (url.pathname !== "/mcp") return send(res, 404, { error: "Not found. MCP endpoint: /mcp" });

  // Stateless mode: no sessions, so GET (SSE stream) and DELETE are not offered.
  if (req.method !== "POST") {
    res.writeHead(405, { Allow: "POST" });
    return res.end();
  }

  const { apiKey, chinaKey } = keysFrom(req, url);
  if (!apiKey && !chinaKey) {
    return send(res, 401, {
      jsonrpc: "2.0",
      error: { code: -32001, message: "API key required: Authorization: Bearer <key> (get one at https://encarapi.com)" },
      id: null,
    });
  }

  let body;
  try {
    body = await readJson(req);
  } catch {
    return send(res, 400, { jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null });
  }

  const server = createServer({ apiKey, chinaKey });
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
});

httpServer.listen(PORT, () => console.log(`encarapi-mcp HTTP on :${PORT} (POST /mcp)`));
