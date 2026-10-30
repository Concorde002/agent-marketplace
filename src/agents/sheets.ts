/**
 * Row-level access to a Google Sheet for the Instinct bridge.
 *
 * Instinct can only reach the backend through a Google Sheet, so the bridge polls a tab,
 * acts on rows the bot writes, and writes results back. This module is only the sheet
 * access layer: a `RowTable` interface, a Google Sheets API v4 implementation (REST over
 * fetch, service-account JWT auth via node:crypto) and an in-memory implementation with
 * the same semantics for tests and dry runs. Sheet contents are untrusted input.
 */
import { createSign } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

/** One sheet row. rowNumber is the 1-based row in the tab (row 1 is the header). */
export interface SheetRow { rowNumber: number; values: string[] }

export interface RowTable {
  /** Create the tab if missing; if row 1 is empty, write `header` into it. Idempotent. */
  ensureTab(tab: string, header: readonly string[]): Promise<void>;
  /** All non-empty rows of the tab including the header row, values as display strings ("" for blank cells). */
  readRows(tab: string): Promise<SheetRow[]>;
  /** Overwrite the cells of one row starting at column A with `values` (RAW input). */
  updateRow(tab: string, rowNumber: number, values: readonly string[]): Promise<void>;
  /** Append one row after the last non-empty row (RAW input, INSERT_ROWS). */
  appendRow(tab: string, values: readonly string[]): Promise<void>;
}

export interface ServiceAccountCredentials { client_email: string; private_key: string }

export interface GoogleSheetsTableOptions {
  spreadsheetId: string;
  credentials: ServiceAccountCredentials;
  fetchImpl?: typeof fetch;          // default global fetch
  now?: () => number;                // epoch ms, default Date.now
  timeoutMs?: number;                // per request, default 10000
}

const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const TOKEN_LABEL = "oauth2.googleapis.com/token";
const SHEETS_BASE = "https://sheets.googleapis.com/v4/spreadsheets";
const JWT_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:jwt-bearer";
/** Reads cover columns A..Z; both implementations expose at most this many cells per row. */
const MAX_COLUMNS = 26;
const LAST_COLUMN = "Z";
const JWT_LIFETIME_SECONDS = 3600;
const TOKEN_REFRESH_MARGIN_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 10_000;
const RETRY_DELAY_MS = 250;
const MAX_DETAIL_LENGTH = 200;
/** Any PEM private key block, including one cut off before its END line. */
const PEM_PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g;

/** Parse a Google service-account JSON key (string). Throw a clear Error naming the missing field, never echoing the key. */
export function parseServiceAccount(json: string): ServiceAccountCredentials {
  if (typeof json !== "string") throw new Error("Service account key must be a JSON string");
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    // The parser's message can quote part of the input, so it is deliberately dropped.
    throw new Error("Service account key is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Service account key must be a JSON object");
  }
  const record = parsed as Record<string, unknown>;
  const clientEmail = requireKeyField(record, "client_email");
  const privateKey = requireKeyField(record, "private_key");
  return { client_email: clientEmail, private_key: privateKey };
}

function requireKeyField(record: Record<string, unknown>, field: "client_email" | "private_key"): string {
  const value = record[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Service account key is missing required field "${field}"`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Shared validation and row semantics

function assertTab(tab: unknown): asserts tab is string {
  if (typeof tab !== "string" || tab.length === 0) throw new Error("Tab name must be a non-empty string");
}

function assertRowNumber(rowNumber: unknown): asserts rowNumber is number {
  if (typeof rowNumber !== "number" || !Number.isInteger(rowNumber) || rowNumber < 1) {
    throw new Error("Row number must be an integer >= 1");
  }
}

function assertValues(values: unknown, what: string): asserts values is readonly string[] {
  if (!Array.isArray(values) || !values.every((value) => typeof value === "string")) {
    throw new Error(`${what} must be an array of strings`);
  }
}

/** A1 sheet reference with the tab name quoted: `'Tab ''Name'''`. */
function quoteTab(tab: string): string {
  return `'${tab.replaceAll("'", "''")}'`;
}

function cellToString(cell: unknown): string {
  if (typeof cell === "string") return cell;
  if (typeof cell === "number" || typeof cell === "boolean") return String(cell);
  return "";
}

function rowHasContent(row: unknown): boolean {
  return Array.isArray(row) && row.some((cell) => cellToString(cell) !== "");
}

/** Normalise raw rows (index 0 = row 1) into non-empty SheetRows, columns A..Z, trailing blanks trimmed. */
function toSheetRows(rows: readonly unknown[]): SheetRow[] {
  const result: SheetRow[] = [];
  rows.forEach((row, index) => {
    const cells = Array.isArray(row) ? row.slice(0, MAX_COLUMNS).map(cellToString) : [];
    while (cells.length > 0 && cells[cells.length - 1] === "") cells.pop();
    if (cells.length > 0) result.push({ rowNumber: index + 1, values: cells });
  });
  return result;
}

function truncate(text: string, max = MAX_DETAIL_LENGTH): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

// ---------------------------------------------------------------------------
// Google Sheets API v4

export class GoogleSheetsTable implements RowTable {
  readonly #spreadsheetId: string;
  readonly #credentials: ServiceAccountCredentials;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #timeoutMs: number;
  #token: { value: string; expiresAtMs: number } | undefined;
  #pendingToken: Promise<string> | undefined;
  #lastAssertion: string | undefined;

  constructor(options: GoogleSheetsTableOptions) {
    if (typeof options.spreadsheetId !== "string" || options.spreadsheetId.trim() === "") {
      throw new Error("spreadsheetId must be a non-empty string");
    }
    const { client_email: clientEmail, private_key: privateKey } = options.credentials;
    if (typeof clientEmail !== "string" || clientEmail === "" || typeof privateKey !== "string" || privateKey === "") {
      throw new Error("credentials must include client_email and private_key");
    }
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("timeoutMs must be a positive number");
    this.#spreadsheetId = options.spreadsheetId;
    this.#credentials = { client_email: clientEmail, private_key: privateKey };
    this.#fetch = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.#now = options.now ?? Date.now;
    this.#timeoutMs = timeoutMs;
  }

  async ensureTab(tab: string, header: readonly string[]): Promise<void> {
    assertTab(tab);
    assertValues(header, "Header");
    if (!(await this.#tabTitles()).includes(tab)) {
      try {
        await this.#api("POST", ":batchUpdate", ":batchUpdate", {
          requests: [{ addSheet: { properties: { title: tab } } }],
        });
      } catch (error) {
        // Another bridge process may have created the tab concurrently.
        if (!(await this.#tabTitles()).includes(tab)) throw error;
      }
    }
    const firstRow = await this.#getValues(`${quoteTab(tab)}!A1:${LAST_COLUMN}1`);
    if (!rowHasContent(firstRow[0]) && header.length > 0) {
      await this.#putRow(tab, 1, header);
    }
  }

  async readRows(tab: string): Promise<SheetRow[]> {
    assertTab(tab);
    return toSheetRows(await this.#getValues(`${quoteTab(tab)}!A1:${LAST_COLUMN}`));
  }

  async updateRow(tab: string, rowNumber: number, values: readonly string[]): Promise<void> {
    assertTab(tab);
    assertRowNumber(rowNumber);
    assertValues(values, "Row values");
    if (values.length === 0) return;
    await this.#putRow(tab, rowNumber, values);
  }

  async appendRow(tab: string, values: readonly string[]): Promise<void> {
    assertTab(tab);
    assertValues(values, "Row values");
    if (values.length === 0) return;
    const range = `${quoteTab(tab)}!A1`;
    await this.#api(
      "POST",
      `/values/${encodeURIComponent(range)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
      `values/${range}:append`,
      { values: [[...values]] },
    );
  }

  async #tabTitles(): Promise<string[]> {
    const body = await this.#api("GET", "?fields=sheets.properties.title", "(sheet titles)");
    const sheets = isRecord(body) && Array.isArray(body["sheets"]) ? body["sheets"] : [];
    const titles: string[] = [];
    for (const sheet of sheets) {
      const properties = isRecord(sheet) ? sheet["properties"] : undefined;
      const title = isRecord(properties) ? properties["title"] : undefined;
      if (typeof title === "string") titles.push(title);
    }
    return titles;
  }

  async #getValues(range: string): Promise<unknown[]> {
    const body = await this.#api("GET", `/values/${encodeURIComponent(range)}`, `values/${range}`);
    return isRecord(body) && Array.isArray(body["values"]) ? body["values"] : [];
  }

  async #putRow(tab: string, rowNumber: number, values: readonly string[]): Promise<void> {
    const range = `${quoteTab(tab)}!A${rowNumber}`;
    await this.#api("PUT", `/values/${encodeURIComponent(range)}?valueInputOption=RAW`, `values/${range}`, {
      values: [[...values]],
    });
  }

  /** Authenticated JSON call relative to the spreadsheet resource. `label` is the short path used in errors. */
  async #api(method: string, suffix: string, label: string, body?: unknown): Promise<unknown> {
    const token = await this.#accessToken();
    const headers: Record<string, string> = { authorization: `Bearer ${token}`, accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    const url = `${SHEETS_BASE}/${encodeURIComponent(this.#spreadsheetId)}${suffix}`;
    return this.#send(method, url, label, headers, body === undefined ? undefined : JSON.stringify(body));
  }

  async #accessToken(): Promise<string> {
    const cached = this.#token;
    if (cached !== undefined && this.#now() < cached.expiresAtMs - TOKEN_REFRESH_MARGIN_MS) return cached.value;
    if (this.#pendingToken === undefined) {
      this.#pendingToken = this.#fetchToken().finally(() => {
        this.#pendingToken = undefined;
      });
    }
    return this.#pendingToken;
  }

  async #fetchToken(): Promise<string> {
    const issuedAtMs = this.#now();
    const assertion = signServiceAccountJwt(this.#credentials, Math.floor(issuedAtMs / 1000));
    this.#lastAssertion = assertion;
    const form = new URLSearchParams({ grant_type: JWT_GRANT_TYPE, assertion }).toString();
    const body = await this.#send(
      "POST",
      TOKEN_URL,
      TOKEN_LABEL,
      { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      form,
    );
    const accessToken = isRecord(body) ? body["access_token"] : undefined;
    if (typeof accessToken !== "string" || accessToken === "") {
      throw new Error(`POST ${TOKEN_LABEL} failed: response did not include an access_token`);
    }
    const expiresIn = isRecord(body) ? body["expires_in"] : undefined;
    const lifetimeSeconds = typeof expiresIn === "number" && expiresIn > 0 ? expiresIn : JWT_LIFETIME_SECONDS;
    this.#token = { value: accessToken, expiresAtMs: issuedAtMs + lifetimeSeconds * 1000 };
    return accessToken;
  }

  async #send(
    method: string,
    url: string,
    label: string,
    headers: Record<string, string>,
    body: string | undefined,
  ): Promise<unknown> {
    for (let attempt = 0; ; attempt += 1) {
      const init: RequestInit = { method, headers: { ...headers }, signal: AbortSignal.timeout(this.#timeoutMs) };
      if (body !== undefined) init.body = body;
      let response: Response;
      try {
        response = await this.#fetch(url, init);
      } catch (error) {
        throw this.#error(method, label, ...describeFetchFailure(error, this.#timeoutMs));
      }
      if (response.ok) {
        const text = await response.text();
        if (text.trim() === "") return {};
        try {
          return JSON.parse(text) as unknown;
        } catch {
          throw this.#error(method, label, `HTTP ${response.status}: response was not valid JSON`);
        }
      }
      const retryable = response.status === 429 || response.status >= 500;
      if (retryable && attempt === 0) {
        await response.body?.cancel().catch(() => undefined);
        await delay(RETRY_DELAY_MS);
        continue;
      }
      const detail = await readErrorDetail(response);
      const error = this.#error(method, label, `HTTP ${response.status}`, detail);
      // A rejected token is dropped (after redaction above) so the next call fetches a fresh one.
      if (response.status === 401 && url !== TOKEN_URL) this.#token = undefined;
      throw error;
    }
  }

  /**
   * Build an Error. `remoteDetail` (text from Google or the network stack) is scrubbed of anything
   * secret it might echo, then truncated, so a cut-off secret fragment can never survive.
   */
  #error(method: string, label: string, summary: string, remoteDetail = ""): Error {
    let detail = remoteDetail.replace(PEM_PRIVATE_KEY, "[redacted]");
    for (const secret of [this.#credentials.private_key, this.#token?.value, this.#lastAssertion]) {
      if (secret !== undefined && secret.length >= 8) detail = detail.split(secret).join("[redacted]");
    }
    detail = truncate(detail.trim());
    return new Error(`${method} ${label} failed: ${summary}${detail === "" ? "" : `: ${detail}`}`);
  }
}

function signServiceAccountJwt(credentials: ServiceAccountCredentials, issuedAtSeconds: number): string {
  const header = { alg: "RS256", typ: "JWT" };
  const claims = {
    iss: credentials.client_email,
    scope: SHEETS_SCOPE,
    aud: TOKEN_URL,
    iat: issuedAtSeconds,
    exp: issuedAtSeconds + JWT_LIFETIME_SECONDS,
  };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  let signature: string;
  try {
    const signer = createSign("RSA-SHA256");
    signer.update(signingInput);
    signer.end();
    signature = signer.sign(credentials.private_key, "base64url");
  } catch {
    throw new Error("Could not sign the service account JWT: private_key is not a usable RSA private key");
  }
  return `${signingInput}.${signature}`;
}

function base64url(text: string): string {
  return Buffer.from(text, "utf8").toString("base64url");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeFetchFailure(error: unknown, timeoutMs: number): [summary: string, detail: string] {
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return [`request timed out after ${timeoutMs}ms`, ""];
  }
  return ["network error", error instanceof Error ? error.message : String(error)];
}

/** Google's error message (untruncated): `{ error: { message } }` for Sheets, `{ error, error_description }` for OAuth. */
async function readErrorDetail(response: Response): Promise<string> {
  let text: string;
  try {
    text = await response.text();
  } catch {
    return "";
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return "";
  }
  if (!isRecord(parsed)) return "";
  const error = parsed["error"];
  if (isRecord(error) && typeof error["message"] === "string") return error["message"];
  if (typeof error === "string") {
    const description = parsed["error_description"];
    return typeof description === "string" ? `${error}: ${description}` : error;
  }
  return "";
}

// ---------------------------------------------------------------------------
// In-memory implementation

/** In-memory implementation with identical semantics, used by tests and local dry runs. */
export class MemoryRowTable implements RowTable {
  readonly #tabs = new Map<string, string[][]>();

  /** Test helper: direct access to a tab's rows (array of string arrays, index 0 = row 1). */
  tab(name: string): string[][] {
    const rows = this.#tabs.get(name);
    if (rows === undefined) throw new Error(`Tab ${quoteTab(name)} does not exist`);
    return rows;
  }

  async ensureTab(tab: string, header: readonly string[]): Promise<void> {
    assertTab(tab);
    assertValues(header, "Header");
    let rows = this.#tabs.get(tab);
    if (rows === undefined) {
      rows = [];
      this.#tabs.set(tab, rows);
    }
    if (!rowHasContent(rows[0]) && header.length > 0) {
      if (rows.length === 0) rows.push([]);
      rows[0] = [...header];
    }
  }

  async readRows(tab: string): Promise<SheetRow[]> {
    assertTab(tab);
    return toSheetRows(this.tab(tab));
  }

  async updateRow(tab: string, rowNumber: number, values: readonly string[]): Promise<void> {
    assertTab(tab);
    assertRowNumber(rowNumber);
    assertValues(values, "Row values");
    const rows = this.tab(tab);
    if (values.length === 0) return;
    while (rows.length < rowNumber) rows.push([]);
    const row = rows[rowNumber - 1] ?? [];
    while (row.length < values.length) row.push("");
    values.forEach((value, index) => {
      row[index] = value;
    });
    rows[rowNumber - 1] = row;
  }

  async appendRow(tab: string, values: readonly string[]): Promise<void> {
    assertTab(tab);
    assertValues(values, "Row values");
    const rows = this.tab(tab);
    if (values.length === 0) return;
    let lastNonEmpty = -1;
    rows.forEach((row, index) => {
      if (rowHasContent(row)) lastNonEmpty = index;
    });
    rows.splice(lastNonEmpty + 1, 0, [...values]);
  }
}
