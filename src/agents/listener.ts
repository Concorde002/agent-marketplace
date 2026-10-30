import type {
  EventPage,
  Offer,
  Order,
  ParticipantEvent,
  SourcingRequest,
} from "../contracts.js";
import { PlatformClient, PlatformClientError } from "./client.js";
import type { SupplierAgentConfig } from "./config.js";
import {
  decideSupplierOffer,
  supplierInitialAskAmount,
  type NegotiationLimits,
  type SupplierPolicy,
} from "./policy.js";
import {
  PARTICIPANT_ID_STATE_KEY,
  ResultReporter,
  type ReportChannel,
} from "./reporter.js";
import type { AgentStateStore } from "./store.js";
import type { AgentClock, AgentError, AgentLogger, SleepFn } from "./types.js";

const DECLINE_KEY_PREFIX = "decline:";
const NEGOTIATION_KEY_PREFIX = "negotiation:";
const EVENT_SEEN_PREFIX = "event:";
const MAX_CHAIN_WALK = 20;
const DEFAULT_SLEEP: SleepFn = (ms) =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (
      typeof timer === "object" &&
      "unref" in timer &&
      typeof timer.unref === "function"
    ) {
      timer.unref();
    }
  });

export interface SupplierListenerOptions {
  client: PlatformClient;
  store: AgentStateStore;
  config: SupplierAgentConfig;
  /** The bot's own conversation; the only report transport in the MVP. */
  channel: ReportChannel;
  /**
   * The supplier participant id this listener acts as. Falls back to the
   * persisted `participant:id` state key written by setup tooling.
   */
  participantId?: string;
  clock?: AgentClock;
  sleep?: SleepFn;
  logger?: AgentLogger;
  /** Overrides `POLL_INTERVAL_MS`; defaults to the loaded config value. */
  pollIntervalMs?: number;
  /** Overrides `POLL_MAX_INTERVAL_MS`; defaults to the loaded config value. */
  pollMaxIntervalMs?: number;
}

export interface ListenerEventResult {
  eventId: string;
  eventType: string;
  status: "handled" | "skipped" | "failed";
  reason?: string;
}

export interface ListenerDecline {
  requestId: string;
  reason: string;
  eventId: string;
}

export interface ListenerTickResult {
  /** Cursor that was durably persisted by the end of the tick. */
  cursor: string;
  handled: string[];
  skipped: ListenerEventResult[];
  failed: ListenerEventResult[];
  reports: string[];
  declined: ListenerDecline[];
  /** True when at least one event was handled, so backoff may reset. */
  productive: boolean;
  lastError?: AgentError;
}

export type ListenerTickObserver = (
  result: ListenerTickResult,
) => void | Promise<void>;

interface HandlingOutcome {
  status: "handled" | "skipped";
  reason?: string;
  report?: string;
  decline?: ListenerDecline;
}

interface DeclineRecord {
  requestId: string;
  reason: string;
  eventId: string;
  atMs: number;
}

function seenKey(eventId: string): string {
  return `${EVENT_SEEN_PREFIX}${eventId}`;
}

function declineKey(requestId: string): string {
  return `${DECLINE_KEY_PREFIX}${requestId}`;
}

function negotiationKey(requestId: string): string {
  return `${NEGOTIATION_KEY_PREFIX}${requestId}`;
}

function compareCursor(left: string, right: string): number {
  if (/^\d+$/.test(left) && /^\d+$/.test(right)) {
    return Number(left) - Number(right);
  }
  return left.localeCompare(right);
}

function earlierIso(left: string, right: string): string {
  return Date.parse(left) <= Date.parse(right) ? left : right;
}

function toAgentError(error: unknown): AgentError {
  if (error instanceof PlatformClientError) {
    return {
      code: error.code,
      message: error.message.slice(0, 300),
      status: error.status,
    };
  }
  if (error instanceof Error) {
    return { code: "INTERNAL", message: error.message.slice(0, 300) };
  }
  return { code: "INTERNAL", message: "unknown listener failure" };
}

function parseDecline(raw: string | undefined): DeclineRecord | undefined {
  if (raw === undefined) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return undefined;
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.reason !== "string" || typeof record.requestId !== "string") {
    return undefined;
  }
  return {
    requestId: record.requestId,
    reason: record.reason,
    eventId: typeof record.eventId === "string" ? record.eventId : "",
    atMs: typeof record.atMs === "number" ? record.atMs : 0,
  };
}

function parseNegotiationStart(raw: string | undefined): number | undefined {
  if (raw === undefined) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return undefined;
  }
  const startedAtMs = (parsed as Record<string, unknown>).startedAtMs;
  return typeof startedAtMs === "number" && Number.isFinite(startedAtMs)
    ? startedAtMs
    : undefined;
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal.aborted;
}

/**
 * Supplier-side event listener. One `tick` performs a single bounded poll;
 * `run` repeats ticks with exponential backoff and keeps running after an
 * agreement so later payment updates are still reported.
 */
export class SupplierListener {
  /** Number of ticks performed; useful for tests and scheduled Routines. */
  tickCount = 0;

  private readonly client: PlatformClient;
  private readonly store: AgentStateStore;
  private readonly config: SupplierAgentConfig;
  private readonly reporter: ResultReporter;
  private readonly clock: AgentClock | undefined;
  private readonly sleep: SleepFn;
  private readonly logger: AgentLogger;
  private readonly pollIntervalMs: number;
  private readonly pollMaxIntervalMs: number;
  private participantId: string | undefined;
  private identityPersisted = false;

  constructor(options: SupplierListenerOptions) {
    if (options.config.role !== "supplier") {
      throw new Error("SupplierListener requires a supplier configuration");
    }
    this.client = options.client;
    this.store = options.store;
    this.config = options.config;
    this.reporter = new ResultReporter({
      store: options.store,
      channel: options.channel,
    });
    this.clock = options.clock;
    this.sleep = options.sleep ?? DEFAULT_SLEEP;
    this.logger = options.logger ?? {};
    this.pollIntervalMs = Math.max(
      1,
      options.pollIntervalMs ?? options.config.pollIntervalMs,
    );
    this.pollMaxIntervalMs = Math.max(
      this.pollIntervalMs,
      options.pollMaxIntervalMs ?? options.config.pollMaxIntervalMs,
    );
    this.participantId = options.participantId;
  }

  /**
   * One bounded poll of `listEvents(after=cursor)`. Events are handled in
   * cursor order; the cursor is persisted only after successful handling.
   * A failed event does not block later events on the same page.
   */
  async tick(): Promise<ListenerTickResult> {
    this.tickCount += 1;
    const stored = await this.store.getCursor();
    const result: ListenerTickResult = {
      cursor: stored ?? "",
      handled: [],
      skipped: [],
      failed: [],
      reports: [],
      declined: [],
      productive: false,
    };

    await this.persistIdentity();

    let page: EventPage;
    try {
      page = await this.client.listEvents(stored);
    } catch (error) {
      result.lastError = toAgentError(error);
      this.logger.warn?.("event poll failed", { code: result.lastError.code });
      return result;
    }

    const events = [...page.events].sort((left, right) =>
      compareCursor(left.cursor, right.cursor),
    );
    let cursor = stored;
    let blocked = false;

    for (const event of events) {
      if (await this.store.hasSeen(seenKey(event.id))) {
        if (!blocked) {
          cursor = event.cursor;
          await this.store.setCursor(event.cursor);
        }
        result.skipped.push({
          eventId: event.id,
          eventType: event.type,
          status: "skipped",
          reason: "duplicate_event",
        });
        continue;
      }

      try {
        const outcome = await this.handleEvent(event);
        await this.store.markSeen(seenKey(event.id));
        if (!blocked) {
          cursor = event.cursor;
          await this.store.setCursor(event.cursor);
        }
        if (outcome.status === "handled") {
          result.handled.push(event.id);
        } else {
          result.skipped.push({
            eventId: event.id,
            eventType: event.type,
            status: "skipped",
            ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
          });
        }
        if (outcome.report !== undefined) {
          result.reports.push(outcome.report);
        }
        if (outcome.decline !== undefined) {
          result.declined.push(outcome.decline);
        }
      } catch (error) {
        blocked = true;
        const agentError = toAgentError(error);
        result.lastError = agentError;
        result.failed.push({
          eventId: event.id,
          eventType: event.type,
          status: "failed",
          reason: agentError.code,
        });
        this.logger.error?.("event handling failed", {
          eventId: event.id,
          eventType: event.type,
          code: agentError.code,
        });
      }
    }

    if (!blocked && events.length > 0) {
      cursor = page.nextCursor;
      if (page.nextCursor !== (stored ?? "")) {
        await this.store.setCursor(page.nextCursor);
      }
    }

    result.cursor = cursor ?? "";
    result.productive = result.handled.length > 0;
    return result;
  }

  /**
   * Poll forever with exponential backoff from `pollIntervalMs` to
   * `pollMaxIntervalMs`, resetting after a productive tick. Stops on abort.
   */
  async run(
    signal?: AbortSignal,
    onTick?: ListenerTickObserver,
  ): Promise<void> {
    let interval = this.pollIntervalMs;
    while (!isAborted(signal)) {
      const result = await this.tick();
      if (onTick !== undefined) {
        await onTick(result);
      }
      if (isAborted(signal)) {
        return;
      }

      const delay = result.productive ? this.pollIntervalMs : interval;
      interval = result.productive
        ? this.pollIntervalMs
        : Math.min(interval * 2, this.pollMaxIntervalMs);
      await this.wait(delay, signal);
    }
  }

  /** Unread completion messages, e.g. from a previously failed chat report. */
  pendingReports(): Promise<string[]> {
    return this.reporter.pendingReports();
  }

  /** Read and clear unread completion messages for `report_pending`. */
  drainPendingReports(): Promise<string[]> {
    return this.reporter.drainPendingReports();
  }

  /** Persisted decline reason for a request, if the listener refused it. */
  async declinedReason(requestId: string): Promise<string | undefined> {
    return parseDecline(await this.store.getReport(declineKey(requestId)))
      ?.reason;
  }

  private async wait(ms: number, signal?: AbortSignal): Promise<void> {
    if (ms <= 0 || isAborted(signal)) {
      return;
    }
    if (signal === undefined) {
      await this.sleep(ms);
      return;
    }
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        signal.removeEventListener("abort", finish);
        resolve();
      };
      signal.addEventListener("abort", finish, { once: true });
      void this.sleep(ms).then(finish, finish);
    });
  }

  private now(): number {
    return this.clock === undefined ? Date.now() : this.clock.now();
  }

  private limits(): NegotiationLimits {
    return {
      maxRevisions: this.config.negotiationMaxRevisions,
      deadlineMs: this.config.negotiationDeadlineMs,
    };
  }

  private supplierPolicy(): SupplierPolicy {
    return {
      minimumDeliveredTotalMinor: this.config.supplier.minTotalMinor,
      availableQuantity: this.config.supplier.quantity,
      earliestDeliveryAt: this.config.supplier.earliestDeliveryAt,
      expiresAt: this.config.supplier.expiresAt,
      unit: this.config.supplier.unit,
      currency: this.config.currency,
    };
  }

  private async handleEvent(event: ParticipantEvent): Promise<HandlingOutcome> {
    const eventType: string = event.type;
    switch (eventType) {
      case "quote_requested":
        return this.handleQuoteRequested(event);
      case "offer_received":
        return this.handleOfferReceived(event);
      case "agreement_created":
        return this.handleAgreementCreated(event);
      case "payment_updated":
        return this.handlePaymentUpdated(event);
      default:
        this.logger.info?.("ignored unknown event type", {
          eventId: event.id,
          eventType,
        });
        return { status: "skipped", reason: `unknown_event_type:${eventType}` };
    }
  }

  private async handleQuoteRequested(
    event: ParticipantEvent,
  ): Promise<HandlingOutcome> {
    try {
      const request = await this.client.getRequest(event.requestId);
      const nowMs = this.now();
      await this.rememberNegotiationStart(request.id, nowMs);

      const declineReason = this.checkRequest(request, nowMs);
      if (declineReason !== undefined) {
        return this.decline(event, request.id, declineReason);
      }

      const decision = decideSupplierOffer({
        policy: this.supplierPolicy(),
        state: { revisions: 0, startedAtMs: nowMs },
        nowMs,
        limits: this.limits(),
      });
      if (decision.kind !== "offer") {
        return this.decline(event, request.id, `policy:${decision.kind}`);
      }

      const offer = await this.client.submitOffer(
        await this.buildInitialOffer(request, decision.amountMinor),
        { idempotencyKey: `listener:${event.id}:offer` },
      );
      return { status: "handled", reason: `submitted_offer:${offer.id}` };
    } catch (error) {
      const translated = await this.translatePlatformError(
        error,
        event,
        event.requestId,
      );
      if (translated !== undefined) {
        return translated;
      }
      throw error;
    }
  }

  private async handleOfferReceived(
    event: ParticipantEvent,
  ): Promise<HandlingOutcome> {
    const declined = await this.declinedReason(event.requestId);
    if (declined !== undefined) {
      return { status: "skipped", reason: `declined:${declined}` };
    }

    try {
      const offer = await this.client.getOffer(event.resourceId);
      if (this.participantId === undefined) {
        this.participantId = offer.supplierId;
      }
      const nowMs = this.now();
      const priorOffers = await this.countPriorOffers(offer);
      const startedAtMs =
        (await this.negotiationStart(event.requestId)) ?? nowMs;

      const decision = decideSupplierOffer({
        policy: this.supplierPolicy(),
        state: { revisions: priorOffers, startedAtMs },
        nowMs,
        limits: this.limits(),
        offer,
      });

      if (decision.kind === "accept") {
        const acceptance = await this.client.acceptOffer(offer.id, {
          idempotencyKey: `listener:${event.id}:accept`,
        });
        return {
          status: "handled",
          reason:
            acceptance.state === "agreed"
              ? `accepted:${acceptance.order.id}`
              : "accepted:awaiting_counterparty",
        };
      }

      if (decision.kind === "offer") {
        const submitted = await this.client.submitOffer(
          this.buildCounterOffer(offer, decision.amountMinor),
          { idempotencyKey: `listener:${event.id}:offer` },
        );
        return { status: "handled", reason: `countered:${submitted.id}` };
      }

      return this.decline(
        event,
        offer.requestId,
        `refused:${decision.reasons.join(",")}`,
      );
    } catch (error) {
      const translated = await this.translatePlatformError(
        error,
        event,
        event.requestId,
      );
      if (translated !== undefined) {
        return translated;
      }
      throw error;
    }
  }

  private async handleAgreementCreated(
    event: ParticipantEvent,
  ): Promise<HandlingOutcome> {
    const orderId = event.resourceId;
    await this.client.settleOrder(orderId, {
      idempotencyKey: `listener:${event.id}:settle`,
    });
    const order = await this.client.getOrder(orderId);
    const report = await this.reporter.reportOrder(order, {
      eventId: event.id,
      nowMs: this.now(),
    });
    return {
      status: "handled",
      reason: `settled:${order.paymentStatus}`,
      ...(report.reported ? { report: report.message } : {}),
    };
  }

  private async handlePaymentUpdated(
    event: ParticipantEvent,
  ): Promise<HandlingOutcome> {
    const order = await this.client.getOrder(event.resourceId);
    if (order.paymentStatus !== "succeeded" && order.paymentStatus !== "failed") {
      return {
        status: "skipped",
        reason: `non_terminal_payment:${order.paymentStatus}`,
      };
    }
    const report = await this.reporter.reportOrder(order, {
      eventId: event.id,
      nowMs: this.now(),
    });
    return {
      status: "handled",
      reason: `payment:${order.paymentStatus}`,
      ...(report.reported ? { report: report.message } : {}),
    };
  }

  private async decline(
    event: ParticipantEvent,
    requestId: string,
    reason: string,
  ): Promise<HandlingOutcome> {
    const record: DeclineRecord = {
      requestId,
      reason,
      eventId: event.id,
      atMs: this.now(),
    };
    await this.store.putReport(declineKey(requestId), JSON.stringify(record));

    const report = await this.reporter.reportNoMatch(reason, {
      subjectKey: `request:${requestId}`,
      eventId: `decline:${event.id}`,
      nowMs: this.now(),
    });
    return {
      status: "handled",
      reason: `declined:${reason}`,
      decline: { requestId, reason, eventId: event.id },
      ...(report.reported ? { report: report.message } : {}),
    };
  }

  private async translatePlatformError(
    error: unknown,
    event: ParticipantEvent,
    requestId: string,
  ): Promise<HandlingOutcome | undefined> {
    if (!(error instanceof PlatformClientError)) {
      return undefined;
    }
    switch (error.code) {
      case "STALE_OFFER":
        return { status: "skipped", reason: "stale_offer" };
      case "REVISION_LIMIT":
        return this.decline(event, requestId, "revision_limit");
      case "CAPACITY_CONFLICT":
        return this.decline(event, requestId, "capacity_conflict");
      default:
        return undefined;
    }
  }

  private checkRequest(request: SourcingRequest, nowMs: number): string | undefined {
    if (request.quantity > this.config.supplier.quantity) {
      return "quantity_unavailable";
    }
    if (request.unit !== this.config.supplier.unit) {
      return "unit_mismatch";
    }
    if (request.maximumDeliveredTotal.currency !== this.config.currency) {
      return "currency_mismatch";
    }
    if (Date.parse(this.config.supplier.expiresAt) <= nowMs) {
      return "mandate_expired";
    }
    if (
      Date.parse(this.config.supplier.earliestDeliveryAt) >
      Date.parse(request.deliverBy)
    ) {
      return "delivery_after_deadline";
    }
    const initialAsk = supplierInitialAskAmount(
      this.config.supplier.minTotalMinor,
    );
    if (initialAsk > request.maximumDeliveredTotal.amountMinor) {
      return "buyer_budget_below_minimum";
    }
    return undefined;
  }

  private async buildInitialOffer(
    request: SourcingRequest,
    amountMinor: number,
  ): Promise<Omit<Offer, "id">> {
    return {
      requestId: request.id,
      buyerId: request.buyerId,
      supplierId: await this.requireSupplierId(),
      quantity: request.quantity,
      unit: request.unit,
      destination: request.destination,
      deliveredTotal: {
        amountMinor,
        currency: request.maximumDeliveredTotal.currency,
      },
      taxMinor: 0,
      deliveryMinor: 0,
      deliveryAt: this.config.supplier.earliestDeliveryAt,
      expiresAt: this.config.supplier.expiresAt,
      confirmedRequirementKeys: request.requirements.map(
        (requirement) => requirement.key,
      ),
      termsOrigin: "demo-supplier-declaration",
      demo: true,
    };
  }

  private buildCounterOffer(
    offer: Offer,
    amountMinor: number,
  ): Omit<Offer, "id"> {
    return {
      requestId: offer.requestId,
      buyerId: offer.buyerId,
      supplierId: offer.supplierId,
      previousOfferId: offer.id,
      quantity: offer.quantity,
      unit: offer.unit,
      destination: offer.destination,
      deliveredTotal: {
        amountMinor,
        currency: offer.deliveredTotal.currency,
      },
      taxMinor: 0,
      deliveryMinor: 0,
      deliveryAt: offer.deliveryAt,
      expiresAt: earlierIso(offer.expiresAt, this.config.supplier.expiresAt),
      confirmedRequirementKeys: offer.confirmedRequirementKeys,
      termsOrigin: "demo-supplier-declaration",
      demo: true,
    };
  }

  private async countPriorOffers(offer: Offer): Promise<number> {
    let length = 1;
    let previousId = offer.previousOfferId;
    const visited = new Set<string>([offer.id]);
    let guard = 0;
    while (
      previousId !== undefined &&
      !visited.has(previousId) &&
      guard < MAX_CHAIN_WALK
    ) {
      visited.add(previousId);
      guard += 1;
      const previous = await this.client.getOffer(previousId);
      length += 1;
      previousId = previous.previousOfferId;
    }
    return Math.max(0, length - 1);
  }

  private async requireSupplierId(): Promise<string> {
    if (this.participantId !== undefined && this.participantId.trim() !== "") {
      return this.participantId;
    }
    const stored = await this.store.getReport(PARTICIPANT_ID_STATE_KEY);
    if (stored !== undefined && stored.trim() !== "") {
      this.participantId = stored.trim();
      return this.participantId;
    }
    throw new Error(
      "supplier participant id is not configured; set SupplierListenerOptions.participantId or persist participant:id",
    );
  }

  private async persistIdentity(): Promise<void> {
    if (this.identityPersisted || this.participantId === undefined) {
      return;
    }
    if (this.participantId.trim() === "") {
      return;
    }
    await this.store.putReport(PARTICIPANT_ID_STATE_KEY, this.participantId);
    this.identityPersisted = true;
  }

  private async rememberNegotiationStart(
    requestId: string,
    nowMs: number,
  ): Promise<void> {
    if ((await this.negotiationStart(requestId)) !== undefined) {
      return;
    }
    await this.store.putReport(
      negotiationKey(requestId),
      JSON.stringify({ startedAtMs: nowMs }),
    );
  }

  private async negotiationStart(requestId: string): Promise<number | undefined> {
    return parseNegotiationStart(
      await this.store.getReport(negotiationKey(requestId)),
    );
  }
}


