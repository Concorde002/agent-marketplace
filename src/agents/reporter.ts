import type { Order } from "../contracts.js";
import type { AgentStateStore } from "./store.js";

/**
 * Participant-facing result reporting. Messages are derived only from
 * authoritative order state read back from the platform; a transport failure
 * never changes that state and never throws out of this module.
 */

/** The only three literal result prefixes allowed in a bot conversation. */
export const REPORT_PAID_PREFIX = "agreed and sandbox-paid";
export const REPORT_NO_MATCH_PREFIX = "no match";
export const REPORT_PAYMENT_FAILED_PREFIX = "payment failed";

/** Store key used by setup tooling to remember the participant's own id. */
export const PARTICIPANT_ID_STATE_KEY = "participant:id";

const REPORT_KEY_PREFIX = "report:";
const REPORT_EVENT_KEY_PREFIX = "report-event:";
const PENDING_REPORTS_KEY = "pending:reports";
const MAX_PENDING_REPORTS = 50;
const MAX_REASON_LENGTH = 200;

export type ReportOutcome = "paid" | "no_match" | "payment_failed";

/** Transport for a result: the participant's own bot conversation. */
export type ReportChannel = (message: string) => Promise<void>;

export interface NoMatchSubject {
  kind: "no_match";
  reason: string;
}

export type ReportSubject = Order | NoMatchSubject;

export interface ReportBuildOptions {
  /** Injectable clock value so deadline decisions are deterministic in tests. */
  nowMs?: number;
  /** Epoch ms after which a pending payment is reported as needing action. */
  paymentDeadlineAtMs?: number;
}

export type ReportDecision =
  | { report: true; outcome: ReportOutcome; message: string }
  | { report: false; reason: "not_terminal" | "missing_payment_reference" };

export type ReportFailureReason =
  | "duplicate"
  | "not_terminal"
  | "missing_payment_reference"
  | "channel_failed";

export type ReportResult =
  | { reported: true; outcome: ReportOutcome; message: string }
  | { reported: false; reason: ReportFailureReason; message?: string };

function readReference(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function sanitizeReason(reason: string): string {
  const collapsed = reason.replace(/\s+/g, " ").trim();
  if (collapsed === "") {
    return "no qualifying supplier or agreement";
  }
  return collapsed.length > MAX_REASON_LENGTH
    ? `${collapsed.slice(0, MAX_REASON_LENGTH - 3)}...`
    : collapsed;
}

function orderReference(order: Order, paymentReference: string | undefined): string {
  const parts: string[] = [`order ${order.id}`];
  const total = order.acceptedOffer?.deliveredTotal;
  if (
    total !== undefined &&
    Number.isSafeInteger(total.amountMinor) &&
    typeof total.currency === "string"
  ) {
    parts.push(`total ${formatMinor(total.amountMinor)} ${total.currency}`);
  }
  const documentId = readReference(order.demoInvoice?.id);
  if (documentId !== undefined) {
    parts.push(`document ${documentId}`);
  }
  if (paymentReference !== undefined) {
    parts.push(`payment ${paymentReference}`);
  }
  return parts.join("; ");
}

/** 484000 -> "4840.00". Minor units are assumed to be cents for display only. */
function formatMinor(amountMinor: number): string {
  const sign = amountMinor < 0 ? "-" : "";
  const absolute = Math.abs(amountMinor);
  const major = Math.floor(absolute / 100);
  const minor = String(absolute % 100).padStart(2, "0");
  return `${sign}${major}.${minor}`;
}

function isNoMatchSubject(subject: ReportSubject): subject is NoMatchSubject {
  return (
    typeof subject === "object" &&
    subject !== null &&
    (subject as { kind?: unknown }).kind === "no_match"
  );
}

/**
 * Classify authoritative state into exactly one reporting decision. A paid
 * message requires an agreed order, a succeeded payment and a non-empty
 * sandbox payment reference; nothing else can produce it.
 */
export function buildReport(
  subject: ReportSubject,
  options: ReportBuildOptions = {},
): ReportDecision {
  if (isNoMatchSubject(subject)) {
    return {
      report: true,
      outcome: "no_match",
      message: `${REPORT_NO_MATCH_PREFIX} — ${sanitizeReason(subject.reason)}`,
    };
  }

  const agreementStatus: string = subject.agreementStatus;
  const paymentStatus: string = subject.paymentStatus;
  if (agreementStatus !== "agreed") {
    return { report: false, reason: "not_terminal" };
  }

  if (paymentStatus === "succeeded") {
    const paymentReference = readReference(subject.sandboxPaymentId);
    if (paymentReference === undefined) {
      return { report: false, reason: "missing_payment_reference" };
    }
    return {
      report: true,
      outcome: "paid",
      message: `${REPORT_PAID_PREFIX} — ${orderReference(subject, paymentReference)}`,
    };
  }

  if (paymentStatus === "requires_action") {
    // A headless sandbox run has no customer to complete extra authentication, so
    // this is reported now as a failure that needs action, never as paid.
    return {
      report: true,
      outcome: "payment_failed",
      message: `${REPORT_PAYMENT_FAILED_PREFIX} — payment requires further action; ${orderReference(
        subject,
        readReference(subject.sandboxPaymentId),
      )}`,
    };
  }

  if (paymentStatus === "failed") {
    return {
      report: true,
      outcome: "payment_failed",
      message: `${REPORT_PAYMENT_FAILED_PREFIX} — ${orderReference(
        subject,
        readReference(subject.sandboxPaymentId),
      )}`,
    };
  }

  if (paymentStatus === "not_started" || paymentStatus === "pending") {
    const nowMs = options.nowMs ?? Date.now();
    const deadline = options.paymentDeadlineAtMs;
    if (deadline !== undefined && nowMs >= deadline) {
      const paymentReference = readReference(subject.sandboxPaymentId);
      const suffix =
        paymentReference === undefined ? "" : `; payment ${paymentReference}`;
      return {
        report: true,
        outcome: "payment_failed",
        message: `${REPORT_PAYMENT_FAILED_PREFIX} — payment still ${paymentStatus} after the reporting window; order ${subject.id}${suffix}`,
      };
    }
  }

  return { report: false, reason: "not_terminal" };
}

function reportKey(subjectKey: string, outcome: ReportOutcome): string {
  return `${REPORT_KEY_PREFIX}${subjectKey}:${outcome}`;
}

function reportEventKey(eventId: string): string {
  return `${REPORT_EVENT_KEY_PREFIX}${eventId}`;
}

interface PendingReportEntry {
  key: string;
  message: string;
  queuedAtMs: number;
}

function parsePendingEntries(raw: string | undefined): PendingReportEntry[] {
  if (raw === undefined) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  const entries: PendingReportEntry[] = [];
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    if (typeof record.key !== "string" || typeof record.message !== "string") {
      continue;
    }
    entries.push({
      key: record.key,
      message: record.message,
      queuedAtMs: typeof record.queuedAtMs === "number" ? record.queuedAtMs : 0,
    });
  }
  return entries;
}

/**
 * Persisted report ledger over the shared agent state store. It records one
 * report per `subjectKey:outcome` pair and one report per event id, and keeps a
 * bounded queue of messages whose chat delivery failed so a bot that was
 * offline can read them later.
 */
export class ReportLedger {
  readonly store: AgentStateStore;

  constructor(store: AgentStateStore) {
    this.store = store;
  }

  async isReported(subjectKey: string, outcome: ReportOutcome): Promise<boolean> {
    return (await this.store.getReport(reportKey(subjectKey, outcome))) !== undefined;
  }

  async recordReport(
    subjectKey: string,
    outcome: ReportOutcome,
    message: string,
  ): Promise<void> {
    await this.store.putReport(reportKey(subjectKey, outcome), message);
  }

  async hasEvent(eventId: string): Promise<boolean> {
    return this.store.hasSeen(reportEventKey(eventId));
  }

  async markEvent(eventId: string): Promise<void> {
    await this.store.markSeen(reportEventKey(eventId));
  }

  async enqueuePending(
    subjectKey: string,
    outcome: ReportOutcome,
    message: string,
    nowMs: number = Date.now(),
  ): Promise<void> {
    const key = reportKey(subjectKey, outcome);
    const existing = await this.readPendingEntries();
    const entries = existing.filter((entry) => entry.key !== key);
    entries.push({ key, message, queuedAtMs: nowMs });
    const bounded = entries.slice(-MAX_PENDING_REPORTS);
    await this.store.putReport(PENDING_REPORTS_KEY, JSON.stringify(bounded));
  }

  async listPending(): Promise<string[]> {
    const entries = await this.readPendingEntries();
    return entries.map((entry) => entry.message);
  }

  /** Read and clear unread reports, as used by the MCP `report_pending` tool. */
  async drainPending(): Promise<string[]> {
    const entries = await this.readPendingEntries();
    if (entries.length > 0) {
      await this.store.putReport(PENDING_REPORTS_KEY, JSON.stringify([]));
    }
    return entries.map((entry) => entry.message);
  }

  /**
   * Try to deliver queued messages through the channel again. Delivered ones
   * are recorded as reported and leave the queue; the rest stay queued.
   */
  async retryPending(channel: ReportChannel): Promise<string[]> {
    const entries = await this.readPendingEntries();
    if (entries.length === 0) {
      return [];
    }
    const delivered: string[] = [];
    const remaining: PendingReportEntry[] = [];
    for (const entry of entries) {
      try {
        await channel(entry.message);
        await this.store.putReport(entry.key, entry.message);
        delivered.push(entry.message);
      } catch {
        remaining.push(entry);
      }
    }
    await this.store.putReport(PENDING_REPORTS_KEY, JSON.stringify(remaining));
    return delivered;
  }

  private async readPendingEntries(): Promise<PendingReportEntry[]> {
    return parsePendingEntries(await this.store.getReport(PENDING_REPORTS_KEY));
  }
}

export interface ReportOrderOptions {
  eventId?: string;
  nowMs?: number;
  paymentDeadlineAtMs?: number;
}

export interface ReportNoMatchOptions {
  /** Stable dedupe key; defaults to the literal `no-match`. */
  subjectKey?: string;
  eventId?: string;
  nowMs?: number;
}

async function deliver(
  decision: Extract<ReportDecision, { report: true }>,
  subjectKey: string,
  channel: ReportChannel,
  ledger: ReportLedger,
  options: { eventId?: string; nowMs?: number },
): Promise<ReportResult> {
  if (options.eventId !== undefined && (await ledger.hasEvent(options.eventId))) {
    return { reported: false, reason: "duplicate" };
  }
  if (await ledger.isReported(subjectKey, decision.outcome)) {
    return { reported: false, reason: "duplicate" };
  }

  try {
    await channel(decision.message);
  } catch {
    await ledger.enqueuePending(
      subjectKey,
      decision.outcome,
      decision.message,
      options.nowMs ?? Date.now(),
    );
    return { reported: false, reason: "channel_failed", message: decision.message };
  }

  await ledger.recordReport(subjectKey, decision.outcome, decision.message);
  if (options.eventId !== undefined) {
    await ledger.markEvent(options.eventId);
  }
  return {
    reported: true,
    outcome: decision.outcome,
    message: decision.message,
  };
}

/**
 * Report authoritative order state through the injected conversation channel.
 * Never throws: a duplicate, non-terminal state, missing payment reference or
 * channel failure is returned as `{ reported: false }`.
 */
export async function reportOrder(
  order: Order,
  channel: ReportChannel,
  ledger: ReportLedger,
  options: ReportOrderOptions = {},
): Promise<ReportResult> {
  const decision = buildReport(order, {
    ...(options.nowMs === undefined ? {} : { nowMs: options.nowMs }),
    ...(options.paymentDeadlineAtMs === undefined
      ? {}
      : { paymentDeadlineAtMs: options.paymentDeadlineAtMs }),
  });
  if (!decision.report) {
    return { reported: false, reason: decision.reason };
  }
  return deliver(decision, order.id, channel, ledger, {
    ...(options.eventId === undefined ? {} : { eventId: options.eventId }),
    ...(options.nowMs === undefined ? {} : { nowMs: options.nowMs }),
  });
}

/** Report a non-match/refusal outcome with the literal `no match` prefix. */
export async function reportNoMatch(
  reason: string,
  channel: ReportChannel,
  ledger: ReportLedger,
  options: ReportNoMatchOptions = {},
): Promise<ReportResult> {
  const decision = buildReport({ kind: "no_match", reason });
  if (!decision.report) {
    return { reported: false, reason: decision.reason };
  }
  return deliver(decision, options.subjectKey ?? "no-match", channel, ledger, {
    ...(options.eventId === undefined ? {} : { eventId: options.eventId }),
    ...(options.nowMs === undefined ? {} : { nowMs: options.nowMs }),
  });
}

export interface ResultReporterOptions {
  store: AgentStateStore;
  channel: ReportChannel;
}

/** Convenience wrapper binding a channel and the persisted ledger together. */
export class ResultReporter {
  readonly ledger: ReportLedger;
  private readonly channel: ReportChannel;

  constructor(options: ResultReporterOptions) {
    this.ledger = new ReportLedger(options.store);
    this.channel = options.channel;
  }

  reportOrder(order: Order, options: ReportOrderOptions = {}): Promise<ReportResult> {
    return reportOrder(order, this.channel, this.ledger, options);
  }

  reportNoMatch(
    reason: string,
    options: ReportNoMatchOptions = {},
  ): Promise<ReportResult> {
    return reportNoMatch(reason, this.channel, this.ledger, options);
  }

  pendingReports(): Promise<string[]> {
    return this.ledger.listPending();
  }

  retryPendingReports(): Promise<string[]> {
    return this.ledger.retryPending(this.channel);
  }

  drainPendingReports(): Promise<string[]> {
    return this.ledger.drainPending();
  }
}
