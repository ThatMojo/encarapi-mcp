import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import encarapi from "encarapi";

const { KoreaClient, ChinaClient } = encarapi;

export const VERSION = "1.6.3";
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

// Compact, English-first view of a Korean catalog item for LLM context. With
// lang "ru" / "de" the API puts the Russian / German values into the main
// fields, so those win over the *English twins.
const koreaItem = (c, lang = "en") => {
  const pick = (en, main) => (lang === "en" ? en || main : main ?? en);
  return {
    id: c.Id,
    source: c.Source || "encar",
    make: c.ManufacturerEnglish || c.Manufacturer,
    model: pick(c.ModelEnglish, c.Model),
    trim: pick(c.BadgeEnglish, c.Badge),
    year: c.Year,
    priceKRW: typeof c.Price === "number" ? c.Price * 10000 : undefined,
    mileageKm: c.Mileage,
    fuel: pick(c.FuelTypeEnglish, c.FuelType),
    transmission: c.Transmission,
    powerPs: c.PowerPs,
    displacementCc: c.DisplacementCc,
    color: c.Color,
    region: c.Region || undefined,
    city: c.City || undefined,
    duplicateOf: c.IsDuplicate ? c.DuplicateOf : undefined,
    url: c.Url,
    photo: firstPhoto(c.Photos),
  };
};

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

// China response language. "ru" (API since 2026-10-22) translates the fixed fields,
// city names and equipment names; make, model and trim names stay Latin.
const chinaLang = z
  .enum(["en", "zh", "ru"])
  .optional()
  .describe(
    "Language of the returned values: en (default), zh = the original Chinese values, ru = Russian values for the fixed fields " +
      "(fuel, transmission, drivetrain, colours, seller type, condition, vehicle class), city names and equipment names; " +
      "make, model and trim names stay Latin"
  );

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
          region: z.string().optional().describe("Seller region code, comma = OR: seoul, gyeonggi, incheon, busan, daegu, daejeon, ulsan, gwangju, sejong, gangwon, chungbuk, chungnam, jeonbuk, jeonnam, gyeongbuk, gyeongnam, jeju. Encar listings only: leave source unset"),
          city: z.string().optional().describe("Seller city, e.g. suwon, gangnam (values in korean_filter_values -> city). Encar listings only: leave source unset"),
          sort: z.enum(["newest", "price_asc", "price_desc", "mileage_asc", "mileage_desc", "year_desc", "year_asc"]).optional(),
          limit: z.number().int().min(1).max(50).optional().describe("Results per page, default 10"),
          page: z.number().int().min(1).optional(),
          lang: z.enum(["en", "ru", "de"]).optional().describe("Language of the returned values (fuel, colors, regions, options; with 'de' also model and trim names): en (default), ru = Russian, de = German. Filters stay English"),
        },
        annotations: readOnly,
      },
      run(async (args) => {
        const lang = args.lang || "en";
        const res = await needKorea().catalog({ ...args, limit: args.limit || 10, lang, count: true });
        return { total: res.Count, page: args.page || 1, results: (res.SearchResults || []).map((c) => koreaItem(c, lang)) };
      })
    );

    server.registerTool(
      "search_korean_trucks",
      {
        title: "Search Korean trucks and buses",
        description:
          "Search used trucks, buses and special vehicles in South Korea (Encar truck marketplace): cargo trucks " +
          "(Porter, Bongo, Mighty, Xcient), wing bodies, dump and construction trucks, cranes, tankers, buses, campers. " +
          "Prices are in 10,000 KRW. Needs a Business or Scale key (or a trial).",
        inputSchema: {
          form: z.string().optional().describe("Body type, comma = OR: cargo, wing_body, bus, dump_construction, crane, tank, camper, waste_transport, live_fish, tow_transport, tractor, trailer"),
          manufacturer: z.string().optional().describe("Brand in English, e.g. Hyundai, Kia, Volvo"),
          model: z.string().optional().describe("Substring of the Korean model name, e.g. 포터 (Porter), 봉고 (Bongo), 마이티 (Mighty)"),
          min_tons: z.number().optional().describe("Minimum payload in tons"),
          max_tons: z.number().optional().describe("Maximum payload in tons"),
          use: z.enum(["private", "commercial", "other"]).optional().describe("Registration use"),
          fuel: z.string().optional(),
          transmission: z.string().optional(),
          min_year: z.number().int().optional(),
          max_year: z.number().int().optional(),
          max_price: z.number().int().optional().describe("Maximum price in 10,000 KRW"),
          max_mileage: z.number().int().optional().describe("Maximum mileage in km"),
          region: z.string().optional().describe("Region code, e.g. gyeonggi, busan"),
          sort: z.enum(["newest", "price_asc", "price_desc", "mileage_asc", "mileage_desc", "year_desc", "year_asc"]).optional(),
          limit: z.number().int().min(1).max(50).optional().describe("Results per page, default 10"),
          page: z.number().int().min(1).optional(),
        },
        annotations: readOnly,
      },
      run(async (args) => {
        const res = await needKorea().trucks({ ...args, limit: args.limit || 10, lang: "en", count: true });
        return {
          total: res.Count,
          page: args.page || 1,
          results: (res.SearchResults || []).map((c) => ({
            id: c.Id, make: c.Manufacturer, model: c.Model, trim: c.Badge, bodyType: c.FormEnglish || c.Form,
            bodyDetail: c.FormDetail, payloadTons: c.CapacityTons ?? undefined, use: c.UseEnglish || c.Use,
            year: c.Year, priceKRW: typeof c.Price === "number" ? c.Price * 10000 : undefined, mileageKm: c.Mileage,
            fuel: c.FuelTypeEnglish || c.FuelType, transmission: c.TransmissionEnglish || c.Transmission,
            region: c.Region || undefined, url: c.Url, photo: firstPhoto(c.Photos),
          })),
        };
      })
    );

    server.registerTool(
      "search_korean_excavators",
      {
        title: "Search Korean used excavators",
        description:
          "Search used excavators in South Korea (굴삭기나라 / direct-nara.co.kr, Korea's construction-equipment " +
          "marketplace): crawler and wheeled excavators with maker, model, year, operating hours, " +
          "weight class, region and price. Needs a Business or Scale key (or a trial). Export-control rules for " +
          "construction machinery are the exporter's responsibility.",
        inputSchema: {
          maker: z.string().optional().describe("Maker in English, e.g. Doosan (Develon), HD Hyundai, Volvo, Kubota, Kobelco"),
          model: z.string().optional().describe("Model or title substring, e.g. DX55, HX60"),
          sub_type: z.enum(["crawler", "wheel"]).optional(),
          weight_class: z.string().optional().describe("Weight class code, e.g. EXC_CR_LE_6_5 (02 class crawler), EXC_TIRE_LE_17 (06W wheeled)"),
          min_year: z.number().int().optional(),
          max_hours: z.number().int().optional().describe("Maximum operating hours"),
          max_price: z.number().int().optional().describe("Maximum price in 10,000 KRW"),
          region: z.string().optional().describe("Region code, e.g. gyeonggi"),
          sort: z.enum(["newest", "price_asc", "price_desc", "hours_asc", "year_desc", "year_asc"]).optional(),
          limit: z.number().int().min(1).max(50).optional().describe("Results per page, default 10"),
          page: z.number().int().min(1).optional(),
        },
        annotations: readOnly,
      },
      run(async (args) => {
        const res = await needKorea().equipment({ ...args, limit: args.limit || 10, count: true });
        return {
          total: res.Count,
          page: args.page || 1,
          results: (res.SearchResults || []).map((c) => ({
            id: c.Id, title: c.Title, maker: c.MakerEnglish || c.Maker, model: c.Model || undefined, year: c.Year,
            hours: c.Hours ?? undefined, type: c.SubType || undefined, weightClass: c.WeightClassLabel || undefined,
            priceKRW: c.PriceKRW ?? undefined, region: c.Region || undefined, city: c.City || undefined,
            sold: c.Sold || undefined, url: c.Url, photo: (c.Photos || [])[0],
          })),
        };
      })
    );

    server.registerTool(
      "find_korean_car_by_vin",
      {
        title: "Find a Korean car by VIN",
        description:
          "Every Encar and K Car listing of one VIN, active and removed - the listing history of one vehicle " +
          "(relists, earlier prices). Use the returned id with get_korean_car for full details. Needs a Business or Scale key (or a trial).",
        inputSchema: { vin: z.string().describe("17-character VIN") },
        annotations: readOnly,
      },
      run(async ({ vin }) => needKorea().vehicleByVin(vin))
    );

    server.registerTool(
      "get_korean_truck",
      {
        title: "Get a Korean truck",
        description: "Full record for one truck or bus from search_korean_trucks: detail page, official inspection report, cargo box dimensions, horse power, VIN and plate. Needs a Business or Scale key (or a trial).",
        inputSchema: { id: z.string().describe("Truck id from search_korean_trucks") },
        annotations: readOnly,
      },
      run(async ({ id }) => needKorea().truck(id, { lang: "en" }))
    );

    server.registerTool(
      "get_korean_car",
      {
        title: "Get a Korean car",
        description: "Full details for one Korean listing: specs, options, photos, price history, seller. Id: Encar id, 'kbc:<id>' or 'kcar:<id>'.",
        inputSchema: {
          id: z.string().describe("Listing id from search_korean_cars"),
          lang: z.enum(["en", "ru", "de"]).optional().describe("Language of the spec, category and option names: en (default), ru = Russian, de = German"),
        },
        annotations: readOnly,
      },
      run(({ id, lang }) => needKorea().vehicle(id, { lang: lang || "en" }))
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
          power_min: z.number().int().optional().describe("Minimum power in hp (cars without a known power figure are left out)"),
          power_max: z.number().int().optional().describe("Maximum power in hp"),
          city: z.string().optional().describe("City: pass the exact 'value' of an entry in chinese_filter_values (list 'cities')"),
          fuel: z.string().optional().describe("Fuel type in English, see chinese_filter_values (list 'fuels')"),
          export_ready: z.boolean().optional().describe("Only cars that can be exported now"),
          has_report: z.boolean().optional().describe("Only cars with an inspection report"),
          sort: z.enum(["newest", "price_asc", "price_desc", "mileage_asc", "year_desc"]).optional(),
          lang: chinaLang,
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
        inputSchema: { id: z.string().describe("Listing id from search_chinese_cars"), source: chinaSource, lang: chinaLang },
        annotations: readOnly,
      },
      run(({ id, source, lang }) => needChina().vehicle(id, { source, lang }))
    );

    server.registerTool(
      "get_chinese_car_by_url",
      {
        title: "Get a Chinese car by link",
        description: "Same full record as get_chinese_car, looked up by a Che168 or Dongchedi listing link (desktop, mobile site or app, also inside a pasted share text). Short links are not resolved.",
        inputSchema: { url: z.string().describe("Listing link, e.g. https://m.che168.com/cardetail/index?infoid=60234085"), lang: chinaLang },
        annotations: readOnly,
      },
      run(({ url, lang }) => needChina().vehicleByUrl(url, { lang }))
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
      "get_chinese_specs",
      {
        title: "Get a Chinese trim specification sheet",
        description:
          "Autohome specification sheet of a Che168 trim (use trim.id from get_chinese_car): displacement in cc, power in kW and hp (also EVs), " +
          "torque, emission standard, wheelbase, weights, tank, gears, drive type, EV battery. One sheet covers every car of that trim. Che168 only.",
        inputSchema: { trimId: z.union([z.string(), z.number()]).describe("Autohome trim id (trim.id of a Che168 vehicle record)") },
        annotations: readOnly,
      },
      run(({ trimId }) => needChina().specs(trimId))
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
