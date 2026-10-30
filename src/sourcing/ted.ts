import type { DiscoveryResult, Evidence } from "../contracts.js";

export const TED_SEARCH_URL = "https://api.ted.europa.eu/v3/notices/search";
export const TED_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export interface TedNotice {
  publicationNumber: string;
  noticeUrl: string;
  /** TED's calendar date, including its original timezone suffix, not a timestamp. */
  publishedOn: string;
  noticeType: string | null;
  titles: Record<string, string>;
  descriptions: Record<string, string>;
  buyerNames: Record<string, string[]>;
  /** Raw, unpaired lot-level values. Never zip these arrays or infer a delivery date. */
  tenderDeadlineDates: string[];
  tenderDeadlineTimes: string[];
  participationDeadlineDates: string[];
  participationDeadlineTimes: string[];
  quotationLanguage: string;
  evidence: Evidence;
}

export interface TedSearchInput {
  query: string;
  page?: number;
  limit?: number;
  scope?: "ACTIVE" | "ALL";
}

export interface TedSearchResult {
  query: string;
  page: number;
  limit: number;
  scope: "ACTIVE" | "ALL";
  source: Omit<Evidence, "quotation">;
  totalNoticeCount: number;
  notices: TedNotice[];
  sourceErrors: DiscoveryResult["sourceErrors"];
}

type ErrorCode = "INVALID_INPUT" | "NETWORK" | "TIMEOUT" | "HTTP" | "TOO_LARGE" | "INVALID_RESPONSE" | "UPSTREAM_TIMEOUT";

export class TedSourceError extends Error {
  readonly url = TED_SEARCH_URL;
  constructor(readonly code: ErrorCode, message: string) {
    super(message);
    this.name = "TedSourceError";
  }
}

interface TedClientOptions {
  fetch?: (request: Request) => Promise<Response>;
  now?: () => Date;
  timeoutMs?: number;
}

export class TedClient {
  private readonly fetcher: (request: Request) => Promise<Response>;
  private readonly now: () => Date;
  private readonly timeoutMs: number;

  constructor(options: TedClientOptions = {}) {
    this.fetcher = options.fetch ?? ((request) => fetch(request));
    this.now = options.now ?? (() => new Date());
    this.timeoutMs = options.timeoutMs ?? 10_000;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 15_000) {
      throw new RangeError("TED timeout must be an integer between 1 and 15000 milliseconds");
    }
  }

  async search(input: TedSearchInput): Promise<TedSearchResult> {
    const search = validateInput(input);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new TedSourceError("TIMEOUT", "TED retrieval exceeded its time limit"));
      }, this.timeoutMs);
    });
    try {
      return await Promise.race([this.retrieve(search, controller.signal), timeout]);
    } catch (error) {
      if (error instanceof TedSourceError) throw error;
      if (controller.signal.aborted) throw new TedSourceError("TIMEOUT", "TED retrieval exceeded its time limit");
      // Never echo upstream bodies, exceptions, or instructions into the platform error channel.
      throw new TedSourceError("NETWORK", "TED retrieval failed at the network boundary");
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }

  private async retrieve(search: Required<TedSearchInput>, signal: AbortSignal): Promise<TedSearchResult> {
    // MVP_LIMIT: fixed TED HTTPS origin only, one page per call, no retries or link traversal.
    // Arbitrary supplier URLs need a separate DNS-aware public-destination boundary, not this client.
    const response = await this.fetcher(new Request(TED_SEARCH_URL, {
      method: "POST", redirect: "error", credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer",
      headers: { "accept": "application/json", "content-type": "application/json" },
      body: JSON.stringify({ ...search, fields: FIELDS, checkQuerySyntax: false, onlyLatestVersions: true }),
      signal,
    }));
    if (signal.aborted) failResponse(response, "TIMEOUT", "TED retrieval exceeded its time limit");
    if (!response.ok) failResponse(response, "HTTP", `TED returned HTTP ${response.status}`);
    if (response.redirected || (response.url !== "" && response.url !== TED_SEARCH_URL)) {
      failResponse(response, "INVALID_RESPONSE", "TED response came from an unexpected location");
    }
    if (response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
      failResponse(response, "INVALID_RESPONSE", "TED did not return JSON");
    }
    const bytes = await readBounded(response, signal);
    let payload: unknown;
    try {
      payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      throw new TedSourceError("INVALID_RESPONSE", "TED returned invalid JSON or UTF-8");
    }
    if (!isRecord(payload) || !Array.isArray(payload.notices) || typeof payload.timedOut !== "boolean" ||
        !Number.isSafeInteger(payload.totalNoticeCount) || (payload.totalNoticeCount as number) < payload.notices.length ||
        payload.notices.length > search.limit) {
      throw new TedSourceError("INVALID_RESPONSE", "TED returned an invalid search envelope");
    }
    if (payload.timedOut) throw new TedSourceError("UPSTREAM_TIMEOUT", "TED reported an incomplete timed-out search");
    const digest = await crypto.subtle.digest("SHA-256", bytes.buffer);
    const source = {
      url: TED_SEARCH_URL, retrievedAt: this.now().toISOString(),
      contentHash: `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`,
    };
    const notices: TedNotice[] = [];
    const sourceErrors: DiscoveryResult["sourceErrors"] = [];
    for (const [index, raw] of payload.notices.entries()) {
      try {
        notices.push(parseNotice(raw, source));
      } catch {
        sourceErrors.push({ url: TED_SEARCH_URL, message: `Invalid notice at index ${index}: unsupported or missing TED fields` });
      }
    }
    return { ...search, source, totalNoticeCount: payload.totalNoticeCount as number, notices, sourceErrors };
  }
}

const FIELDS = [
  "publication-number", "publication-date", "notice-type", "notice-title", "description-proc",
  "organisation-name-buyer", "deadline-receipt-tender-date-lot", "deadline-receipt-tender-time-lot",
  "deadline-receipt-request-date-lot", "deadline-receipt-request-time-lot",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateInput(input: TedSearchInput): Required<TedSearchInput> {
  const page = input?.page ?? 1;
  const limit = input?.limit ?? 5;
  const scope = input?.scope ?? "ACTIVE";
  // MVP_LIMIT: at most 10 notices/call and the first 20 pages. Expand deliberately, not by crawling.
  if (!isRecord(input) || typeof input.query !== "string" || !input.query.trim() || input.query.length > 4000 ||
      !Number.isInteger(page) || page < 1 || page > 20 || !Number.isInteger(limit) || limit < 1 || limit > 10 ||
      (scope !== "ACTIVE" && scope !== "ALL")) {
    throw new TedSourceError("INVALID_INPUT", "Invalid TED query, scope, or pagination bounds");
  }
  return { query: input.query.trim(), page, limit, scope };
}

function failResponse(response: Response, code: ErrorCode, message: string): never {
  void response.body?.cancel().catch(() => {});
  throw new TedSourceError(code, message);
}

async function readBounded(response: Response, signal: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  if (Number(response.headers.get("content-length")) > TED_MAX_RESPONSE_BYTES) {
    failResponse(response, "TOO_LARGE", "TED response exceeds its byte limit");
  }
  if (!response.body) throw new TedSourceError("INVALID_RESPONSE", "TED returned no response body");
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let length = 0;
  let complete = false;
  try {
    while (true) {
      if (signal.aborted) throw new TedSourceError("TIMEOUT", "TED retrieval exceeded its time limit");
      const { value, done } = await reader.read();
      if (signal.aborted) throw new TedSourceError("TIMEOUT", "TED retrieval exceeded its time limit");
      if (done) break;
      length += value.byteLength;
      if (length > TED_MAX_RESPONSE_BYTES) throw new TedSourceError("TOO_LARGE", "TED response exceeds its byte limit");
      chunks.push(value);
    }
    complete = true;
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  } finally {
    signal.removeEventListener("abort", cancel);
    if (!complete) cancel();
    reader.releaseLock();
  }
}

function textMap(value: unknown): Record<string, string> {
  if (value == null) return {};
  if (!isRecord(value) || Object.entries(value).some(([language, text]) => !/^[a-z]{3}$/.test(language) || typeof text !== "string")) {
    throw new Error("Invalid localized text");
  }
  return Object.fromEntries(Object.entries(value).filter(([, text]) => (text as string).trim())) as Record<string, string>;
}

function strings(value: unknown): string[] {
  if (value == null) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error("Invalid string array");
  }
  return value;
}

function validPublicationDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}(Z|[+-](0\d|1[0-4]):[0-5]\d)?$/.test(value)) return false;
  const date = value.slice(0, 10);
  const parsed = new Date(`${date}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
}

function parseNotice(value: unknown, source: Omit<Evidence, "quotation">): TedNotice {
  if (!isRecord(value) || typeof value["publication-number"] !== "string" ||
      !/^\d{1,7}-(19|20)\d{2}$/.test(value["publication-number"]) || !validPublicationDate(value["publication-date"])) {
    throw new Error("Invalid publication metadata");
  }
  const titles = textMap(value["notice-title"]);
  const descriptions = textMap(value["description-proc"]);
  const quotations = Object.keys(descriptions).length ? descriptions : titles;
  const quotationLanguage = "eng" in quotations ? "eng" : Object.keys(quotations).sort()[0];
  if (!Object.keys(titles).length || !quotationLanguage) throw new Error("Missing title");
  const rawBuyers = value["organisation-name-buyer"] ?? {};
  if (!isRecord(rawBuyers) || Object.keys(rawBuyers).some((key) => !/^[a-z]{3}$/.test(key))) throw new Error("Invalid buyers");
  const buyerNames = Object.fromEntries(Object.entries(rawBuyers).map(([key, names]) => [key, strings(names)]));
  const noticeType = value["notice-type"] ?? null;
  if (noticeType !== null && (typeof noticeType !== "string" || !noticeType.trim())) throw new Error("Invalid notice type");
  return {
    publicationNumber: value["publication-number"],
    noticeUrl: `https://ted.europa.eu/en/notice/${value["publication-number"]}/html`,
    publishedOn: value["publication-date"], noticeType, titles, descriptions, buyerNames,
    tenderDeadlineDates: strings(value["deadline-receipt-tender-date-lot"]),
    tenderDeadlineTimes: strings(value["deadline-receipt-tender-time-lot"]),
    participationDeadlineDates: strings(value["deadline-receipt-request-date-lot"]),
    participationDeadlineTimes: strings(value["deadline-receipt-request-time-lot"]),
    quotationLanguage, evidence: { ...source, quotation: quotations[quotationLanguage]! },
  };
}
