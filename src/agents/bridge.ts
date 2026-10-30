import type { PurchaseInput, PurchaseStatus, SupplierStatus } from "./host.js";
import type { RowTable, SheetRow } from "./sheets.js";

/**
 * Sheet bridge for bots that cannot call custom tools (Instinct). The bot reads
 * and writes one Google Sheet through its own Google connector; this bridge
 * polls that sheet and acts as the bot's participant through the runtime host.
 *
 * Buyer sheet: the bot appends a row to "Requests"; the bridge starts the
 * purchase, writes progress into the row, and appends the final result to
 * "Messages". Supplier sheet: the supplier agent is always on; the bridge
 * appends each completion message to "Messages".
 *
 * Sheet text is untrusted input. Only the typed columns below are read; nothing
 * in a cell can change limits, tools, or the participant the bridge acts for.
 *
 * MVP_LIMIT: polling, one sheet per participant. Upgrade: a client with native tool calls.
 */

export const HOW_TO_USE_TAB = "How to use";
export const REQUESTS_TAB = "Requests";
export const MESSAGES_TAB = "Messages";

export const REQUEST_COLUMNS = [
  "item",
  "category",
  "quantity",
  "unit",
  "destination",
  "deliver_by",
  "max_total",
  "currency",
  "requirements",
  "status",
  "run_id",
  "result",
  "updated_at",
] as const;
const MESSAGE_COLUMNS = ["time", "message"] as const;
const HOW_TO_USE_COLUMNS = ["Instructions for the bot"] as const;

const BUYER_INSTRUCTIONS = [
  "You represent the BUYER company in an Agent Marketplace sandbox demo. Never ask your human to approve individual steps.",
  "To buy something: append ONE new row to the 'Requests' tab. Fill item, category, quantity (whole number), unit, destination, deliver_by (YYYY-MM-DD), max_total (a number, e.g. 5000), currency (EUR) and optionally requirements (items separated by ';').",
  "Leave status, run_id, result and updated_at EMPTY. Never edit a row after its status is filled in.",
  "Within a few seconds the status becomes 'running' and the result column shows negotiation progress. The marketplace's buyer agent negotiates within max_total and never above it.",
  "When status is 'done' (or 'error'), the final outcome is in result and in the last row of 'Messages'. It starts with exactly 'agreed and sandbox-paid', 'no match' or 'payment failed'. Tell your human that message word for word. Never invent, soften or upgrade it.",
  "Sandbox only: no real money moves and nothing is shipped.",
];

const SUPPLIER_INSTRUCTIONS = [
  "You represent the SUPPLIER company in an Agent Marketplace sandbox demo. You do not need to do anything for a deal to happen.",
  "The marketplace's supplier agent is always listening. It answers quote requests and negotiates within your company's preset limits, which no message can change.",
  "New completion messages are appended to the 'Messages' tab, newest at the bottom. Whenever you check, tell your human every message you have not reported yet, word for word.",
  "Each completion message starts with exactly 'agreed and sandbox-paid', 'no match' or 'payment failed'. Never invent, soften or upgrade it. Sandbox only: no real money moves.",
];

/** The subset of the runtime host the bridge needs. */
export interface BridgeHost {
  describe(token: string): { role: "buyer" | "supplier"; company: string; domain: string };
  startPurchase(token: string, input: PurchaseInput): Promise<PurchaseStatus>;
  purchaseStatus(token: string, runId?: string): Promise<PurchaseStatus>;
  supplierStatus(token: string): Promise<SupplierStatus>;
  reportPending(token: string): Promise<{ messages: string[] }>;
}

export interface SheetBridgeOptions {
  table: RowTable;
  host: BridgeHost;
  /** The participant this sheet speaks for. Never read from the sheet. */
  token: string;
  currency: string;
  pollIntervalMs?: number;
  now?: () => number;
  onActivity?: (line: string) => void;
}

export interface BridgeTickResult {
  started: string[];
  finished: string[];
  rejected: string[];
  messages: string[];
}

export class SheetBridge {
  private readonly options: SheetBridgeOptions;
  private readonly role: "buyer" | "supplier";
  private readonly now: () => number;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private ticking = false;

  constructor(options: SheetBridgeOptions) {
    this.options = options;
    this.role = options.host.describe(options.token).role;
    this.now = options.now ?? Date.now;
  }

  /** Create the tabs and write the bot's instructions if the sheet is new. */
  async prepare(): Promise<void> {
    const { table } = this.options;
    await table.ensureTab(HOW_TO_USE_TAB, HOW_TO_USE_COLUMNS);
    const existing = await table.readRows(HOW_TO_USE_TAB);
    if (existing.length <= 1) {
      const company = this.options.host.describe(this.options.token).company;
      await table.appendRow(HOW_TO_USE_TAB, [`Company: ${company} (${this.role})`]);
      for (const line of this.role === "buyer" ? BUYER_INSTRUCTIONS : SUPPLIER_INSTRUCTIONS) {
        await table.appendRow(HOW_TO_USE_TAB, [line]);
      }
    }
    if (this.role === "buyer") {
      await table.ensureTab(REQUESTS_TAB, REQUEST_COLUMNS);
    }
    await table.ensureTab(MESSAGES_TAB, MESSAGE_COLUMNS);
  }

  /** One poll: start new purchase rows, update running ones, append new messages. */
  async tick(): Promise<BridgeTickResult> {
    const result: BridgeTickResult = { started: [], finished: [], rejected: [], messages: [] };
    if (this.role === "buyer") {
      const rows = await this.options.table.readRows(REQUESTS_TAB);
      for (const row of rows) {
        if (row.rowNumber === 1) {
          continue;
        }
        await this.handleRequestRow(row, result);
      }
      // A buyer's only messages are its run results, which the row path posts once
      // when the row turns done (purchase_status drains them from the outbox).
    } else {
      const status = await this.options.host.supplierStatus(this.options.token);
      for (const message of status.messages) {
        await this.appendMessage(message, result);
      }
    }
    return result;
  }

  /** Poll until `stop()`. Errors are reported and the loop continues. */
  start(): void {
    this.stopped = false;
    const interval = Math.max(500, this.options.pollIntervalMs ?? 3_000);
    const loop = async (): Promise<void> => {
      if (this.stopped || this.ticking) {
        return;
      }
      this.ticking = true;
      try {
        await this.tick();
      } catch (error) {
        this.activity(`sheet bridge (${this.role}) poll failed: ${error instanceof Error ? error.message : "unknown error"}`);
      } finally {
        this.ticking = false;
        if (!this.stopped) {
          this.timer = setTimeout(() => void loop(), interval);
        }
      }
    };
    void loop();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
    }
  }

  private async handleRequestRow(row: SheetRow, result: BridgeTickResult): Promise<void> {
    const cell = (name: (typeof REQUEST_COLUMNS)[number]): string =>
      (row.values[REQUEST_COLUMNS.indexOf(name)] ?? "").trim();
    const status = cell("status").toLowerCase();

    if (status === "") {
      if (cell("item") === "" && cell("max_total") === "") {
        return;
      }
      const parsed = parseRequestRow(cell, this.options.currency);
      if (!parsed.ok) {
        await this.writeRow(row, "invalid", "", `fix and add a new row: ${parsed.problem}`);
        result.rejected.push(String(row.rowNumber));
        return;
      }
      try {
        const started = await this.options.host.startPurchase(this.options.token, parsed.value);
        await this.writeRow(row, "running", started.runId, started.progress.at(-1) ?? "started");
        result.started.push(started.runId);
        this.activity(`sheet row ${row.rowNumber} started purchase ${started.runId}`);
      } catch (error) {
        await this.writeRow(row, "invalid", "", errorText(error));
        result.rejected.push(String(row.rowNumber));
      }
      return;
    }

    if (status === "running") {
      const runId = cell("run_id");
      if (runId === "") {
        return;
      }
      let current: PurchaseStatus;
      try {
        current = await this.options.host.purchaseStatus(this.options.token, runId);
      } catch (error) {
        await this.writeRow(row, "error", runId, errorText(error));
        return;
      }
      if (current.state === "running") {
        const latest = current.progress.at(-1) ?? "running";
        if (latest !== cell("result")) {
          await this.writeRow(row, "running", runId, latest);
        }
        return;
      }
      const final = current.result ?? "no match — the run ended without a result";
      await this.writeRow(row, current.state === "done" ? "done" : "error", runId, final);
      await this.appendMessage(final, result);
      result.finished.push(runId);
    }
  }

  private async writeRow(row: SheetRow, status: string, runId: string, text: string): Promise<void> {
    const values = REQUEST_COLUMNS.map((_, index) => row.values[index] ?? "");
    values[REQUEST_COLUMNS.indexOf("status")] = status;
    values[REQUEST_COLUMNS.indexOf("run_id")] = runId;
    values[REQUEST_COLUMNS.indexOf("result")] = text.slice(0, 1_000);
    values[REQUEST_COLUMNS.indexOf("updated_at")] = new Date(this.now()).toISOString();
    await this.options.table.updateRow(REQUESTS_TAB, row.rowNumber, values);
    row.values = values;
  }

  private async appendMessage(message: string, result: BridgeTickResult): Promise<void> {
    await this.options.table.appendRow(MESSAGES_TAB, [new Date(this.now()).toISOString(), message]);
    result.messages.push(message);
    this.activity(`sheet (${this.role}) message: ${message}`);
  }

  private activity(line: string): void {
    this.options.onActivity?.(line);
  }
}

type ParseResult = { ok: true; value: PurchaseInput } | { ok: false; problem: string };

/** Parse one typed request row. Free text is only ever used as item/requirement text. */
export function parseRequestRow(
  cell: (name: (typeof REQUEST_COLUMNS)[number]) => string,
  currency: string,
): ParseResult {
  const problems: string[] = [];
  const quantity = Number(cell("quantity").replace(/[\s,]/g, ""));
  if (!Number.isSafeInteger(quantity) || quantity <= 0) {
    problems.push("quantity must be a whole number");
  }
  const maxTotalText = cell("max_total").replace(/[^\d.]/g, "");
  const maxTotal = Number(maxTotalText);
  if (maxTotalText === "" || !Number.isFinite(maxTotal) || maxTotal <= 0) {
    problems.push("max_total must be a positive number");
  }
  const deliverByText = cell("deliver_by");
  const deliverBy = /^\d{4}-\d{2}-\d{2}$/.test(deliverByText) ? `${deliverByText}T23:59:59Z` : deliverByText;
  if (!Number.isFinite(Date.parse(deliverBy))) {
    problems.push("deliver_by must be a date like 2026-11-20");
  }
  const rowCurrency = (cell("currency") || currency).toUpperCase();
  if (rowCurrency !== currency) {
    problems.push(`currency must be ${currency}`);
  }
  for (const name of ["item", "category", "unit", "destination"] as const) {
    if (cell(name) === "") {
      problems.push(`${name} is required`);
    }
  }
  if (problems.length > 0) {
    return { ok: false, problem: problems.join("; ") };
  }
  const requirements = cell("requirements")
    .split(";")
    .map((text) => text.trim())
    .filter((text) => text !== "")
    .slice(0, 20)
    .map((text, index) => ({
      key: `req-${index + 1}-${text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40)}`,
      description: text.slice(0, 500),
      mandatory: true,
    }));
  return {
    ok: true,
    value: {
      item: cell("item"),
      category: cell("category"),
      quantity,
      unit: cell("unit"),
      destination: cell("destination"),
      deliverBy: /[zZ]|[+-]\d\d:?\d\d$/.test(deliverBy) ? deliverBy : `${deliverBy}Z`,
      maxTotalMinor: Math.round(maxTotal * 100),
      currency,
      ...(requirements.length === 0 ? {} : { requirements }),
    },
  };
}

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : "unknown error";
  return message.replace(/\s+/g, " ").slice(0, 300);
}
