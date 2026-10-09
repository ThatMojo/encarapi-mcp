import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import encarapi from "encarapi";

const { KoreaClient, ChinaClient } = encarapi;

export const VERSION = "1.2.1";
const MAX_TEXT = 40000;

const asText = (data) => {
  let text = typeof data === "string" ? data : JSON.stringify(data, null, 1);
  if (text.length > MAX_TEXT) text = text.slice(0, MAX_TEXT) + "\n... (truncated)";
  return { content: [{ type: "text", text }] };
};

// Plan gates (403) and rate limits (429) answer with { error, hint }: the agent gets
// that text as is, since it says what the plan covers and how to get more.
const asError = (e) => {
  let text = String(e?.message || e);
  if (e?.status === 403 || e?.status === 429) {
    try {
      const body = JSON.parse(e.body);
      if (body?.error && body?.hint) text = `${body.error} ${body.hint}`;
    } catch {}
  }
  return { isError: true, content: [{ type: "text", text }] };
};

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

const chinaSource = z
  .enum(["dongchedi", "che168"])
  .optional()
  .describe("Marketplace of the id, from the search result; needed when an id exists on both");

// Every API call carries "encarapi-mcp/<version> (<transport>)" as User-Agent,
// so MCP usage can be told apart from other clients on the API side.
function withUserAgent(fetchImpl, transport) {
  const base = fetchImpl || globalThis.fetch;
  const ua = `encarapi-mcp/${VERSION} (${transport})`;
  return (url, init = {}) => base(url, { ...init, headers: { ...(init.headers || {}), "User-Agent": ua } });
}

const SERVER_INFO = {
  korea: {
    info: { name: "encarapi", title: "EnCarAPI - Korean & Chinese used car data", version: VERSION },
    instructions:
      "Live used car listings from South Korea (Encar, KB Chachacha, K Car) and China (Dongchedi, Che168). " +
      "Korean prices are in KRW, Chinese prices in CNY with USD/EUR conversions. " +
      "Use find_korean_models or korean_filter_values to get exact names before filtering. " +
      "Requires an API key from https://encarapi.com/?utm_source=mcp&utm_medium=encarapi-mcp&utm_content=instructions (China: https://chinacarapi.com/?utm_source=mcp&utm_medium=encarapi-mcp&utm_content=instructions).",
  },
  china: {
    info: { name: "chinacarapi", title: "ChinaCarAPI - Chinese & Korean used car data", version: VERSION },
    instructions:
      "Live used car listings from China (Dongchedi, Che168) and South Korea (Encar, KB Chachacha, K Car). " +
      "Chinese prices are in CNY with USD/EUR conversions, Korean prices in KRW. " +
      "Use chinese_filter_values (makes, fuels, cities) and chinese_models to get exact values before filtering " +
      "search_chinese_cars; for Korea use find_korean_models or korean_filter_values. " +
      "Requires an API key from https://chinacarapi.com/?utm_source=mcp&utm_medium=encarapi-mcp&utm_content=instructions (Korea: https://encarapi.com/?utm_source=mcp&utm_medium=encarapi-mcp&utm_content=instructions).",
  },
};

/**
 * Builds an MCP server for one caller. `apiKey` is an EnCarAPI key (Korean data;
 * also Chinese data if it has the China add-on), `chinaKey` an optional separate
 * ChinaCarAPI key. `brand` ("korea" | "china") sets the server instructions and
 * which tools are listed first.
 */
export function createServer({ apiKey, chinaKey, fetchImpl, transport = "stdio", brand = "korea" } = {}) {
  fetchImpl = withUserAgent(fetchImpl, transport);
  const meta = SERVER_INFO[brand] || SERVER_INFO.korea;
  const server = new McpServer(meta.info, { instructions: meta.instructions });

  const korea = apiKey ? new KoreaClient(apiKey, { fetch: fetchImpl }) : null;
  const china = chinaKey || apiKey ? new ChinaClient(chinaKey || apiKey, { fetch: fetchImpl }) : null;
  const needKorea = () => {
    if (!korea) throw new Error("No EnCarAPI key configured (ENCARAPI_KEY). Get one at https://encarapi.com/?utm_source=mcp&utm_medium=encarapi-mcp&utm_content=error");
    return korea;
  };
  const needChina = () => {
    if (!china) throw new Error("No ChinaCarAPI key configured (CHINACARAPI_KEY). Get one at https://chinacarapi.com/?utm_source=mcp&utm_medium=encarapi-mcp&utm_content=error");
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

  const registerKorea = () => {
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

  };

  // -- China -----------------------------------------------------------------

  const registerChina = () => {
    server.registerTool(
      "search_chinese_cars",
      {
        title: "Search Chinese used cars",
        description:
          "Search live used car listings in China (Dongchedi and Che168, duplicates merged), in English. " +
          "Prices are in CNY; results include USD and EUR conversions. " +
          "Use chinese_filter_values and chinese_models for exact make, model, fuel and city values.",
        inputSchema: {
          make: z.string().optional().describe("Brand in English, e.g. BYD, Toyota, Audi"),
          model: z.string().optional().describe("Model name or id from chinese_models"),
          source: z.enum(["dongchedi", "che168"]).optional().describe("Marketplace; default both"),
          duplicates: z
            .enum(["include"])
            .optional()
            .describe("'include' also returns Che168 listings that duplicate a Dongchedi listing (hidden by default)"),
          year_min: z.number().int().optional().describe("Model year from"),
          year_max: z.number().int().optional().describe("Model year to"),
          reg_year_min: z.number().int().optional().describe("First registration year from"),
          reg_year_max: z.number().int().optional().describe("First registration year to"),
          price_min: z.number().int().optional().describe("Minimum price in CNY"),
          price_max: z.number().int().optional().describe("Maximum price in CNY"),
          mileage_max: z.number().int().optional().describe("Maximum mileage in km"),
          city: z.string().optional().describe("City: pass the exact 'value' of an entry in chinese_filter_values (list 'cities')"),
          fuel: z.string().optional().describe("Fuel type in English, see chinese_filter_values (list 'fuels')"),
          export_ready: z.boolean().optional().describe("Only cars that can be exported now"),
          has_report: z.boolean().optional().describe("Only cars with an inspection report"),
          sort: z.enum(["newest", "price_asc", "price_desc", "mileage_asc", "year_desc"]).optional(),
          lang: z.enum(["en", "zh"]).optional().describe("'zh' returns the original Chinese values; default English"),
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
        inputSchema: { id: z.string().describe("Listing id from search_chinese_cars"), source: chinaSource },
        annotations: readOnly,
      },
      run(({ id, source }) => needChina().vehicle(id, { source }))
    );

    server.registerTool(
      "get_chinese_inspection",
      {
        title: "Get a Chinese inspection report",
        description: "Inspection report for one Chinese car: accident, flood and fire checks, battery data for EVs.",
        inputSchema: { id: z.string(), source: chinaSource },
        annotations: readOnly,
      },
      run(({ id, source }) => needChina().inspection(id, { source }))
    );

    server.registerTool(
      "chinese_filter_values",
      {
        title: "Chinese filter values",
        description:
          "Valid values for the Chinese search filters, with listing counts: makes, fuels, cities, sources, sorts. " +
          "City filters need the exact 'value' of a city entry. Pass list to get one list only.",
        inputSchema: { list: z.enum(["makes", "fuels", "cities", "sources", "sorts"]).optional() },
        annotations: readOnly,
      },
      run(async ({ list }) => {
        const res = await needChina().enums();
        // Compact JSON: the full set is large and must not hit the text limit.
        return JSON.stringify(list ? { [list]: res?.[list] } : res);
      })
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
  };

  if (brand === "china") {
    registerChina();
    registerKorea();
  } else {
    registerKorea();
    registerChina();
  }
  return server;
}
