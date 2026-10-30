import type { DiscoveryResult, Evidence } from "../contracts.js";
import { FixedJsonApi, SourceApiError, type JsonApiOptions } from "./json-api.js";

export const TAVILY_SEARCH_URL = "https://api.tavily.com/search";

export interface SupplierSearchHit {
  url: string;
  title: string;
  /** Search-index lead only, never accepted as verified current capability. */
  snippet: string;
}

export interface SupplierSearchResult {
  query: string;
  hits: SupplierSearchHit[];
  source: Omit<Evidence, "quotation">;
  sourceErrors: DiscoveryResult["sourceErrors"];
}

export interface SupplierSearch {
  search(query: string, options?: { limit?: number; signal?: AbortSignal }): Promise<SupplierSearchResult>;
}

export interface TavilySearchOptions extends Omit<JsonApiOptions, "endpoint" | "headers"> {
  access: { mode: "keyless" } | { mode: "keyed"; apiKey: string };
}

export class TavilySearch implements SupplierSearch {
  #api: FixedJsonApi;
  constructor(options: TavilySearchOptions) {
    this.#api = new FixedJsonApi({ ...options, endpoint: TAVILY_SEARCH_URL, headers: accessHeaders(options.access) });
  }
  async search(query: string, options: { limit?: number; signal?: AbortSignal } = {}): Promise<SupplierSearchResult> {
    const limit = options.limit ?? 5;
    if (typeof query !== "string" || !query.trim() || query.length > 1500 || /[\x00-\x1f]/.test(query) ||
        !Number.isInteger(limit) || limit < 1 || limit > 10) {
      throw new SourceApiError("INVALID_INPUT", TAVILY_SEARCH_URL, "Invalid supplier query or result bound");
    }
    const result = await this.#api.post({ query: query.trim(), max_results: limit, search_depth: "basic", topic: "general",
      include_answer: false, include_raw_content: false }, options.signal);
    if (!isRecord(result.payload) || !Array.isArray(result.payload.results) || result.payload.results.length > limit) {
      throw new SourceApiError("INVALID_RESPONSE", TAVILY_SEARCH_URL, "Invalid supplier search envelope");
    }
    const hits: SupplierSearchHit[] = [];
    const sourceErrors: DiscoveryResult["sourceErrors"] = [];
    const urls = new Set<string>();
    for (const [index, raw] of result.payload.results.entries()) {
      try {
        if (!isRecord(raw) || typeof raw.title !== "string" || raw.title.length > 1000 ||
            typeof raw.content !== "string" || raw.content.length > 8000) throw new Error("Invalid result");
        const url = normalizeSourceUrl(raw.url);
        if (urls.has(url)) continue;
        urls.add(url);
        hits.push({ url, title: raw.title, snippet: raw.content });
      } catch {
        sourceErrors.push({ url: TAVILY_SEARCH_URL, message: `Invalid search result at index ${index}` });
      }
    }
    return { query: query.trim(), hits, source: { url: result.url, retrievedAt: result.retrievedAt, contentHash: result.contentHash }, sourceErrors };
  }
}

export function accessHeaders(access: TavilySearchOptions["access"]): Record<string, string> {
  if (access?.mode === "keyless") return { "x-tavily-access-mode": "keyless" };
  if (access?.mode !== "keyed" || typeof access.apiKey !== "string" || !access.apiKey.trim() || access.apiKey !== access.apiKey.trim()) {
    throw new TypeError("Invalid supplier API access configuration");
  }
  return { "authorization": `Bearer ${access.apiKey}` };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Lead URL validation only. Our service calls the fixed API, never this URL directly. */
export function normalizeSourceUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 2048) throw new TypeError("Invalid source URL");
  const url = new URL(value);
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (url.protocol !== "https:" || url.username || url.password || url.port || !host.includes(".") ||
      /^[\d.]+$/.test(host) || host.includes(":") || /(^|\.)(localhost|local|internal|invalid|test|example)$/.test(host) ||
      host.endsWith(".home.arpa")) throw new TypeError("Invalid source URL");
  url.hostname = host;
  url.hash = "";
  return url.href;
}
