#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

const apiKey = process.env.ENCARAPI_KEY;
const chinaKey = process.env.CHINACARAPI_KEY;

if (!apiKey && !chinaKey) {
  console.error(
    "encarapi-mcp: set ENCARAPI_KEY (Korea, https://encarapi.com/?utm_source=mcp&utm_medium=encarapi-mcp&utm_content=error) and/or CHINACARAPI_KEY (China, https://chinacarapi.com/?utm_source=mcp&utm_medium=encarapi-mcp&utm_content=error)."
  );
  process.exit(1);
}

const server = createServer({ apiKey, chinaKey });
await server.connect(new StdioServerTransport());
