import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createVerify, generateKeyPairSync } from "node:crypto";
import {
  GoogleSheetsTable,
  MemoryRowTable,
  parseServiceAccount,
  type GoogleSheetsTableOptions,
  type RowTable,
} from "../../src/agents/sheets.js";

const { publicKey, privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const CLIENT_EMAIL = "bridge@demo-project.iam.gserviceaccount.com";
const SPREADSHEET_ID = "sheet-123";
const SCOPE = "https://www.googleapis.com/auth/spreadsheets";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const T0 = 1_700_000_000_123;

// ---------------------------------------------------------------------------
// Fake Google: token endpoint plus an in-memory spreadsheet speaking Sheets v4 REST.

interface RecordedRequest {
  method: string;
  url: URL;
  /** Range path segment exactly as sent (still percent-encoded), when present. */
  rawRange: string | undefined;
  headers: Headers;
  body: string;
}

interface QueuedResponse { status: number; body: unknown }

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function googleError(status: number, message: string): Response {
  return json(status, { error: { code: status, message, status: "ERROR" } });
}

function trimRow(row: readonly string[]): string[] {
  const copy = [...row];
  while (copy.length > 0 && copy[copy.length - 1] === "") copy.pop();
  return copy;
}

class FakeGoogle {
  readonly tabs = new Map<string, string[][]>();
  readonly assertions: string[] = [];
  readonly tokenRequestBodies: URLSearchParams[] = [];
  readonly tokenContentTypes: (string | null)[] = [];
  readonly issuedTokens: string[] = [];
  readonly requests: RecordedRequest[] = [];
  /** Responses returned (in order) for the next Sheets API requests instead of normal handling. */
  readonly sheetFailures: QueuedResponse[] = [];
  /** Responses returned (in order) for the next token requests. */
  readonly tokenFailures: QueuedResponse[] = [];
  nowMs = T0;

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === "string" ? init.body : "";
    assert.ok(init?.signal instanceof AbortSignal, "every request carries an AbortSignal");
    if (url.href === TOKEN_URL) return this.#token(method, headers, body);
    return this.#sheets(method, url, headers, body);
  };

  table(overrides: Partial<GoogleSheetsTableOptions> = {}): GoogleSheetsTable {
    return new GoogleSheetsTable({
      spreadsheetId: SPREADSHEET_ID,
      credentials: { client_email: CLIENT_EMAIL, private_key: privateKey },
      fetchImpl: this.fetch,
      now: () => this.nowMs,
      ...overrides,
    });
  }

  sheetRequests(): RecordedRequest[] {
    return this.requests;
  }

  #token(method: string, headers: Headers, body: string): Response {
    assert.equal(method, "POST");
    const form = new URLSearchParams(body);
    this.tokenRequestBodies.push(form);
    this.tokenContentTypes.push(headers.get("content-type"));
    this.assertions.push(form.get("assertion") ?? "");
    const failure = this.tokenFailures.shift();
    if (failure !== undefined) return json(failure.status, failure.body);
    const token = `ya29.fake-access-token-${this.issuedTokens.length + 1}-abcdefgh`;
    this.issuedTokens.push(token);
    return json(200, { access_token: token, expires_in: 3600, token_type: "Bearer" });
  }

  #sheets(method: string, url: URL, headers: Headers, body: string): Response {
    const prefix = `/v4/spreadsheets/${SPREADSHEET_ID}`;
    assert.equal(url.origin, "https://sheets.googleapis.com");
    assert.ok(url.pathname.startsWith(prefix), `unexpected path ${url.pathname}`);
    const rest = url.pathname.slice(prefix.length);
    const valuesPrefix = "/values/";
    const rawRange = rest.startsWith(valuesPrefix) ? rest.slice(valuesPrefix.length).replace(/:append$/, "") : undefined;
    this.requests.push({ method, url, rawRange, headers, body });

    const latest = this.issuedTokens[this.issuedTokens.length - 1];
    if (latest === undefined || headers.get("authorization") !== `Bearer ${latest}`) {
      return googleError(401, "Request had invalid authentication credentials.");
    }
    const failure = this.sheetFailures.shift();
    if (failure !== undefined) return json(failure.status, failure.body);

    if (rest === "" && method === "GET") {
      assert.equal(url.searchParams.get("fields"), "sheets.properties.title");
      return json(200, { sheets: [...this.tabs.keys()].map((title) => ({ properties: { title } })) });
    }
    if (rest === ":batchUpdate" && method === "POST") {
      assert.equal(headers.get("content-type"), "application/json");
      const parsed = JSON.parse(body) as { requests: { addSheet: { properties: { title: string } } }[] };
      for (const request of parsed.requests) {
        const title = request.addSheet.properties.title;
        if (this.tabs.has(title)) return googleError(400, `A sheet with the name "${title}" already exists.`);
        this.tabs.set(title, []);
      }
      return json(200, { spreadsheetId: SPREADSHEET_ID, replies: [{}] });
    }
    if (rawRange === undefined) return googleError(404, "Not found");
    // The range segment must be percent-encoded: a literal ':' or space means it was not.
    if (rawRange.includes(":") || rawRange.includes(" ")) return googleError(400, `Range not URL-encoded: ${rawRange}`);
    const range = decodeURIComponent(rawRange);
    const match = /^'((?:[^']|'')*)'!A(\d+)(:Z(\d*))?$/.exec(range);
    if (match === null) return googleError(400, `Unable to parse range: ${range}`);
    const tab = (match[1] ?? "").replaceAll("''", "'");
    const startRow = Number(match[2]);
    const rows = this.tabs.get(tab);
    if (rows === undefined) return googleError(400, `Unable to parse range: ${range}`);

    if (method === "GET") {
      const endRow = match[3] === undefined ? startRow : match[4] ? Number(match[4]) : Number.POSITIVE_INFINITY;
      const values = rows.slice(startRow - 1, endRow).map(trimRow);
      while (values.length > 0 && (values[values.length - 1] ?? []).length === 0) values.pop();
      return json(200, values.length === 0 ? { range, majorDimension: "ROWS" } : { range, majorDimension: "ROWS", values });
    }
    const parsed = JSON.parse(body) as { values: string[][] };
    const newRow = parsed.values[0] ?? [];
    assert.equal(parsed.values.length, 1);
    assert.equal(url.searchParams.get("valueInputOption"), "RAW");
    if (method === "PUT") {
      while (rows.length < startRow) rows.push([]);
      const row = rows[startRow - 1] ?? [];
      newRow.forEach((value, index) => {
        while (row.length < index) row.push("");
        row[index] = value;
      });
      rows[startRow - 1] = row;
      return json(200, { updatedRange: range, updatedRows: 1 });
    }
    if (method === "POST" && rest.endsWith(":append")) {
      assert.equal(url.searchParams.get("insertDataOption"), "INSERT_ROWS");
      let last = -1;
      rows.forEach((row, index) => {
        if (row.some((cell) => cell !== "")) last = index;
      });
      rows.splice(last + 1, 0, [...newRow]);
      return json(200, { updates: { updatedRows: 1 } });
    }
    return googleError(405, "Method not allowed");
  }
}

// ---------------------------------------------------------------------------
// Shared RowTable contract, run against both implementations.

interface Harness {
  table: RowTable;
  /** Raw stored cells of a tab, or undefined when the tab does not exist. */
  cells(tab: string): string[][] | undefined;
}

function rowTableContract(name: string, makeHarness: () => Harness): void {
  describe(`${name} satisfies the RowTable contract`, () => {
    const HEADER = ["id", "status", "payload"] as const;

    test("ensureTab creates a missing tab, writes the header once and keeps an existing header", async () => {
      const { table, cells } = makeHarness();
      assert.equal(cells("Requests"), undefined);
      await table.ensureTab("Requests", HEADER);
      assert.deepEqual(await table.readRows("Requests"), [{ rowNumber: 1, values: [...HEADER] }]);
      await table.ensureTab("Requests", HEADER);
      await table.ensureTab("Requests", ["different", "header"]);
      assert.deepEqual(await table.readRows("Requests"), [{ rowNumber: 1, values: [...HEADER] }]);
      assert.deepEqual(cells("Requests"), [[...HEADER]]);
    });

    test("ensureTab fills an empty row 1 without touching later rows", async () => {
      const { table } = makeHarness();
      await table.ensureTab("Requests", []);
      await table.updateRow("Requests", 2, ["r2"]);
      await table.ensureTab("Requests", HEADER);
      assert.deepEqual(await table.readRows("Requests"), [
        { rowNumber: 1, values: [...HEADER] },
        { rowNumber: 2, values: ["r2"] },
      ]);
    });

    test("append, read and update round-trip with correct row numbers across a blank gap", async () => {
      const { table } = makeHarness();
      await table.ensureTab("Requests", HEADER);
      await table.appendRow("Requests", ["r2", "new", "{}"]);
      await table.appendRow("Requests", ["r3", "new", ""]);
      assert.deepEqual(await table.readRows("Requests"), [
        { rowNumber: 1, values: [...HEADER] },
        { rowNumber: 2, values: ["r2", "new", "{}"] },
        { rowNumber: 3, values: ["r3", "new"] },
      ]);

      // Writing row 5 leaves row 4 blank: it is skipped but numbering stays true to the sheet.
      await table.updateRow("Requests", 5, ["r5", "new", "x"]);
      await table.appendRow("Requests", ["r6", "new", "y"]);
      // Partial overwrite keeps cells beyond the written values; blank cells read back as "".
      await table.updateRow("Requests", 2, ["r2", "done"]);
      await table.updateRow("Requests", 3, ["", "", "z"]);
      assert.deepEqual(await table.readRows("Requests"), [
        { rowNumber: 1, values: [...HEADER] },
        { rowNumber: 2, values: ["r2", "done", "{}"] },
        { rowNumber: 3, values: ["", "", "z"] },
        { rowNumber: 5, values: ["r5", "new", "x"] },
        { rowNumber: 6, values: ["r6", "new", "y"] },
      ]);

      // Blanking a row removes it from reads; values are taken literally (RAW), not as formulas.
      await table.updateRow("Requests", 5, ["", "", ""]);
      await table.appendRow("Requests", ["=1+1", "new", "'quoted"]);
      const rows = await table.readRows("Requests");
      assert.deepEqual(rows.map((row) => row.rowNumber), [1, 2, 3, 6, 7]);
      assert.deepEqual(rows[4]?.values, ["=1+1", "new", "'quoted"]);
    });

    test("tab names containing a quote and a space are isolated from similar names", async () => {
      const { table } = makeHarness();
      const tab = "Bot's Inbox 1";
      await table.ensureTab(tab, HEADER);
      await table.ensureTab("Bot", ["other"]);
      await table.appendRow(tab, ["a", "b", "c"]);
      await table.updateRow(tab, 2, ["A"]);
      assert.deepEqual(await table.readRows(tab), [
        { rowNumber: 1, values: [...HEADER] },
        { rowNumber: 2, values: ["A", "b", "c"] },
      ]);
      assert.deepEqual(await table.readRows("Bot"), [{ rowNumber: 1, values: ["other"] }]);
    });

    test("reads only columns A..Z", async () => {
      const { table } = makeHarness();
      await table.ensureTab("Wide", []);
      const wide = Array.from({ length: 30 }, (_, index) => `c${index}`);
      await table.appendRow("Wide", wide);
      assert.deepEqual(await table.readRows("Wide"), [{ rowNumber: 1, values: wide.slice(0, 26) }]);
    });

    test("rejects missing tabs and invalid arguments", async () => {
      const { table } = makeHarness();
      await assert.rejects(table.readRows("Nope"));
      await table.ensureTab("Requests", HEADER);
      await assert.rejects(table.updateRow("Requests", 0, ["x"]), /Row number/);
      await assert.rejects(table.updateRow("Requests", 1.5, ["x"]), /Row number/);
      await assert.rejects(table.appendRow("Requests", [1 as unknown as string]), /array of strings/);
      await assert.rejects(table.ensureTab("", HEADER), /Tab name/);
      assert.deepEqual(await table.readRows("Requests"), [{ rowNumber: 1, values: [...HEADER] }]);
    });

    test("returned rows are copies", async () => {
      const { table } = makeHarness();
      await table.ensureTab("Requests", HEADER);
      const [first] = await table.readRows("Requests");
      first?.values.push("mutated");
      assert.deepEqual(await table.readRows("Requests"), [{ rowNumber: 1, values: [...HEADER] }]);
    });
  });
}

rowTableContract("MemoryRowTable", () => {
  const table = new MemoryRowTable();
  return {
    table,
    cells: (tab) => {
      try {
        return table.tab(tab);
      } catch {
        return undefined;
      }
    },
  };
});

rowTableContract("GoogleSheetsTable", () => {
  const google = new FakeGoogle();
  return { table: google.table(), cells: (tab) => google.tabs.get(tab) };
});

// ---------------------------------------------------------------------------
// Google-specific behaviour: auth, request shapes, errors.

function decodeSegment(segment: string | undefined): unknown {
  assert.ok(segment !== undefined);
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as unknown;
}

describe("GoogleSheetsTable", () => {
  test("signs an RS256 service-account JWT that verifies with the public key", async () => {
    const google = new FakeGoogle();
    await google.table().ensureTab("Requests", ["id"]);
    assert.equal(google.assertions.length, 1);
    const form = google.tokenRequestBodies[0];
    assert.equal(form?.get("grant_type"), "urn:ietf:params:oauth:grant-type:jwt-bearer");
    assert.equal(google.tokenContentTypes[0], "application/x-www-form-urlencoded");

    const jwt = google.assertions[0] ?? "";
    const [header, claims, signature] = jwt.split(".");
    assert.deepEqual(decodeSegment(header), { alg: "RS256", typ: "JWT" });
    const iat = Math.floor(T0 / 1000);
    assert.deepEqual(decodeSegment(claims), {
      iss: CLIENT_EMAIL,
      scope: SCOPE,
      aud: TOKEN_URL,
      iat,
      exp: iat + 3600,
    });
    assert.ok(signature !== undefined && signature.length > 0);
    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${header}.${claims}`);
    assert.equal(verifier.verify(publicKey, signature, "base64url"), true);

    for (const request of google.sheetRequests()) {
      assert.equal(request.headers.get("authorization"), `Bearer ${google.issuedTokens[0]}`);
    }
  });

  test("caches the access token and refreshes it 60s before expiry", async () => {
    const google = new FakeGoogle();
    const table = google.table();
    await table.ensureTab("Requests", ["id"]);
    await table.readRows("Requests");
    await Promise.all([table.readRows("Requests"), table.readRows("Requests"), table.appendRow("Requests", ["1"])]);
    assert.equal(google.issuedTokens.length, 1);

    google.nowMs = T0 + 3539_000;
    await table.readRows("Requests");
    assert.equal(google.issuedTokens.length, 1);

    google.nowMs = T0 + 3540_000;
    await table.readRows("Requests");
    assert.equal(google.issuedTokens.length, 2);
    const claims = decodeSegment(google.assertions[1]?.split(".")[1]) as { iat: number };
    assert.equal(claims.iat, Math.floor((T0 + 3540_000) / 1000));
    const last = google.sheetRequests().at(-1);
    assert.equal(last?.headers.get("authorization"), `Bearer ${google.issuedTokens[1]}`);
  });

  test("concurrent first calls share one token request", async () => {
    const google = new FakeGoogle();
    google.tabs.set("Requests", [["id"]]);
    const table = google.table();
    await Promise.all([table.readRows("Requests"), table.readRows("Requests"), table.readRows("Requests")]);
    assert.equal(google.tokenRequestBodies.length, 1);
  });

  test("ensureTab adds the sheet once and writes the header once", async () => {
    const google = new FakeGoogle();
    const table = google.table();
    await table.ensureTab("Requests", ["id", "status"]);
    await table.ensureTab("Requests", ["id", "status"]);
    const requests = google.sheetRequests();
    assert.equal(requests.filter((r) => r.url.pathname.endsWith(":batchUpdate")).length, 1);
    assert.equal(requests.filter((r) => r.method === "PUT").length, 1);
    const batch = requests.find((r) => r.url.pathname.endsWith(":batchUpdate"));
    assert.deepEqual(JSON.parse(batch?.body ?? "null"), {
      requests: [{ addSheet: { properties: { title: "Requests" } } }],
    });
    assert.deepEqual(google.tabs.get("Requests"), [["id", "status"]]);
  });

  test("ensureTab tolerates a tab created concurrently by another process", async () => {
    const google = new FakeGoogle();
    const table = google.table();
    google.sheetFailures.push({ status: 200, body: { sheets: [] } });
    google.tabs.set("Requests", [["id"]]);
    await table.ensureTab("Requests", ["id"]);
    assert.deepEqual(google.tabs.get("Requests"), [["id"]]);
  });

  test("quotes and URL-encodes ranges and sends RAW / INSERT_ROWS writes", async () => {
    const google = new FakeGoogle();
    const table = google.table();
    const tab = "Bot's Inbox";
    await table.ensureTab(tab, ["id"]);
    await table.appendRow(tab, ["r2"]);
    await table.updateRow(tab, 2, ["R2", "done"]);
    await table.readRows(tab);
    const requests = google.sheetRequests();

    const append = requests.find((r) => r.method === "POST" && r.url.pathname.endsWith(":append"));
    assert.equal(append?.rawRange, "'Bot''s%20Inbox'!A1");
    assert.equal(append?.url.searchParams.get("valueInputOption"), "RAW");
    assert.equal(append?.url.searchParams.get("insertDataOption"), "INSERT_ROWS");
    assert.deepEqual(JSON.parse(append?.body ?? "null"), { values: [["r2"]] });

    const update = requests.filter((r) => r.method === "PUT").at(-1);
    assert.equal(update?.rawRange, "'Bot''s%20Inbox'!A2");
    assert.equal(update?.url.searchParams.get("valueInputOption"), "RAW");
    assert.deepEqual(JSON.parse(update?.body ?? "null"), { values: [["R2", "done"]] });

    const read = requests.filter((r) => r.method === "GET" && r.rawRange !== undefined).at(-1);
    assert.equal(read?.rawRange, "'Bot''s%20Inbox'!A1%3AZ");
  });

  test("errors name method, path and status with Google's message but never secrets", async () => {
    const google = new FakeGoogle();
    const table = google.table();
    google.tabs.set("Requests", [["id"]]);
    await table.readRows("Requests");
    const token = google.issuedTokens[0] ?? "";
    const jwt = google.assertions[0] ?? "";
    const before = google.sheetRequests().length;
    google.sheetFailures.push({
      status: 403,
      body: {
        error: {
          code: 403,
          message: `The caller does not have permission (${token}) ${privateKey} ${jwt} ${"x".repeat(500)}`,
          status: "PERMISSION_DENIED",
        },
      },
    });
    const error = await table.readRows("Requests").then(
      () => assert.fail("expected rejection"),
      (caught: unknown) => caught,
    );
    assert.ok(error instanceof Error);
    assert.match(error.message, /^GET values\/'Requests'!A1:Z failed: HTTP 403: The caller does not have permission/);
    assert.ok(!error.message.includes(token), "message leaks access token");
    assert.ok(!error.message.includes(privateKey), "message leaks private key");
    assert.ok(!error.message.includes(jwt), "message leaks JWT");
    assert.ok(!error.message.includes("PRIVATE KEY"), "message leaks key material");
    assert.ok(error.message.length < 300, "Google message is truncated");
    assert.equal(google.sheetRequests().length, before + 1, "4xx is not retried");
  });

  test("token endpoint errors are reported without the JWT or key", async () => {
    const google = new FakeGoogle();
    google.tokenFailures.push({ status: 400, body: { error: "invalid_grant", error_description: "Invalid JWT Signature." } });
    const error = await google.table().readRows("Requests").then(
      () => assert.fail("expected rejection"),
      (caught: unknown) => caught,
    );
    assert.ok(error instanceof Error);
    assert.equal(error.message, "POST oauth2.googleapis.com/token failed: HTTP 400: invalid_grant: Invalid JWT Signature.");
    assert.ok(!error.message.includes(google.assertions[0] ?? "<none>"));
    assert.equal(google.tokenRequestBodies.length, 1);
  });

  test("retries 429/5xx once, then gives up", async () => {
    const google = new FakeGoogle();
    google.tabs.set("Requests", [["id"]]);
    const table = google.table();
    google.sheetFailures.push({ status: 503, body: { error: { message: "Backend unavailable" } } });
    assert.deepEqual(await table.readRows("Requests"), [{ rowNumber: 1, values: ["id"] }]);
    assert.equal(google.sheetRequests().length, 2);

    google.sheetFailures.push({ status: 429, body: {} }, { status: 500, body: { error: { message: "Internal error" } } });
    await assert.rejects(table.readRows("Requests"), /^Error: GET values\/'Requests'!A1:Z failed: HTTP 500: Internal error$/);
    assert.equal(google.sheetRequests().length, 4);
  });

  test("a 401 drops the cached token so the next call re-authenticates", async () => {
    const google = new FakeGoogle();
    google.tabs.set("Requests", [["id"]]);
    const table = google.table();
    await table.readRows("Requests");
    google.sheetFailures.push({ status: 401, body: { error: { message: "Invalid credentials" } } });
    await assert.rejects(table.readRows("Requests"), /HTTP 401/);
    await table.readRows("Requests");
    assert.equal(google.issuedTokens.length, 2);
  });

  test("applies the per-request timeout", async () => {
    const hanging: typeof fetch = (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    const table = new GoogleSheetsTable({
      spreadsheetId: SPREADSHEET_ID,
      credentials: { client_email: CLIENT_EMAIL, private_key: privateKey },
      fetchImpl: hanging,
      timeoutMs: 20,
    });
    // The hanging fake has no socket; AbortSignal.timeout alone does not keep Node alive.
    const keepalive = setTimeout(() => {}, 1000);
    try {
      await assert.rejects(table.readRows("Requests"), /^Error: POST oauth2\.googleapis\.com\/token failed: request timed out after 20ms$/);
    } finally {
      clearTimeout(keepalive);
    }
  });
});

// ---------------------------------------------------------------------------

describe("parseServiceAccount", () => {
  const key = JSON.stringify({ type: "service_account", client_email: CLIENT_EMAIL, private_key: privateKey });

  test("returns client_email and private_key", () => {
    assert.deepEqual(parseServiceAccount(key), { client_email: CLIENT_EMAIL, private_key: privateKey });
  });

  test("names the missing field without echoing the key", () => {
    assert.throws(
      () => parseServiceAccount(JSON.stringify({ private_key: privateKey })),
      (error: unknown) =>
        error instanceof Error && error.message.includes('"client_email"') && !error.message.includes("PRIVATE KEY"),
    );
    assert.throws(
      () => parseServiceAccount(JSON.stringify({ client_email: CLIENT_EMAIL, private_key: "" })),
      /missing required field "private_key"/,
    );
    assert.throws(() => parseServiceAccount(JSON.stringify({ client_email: CLIENT_EMAIL })), /"private_key"/);
  });

  test("rejects invalid JSON without quoting it", () => {
    const broken = key.slice(0, -10);
    assert.throws(
      () => parseServiceAccount(broken),
      (error: unknown) =>
        error instanceof Error && error.message === "Service account key is not valid JSON",
    );
    assert.throws(() => parseServiceAccount("[]"), /JSON object/);
  });
});
