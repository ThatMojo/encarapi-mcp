# EnCarAPI MCP server: Korean and Chinese used car data for AI assistants

[Model Context Protocol](https://modelcontextprotocol.io) server for
[EnCarAPI](https://encarapi.com). Lets Claude, Cursor, ChatGPT and other MCP clients search
**live used car listings from South Korea** (Encar, KB Chachacha, K Car) and **China**
(Dongchedi, Che168), and pull full details, inspection reports and accident records.

> **An API key is required.** Get one (5-day trial) at [encarapi.com](https://encarapi.com).
> Chinese data works with a [ChinaCarAPI](https://chinacarapi.com) key or an EnCarAPI key
> with the China add-on.

## Tools

| Tool | What it does |
|---|---|
| `search_korean_cars` | Search Korean listings (brand, model, year, price in 10,000 KRW, mileage, fuel, accident-free, source: encar / kbc / kcar / all) |
| `get_korean_car` | Full detail for one listing (specs, options, photos, price history, seller) |
| `get_korean_inspection` | Official Korean inspection report |
| `get_korean_accident_record` | Insurance accident history and ownership changes |
| `find_korean_models` | Model name autocomplete across brands |
| `korean_filter_values` | Valid filter values |
| `search_chinese_cars` | Search Chinese listings (brand, model, year, price in CNY, mileage, city, export-ready) |
| `get_chinese_car` | Full record for one Chinese listing |
| `get_chinese_inspection` | Chinese inspection report (accident, flood, fire, EV battery) |
| `chinese_models` | Models of a brand with listing counts |

All tools are read-only.

## Option 1: hosted (no install)

Add this URL as a remote MCP server and send your key as a Bearer token:

```
https://mcp.encarapi.com/mcp
Authorization: Bearer YOUR_ENCARAPI_KEY
```

Claude Code:

```bash
claude mcp add --transport http encarapi https://mcp.encarapi.com/mcp \
  --header "Authorization: Bearer YOUR_ENCARAPI_KEY"
```

Clients that only accept a URL can use `https://mcp.encarapi.com/mcp?key=YOUR_ENCARAPI_KEY`
(the Bearer header is preferred, since URLs can end up in logs). A separate ChinaCarAPI key
goes into the `x-china-key` header.

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

## Links

- EnCarAPI: https://encarapi.com
- ChinaCarAPI: https://chinacarapi.com
- SDKs: [Node.js](https://github.com/ThatMojo/encarapi-node), [Python](https://github.com/ThatMojo/encarapi-python)

EnCarAPI is an independent service and not affiliated with Encar, KB Chachacha, K Car,
Dongchedi or Che168.

## License

MIT
