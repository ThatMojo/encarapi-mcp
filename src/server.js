import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import encarapi from "encarapi";

const { KoreaClient, ChinaClient } = encarapi;

export const VERSION = "1.1.0";
const MAX_TEXT = 40000;

const asText = (data) => {
  let text = typeof data === "string" ? data : JSON.stringify(data, null, 1);
  if (text.length > MAX_TEXT) text = text.slice(0, MAX_TEXT) + "\n... (truncated)";
  return { content: [{ type: "text", text }] };
};

const asError = (e) => ({
  isError: true,
  content: [{ type: "text", text: e?.body ? `${e.message}` : String(e?.message || e) }],
});

const firstPhoto = (photos) => {
  const p = Array.isArray(photos) ? photos[0] : null;
  if (!p) return undefined;
  return typeof p === "string" ? p : p.url || p.location || p.Url || undefined;
};

// Compact, English-first view of a Korean catalog item for LLM context.
const koreaItem = (c) => ({
  id: c.Id,
  source: c.Source || "encar",
  make: c.ManufacturerEnglish || c.Manufacturer,
  model: c.ModelEnglish || c.Model,
  trim: c.BadgeEnglish || c.Badge,
  year: c.Year,
  priceKRW: typeof c.Price === "number" ? c.Price * 10000 : undefined,
  mileageKm: c.Mileage,
  fuel: c.FuelTypeEnglish || c.FuelType,
  transmission: c.Transmission,
  powerPs: c.PowerPs,
  color: c.Color,
  duplicateOf: c.IsDuplicate ? c.DuplicateOf : undefined,
  url: c.Url,
  photo: firstPhoto(c.Photos),
});

const chinaItem = (c) => ({
  id: c.id,
  source: c.source,
  title: c.title,
  make: c.make?.name,
  model: c.model?.name,
  trim: c.trim?.name,
  modelYear: c.modelYear,
  firstRegistration: c.firstRegistration,
  mileageKm: c.mileageKm,
  price: c.price,
  city: c.city,
  fuel: c.fuel,
  transmission: c.transmission,
  inspectionReport: c.hasInspectionReport,
  url: c.url,
  photo: c.image,
});

const readOnly = { readOnlyHint: true, openWorldHint: true };

/**
 * Builds an MCP server for one caller. `apiKey` is an EnCarAPI key (Korean data;
 * also Chinese data if it has the China add-on), `chinaKey` an optional separate
 * ChinaCarAPI key.
 */
export function createServer({ apiKey, chinaKey, fetchImpl } = {}) {
  const server = new McpServer(
    { name: "encarapi", title: "EnCarAPI - Korean & Chinese used car data", version: VERSION },
    {
      instructions:
        "Live used car listings from South Korea (Encar, KB Chachacha, K Car) and China (Dongchedi, Che168). " +
        "Korean prices are in KRW, Chinese prices in CNY with USD/EUR conversions. " +
        "Use find_korean_models or korean_filter_values to get exact names before filtering. " +
        "Requires an API key from https://encarapi.com (China: https://chinacarapi.com).",
    }
  );

  const korea = apiKey ? new KoreaClient(apiKey, { fetch: fetchImpl }) : null;
  const china = chinaKey || apiKey ? new ChinaClient(chinaKey || apiKey, { fetch: fetchImpl }) : null;
  const needKorea = () => {
    if (!korea) throw new Error("No EnCarAPI key configured (ENCARAPI_KEY). Get one at https://encarapi.com");
    return korea;
  };
  const needChina = () => {
    if (!china) throw new Error("No ChinaCarAPI key configured (CHINACARAPI_KEY). Get one at https://chinacarapi.com");
    return china;
  };
  const run = (fn) => async (args) => {
    try {
      return asText(await fn(args));
    } catch (e) {
      return asError(e);
    }
  };

  // -- Korea -----------------------------------------------------------------

  server.registerTool(
    "search_korean_cars",
    {
      title: "Search Korean used cars",
      description:
        "Search live used car listings in South Korea. Default source is Encar; 'kbc' = KB Chachacha, " +
        "'kcar' = K Car, 'all' = all three deduplicated (plan-dependent). Prices are filtered in 10,000 KRW " +
        "units (e.g. max_price 3000 = 30,000,000 KRW). Returns the total count and compact listings.",
      inputSchema: {
        source: z.enum(["encar", "kbc", "kcar", "all"]).optional().describe("Marketplace; default encar"),
        manufacturer: z.string().optional().describe("Brand in English, e.g. Hyundai, Kia, Genesis, BMW. Comma = OR"),
        model_group: z.string().optional().describe("Model line, e.g. Grandeur, Sorento, 5 Series"),
        model: z.string().optional().describe("Specific generation"),
        model_search: z.string().optional().describe("Free-text model search across brands, e.g. 'GV80' or 's63 coupe'"),
        fuel: z.enum(["gasoline", "diesel", "hybrid", "electric", "lpg", "hydrogen", "other"]).optional(),
        transmission: z.enum(["automatic", "manual", "cvt", "semi-automatic", "other"]).optional(),
        category: z.enum(["suv", "rv", "large", "midsize", "compact", "small", "kei", "van", "light-van", "truck", "sports", "other"]).optional(),
        min_year: z.number().int().optional(),
        max_year: z.number().int().optional(),
        min_price: z.number().int().optional().describe("Minimum price in 10,000 KRW"),
        max_price: z.number().int().optional().describe("Maximum price in 10,000 KRW"),
        max_mileage: z.number().int().optional().describe("Maximum mileage in km"),
        frame_clean: z.boolean().optional().describe("Only cars with an accident-free chassis frame"),
        no_damage_cost: z.boolean().optional().describe("Only cars with zero insurance-reported repair cost"),
        has_inspection: z.boolean().optional().describe("Only cars with an official inspection report"),
        sort: z.enum(["newest", "price_asc", "price_desc", "mileage_asc", "mileage_desc", "year_desc", "year_asc"]).optional(),
        limit: z.number().int().min(1).max(50).optional().describe("Results per page, default 10"),
        page: z.number().int().min(1).optional(),
      },
      annotations: readOnly,
    },
    run(async (args) => {
      const res = await needKorea().catalog({ ...args, limit: args.limit || 10, lang: "en", count: true });
      return { total: res.Count, page: args.page || 1, results: (res.SearchResults || []).map(koreaItem) };
    })
  );

  server.registerTool(
    "get_korean_car",
    {
      title: "Get a Korean car",
      description: "Full details for one Korean listing: specs, options, photos, price history, seller. Id: Encar id, 'kbc:<id>' or 'kcar:<id>'.",
      inputSchema: { id: z.string().describe("Listing id from search_korean_cars") },
      annotations: readOnly,
    },
    run(({ id }) => needKorea().vehicle(id, { lang: "en" }))
  );

  server.registerTool(
    "get_korean_inspection",
    {
      title: "Get a Korean inspection report",
      description: "Official Korean inspection report (performance check) for one car: panels, frame, mechanical condition.",
      inputSchema: { id: z.string() },
      annotations: readOnly,
    },
    run(({ id }) => needKorea().inspection(id))
  );

  server.registerTool(
    "get_korean_accident_record",
    {
      title: "Get a Korean accident & ownership record",
      description: "Insurance accident history and ownership changes for one Korean car (own vs. other-party damage in KRW).",
      inputSchema: { id: z.string() },
      annotations: readOnly,
    },
    run(({ id }) => needKorea().record(id))
  );

  server.registerTool(
    "find_korean_models",
    {
      title: "Find Korean model names",
      description: "Autocomplete model names across brands (e.g. 'sorento', 'gv70'). Use the result to filter search_korean_cars.",
      inputSchema: { search: z.string(), limit: z.number().int().min(1).max(50).optional() },
      annotations: readOnly,
    },
    run(({ search, limit }) => needKorea().modelSearch(search, { limit: limit || 10 }))
  );

  server.registerTool(
    "korean_filter_values",
    {
      title: "Korean filter values",
      description: "Valid values for the Korean search filters (fuels, colors, categories, ...).",
      inputSchema: { source: z.enum(["encar", "kbc", "kcar", "all"]).optional() },
      annotations: readOnly,
    },
    run((args) => needKorea().enums(args))
  );

  // -- China -----------------------------------------------------------------

  server.registerTool(
    "search_chinese_cars",
    {
      title: "Search Chinese used cars",
      description:
        "Search live used car listings in China (Dongchedi and Che168, duplicates merged), in English. " +
        "Prices are in CNY; results include USD and EUR conversions.",
      inputSchema: {
        make: z.string().optional().describe("Brand in English, e.g. BYD, Toyota, Audi"),
        model: z.string().optional(),
        source: z.enum(["dongchedi", "che168"]).optional(),
        year_min: z.number().int().optional(),
        year_max: z.number().int().optional(),
        price_min: z.number().int().optional().describe("Minimum price in CNY"),
        price_max: z.number().int().optional().describe("Maximum price in CNY"),
        mileage_max: z.number().int().optional().describe("Maximum mileage in km"),
        city: z.string().optional(),
        fuel: z.string().optional(),
        export_ready: z.boolean().optional().describe("Only cars that can be exported now"),
        has_report: z.boolean().optional().describe("Only cars with an inspection report"),
        sort: z.enum(["newest", "price_asc", "price_desc", "mileage_asc", "year_desc"]).optional(),
        limit: z.number().int().min(1).max(50).optional().describe("Results per page, default 10"),
        page: z.number().int().min(1).optional(),
      },
      annotations: readOnly,
    },
    run(async (args) => {
      const res = await needChina().catalog({ ...args, limit: args.limit || 10 });
      return { total: res.total, page: res.page, results: (res.results || []).map(chinaItem) };
    })
  );

  server.registerTool(
    "get_chinese_car",
    {
      title: "Get a Chinese car",
      description: "Full record for one Chinese listing: price history, photos, seller, export status, same car on the other marketplace.",
      inputSchema: { id: z.string().describe("Listing id from search_chinese_cars") },
      annotations: readOnly,
    },
    run(({ id }) => needChina().vehicle(id))
  );

  server.registerTool(
    "get_chinese_inspection",
    {
      title: "Get a Chinese inspection report",
      description: "Inspection report for one Chinese car: accident, flood and fire checks, battery data for EVs.",
      inputSchema: { id: z.string() },
      annotations: readOnly,
    },
    run(({ id }) => needChina().inspection(id))
  );

  server.registerTool(
    "chinese_models",
    {
      title: "Chinese models of a brand",
      description: "Models of one brand in the Chinese catalog, with listing counts.",
      inputSchema: { make: z.string().describe("Brand name in English or brand id") },
      annotations: readOnly,
    },
    run(({ make }) => needChina().models(make))
  );

  return server;
}
