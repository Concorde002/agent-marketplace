import type { ActorContext, BuyerMandate, Order, OrderId, ParticipantId } from "../contracts.js";
import { verifyStripeSignature, parsePaymentEvent, type PaymentWebhookEvent } from "./webhook.js";
import { TERMINAL, type PaymentAttempt, type PaymentCredential, type PaymentOutcome, type PaymentProvider, type PaymentStatus } from "./types.js";

export type AttemptUpdate = { status: PaymentStatus; providerPaymentId?: string; failureCode?: string };

/**
 * Persistence boundary for payments. The production implementation belongs to the platform storage
 * work (D1 migrations); `claimAttempt` must be one atomic statement guarded by UNIQUE(order_id).
 */
export interface PaymentStore {
  getCredential(participantId: ParticipantId): Promise<PaymentCredential | undefined>;
  /**
   * Atomically inserts the attempt only if no attempt exists for the order AND the buyer's committed
   * spend in that currency (every non-failed attempt) plus this amount stays within `maxCommittedMinor`.
   */
  claimAttempt(attempt: PaymentAttempt, maxCommittedMinor: number):
    Promise<{ claimed: true } | { claimed: false; reason: "exists"; existing: PaymentAttempt } | { claimed: false; reason: "run_total_exceeded" }>;
  getAttempt(orderId: OrderId): Promise<PaymentAttempt | undefined>;
  /** Compare-and-set: applies only while the stored status still equals `expected`. */
  updateAttempt(orderId: OrderId, expected: PaymentStatus, next: AttemptUpdate): Promise<boolean>;
  hasWebhookEvent(eventId: string): Promise<boolean>;
  recordWebhookEvent(eventId: string, type: string): Promise<void>;
  /** Idempotent per (orderId, status): emits one `payment_updated` participant event to buyer and supplier. */
  emitPaymentUpdated(attempt: PaymentAttempt): Promise<void>;
}

export type RefusalCode =
  | "not_order_buyer"
  | "order_not_agreed"
  | "mandate_not_sandbox"
  | "mandate_expired"
  | "currency_mismatch"
  | "order_total_exceeds_mandate"
  | "run_total_exceeds_mandate"
  | "payment_credential_missing";

/** A deterministic policy refusal. No provider call was made and no payment state changed. */
export class PaymentRefusedError extends Error {
  constructor(readonly code: RefusalCode) {
    super(`Payment refused: ${code}`);
  }
}

/** A `creating` attempt younger than this is assumed in flight; Stripe rejects a parallel request with the same idempotency key. */
export const RESUME_AFTER_MS = 30_000;

/** The provider's result is unknown (network, auth, rate limit). The attempt stays `creating`; retrying settle is safe. */
export class PaymentUnavailableError extends Error {}

function canTransition(from: PaymentStatus, to: PaymentStatus): boolean {
  return from !== to && !TERMINAL.has(from) && to !== "creating";
}

function toUpdate(outcome: PaymentOutcome): AttemptUpdate {
  if (outcome.status === "failed") {
    return outcome.providerPaymentId ? { status: "failed", providerPaymentId: outcome.providerPaymentId, failureCode: outcome.code } : { status: "failed", failureCode: outcome.code };
  }
  return { status: outcome.status, providerPaymentId: outcome.providerPaymentId };
}

/** Projects payment state onto the shared Order contract. */
export function withPayment(order: Order, attempt: PaymentAttempt | undefined): Order {
  if (!attempt) return { ...order, paymentStatus: "not_started" };
  const paymentStatus = attempt.status === "creating" ? "pending" : attempt.status;
  return attempt.providerPaymentId ? { ...order, paymentStatus, sandboxPaymentId: attempt.providerPaymentId } : { ...order, paymentStatus };
}

export class SettlementService {
  constructor(private readonly store: PaymentStore, private readonly provider: PaymentProvider, private readonly now: () => Date = () => new Date()) {}

  /**
   * Charges the buyer's operator-provisioned payment method for exactly the accepted offer total.
   * Safe to retry and to call concurrently: one order maps to one attempt and one idempotency key.
   */
  async settle(actor: ActorContext, order: Order, mandate: BuyerMandate): Promise<PaymentAttempt> {
    const offer = order.acceptedOffer;
    if (actor.role !== "buyer" || actor.participantId !== offer.buyerId) throw new PaymentRefusedError("not_order_buyer");
    if (order.agreementStatus !== "agreed") throw new PaymentRefusedError("order_not_agreed");

    const existing = await this.store.getAttempt(order.id);
    if (existing) return this.resume(existing);

    // The amount comes from the immutable accepted offer, never from a request body.
    const amount = offer.deliveredTotal;
    if (mandate.sandboxOnly !== true) throw new PaymentRefusedError("mandate_not_sandbox");
    if (!(Date.parse(mandate.expiresAt) > this.now().getTime())) throw new PaymentRefusedError("mandate_expired");
    if (amount.currency !== mandate.maximumOrderTotal.currency || amount.currency !== mandate.maximumRunTotal.currency) throw new PaymentRefusedError("currency_mismatch");
    if (amount.amountMinor > mandate.maximumOrderTotal.amountMinor) throw new PaymentRefusedError("order_total_exceeds_mandate");

    const credential = await this.store.getCredential(actor.participantId);
    if (!credential || credential.sandboxOnly !== true) throw new PaymentRefusedError("payment_credential_missing");

    const attempt: PaymentAttempt = {
      orderId: order.id,
      buyerId: offer.buyerId,
      supplierId: offer.supplierId,
      amount,
      idempotencyKey: `order:${order.id}:v1`,
      status: "creating",
      createdAt: this.now().toISOString(),
    };
    const claim = await this.store.claimAttempt(attempt, mandate.maximumRunTotal.amountMinor);
    if (!claim.claimed) {
      if (claim.reason === "run_total_exceeded") throw new PaymentRefusedError("run_total_exceeds_mandate");
      return this.resume(claim.existing);
    }
    return this.charge(attempt, credential);
  }

  /** Verifies, deduplicates, and applies a Stripe webhook. Returns the HTTP response Stripe receives. */
  async handleWebhook(request: Request, webhookSecret: string): Promise<Response> {
    if (request.method !== "POST") return Response.json({ error: "METHOD_NOT_ALLOWED" }, { status: 405, headers: { Allow: "POST" } });
    const rawBody = await request.text();
    const nowSeconds = Math.floor(this.now().getTime() / 1000);
    if (!(await verifyStripeSignature(rawBody, request.headers.get("Stripe-Signature"), webhookSecret, nowSeconds))) {
      return Response.json({ error: "INVALID_SIGNATURE" }, { status: 400 });
    }
    const event = parsePaymentEvent(rawBody);
    // Acknowledge verified events we do not act on so Stripe stops retrying them.
    if (!event) return Response.json({ received: true });
    return Response.json({ received: true, result: await this.applyEvent(event) });
  }

  async applyEvent(event: PaymentWebhookEvent): Promise<"applied" | "duplicate" | "ignored"> {
    if (await this.store.hasWebhookEvent(event.eventId)) return "duplicate";
    const result = await this.applyVerifiedOutcome(event);
    // Recorded after processing: a crash mid-way lets Stripe's retry finish the job, and transitions are idempotent.
    await this.store.recordWebhookEvent(event.eventId, event.type);
    return result;
  }

  private async applyVerifiedOutcome(event: PaymentWebhookEvent): Promise<"applied" | "ignored"> {
    for (let i = 0; i < 3; i++) {
      const attempt = await this.store.getAttempt(event.orderId);
      // Only PaymentIntents this service created for this order, for exactly the stored amount.
      if (!attempt) return "ignored";
      if (attempt.providerPaymentId && attempt.providerPaymentId !== event.paymentIntentId) return "ignored";
      if (attempt.amount.amountMinor !== event.amountMinor || attempt.amount.currency !== event.currency) return "ignored";
      const next = toUpdate(event.outcome);
      if (!canTransition(attempt.status, next.status)) return "ignored";
      if (await this.store.updateAttempt(attempt.orderId, attempt.status, { providerPaymentId: event.paymentIntentId, ...next })) {
        await this.store.emitPaymentUpdated({ ...attempt, ...next, providerPaymentId: event.paymentIntentId });
        return "applied";
      }
    }
    return "ignored";
  }

  private async resume(attempt: PaymentAttempt): Promise<PaymentAttempt> {
    if (attempt.status !== "creating") return attempt;
    // Another call is still talking to Stripe: report pending rather than racing it.
    if (this.now().getTime() - Date.parse(attempt.createdAt) < RESUME_AFTER_MS) return attempt;
    // A previous call crashed or timed out before recording Stripe's answer. The same idempotency key
    // makes Stripe return the original PaymentIntent instead of charging again.
    const credential = await this.store.getCredential(attempt.buyerId);
    if (!credential) throw new PaymentRefusedError("payment_credential_missing");
    return this.charge(attempt, credential);
  }

  private async charge(attempt: PaymentAttempt, credential: PaymentCredential): Promise<PaymentAttempt> {
    let outcome: PaymentOutcome;
    try {
      outcome = await this.provider.createPayment({
        orderId: attempt.orderId,
        amount: attempt.amount,
        customerRef: credential.stripeCustomerId,
        paymentMethodRef: credential.stripePaymentMethodId,
        idempotencyKey: attempt.idempotencyKey,
      });
    } catch (error) {
      throw new PaymentUnavailableError(error instanceof Error ? error.message : "payment provider unavailable");
    }
    const next = toUpdate(outcome);
    if (await this.store.updateAttempt(attempt.orderId, "creating", next)) {
      const updated = { ...attempt, ...next };
      await this.store.emitPaymentUpdated(updated);
      return updated;
    }
    // A webhook recorded the result first; it is authoritative.
    return (await this.store.getAttempt(attempt.orderId)) ?? attempt;
  }
}
