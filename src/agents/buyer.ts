import type {
  DiscoveryResult,
  Offer,
  Order,
  ParticipantId,
  RankedCandidate,
  RegistrationInput,
  SourcingRequest,
} from "../contracts.js";
import { PlatformClient, PlatformClientError } from "./client.js";
import type { BuyerAgentConfig } from "./config.js";
import {
  BuyerNegotiation,
  noMatchReasonFor,
  type NegotiationNoMatchReason,
} from "./negotiation.js";
import type { AgentStateStore } from "./store.js";
import type { AgentClock, AgentLogger, SleepFn } from "./types.js";

/** Discovery polling is bounded independently from the negotiation deadline. */
export const DEFAULT_DISCOVERY_TIMEOUT_MS = 60_000;
/** Hard ceiling on discovery polls per request. */
export const MAX_DISCOVERY_POLLS = 20;
/** Hard ceiling on quote-request attempts after discovery. */
export const MAX_QUOTE_CANDIDATES = 5;
/** Safety bound so a static clock can never make the event loop spin forever. */
export const MAX_EVENT_POLLS = 1_000;
/** Bounded waits for a just-settled order to reach a terminal payment status. */
export const PAYMENT_POLL_ATTEMPTS = 5;
/** Delay between those reads; a sandbox payment normally resolves on the first read. */
export const PAYMENT_POLL_DELAY_MS = 400;

export interface BuyerOrderOutcome {
  status: "agreed_and_paid" | "payment_failed";
  order: Order;
  message: string;
}

export interface BuyerNoMatchOutcome {
  status: "no_match";
  reason: NegotiationNoMatchReason;
  detail?: string;
  message: string;
}

export type BuyerOutcome = BuyerOrderOutcome | BuyerNoMatchOutcome;

/** In-chat transport injected by the caller; failure never changes order state. */
export type BuyerReportSink = (outcome: BuyerOutcome) => Promise<void> | void;

export interface BuyerRunnerOptions {
  config: BuyerAgentConfig;
  client: PlatformClient;
  store?: AgentStateStore;
  clock?: AgentClock;
  sleep?: SleepFn;
  logger?: AgentLogger;
  report?: BuyerReportSink;
  /**
   * Participant id already known from an earlier registration. Used only when
   * the platform answers ALREADY_REGISTERED without returning the id.
   */
  knownParticipantId?: ParticipantId;
  /**
   * The draft contract does not carry a participant id on a ranked candidate.
   * Callers can inject the mapping discovered through their own integration.
   */
  supplierIdForCandidate?: (candidate: RankedCandidate) => ParticipantId | undefined;
  /** Convenience domain-keyed form of the same mapping. */
  supplierIdsByDomain?: Readonly<Record<string, ParticipantId>>;
  discoveryTimeoutMs?: number;
  discoveryMaxPolls?: number;
  maxCandidates?: number;
  maxEventPolls?: number;
}

type DiscoveryPollOutcome =
  | { kind: "complete"; result: DiscoveryResult }
  | { kind: "failed"; result: DiscoveryResult }
  | { kind: "timeout" };

interface NegotiationContext {
  participantId: ParticipantId;
  supplierId: ParticipantId;
  request: SourcingRequest;
  negotiation: BuyerNegotiation;
  handledOfferIds: Set<string>;
  handledOrderIds: Set<string>;
  lastOutcome?: BuyerOutcome;
}

/**
 * Buyer-side runner for one request. It registers, creates the request, runs
 * bounded discovery, requests a quote from ranked candidates and then follows
 * participant-scoped events to a settled order. Evidence text never feeds a
 * policy or a payment destination: only typed platform fields do.
 */
export class BuyerRunner {
  private readonly config: BuyerAgentConfig;
  private readonly client: PlatformClient;
  private readonly store: AgentStateStore | undefined;
  private readonly clock: AgentClock;
  private readonly sleep: SleepFn;
  private readonly logger: AgentLogger | undefined;
  private readonly report: BuyerReportSink | undefined;
  private readonly knownParticipantId: ParticipantId | undefined;
  private readonly supplierIdForCandidate:
    | ((candidate: RankedCandidate) => ParticipantId | undefined)
    | undefined;
  private readonly supplierIdsByDomain:
    | Readonly<Record<string, ParticipantId>>
    | undefined;
  private readonly discoveryTimeoutMs: number;
  private readonly discoveryMaxPolls: number;
  private readonly maxCandidates: number;
  private readonly maxEventPolls: number;
  private participantId: ParticipantId | undefined;
  private cursor: string | undefined;
  private readonly seenKeys = new Set<string>();
  private reported = false;

  constructor(options: BuyerRunnerOptions) {
    this.config = options.config;
    this.client = options.client;
    this.store = options.store;
    this.clock = options.clock ?? { now: () => Date.now() };
    this.sleep = options.sleep ?? defaultSleep;
    this.logger = options.logger;
    this.report = options.report;
    this.knownParticipantId = options.knownParticipantId;
    this.supplierIdForCandidate = options.supplierIdForCandidate;
    this.supplierIdsByDomain = options.supplierIdsByDomain;
    this.discoveryTimeoutMs = Math.max(
      1,
      options.discoveryTimeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS,
    );
    this.discoveryMaxPolls = Math.max(
      1,
      Math.min(options.discoveryMaxPolls ?? MAX_DISCOVERY_POLLS, MAX_DISCOVERY_POLLS),
    );
    this.maxCandidates = Math.max(
      1,
      Math.min(options.maxCandidates ?? MAX_QUOTE_CANDIDATES, MAX_QUOTE_CANDIDATES),
    );
    this.maxEventPolls = Math.max(
      1,
      options.maxEventPolls ?? MAX_EVENT_POLLS,
    );
  }

  async run(): Promise<BuyerOutcome> {
    const startedAtMs = this.clock.now();
    const participantId = await this.ensureRegistered();
    const request = await this.createRequest();

    const discovery = await this.awaitDiscovery(request.id);
    if (discovery.kind === "failed") {
      return this.finishNoMatch(
        "discovery_failed",
        describeSourceErrors(discovery.result),
      );
    }
    if (discovery.kind === "timeout") {
      return this.finishNoMatch(
        "discovery_timeout",
        "discovery did not complete within the bounded polling window",
      );
    }

    const candidates = rankEligibleCandidates(discovery.result.candidates).slice(
      0,
      this.maxCandidates,
    );
    if (candidates.length === 0) {
      return this.finishNoMatch(
        "no_candidates",
        "discovery returned no eligible candidates",
      );
    }

    const supplierId = await this.selectSupplier(request.id, candidates);
    if (supplierId === undefined) {
      return this.finishNoMatch(
        "no_connected_supplier",
        "no ranked candidate had a connected supplier participant",
      );
    }

    const negotiation = new BuyerNegotiation({
      request,
      mandate: this.config.buyer,
      buyerId: participantId,
      currency: this.config.currency,
      startedAtMs,
      limits: {
        maxRevisions: this.config.negotiationMaxRevisions,
        deadlineMs: this.config.negotiationDeadlineMs,
      },
    });

    const context: NegotiationContext = {
      participantId,
      supplierId,
      request,
      negotiation,
      handledOfferIds: new Set<string>(),
      handledOrderIds: new Set<string>(),
    };

    return this.negotiate(context);
  }

  private async ensureRegistered(): Promise<ParticipantId> {
    if (this.participantId !== undefined) {
      return this.participantId;
    }
    const input = buildBuyerRegistration(this.config);
    const idempotencyKey = `agent-register-buyer-${registrationKey(this.config)}`;
    try {
      const result = await this.client.registerParticipant(input, {
        idempotencyKey,
      });
      this.participantId = result.participantId;
      return result.participantId;
    } catch (error) {
      if (
        error instanceof PlatformClientError &&
        error.code === "ALREADY_REGISTERED" &&
        this.knownParticipantId !== undefined
      ) {
        this.participantId = this.knownParticipantId;
        return this.knownParticipantId;
      }
      throw error;
    }
  }

  private async createRequest(): Promise<SourcingRequest> {
    const mandate = this.config.buyer;
    const input: Omit<SourcingRequest, "id" | "buyerId"> = {
      category: mandate.category,
      description: mandate.item,
      quantity: mandate.quantity,
      unit: mandate.unit,
      destination: mandate.destination,
      maximumDeliveredTotal: {
        amountMinor: mandate.maxOrderMinor,
        currency: this.config.currency,
      },
      deliverBy: mandate.deliverBy,
      requirements: mandate.requirements.map((requirement) => ({
        key: requirement.key,
        description: requirement.description,
        mandatory: requirement.mandatory,
      })),
      demo: true,
    };
    return this.client.createRequest(input, {
      idempotencyKey: `agent-create-request-buyer-${registrationKey(this.config)}`,
    });
  }

  private async awaitDiscovery(
    requestId: string,
  ): Promise<DiscoveryPollOutcome> {
    const { discoveryId } = await this.client.startDiscovery(requestId, {
      idempotencyKey: `agent-discover-${requestId}`,
    });
    const startedAtMs = this.clock.now();

    for (let poll = 0; poll < this.discoveryMaxPolls; poll += 1) {
      const result = await this.client.getDiscovery(discoveryId);
      if (result.status === "complete") {
        return { kind: "complete", result };
      }
      if (result.status === "failed") {
        return { kind: "failed", result };
      }

      const elapsedMs = this.clock.now() - startedAtMs;
      if (elapsedMs >= this.discoveryTimeoutMs) {
        break;
      }
      const delayMs = Math.min(
        this.config.pollIntervalMs,
        this.discoveryTimeoutMs - elapsedMs,
      );
      await this.sleep(delayMs);
    }

    return { kind: "timeout" };
  }

  private async selectSupplier(
    requestId: string,
    candidates: readonly RankedCandidate[],
  ): Promise<ParticipantId | undefined> {
    for (const candidate of candidates) {
      const supplierId = this.resolveSupplierId(candidate);
      if (supplierId === undefined) {
        this.logger?.warn?.("buyer candidate has no mapped supplier participant", {
          domain: candidate.candidate.company.officialDomain,
        });
        continue;
      }

      try {
        await this.client.requestQuote(requestId, supplierId, {
          idempotencyKey: `agent-quote-${requestId}-${supplierId}`,
        });
        return supplierId;
      } catch (error) {
        if (
          error instanceof PlatformClientError &&
          (error.code === "NO_CONNECTED_REPRESENTATIVE" ||
            error.code === "NOT_FOUND")
        ) {
          this.logger?.info?.("buyer candidate is not connected; trying next", {
            domain: candidate.candidate.company.officialDomain,
            code: error.code,
          });
          continue;
        }
        throw error;
      }
    }
    return undefined;
  }

  private resolveSupplierId(
    candidate: RankedCandidate,
  ): ParticipantId | undefined {
    if (this.supplierIdForCandidate !== undefined) {
      return this.supplierIdForCandidate(candidate);
    }
    const domain = normalizeDomain(candidate.candidate.company.officialDomain);
    const mapped = this.supplierIdsByDomain?.[domain];
    if (mapped !== undefined) {
      return mapped;
    }
    return candidate.candidate.company.publicOrganizationId;
  }

  private async negotiate(
    context: NegotiationContext,
  ): Promise<BuyerOutcome> {
    this.cursor = (await this.store?.getCursor()) ?? this.cursor;

    for (let iteration = 0; iteration < this.maxEventPolls; iteration += 1) {
      const nowMs = this.clock.now();
      const status = context.negotiation.status(nowMs);
      if (!status.open && status.reason === "deadline_exceeded") {
        return this.finishNoMatch(
          "deadline_exceeded",
          "negotiation deadline reached",
        );
      }

      const page = await this.client.listEvents(this.cursor);
      for (const event of page.events) {
        if (event.requestId !== context.request.id) {
          await this.markSeen(event.id);
          continue;
        }
        if (await this.isSeen(event.id)) {
          continue;
        }

        let outcome: BuyerOutcome | undefined;
        if (event.type === "offer_received") {
          outcome = await this.handleOffer(context, event.resourceId);
        } else if (event.type === "agreement_created") {
          outcome = await this.handleAgreement(context, event.resourceId);
        } else {
          this.logger?.debug?.("buyer ignored an unrelated event type", {
            type: event.type,
          });
        }

        await this.markSeen(event.id);
        if (outcome !== undefined) {
          return outcome;
        }
      }

      this.cursor = page.nextCursor;
      await this.store?.setCursor(this.cursor);

      const afterPageMs = this.clock.now();
      const afterPage = context.negotiation.status(afterPageMs);
      if (!afterPage.open && afterPage.reason === "deadline_exceeded") {
        return this.finishNoMatch(
          "deadline_exceeded",
          "negotiation deadline reached",
        );
      }

      const remainingMs = context.negotiation.deadlineAtMs - afterPageMs;
      if (remainingMs <= 0) {
        continue;
      }
      await this.sleep(Math.min(this.config.pollIntervalMs, remainingMs));
    }

    return this.finishNoMatch(
      "deadline_exceeded",
      "bounded event polling exhausted without an agreement",
    );
  }

  private async handleOffer(
    context: NegotiationContext,
    offerId: string,
  ): Promise<BuyerOutcome | undefined> {
    const offer = await this.client.getOffer(offerId);
    if (
      offer.requestId !== context.request.id ||
      offer.buyerId !== context.participantId ||
      offer.supplierId !== context.supplierId
    ) {
      return undefined;
    }
    if (context.handledOfferIds.has(offer.id)) {
      return undefined;
    }
    context.handledOfferIds.add(offer.id);

    const decision = context.negotiation.evaluate(offer, this.clock.now());
    if (decision.kind === "accept") {
      try {
        const acceptance = await this.client.acceptOffer(offer.id, {
          idempotencyKey: `agent-accept-${offer.id}`,
        });
        if (acceptance.state === "agreed") {
          return this.finalizeOrder(context, acceptance.order.id);
        }
      } catch (error) {
        const mapped = mapNegotiationError(error);
        if (mapped !== undefined) {
          return this.finishNoMatch(mapped, safeErrorMessage(error));
        }
        throw error;
      }
      return undefined;
    }

    if (decision.kind === "counter") {
      const counter = context.negotiation.buildCounterOffer(
        offer,
        decision.amountMinor,
      );
      try {
        await this.client.submitOffer(counter, {
          idempotencyKey: `agent-counter-${offer.id}`,
        });
        context.negotiation.recordSubmittedCounter();
      } catch (error) {
        const mapped = mapNegotiationError(error);
        if (mapped !== undefined) {
          return this.finishNoMatch(mapped, safeErrorMessage(error));
        }
        throw error;
      }
      return undefined;
    }

    return this.finishNoMatch(
      noMatchReasonFor(decision.reasons),
      decision.reasons.join(", "),
    );
  }

  private async handleAgreement(
    context: NegotiationContext,
    orderId: string,
  ): Promise<BuyerOutcome | undefined> {
    if (context.handledOrderIds.has(orderId)) {
      return undefined;
    }
    return this.finalizeOrder(context, orderId);
  }

  private async finalizeOrder(
    context: NegotiationContext,
    orderId: string,
  ): Promise<BuyerOutcome> {
    if (context.handledOrderIds.has(orderId)) {
      return (
        context.lastOutcome ??
        this.finishNoMatch("platform_error", "duplicate agreement event")
      );
    }
    context.handledOrderIds.add(orderId);

    try {
      await this.client.settleOrder(orderId, {
        idempotencyKey: `agent-settle-${orderId}`,
      });
    } catch (error) {
      this.logger?.warn?.("buyer settlement request failed; reading order state", {
        orderId,
        reason: safeErrorMessage(error),
      });
    }

    const order = await this.awaitTerminalPayment(orderId);
    if (order.acceptedOffer.requestId !== context.request.id) {
      return this.finishNoMatch(
        "platform_error",
        "settled order does not belong to this request",
      );
    }

    const outcome = buildOrderOutcome(order);
    context.lastOutcome = outcome;
    return this.emitOutcome(outcome);
  }

  private async awaitTerminalPayment(orderId: string): Promise<Order> {
    let order = await this.client.getOrder(orderId);
    for (
      let attempt = 0;
      attempt < PAYMENT_POLL_ATTEMPTS && !isTerminalPayment(order);
      attempt += 1
    ) {
      // A sandbox payment can still be settling when the agreement is read. Reporting
      // "payment failed" for a pending charge would be a false negative.
      await this.sleep(PAYMENT_POLL_DELAY_MS);
      order = await this.client.getOrder(orderId);
    }
    return order;
  }

  private async finishNoMatch(
    reason: NegotiationNoMatchReason,
    detail?: string,
  ): Promise<BuyerNoMatchOutcome> {
    const outcome = buildNoMatchOutcome(reason, detail);
    return this.emitOutcome(outcome);
  }

  private async emitOutcome<T extends BuyerOutcome>(outcome: T): Promise<T> {
    if (this.reported) {
      return outcome;
    }
    this.reported = true;
    if (this.report === undefined) {
      return outcome;
    }
    try {
      await this.report(outcome);
    } catch (error) {
      this.logger?.warn?.("buyer result report failed; order state unchanged", {
        reason: safeErrorMessage(error),
      });
    }
    return outcome;
  }

  private async isSeen(key: string): Promise<boolean> {
    if (this.seenKeys.has(key)) {
      return true;
    }
    if (this.store !== undefined && (await this.store.hasSeen(key))) {
      this.seenKeys.add(key);
      return true;
    }
    return false;
  }

  private async markSeen(key: string): Promise<void> {
    this.seenKeys.add(key);
    await this.store?.markSeen(key);
  }
}

function buildBuyerRegistration(config: BuyerAgentConfig): RegistrationInput {
  const company =
    config.companyOrgId === undefined
      ? {
          name: config.companyName,
          officialDomain: config.companyDomain,
        }
      : {
          name: config.companyName,
          officialDomain: config.companyDomain,
          publicOrganizationId: config.companyOrgId,
        };

  return {
    company,
    role: "buyer",
    mandate: {
      maximumOrderTotal: {
        amountMinor: config.buyer.maxOrderMinor,
        currency: config.currency,
      },
      maximumRunTotal: {
        amountMinor: config.buyer.maxRunMinor,
        currency: config.currency,
      },
      allowedCategories: [config.buyer.category],
      destination: config.buyer.destination,
      expiresAt: config.buyer.expiresAt,
      sandboxOnly: true,
    },
    demo: true,
  };
}

function buildOrderOutcome(order: Order): BuyerOrderOutcome {
  const offer = order.acceptedOffer;
  const parts = [
    `order ${order.id}`,
    `offer ${offer.id}`,
    `total ${offer.deliveredTotal.amountMinor} ${offer.deliveredTotal.currency}`,
  ];
  if (order.demoInvoice !== undefined) {
    parts.push(`document ${order.demoInvoice.id}`);
  }
  if (order.sandboxPaymentId !== undefined) {
    parts.push(`payment ${order.sandboxPaymentId}`);
  }
  const details = parts.join(", ");

  if (
    order.agreementStatus === "agreed" &&
    order.paymentStatus === "succeeded" &&
    typeof order.sandboxPaymentId === "string" &&
    order.sandboxPaymentId !== ""
  ) {
    return {
      status: "agreed_and_paid",
      order,
      message: `agreed and sandbox-paid — ${details}`,
    };
  }

  const reason =
    order.paymentStatus === "failed"
      ? "payment failed"
      : order.paymentStatus === "requires_action" ||
          order.paymentStatus === "pending"
        ? "payment requires further action"
        : `payment ${order.paymentStatus}`;
  return {
    status: "payment_failed",
    order,
    message: `payment failed — ${reason}; ${details}`,
  };
}

function isTerminalPayment(order: Order): boolean {
  return order.paymentStatus === "succeeded" || order.paymentStatus === "failed";
}

function buildNoMatchOutcome(
  reason: NegotiationNoMatchReason,
  detail?: string,
): BuyerNoMatchOutcome {
  const sanitized = detail === undefined ? undefined : sanitizeDetail(detail);
  const suffix =
    sanitized === undefined || sanitized === "" ? "" : `: ${sanitized}`;
  return {
    status: "no_match",
    reason,
    message: `no match — ${reason}${suffix}`,
    ...(sanitized === undefined || sanitized === "" ? {} : { detail: sanitized }),
  };
}

function rankEligibleCandidates(
  candidates: readonly RankedCandidate[],
): RankedCandidate[] {
  return candidates
    .filter((candidate) => candidate.eligible !== "no")
    .slice()
    .sort((left, right) => left.rank - right.rank);
}

function describeSourceErrors(result: DiscoveryResult): string {
  const messages = result.sourceErrors
    .map((sourceError) => sourceError.message)
    .filter((message) => message.trim() !== "");
  return messages.length === 0
    ? "discovery failed without a source error message"
    : messages.join("; ");
}

function mapNegotiationError(
  error: unknown,
): NegotiationNoMatchReason | undefined {
  if (!(error instanceof PlatformClientError)) {
    return undefined;
  }
  switch (error.code) {
    case "REVISION_LIMIT":
      return "revision_limit";
    case "STALE_OFFER":
    case "CAPACITY_CONFLICT":
    case "INVALID_OFFER":
      return "refused";
    default:
      return undefined;
  }
}

function normalizeDomain(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/^www\./, "")
    .replace(/\.$/, "");
}

function registrationKey(config: BuyerAgentConfig): string {
  const domain = normalizeDomain(config.companyDomain);
  const company = config.companyName.trim().toLowerCase().replace(/\s+/g, "-");
  return `${domain}-${company}`;
}

function sanitizeDetail(value: string): string {
  const cleaned = value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  return cleaned.length > 200 ? `${cleaned.slice(0, 197)}...` : cleaned;
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return sanitizeDetail(error.message);
  }
  return "unknown error";
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
