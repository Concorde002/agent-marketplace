import type { Offer } from "../contracts.js";

/** Negotiation revision ceiling. The configured value can only lower this. */
export const MAX_NEGOTIATION_REVISIONS = 3;
/** Negotiation wall-clock ceiling in milliseconds. */
export const MAX_NEGOTIATION_DEADLINE_MS = 300_000;

export const DEFAULT_NEGOTIATION_MAX_REVISIONS = MAX_NEGOTIATION_REVISIONS;
export const DEFAULT_NEGOTIATION_DEADLINE_MS = MAX_NEGOTIATION_DEADLINE_MS;

export type BuyerRefusalReason =
  | "invalid_offer"
  | "quantity_mismatch"
  | "unit_mismatch"
  | "destination_mismatch"
  | "currency_mismatch"
  | "order_total_exceeded"
  | "run_total_exceeded"
  | "delivery_after_deadline"
  | "offer_expired"
  | "mandate_expired"
  | "missing_mandatory_requirement";

export type SupplierRefusalReason =
  | "invalid_offer"
  | "below_minimum"
  | "quantity_unavailable"
  | "unit_mismatch"
  | "currency_mismatch"
  | "delivery_before_earliest"
  | "offer_expired"
  | "mandate_expired";

export type NegotiationStopReason = "revision_limit" | "deadline_exceeded";

export type PolicyRefusalReason =
  | BuyerRefusalReason
  | SupplierRefusalReason
  | NegotiationStopReason;

export interface OfferCheck<Reason extends string> {
  ok: boolean;
  reasons: Reason[];
}

/** Buyer-side mandate inputs a bot may not raise on its own. */
export interface BuyerPolicy {
  maximumOrderTotalMinor: number;
  remainingRunTotalMinor: number;
  currency: string;
  destination: string;
  quantity: number;
  unit: string;
  deliverBy: string;
  mandatoryRequirementKeys: readonly string[];
  /** Optional buyer-mandate expiry. Checked in addition to the offer expiry. */
  expiresAt?: string;
}

/** Supplier-side mandate inputs a bot may not raise on its own. */
export interface SupplierPolicy {
  minimumDeliveredTotalMinor: number;
  availableQuantity: number;
  earliestDeliveryAt: string;
  /** Optional supplier-mandate expiry. Checked in addition to the offer expiry. */
  expiresAt?: string;
  /** Optional unit assertion; when present the offer unit must match. */
  unit?: string;
  /** Optional currency assertion; when present the offer currency must match. */
  currency?: string;
}

export interface NegotiationLimits {
  maxRevisions: number;
  deadlineMs: number;
}

export interface NegotiationLimitsInput {
  maxRevisions?: number;
  deadlineMs?: number;
}

export interface NegotiationState {
  /** Number of offer revisions already submitted in this negotiation. */
  revisions: number;
  /** Epoch milliseconds at which the negotiation started. */
  startedAtMs: number;
}

export interface NegotiationStatus {
  open: boolean;
  reason?: NegotiationStopReason;
}

export type BuyerOfferDecision =
  | { kind: "accept" }
  | { kind: "counter"; amountMinor: number; reasons: BuyerRefusalReason[] }
  | { kind: "refuse"; reasons: PolicyRefusalReason[] };

export type SupplierOfferDecision =
  | { kind: "accept" }
  | { kind: "offer"; amountMinor: number; reasons?: SupplierRefusalReason[] }
  | { kind: "refuse"; reasons: PolicyRefusalReason[] };

export interface BuyerDecisionInput {
  offer: Offer;
  policy: BuyerPolicy;
  state: NegotiationState;
  nowMs: number;
  limits?: NegotiationLimitsInput;
}

export interface SupplierDecisionInput {
  policy: SupplierPolicy;
  state: NegotiationState;
  nowMs: number;
  /** Omit for the supplier's first response to a quote request. */
  offer?: Offer;
  limits?: NegotiationLimitsInput;
}

function isSafeMinor(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function isValidOffer(offer: Offer): boolean {
  if (typeof offer !== "object" || offer === null) {
    return false;
  }
  const total = offer.deliveredTotal;
  return (
    typeof total === "object" &&
    total !== null &&
    isSafeMinor(total.amountMinor) &&
    typeof total.currency === "string" &&
    typeof offer.quantity === "number" &&
    Number.isFinite(offer.quantity) &&
    offer.quantity > 0 &&
    typeof offer.unit === "string" &&
    typeof offer.destination === "string" &&
    typeof offer.deliveryAt === "string" &&
    Number.isFinite(Date.parse(offer.deliveryAt)) &&
    typeof offer.expiresAt === "string" &&
    Number.isFinite(Date.parse(offer.expiresAt)) &&
    Array.isArray(offer.confirmedRequirementKeys)
  );
}

function assertFiniteNow(nowMs: number): void {
  if (!Number.isFinite(nowMs)) {
    throw new RangeError("nowMs must be a finite number");
  }
}

/**
 * Check an offer against every buyer-side constraint. Pure: no clock, no I/O.
 * `nowMs` is supplied so results are deterministic in tests.
 */
export function checkBuyerOffer(
  offer: Offer,
  policy: BuyerPolicy,
  nowMs: number,
): OfferCheck<BuyerRefusalReason> {
  assertFiniteNow(nowMs);
  if (!isValidOffer(offer)) {
    return { ok: false, reasons: ["invalid_offer"] };
  }

  const reasons: BuyerRefusalReason[] = [];
  if (offer.quantity !== policy.quantity) {
    reasons.push("quantity_mismatch");
  }
  if (offer.unit !== policy.unit) {
    reasons.push("unit_mismatch");
  }
  if (offer.destination !== policy.destination) {
    reasons.push("destination_mismatch");
  }
  if (offer.deliveredTotal.currency !== policy.currency) {
    reasons.push("currency_mismatch");
  }
  if (offer.deliveredTotal.amountMinor > policy.maximumOrderTotalMinor) {
    reasons.push("order_total_exceeded");
  }
  if (offer.deliveredTotal.amountMinor > policy.remainingRunTotalMinor) {
    reasons.push("run_total_exceeded");
  }
  if (Date.parse(offer.deliveryAt) > Date.parse(policy.deliverBy)) {
    reasons.push("delivery_after_deadline");
  }
  if (Date.parse(offer.expiresAt) <= nowMs) {
    reasons.push("offer_expired");
  }
  if (
    policy.expiresAt !== undefined &&
    Date.parse(policy.expiresAt) <= nowMs
  ) {
    reasons.push("mandate_expired");
  }

  const confirmed = new Set(offer.confirmedRequirementKeys);
  const missing = policy.mandatoryRequirementKeys.some(
    (key) => !confirmed.has(key),
  );
  if (missing) {
    reasons.push("missing_mandatory_requirement");
  }

  return { ok: reasons.length === 0, reasons };
}

/**
 * Check an offer against every supplier-side constraint. Pure: no clock, no I/O.
 */
export function checkSupplierOffer(
  offer: Offer,
  policy: SupplierPolicy,
  nowMs: number,
): OfferCheck<SupplierRefusalReason> {
  assertFiniteNow(nowMs);
  if (!isValidOffer(offer)) {
    return { ok: false, reasons: ["invalid_offer"] };
  }

  const reasons: SupplierRefusalReason[] = [];
  if (offer.deliveredTotal.amountMinor < policy.minimumDeliveredTotalMinor) {
    reasons.push("below_minimum");
  }
  if (offer.quantity > policy.availableQuantity) {
    reasons.push("quantity_unavailable");
  }
  if (Date.parse(offer.deliveryAt) < Date.parse(policy.earliestDeliveryAt)) {
    reasons.push("delivery_before_earliest");
  }
  if (
    policy.unit !== undefined &&
    offer.unit !== policy.unit
  ) {
    reasons.push("unit_mismatch");
  }
  if (
    policy.currency !== undefined &&
    offer.deliveredTotal.currency !== policy.currency
  ) {
    reasons.push("currency_mismatch");
  }
  if (Date.parse(offer.expiresAt) <= nowMs) {
    reasons.push("offer_expired");
  }
  if (
    policy.expiresAt !== undefined &&
    Date.parse(policy.expiresAt) <= nowMs
  ) {
    reasons.push("mandate_expired");
  }

  return { ok: reasons.length === 0, reasons };
}

/**
 * Supplier's first ask: ceil(minimum * 1.10), computed with integer
 * arithmetic so floating-point artefacts cannot add a minor unit.
 */
export function supplierInitialAskAmount(
  minimumDeliveredTotalMinor: number,
): number {
  if (!isSafeMinor(minimumDeliveredTotalMinor)) {
    throw new RangeError(
      "minimumDeliveredTotalMinor must be a non-negative safe integer",
    );
  }
  const scaled = minimumDeliveredTotalMinor * 11;
  if (!Number.isSafeInteger(scaled)) {
    throw new RangeError("supplier ask exceeds the safe integer range");
  }
  return Math.floor((scaled + 9) / 10);
}

/**
 * Buyer counter: ceil((ask + maximum) / 2), clamped to the maximum order total.
 */
export function buyerCounterAmount(
  askMinor: number,
  maximumOrderTotalMinor: number,
): number {
  if (!isSafeMinor(askMinor) || !isSafeMinor(maximumOrderTotalMinor)) {
    throw new RangeError("amounts must be non-negative safe integers");
  }
  const sum = askMinor + maximumOrderTotalMinor;
  if (!Number.isSafeInteger(sum)) {
    throw new RangeError("counter amount exceeds the safe integer range");
  }
  return Math.min(Math.ceil(sum / 2), maximumOrderTotalMinor);
}

function clampPositiveInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
): number {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback;
  }
  const integer = Math.floor(value);
  if (integer < 1) {
    return fallback;
  }
  return Math.min(integer, maximum);
}

/** Resolve configured limits, never exceeding the hard ceilings. */
export function resolveNegotiationLimits(
  input: NegotiationLimitsInput = {},
): NegotiationLimits {
  return {
    maxRevisions: clampPositiveInteger(
      input.maxRevisions,
      DEFAULT_NEGOTIATION_MAX_REVISIONS,
      MAX_NEGOTIATION_REVISIONS,
    ),
    deadlineMs: clampPositiveInteger(
      input.deadlineMs,
      DEFAULT_NEGOTIATION_DEADLINE_MS,
      MAX_NEGOTIATION_DEADLINE_MS,
    ),
  };
}

export function createNegotiationState(nowMs: number): NegotiationState {
  assertFiniteNow(nowMs);
  return { revisions: 0, startedAtMs: nowMs };
}

export function negotiationStatus(
  state: NegotiationState,
  limits: NegotiationLimitsInput = {},
  nowMs: number,
): NegotiationStatus {
  assertFiniteNow(nowMs);
  const effective = resolveNegotiationLimits(limits);
  if (nowMs - state.startedAtMs >= effective.deadlineMs) {
    return { open: false, reason: "deadline_exceeded" };
  }
  if (state.revisions >= effective.maxRevisions) {
    return { open: false, reason: "revision_limit" };
  }
  return { open: true };
}

export function canSubmitRevision(
  state: NegotiationState,
  limits: NegotiationLimitsInput = {},
  nowMs: number,
): boolean {
  return negotiationStatus(state, limits, nowMs).open;
}

/** Record a submitted offer/counteroffer, stopping at the configured cap. */
export function recordOfferRevision(
  state: NegotiationState,
  limits: NegotiationLimitsInput = {},
): NegotiationState {
  const effective = resolveNegotiationLimits(limits);
  if (state.revisions >= effective.maxRevisions) {
    return { revisions: state.revisions, startedAtMs: state.startedAtMs };
  }
  return {
    revisions: state.revisions + 1,
    startedAtMs: state.startedAtMs,
  };
}

/**
 * Buyer action for an incoming supplier offer. Accept only when every buyer
 * check passes; otherwise counter deterministically while revisions remain.
 */
export function decideBuyerOffer(input: BuyerDecisionInput): BuyerOfferDecision {
  const check = checkBuyerOffer(input.offer, input.policy, input.nowMs);
  const status = negotiationStatus(input.state, input.limits, input.nowMs);

  if (check.ok) {
    if (status.open || status.reason === "revision_limit") {
      return { kind: "accept" };
    }
    return { kind: "refuse", reasons: ["deadline_exceeded"] };
  }

  if (check.reasons.includes("invalid_offer")) {
    return { kind: "refuse", reasons: check.reasons };
  }

  // A counteroffer only changes the price. Any failure of a non-price term
  // (quantity, unit, destination, currency, delivery, expiry, mandate, or a
  // mandatory requirement) is terminal: a different price cannot fix it.
  const nonPriceReasons = check.reasons.filter(
    (reason) =>
      reason !== "order_total_exceeded" && reason !== "run_total_exceeded",
  );
  if (nonPriceReasons.length > 0) {
    const reasons: PolicyRefusalReason[] = [...check.reasons];
    if (status.reason !== undefined) {
      reasons.push(status.reason);
    }
    return { kind: "refuse", reasons };
  }

  if (status.open) {
    return {
      kind: "counter",
      amountMinor: buyerCounterAmount(
        input.offer.deliveredTotal.amountMinor,
        input.policy.maximumOrderTotalMinor,
      ),
      reasons: check.reasons,
    };
  }

  const reasons: PolicyRefusalReason[] = [...check.reasons];
  if (status.reason !== undefined) {
    reasons.push(status.reason);
  }
  return { kind: "refuse", reasons };
}

/**
 * Supplier action for a buyer counteroffer, or the first ask when no offer is
 * supplied. Never offers below the minimum; later asks settle at the minimum.
 */
export function decideSupplierOffer(
  input: SupplierDecisionInput,
): SupplierOfferDecision {
  const status = negotiationStatus(input.state, input.limits, input.nowMs);

  if (input.offer === undefined) {
    if (!status.open) {
      return {
        kind: "refuse",
        reasons: [status.reason ?? "deadline_exceeded"],
      };
    }
    return {
      kind: "offer",
      amountMinor: supplierInitialAskAmount(
        input.policy.minimumDeliveredTotalMinor,
      ),
    };
  }

  const check = checkSupplierOffer(input.offer, input.policy, input.nowMs);

  if (check.ok) {
    if (status.open || status.reason === "revision_limit") {
      return { kind: "accept" };
    }
    return { kind: "refuse", reasons: ["deadline_exceeded"] };
  }

  const nonPriceReasons = check.reasons.filter(
    (reason) => reason !== "below_minimum",
  );
  if (nonPriceReasons.length > 0) {
    return { kind: "refuse", reasons: check.reasons };
  }

  if (status.open) {
    return {
      kind: "offer",
      amountMinor: input.policy.minimumDeliveredTotalMinor,
      reasons: check.reasons,
    };
  }

  const reasons: PolicyRefusalReason[] = [...check.reasons];
  if (status.reason !== undefined) {
    reasons.push(status.reason);
  }
  return { kind: "refuse", reasons };
}

/** Derive the mandatory requirement keys a buyer offer must confirm. */
export function mandatoryRequirementKeys(
  requirements: readonly { key: string; mandatory: boolean }[],
): string[] {
  return requirements
    .filter((requirement) => requirement.mandatory)
    .map((requirement) => requirement.key);
}

/** Remaining buyer run budget after prior committed spend, never negative. */
export function remainingRunTotal(
  maximumRunTotalMinor: number,
  committedMinor: number,
): number {
  if (!isSafeMinor(maximumRunTotalMinor) || !isSafeMinor(committedMinor)) {
    throw new RangeError("amounts must be non-negative safe integers");
  }
  return Math.max(0, maximumRunTotalMinor - committedMinor);
}
