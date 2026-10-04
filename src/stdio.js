#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

const apiKey = process.env.ENCARAPI_KEY;
const chinaKey = process.env.CHINACARAPI_KEY;

if (!apiKey && !chinaKey) {
  console.error(
    "encarapi-mcp: set ENCARAPI_KEY (Korea, https://encarapi.com) and/or CHINACARAPI_KEY (China, https://chinacarapi.com)."
  );
  process.exit(1);
}

const server = createServer({ apiKey, chinaKey });
await server.connect(new StdioServerTransport());
