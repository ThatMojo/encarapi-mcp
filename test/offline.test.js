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
  } else if (u.hostname === "api.chinacarapi.com" && u.pathname === "/api/enums") {
    payload = { makes: [{ id: 1, name: "BYD", nameZh: "比亚迪", count: 5 }], fuels: [], cities: [{ value: "武汉", name: "Wuhan", count: 3 }], sources: [], sorts: ["newest"] };
  } else if (u.hostname === "api.chinacarapi.com" && u.pathname === "/api/vehicle/77") {
    const body = JSON.stringify({ error: "This endpoint is not part of the free dev plan.", hint: "The 5-day trial unlocks it: https://chinacarapi.com/#pricing", plan: "sandbox" });
    return { status: 403, ok: false, text: async () => body };
  } else if (u.hostname === "api.chinacarapi.com" && u.pathname === "/api/catalog" && u.searchParams.get("make") === "Limit") {
    const body = JSON.stringify({ error: "Daily request limit of the free dev plan reached (25 requests per day).", hint: "The limit resets at 00:00 UTC.", plan: "sandbox" });
    return { status: 429, ok: false, text: async () => body };
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
  "chinese_filter_values", "chinese_models", "find_korean_models", "get_chinese_car", "get_chinese_inspection", "get_korean_accident_record",
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

// China filters are passed through with the API's parameter names
await client.callTool({
  name: "search_chinese_cars",
  arguments: { reg_year_min: 2021, reg_year_max: 2023, duplicates: "include", lang: "zh", city: "武汉", source: "che168" },
});
const cq = calls.at(-1).searchParams;
assert.equal(cq.get("reg_year_min"), "2021");
assert.equal(cq.get("reg_year_max"), "2023");
assert.equal(cq.get("duplicates"), "include");
assert.equal(cq.get("lang"), "zh");
assert.equal(cq.get("city"), "武汉");
assert.equal(cq.get("source"), "che168");

// source on detail and inspection
await client.callTool({ name: "get_chinese_car", arguments: { id: "123", source: "che168" } });
assert.equal(calls.at(-1).pathname, "/api/vehicle/123");
assert.equal(calls.at(-1).searchParams.get("source"), "che168");
await client.callTool({ name: "get_chinese_inspection", arguments: { id: "123", source: "dongchedi" } });
assert.equal(calls.at(-1).pathname, "/api/inspection/123");
assert.equal(calls.at(-1).searchParams.get("source"), "dongchedi");
await client.callTool({ name: "get_chinese_car", arguments: { id: "124" } });
assert.equal(calls.at(-1).searchParams.has("source"), false);

// Chinese filter values: compact JSON, optionally one list
const en = await client.callTool({ name: "chinese_filter_values", arguments: {} });
assert.equal(calls.at(-1).pathname, "/api/enums");
assert.equal(JSON.parse(en.content[0].text).makes[0].name, "BYD");
assert.doesNotMatch(en.content[0].text, /\n/, "compact JSON");
const cities = JSON.parse((await client.callTool({ name: "chinese_filter_values", arguments: { list: "cities" } })).content[0].text);
assert.deepEqual(Object.keys(cities), ["cities"]);
assert.equal(cities.cities[0].value, "武汉");

// Plan gate (403) and daily limit (429): the API text reaches the agent as is
const gated = await client.callTool({ name: "get_chinese_car", arguments: { id: "77" } });
assert.equal(gated.isError, true);
assert.equal(gated.content[0].text, "This endpoint is not part of the free dev plan. The 5-day trial unlocks it: https://chinacarapi.com/#pricing");
const limited = await client.callTool({ name: "search_chinese_cars", arguments: { make: "Limit" } });
assert.equal(limited.isError, true);
assert.equal(limited.content[0].text, "Daily request limit of the free dev plan reached (25 requests per day). The limit resets at 00:00 UTC.");

// API errors become tool errors with the upgrade hint
const rec = await client.callTool({ name: "get_korean_accident_record", arguments: { id: "41000001" } });
assert.equal(rec.isError, true);
assert.match(rec.content[0].text, /Upgrade to Business/);

// China-only key: Korean tools explain what is missing
const cnOnly = await connect({ chinaKey: "cn_key" });
const miss = await cnOnly.callTool({ name: "search_korean_cars", arguments: {} });
assert.equal(miss.isError, true);
assert.match(miss.content[0].text, /ENCARAPI_KEY/);

// China brand: China tools listed first, China instructions; Korea brand unchanged
const cnBrand = createServer({ chinaKey: "cn_key", fetchImpl: fakeFetch, brand: "china" });
const [ct, st] = InMemoryTransport.createLinkedPair();
const cnClient = new Client({ name: "test", version: "0" });
await Promise.all([cnBrand.connect(st), cnClient.connect(ct)]);
assert.equal(cnClient.getServerVersion().name, "chinacarapi");
assert.match(cnClient.getInstructions(), /^Live used car listings from China/);
assert.match(cnClient.getInstructions(), /chinese_filter_values/);
const cnTools = (await cnClient.listTools()).tools.map((t) => t.name);
assert.equal(cnTools[0], "search_chinese_cars");
assert.equal(cnTools.length, 11);
assert.equal(tools[0].name, "search_korean_cars");
assert.equal(client.getServerVersion().name, "encarapi");

console.log("encarapi-mcp offline tests: OK");
process.exit(0);
