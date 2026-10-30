import type { DiscoveryResult, Evidence } from "../contracts.js";
import { FixedJsonApi, SourceApiError } from "./json-api.js";
import { accessHeaders, isRecord, normalizeSourceUrl, type TavilySearchOptions } from "./search.js";

export const TAVILY_EXTRACT_URL = "https://api.tavily.com/extract";

/** Provider-reported source text, not a direct fetch or a semantic qualification. */
export interface ApiSourceDocument {
  url: string;
  text: string;
  retrievedAt: string;
  contentHash: string;
  method: "provider-api-extract";
  originRetrievedAt: null;
  api: Omit<Evidence, "quotation">;
}

export interface ExtractionResult {
  documents: ApiSourceDocument[];
  sourceErrors: DiscoveryResult["sourceErrors"];
  source: Omit<Evidence, "quotation">;
}

export interface SourceExtractor {
  extract(urls: readonly string[], options?: { signal?: AbortSignal }): Promise<ExtractionResult>;
}

export class TavilyExtract implements SourceExtractor {
  #api: FixedJsonApi;
  constructor(options: TavilySearchOptions) {
    this.#api = new FixedJsonApi({ ...options, endpoint: TAVILY_EXTRACT_URL, headers: accessHeaders(options.access) });
  }
  async extract(urls: readonly string[], options: { signal?: AbortSignal } = {}): Promise<ExtractionResult> {
    let requested: string[];
    try {
      if (!Array.isArray(urls) || urls.length < 1 || urls.length > 5) throw new Error("Invalid bound");
      requested = [...new Set(urls.map(normalizeSourceUrl))];
    } catch {
      throw new SourceApiError("INVALID_INPUT", TAVILY_EXTRACT_URL, "Invalid source extraction URL batch");
    }
    // MVP_LIMIT: one batch of at most five sources, basic extraction, no crawler or retry.
    const result = await this.#api.post({ urls: requested, extract_depth: "basic", format: "text",
      include_images: false, include_favicon: false, timeout: 8 }, options.signal);
    if (!isRecord(result.payload) || !Array.isArray(result.payload.results) || !Array.isArray(result.payload.failed_results) ||
        result.payload.results.length > 20 || result.payload.failed_results.length > 20) {
      throw new SourceApiError("INVALID_RESPONSE", TAVILY_EXTRACT_URL, "Invalid source extraction envelope");
    }
    const source = { url: result.url, retrievedAt: result.retrievedAt, contentHash: result.contentHash };
    const textByUrl = new Map<string, string>();
    const failed = new Set<string>();
    const sourceErrors: DiscoveryResult["sourceErrors"] = [];
    for (const [index, raw] of result.payload.results.entries()) {
      let url: string;
      try {
        if (!isRecord(raw)) throw new Error("Invalid result");
        url = normalizeSourceUrl(raw.url);
        if (!requested.includes(url)) throw new Error("Unrequested result");
      } catch {
        sourceErrors.push({ url: TAVILY_EXTRACT_URL, message: `Invalid extraction result at index ${index}` });
        continue;
      }
      const content = (raw as Record<string, unknown>).raw_content;
      if (typeof content !== "string" || !content.trim() || content.length > 100_000 ||
          (textByUrl.has(url) && textByUrl.get(url) !== content)) {
        failed.add(url);
        sourceErrors.push({ url, message: "Invalid or conflicting extracted source content" });
      } else {
        textByUrl.set(url, content);
      }
    }
    for (const [index, raw] of result.payload.failed_results.entries()) {
      try {
        if (!isRecord(raw)) throw new Error("Invalid failure");
        const url = normalizeSourceUrl(raw.url);
        if (!requested.includes(url)) throw new Error("Unrequested failure");
        failed.add(url);
        sourceErrors.push({ url, message: "Provider could not extract this source" });
      } catch {
        sourceErrors.push({ url: TAVILY_EXTRACT_URL, message: `Invalid extraction failure at index ${index}` });
      }
    }
    const documents: ApiSourceDocument[] = [];
    for (const url of requested) {
      if (failed.has(url)) continue;
      const text = textByUrl.get(url);
      if (text === undefined) {
        sourceErrors.push({ url, message: "Provider omitted this requested source" });
        continue;
      }
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
      documents.push({ url, text, retrievedAt: result.retrievedAt,
        contentHash: `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`,
        method: "provider-api-extract", originRetrievedAt: null, api: { ...source } });
    }
    return { documents, sourceErrors, source };
  }
}
