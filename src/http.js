#!/usr/bin/env node
// Hosted MCP endpoint (Streamable HTTP, stateless). See src/app.js for the
// accepted credentials and src/oauth.js for the optional OAuth flow.
import http from "node:http";
import { createHandler } from "./app.js";

const PORT = Number(process.env.PORT || 3000);

http.createServer(createHandler()).listen(PORT, () => {
  const oauth = process.env.MCP_OAUTH_SECRET ? "on" : "off (MCP_OAUTH_SECRET not set)";
  console.log(`encarapi-mcp HTTP on :${PORT} (POST /mcp, OAuth ${oauth})`);
});
