export type JsonEndpoint = "https://api.tavily.com/search" | "https://api.tavily.com/extract" |
  "https://api.ted.europa.eu/v3/notices/search" | "https://ezamowienia.gov.pl/mo-board/api/v1/notice";

export class SourceApiError extends Error {
  constructor(readonly code: "INVALID_INPUT" | "HTTP" | "NETWORK" | "TIMEOUT" | "CANCELLED" | "TOO_LARGE" | "INVALID_RESPONSE", readonly url: string, message: string) {
    super(message);
    this.name = "SourceApiError";
  }
}

export interface JsonApiResult {
  url: string;
  retrievedAt: string;
  contentHash: string;
  payload: unknown;
}

export interface JsonApiOptions {
  endpoint: JsonEndpoint;
  headers?: Record<string, string>;
  fetch?: (request: Request) => Promise<Response>;
  now?: () => Date;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

/** Only operator-selected fixed APIs. Never used for untrusted supplier URLs. */
export class FixedJsonApi {
  #endpoint: JsonEndpoint;
  #headers: Record<string, string>;
  #fetcher: (request: Request) => Promise<Response>;
  #now: () => Date;
  #timeoutMs: number;
  #maxBytes: number;

  constructor(options: JsonApiOptions) {
    const timeout = options.timeoutMs ?? 10_000;
    const maxBytes = options.maxResponseBytes ?? 2 * 1024 * 1024;
    const headers = options.headers ?? {};
    if (!["https://api.tavily.com/search", "https://api.tavily.com/extract", "https://api.ted.europa.eu/v3/notices/search", "https://ezamowienia.gov.pl/mo-board/api/v1/notice"].includes(options.endpoint) ||
        (!options.endpoint.startsWith("https://api.tavily.com/") && Object.keys(headers).length > 0) ||
        !Number.isInteger(timeout) || timeout < 1 || timeout > 30_000 ||
        !Number.isInteger(maxBytes) || maxBytes < 1024 || maxBytes > 2 * 1024 * 1024 ||
        Object.entries(headers).some(([key, value]) => !["authorization", "x-tavily-access-mode"].includes(key.toLowerCase()) ||
          typeof value !== "string" || /[\r\n]/.test(value) || value.length > 4096)) {
      throw new TypeError("Invalid fixed source API configuration");
    }
    this.#endpoint = options.endpoint;
    this.#headers = { ...headers };
    this.#fetcher = options.fetch ?? ((request) => fetch(request));
    this.#now = options.now ?? (() => new Date());
    this.#timeoutMs = timeout;
    this.#maxBytes = maxBytes;
  }

  async post(body: unknown, signal?: AbortSignal): Promise<JsonApiResult> {
    let serialized: string | undefined;
    try { serialized = JSON.stringify(body); } catch { /* handled as invalid input below */ }
    if (this.#endpoint.includes("ezamowienia.gov.pl") || serialized === undefined || new TextEncoder().encode(serialized).byteLength > 512 * 1024) {
      throw new SourceApiError("INVALID_INPUT", this.#endpoint, "Invalid or oversized source API input");
    }
    return this.run(this.#endpoint, serialized, signal);
  }

  async get(parameters: URLSearchParams, signal?: AbortSignal): Promise<JsonApiResult> {
    if (this.#endpoint !== "https://ezamowienia.gov.pl/mo-board/api/v1/notice" ||
        [...parameters].some(([key, value]) => !["NoticeType", "PublicationDateFrom", "PublicationDateTo", "PageSize", "CpvCode", "OrderObject"].includes(key) || /[\u0000-\u001f\u007f]/u.test(value)) ||
        parameters.toString().length > 4000) {
      throw new SourceApiError("INVALID_INPUT", this.#endpoint, "Invalid fixed API query");
    }
    return this.run(`${this.#endpoint}?${parameters}`, undefined, signal);
  }

  private async run(url: string, body: string | undefined, signal?: AbortSignal): Promise<JsonApiResult> {
    if (signal?.aborted) throw new SourceApiError("CANCELLED", this.#endpoint, "Source API operation cancelled");
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort = () => {};
    let timedOut = false;
    const interrupted = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new SourceApiError("TIMEOUT", this.#endpoint, "Source API time limit exceeded"));
      }, this.#timeoutMs);
      onAbort = () => {
        controller.abort();
        reject(new SourceApiError("CANCELLED", this.#endpoint, "Source API operation cancelled"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    });
    try {
      return await Promise.race([this.request(url, body, controller.signal), interrupted]);
    } catch (error) {
      if (timedOut) throw new SourceApiError("TIMEOUT", this.#endpoint, "Source API time limit exceeded");
      if (signal?.aborted) throw new SourceApiError("CANCELLED", this.#endpoint, "Source API operation cancelled");
      if (error instanceof SourceApiError) throw error;
      throw new SourceApiError("NETWORK", this.#endpoint, "Source API network operation failed");
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      controller.abort();
    }
  }

  private async request(url: string, body: string | undefined, signal: AbortSignal): Promise<JsonApiResult> {
    const response = await this.#fetcher(new Request(url, {
      method: body === undefined ? "GET" : "POST", redirect: "error", credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer", signal,
      headers: { ...this.#headers, "accept": "application/json", "content-type": "application/json" }, ...(body === undefined ? {} : { body }),
    }));
    const fail = (code: SourceApiError["code"], message: string): never => {
      void response.body?.cancel().catch(() => {});
      throw new SourceApiError(code, this.#endpoint, message);
    };
    if (signal.aborted) fail("CANCELLED", "Source API operation cancelled");
    if (!response.ok) fail("HTTP", `Source API returned HTTP ${response.status}`);
    if (response.redirected || (response.url && response.url !== url)) fail("INVALID_RESPONSE", "Unexpected source API response location");
    if (response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") fail("INVALID_RESPONSE", "Source API did not return JSON");
    if (Number(response.headers.get("content-length")) > this.#maxBytes) fail("TOO_LARGE", "Source API response exceeds byte limit");
    if (!response.body) fail("INVALID_RESPONSE", "Source API returned no body");
    const reader = response.body!.getReader();
    const cancel = () => { void reader.cancel().catch(() => {}); };
    signal.addEventListener("abort", cancel, { once: true });
    const chunks: Uint8Array[] = [];
    let length = 0;
    let complete = false;
    let bytes: Uint8Array<ArrayBuffer>;
    try {
      while (true) {
        if (signal.aborted) throw new SourceApiError("CANCELLED", this.#endpoint, "Source API operation cancelled");
        const { value, done } = await reader.read();
        if (signal.aborted) throw new SourceApiError("CANCELLED", this.#endpoint, "Source API operation cancelled");
        if (done) break;
        length += value.byteLength;
        if (length > this.#maxBytes) throw new SourceApiError("TOO_LARGE", this.#endpoint, "Source API response exceeds byte limit");
        chunks.push(value);
      }
      complete = true;
      bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    } finally {
      signal.removeEventListener("abort", cancel);
      if (!complete) cancel();
      reader.releaseLock();
    }
    let payload: unknown;
    try { payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
    catch { throw new SourceApiError("INVALID_RESPONSE", this.#endpoint, "Source API returned invalid JSON or UTF-8"); }
    const digest = await crypto.subtle.digest("SHA-256", bytes.buffer);
    return { url, retrievedAt: this.#now().toISOString(),
      contentHash: `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`, payload };
  }
}
