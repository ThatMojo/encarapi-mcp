// Per-host branding of the hosted endpoint. One app serves mcp.encarapi.com and
// mcp.chinacarapi.com: the host decides the page texts, the signup link, the
// server instructions and which product a pasted key is checked against first.

export const BRANDS = {
  korea: {
    id: "korea",
    product: "EnCarAPI",
    otherProduct: "ChinaCarAPI",
    signupUrl: "https://encarapi.com",
    signupText: "https://encarapi.com",
    resourceName: "EnCarAPI MCP server",
    // Form field names: the main field is auto-detected, the second one is for a
    // separate key of the other product.
    mainField: "encarapi_key",
    secondField: "chinacarapi_key",
    probeOrder: ["korea", "china"],
  },
  china: {
    id: "china",
    product: "ChinaCarAPI",
    otherProduct: "EnCarAPI",
    signupUrl: "https://chinacarapi.com/#pricing",
    signupText: "chinacarapi.com",
    resourceName: "ChinaCarAPI MCP server",
    mainField: "chinacarapi_key",
    secondField: "encarapi_key",
    probeOrder: ["china", "korea"],
  },
};

/** Brand for a public origin or host name: chinacarapi hosts get the China brand. */
export function brandFor(hostOrUrl) {
  let host = String(hostOrUrl || "");
  try {
    host = new URL(host).hostname;
  } catch {
    host = host.replace(/:\d+$/, "");
  }
  return /(^|\.)chinacarapi\./i.test(host) ? BRANDS.china : BRANDS.korea;
}
