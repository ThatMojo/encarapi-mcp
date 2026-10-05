# EnCarAPI MCP server: Korean and Chinese used car data for AI assistants

[Model Context Protocol](https://modelcontextprotocol.io) server for
[EnCarAPI](https://encarapi.com). Lets Claude, Cursor, ChatGPT and other MCP clients search
**live used car listings from South Korea** (Encar, KB Chachacha, K Car) and **China**
(Dongchedi, Che168), and pull full details, inspection reports and accident records.

> **An API key is required.** Get one (5-day trial) at [encarapi.com](https://encarapi.com).
> Chinese data works with a [ChinaCarAPI](https://chinacarapi.com) key or an EnCarAPI key
> with the China add-on. ChinaCarAPI customers: see [For ChinaCarAPI customers](#for-chinacarapi-customers).

## Tools

| Tool | What it does |
|---|---|
| `search_korean_cars` | Search Korean listings (brand, model, year, price in 10,000 KRW, mileage, fuel, accident-free, source: encar / kbc / kcar / all) |
| `get_korean_car` | Full detail for one listing (specs, options, photos, price history, seller) |
| `get_korean_inspection` | Official Korean inspection report |
| `get_korean_accident_record` | Insurance accident history and ownership changes |
| `find_korean_models` | Model name autocomplete across brands |
| `korean_filter_values` | Valid filter values |
| `search_chinese_cars` | Search Chinese listings (brand, model, model year, registration year, price in CNY, mileage, city, fuel, source, export-ready) |
| `get_chinese_car` | Full record for one Chinese listing |
| `get_chinese_inspection` | Chinese inspection report (accident, flood, fire, EV battery) |
| `chinese_filter_values` | Valid makes, fuels, cities and sources with listing counts |
| `chinese_models` | Models of a brand with listing counts |

All tools are read-only.

## Option 1: hosted (no install)

Add this URL as a remote MCP server:

```
https://mcp.encarapi.com/mcp
```

In clients with OAuth support the URL is all you need. On first use a browser window opens,
you paste your EnCarAPI key once, and the client is connected:

- **Claude** (claude.ai, desktop, mobile): Settings - Connectors - Add custom connector, paste the URL
- **ChatGPT** (developer mode): Settings - Connectors - create a connector with the URL
- **Cursor**: `{"mcpServers": {"encarapi": {"url": "https://mcp.encarapi.com/mcp"}}}` in `.cursor/mcp.json`
- **VS Code**: "MCP: Add Server" - HTTP - paste the URL
- **Claude Code**:

```bash
claude mcp add --transport http encarapi https://mcp.encarapi.com/mcp
```

The key is checked once and is not stored on the server: it is encrypted into the token
your client receives. To disconnect, remove the server in your client; to cut off access
everywhere, rotate your key at [encarapi.com](https://encarapi.com).

### Alternative: send the key yourself

Clients without OAuth support, scripts and gateways can send the key directly:

```
https://mcp.encarapi.com/mcp
Authorization: Bearer YOUR_ENCARAPI_KEY
```

Claude Code:

```bash
claude mcp add --transport http encarapi https://mcp.encarapi.com/mcp \
  --header "Authorization: Bearer YOUR_ENCARAPI_KEY"
```

The `x-api-key: YOUR_ENCARAPI_KEY` header works as well. Clients that only accept a URL and
have no OAuth support can use `https://mcp.encarapi.com/mcp?key=YOUR_ENCARAPI_KEY` (a header
is preferred, since URLs can end up in logs). A separate ChinaCarAPI key goes into the
`x-china-key` header, or into the second field of the browser form.

## For ChinaCarAPI customers

ChinaCarAPI has its own address:

```
https://mcp.chinacarapi.com/mcp
```

Add it as a remote MCP server exactly as above. On first use a browser window opens and you
paste your ChinaCarAPI key once. The form detects which key it is, so an EnCarAPI key works
there as well; customers with both keys put the EnCarAPI key into the optional second field.

- **Claude** (claude.ai, desktop, mobile): Settings - Connectors - Add custom connector, paste the URL
- **Cursor**: `{"mcpServers": {"chinacarapi": {"url": "https://mcp.chinacarapi.com/mcp"}}}` in `.cursor/mcp.json`
- **Claude Code**:

```bash
claude mcp add --transport http chinacarapi https://mcp.chinacarapi.com/mcp
```

On this address the Chinese tools are listed first. Start with `chinese_filter_values` to
get valid makes, fuels and cities (the `city` filter needs the exact `value` from that list).

Without the browser login, send the key as a header. On mcp.chinacarapi.com a key in
`Authorization: Bearer` or `x-api-key` counts as a ChinaCarAPI key:

```bash
claude mcp add --transport http chinacarapi https://mcp.chinacarapi.com/mcp \
  --header "Authorization: Bearer YOUR_CHINACARAPI_KEY"
```

`x-china-key: YOUR_CHINACARAPI_KEY` works on both addresses; then `Authorization` can carry
an EnCarAPI key for the Korean tools.

Locally (npx), set `CHINACARAPI_KEY` instead of `ENCARAPI_KEY`:

```bash
claude mcp add chinacarapi -e CHINACARAPI_KEY=YOUR_CHINACARAPI_KEY -- npx -y encarapi-mcp
```

## Option 2: local (npx)

Claude Desktop (`claude_desktop_config.json`), Cursor (`.cursor/mcp.json`) and most other
clients:

```json
{
  "mcpServers": {
    "encarapi": {
      "command": "npx",
      "args": ["-y", "encarapi-mcp"],
      "env": {
        "ENCARAPI_KEY": "YOUR_ENCARAPI_KEY"
      }
    }
  }
}
```

Claude Code:

```bash
claude mcp add encarapi -e ENCARAPI_KEY=YOUR_ENCARAPI_KEY -- npx -y encarapi-mcp
```

Optional: `CHINACARAPI_KEY` for a separate ChinaCarAPI key.

## Example prompts

- "Find accident-free Genesis GV80 from 2022 or newer under 50 million KRW and compare the mileage."
- "Show the inspection report and accident record for Encar listing 41000001."
- "What are the cheapest export-ready BYD Seal listings in China right now?"

## Self-hosting the HTTP endpoint

```bash
docker build -t encarapi-mcp .
docker run -p 3000:3000 encarapi-mcp     # POST /mcp, GET /health
```

Stateless: every request carries its own key, nothing is stored.

To enable the OAuth flow ("connect by URL only"), set two environment variables:

| Variable | Meaning |
|---|---|
| `MCP_OAUTH_SECRET` | At least 32 random characters, e.g. `openssl rand -base64 48`. Enables OAuth; without it the server only accepts keys sent by the client. |
| `MCP_PUBLIC_URL` | Public origin of the server, e.g. `https://mcp.example.com` (default `https://mcp.encarapi.com`). Tokens are bound to `<MCP_PUBLIC_URL>/mcp`. |
| `MCP_PUBLIC_URLS` | Optional, several public origins separated by commas, e.g. `https://mcp.encarapi.com,https://mcp.chinacarapi.com`. Replaces `MCP_PUBLIC_URL`. The `Host` header picks the origin (unknown hosts get the first one); each origin has its own issuer and branding, and its tokens are not accepted on the others. Origins whose host contains `chinacarapi.` get the ChinaCarAPI branding. |

```bash
docker run -p 3000:3000 -e MCP_OAUTH_SECRET="$(openssl rand -base64 48)" \
  -e MCP_PUBLIC_URL=https://mcp.example.com encarapi-mcp
```

This adds `/.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server`,
`/register`, `/authorize` and `/token` (OAuth 2.1 with PKCE, dynamic client registration).
There is still no database: client ids, authorization codes and tokens are encrypted,
self-contained values (AES-256-GCM) that carry the key. Consequences:

- Changing `MCP_OAUTH_SECRET` signs out all OAuth clients (they reconnect through the browser).
- Access tokens last 1 hour, refresh tokens 90 days and are replaced on every use.
- Single use of authorization codes and of replaced refresh tokens is tracked in memory, so
  it is best-effort: it does not survive a restart and is not shared between instances.
- A single token cannot be revoked on the server. Rotating the EnCarAPI key cuts off all access.

## Links

- EnCarAPI: https://encarapi.com
- ChinaCarAPI: https://chinacarapi.com
- SDKs: [Node.js](https://github.com/ThatMojo/encarapi-node), [Python](https://github.com/ThatMojo/encarapi-python)

EnCarAPI is an independent service and not affiliated with Encar, KB Chachacha, K Car,
Dongchedi or Che168.

## License

MIT
