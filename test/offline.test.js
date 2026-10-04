// Offline test: in-memory MCP client against the server with a fake fetch.
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";

const calls = [];
const fakeFetch = async (url) => {
  const u = new URL(url);
  calls.push(u);
  let payload;
  if (u.hostname === "api.encarapi.com" && u.pathname === "/api/catalog") {
    payload = {
      Count: 2,
      SearchResults: [
        { Id: "41000001", ManufacturerEnglish: "Hyundai", ModelEnglish: "Grandeur", BadgeEnglish: "2.5", Year: 202203, Price: 2890, Mileage: 31000, FuelTypeEnglish: "Gasoline", Photos: [{ url: "https://img/1.jpg" }], Url: "https://fem.encar.com/cars/detail/41000001" },
        { Id: "kbc:123", Source: "kbc", Manufacturer: "기아", Price: 1500, Mileage: 80000 },
      ],
    };
  } else if (u.hostname === "api.chinacarapi.com") {
    payload = { total: 1, page: 1, limit: 10, results: [{ id: "9", source: "dongchedi", title: "BYD Han", make: { name: "BYD" }, price: { cny: 150000, eur: 18000 } }] };
  } else if (u.pathname.startsWith("/api/record/")) {
    return { status: 403, ok: false, text: async () => JSON.stringify({ error: "Upgrade to Business" }) };
  } else {
    payload = { ok: true };
  }
  return { status: 200, ok: true, text: async () => JSON.stringify(payload) };
};

async function connect(opts) {
  const server = createServer({ ...opts, fetchImpl: fakeFetch });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  return client;
}

const client = await connect({ apiKey: "kr_key" });

const { tools } = await client.listTools();
const names = tools.map((t) => t.name).sort();
assert.deepEqual(names, [
  "chinese_models", "find_korean_models", "get_chinese_car", "get_chinese_inspection", "get_korean_accident_record",
  "get_korean_car", "get_korean_inspection", "korean_filter_values", "search_chinese_cars", "search_korean_cars",
]);
assert.ok(tools.every((t) => t.annotations?.readOnlyHint), "all tools are read-only");

// Korea search: compact items, KRW conversion, always English + count
const kr = await client.callTool({ name: "search_korean_cars", arguments: { manufacturer: "Hyundai", max_price: 3000, frame_clean: true } });
const krData = JSON.parse(kr.content[0].text);
assert.equal(krData.total, 2);
assert.equal(krData.results[0].priceKRW, 28900000);
assert.equal(krData.results[0].photo, "https://img/1.jpg");
assert.equal(krData.results[1].source, "kbc");
const q = calls.at(-1).searchParams;
assert.equal(q.get("lang"), "en");
assert.equal(q.get("count"), "true");
assert.equal(q.get("limit"), "10");
assert.equal(q.get("frame_clean"), "true");

// China search goes to the China host with the same key
const cn = await client.callTool({ name: "search_chinese_cars", arguments: { make: "BYD" } });
assert.equal(JSON.parse(cn.content[0].text).results[0].make, "BYD");
assert.equal(calls.at(-1).hostname, "api.chinacarapi.com");

// API errors become tool errors with the upgrade hint
const rec = await client.callTool({ name: "get_korean_accident_record", arguments: { id: "41000001" } });
assert.equal(rec.isError, true);
assert.match(rec.content[0].text, /Upgrade to Business/);

// China-only key: Korean tools explain what is missing
const cnOnly = await connect({ chinaKey: "cn_key" });
const miss = await cnOnly.callTool({ name: "search_korean_cars", arguments: {} });
assert.equal(miss.isError, true);
assert.match(miss.content[0].text, /ENCARAPI_KEY/);

console.log("encarapi-mcp offline tests: OK");
process.exit(0);
