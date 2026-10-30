import type { StripeConfig } from "./config.js";
import type { PaymentAttemptInput, PaymentOutcome, PaymentProvider } from "./types.js";

const API_BASE = "https://api.stripe.com/v1";

type Params = Record<string, string | number | boolean>;
type Fetch = (input: string, init: RequestInit) => Promise<Response>;

interface StripePaymentIntent {
  id: string;
  object: "payment_intent";
  status: string;
  last_payment_error?: { code?: string; decline_code?: string } | null;
}

interface StripeErrorBody {
  error?: { type?: string; code?: string; decline_code?: string; message?: string; payment_intent?: StripePaymentIntent };
}

/** A Stripe call whose commercial effect is unknown (network, auth, rate limit, 5xx). Retry with the same idempotency key. */
export class StripeApiError extends Error {
  constructor(message: string, readonly httpStatus: number | undefined, readonly stripeCode: string | undefined) {
    super(message);
  }
}

/** Defence in depth: Stripe masks keys in errors, but nothing key-shaped may leave this module. */
export function redactSecrets(text: string): string {
  return text.replace(/\b(sk|rk|whsec)_(test|live)?_?[A-Za-z0-9*]+/g, "[redacted]");
}

/** Minimal form-encoded Stripe REST client. Only the calls this MVP needs; no SDK dependency. */
export class StripeClient {
  readonly #secretKey: string;
  readonly #fetch: Fetch;

  constructor(config: StripeConfig, fetchImpl: Fetch = (input, init) => fetch(input, init)) {
    this.#secretKey = config.secretKey;
    this.#fetch = fetchImpl;
  }

  /** Returns the parsed body for 2xx, or the raw error body for card errors (402) so callers can map declines. */
  async post<T>(path: string, params: Params, idempotencyKey?: string): Promise<{ ok: true; body: T } | { ok: false; status: number; body: StripeErrorBody }> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.#secretKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
    };
    if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
    let response: Response;
    try {
      response = await this.#fetch(`${API_BASE}${path}`, { method: "POST", headers, body: new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString() });
    } catch (error) {
      throw new StripeApiError(`Stripe request failed: ${redactSecrets(error instanceof Error ? error.message : String(error))}`, undefined, undefined);
    }
    const body = await response.json().catch(() => ({})) as T & StripeErrorBody;
    if (response.ok) return { ok: true, body };
    if (response.status === 402) return { ok: false, status: 402, body };
    const code = body.error?.code ?? body.error?.type;
    throw new StripeApiError(`Stripe ${path} returned HTTP ${response.status}${code ? ` (${code})` : ""}: ${redactSecrets(body.error?.message ?? "no message")}`, response.status, code);
  }

  async postOk<T>(path: string, params: Params, idempotencyKey?: string): Promise<T> {
    const result = await this.post<T>(path, params, idempotencyKey);
    if (result.ok) return result.body;
    const error = result.body.error;
    throw new StripeApiError(`Stripe ${path} declined: ${error?.decline_code ?? error?.code ?? "unknown"}`, result.status, error?.code);
  }
}

export function mapPaymentIntent(intent: StripePaymentIntent): PaymentOutcome {
  switch (intent.status) {
    case "succeeded": return { status: "succeeded", providerPaymentId: intent.id };
    case "processing": return { status: "pending", providerPaymentId: intent.id };
    case "requires_action": return { status: "requires_action", providerPaymentId: intent.id };
    case "requires_payment_method": {
      const error = intent.last_payment_error;
      return { status: "failed", providerPaymentId: intent.id, code: error?.decline_code ?? error?.code ?? "requires_payment_method" };
    }
    default:
      // Manual capture, cancellation, or unconfirmed intents are not part of this flow; never report them as paid.
      return { status: "failed", providerPaymentId: intent.id, code: `unexpected_status_${intent.status}` };
  }
}

export function toStripeAmount(amountMinor: number, currency: string): { amount: number; currency: string } {
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) throw new RangeError("amount must be a positive integer in minor units");
  if (!/^[A-Z]{3}$/.test(currency)) throw new RangeError("currency must be an uppercase ISO 4217 code");
  return { amount: amountMinor, currency: currency.toLowerCase() };
}

/** Off-session charge of an operator-provisioned saved payment method. One PaymentIntent per idempotency key. */
export class StripeSandboxProvider implements PaymentProvider {
  readonly sandboxOnly = true as const;

  constructor(private readonly client: StripeClient) {}

  async createPayment(input: PaymentAttemptInput): Promise<PaymentOutcome> {
    const { amount, currency } = toStripeAmount(input.amount.amountMinor, input.amount.currency);
    const result = await this.client.post<StripePaymentIntent>("/payment_intents", {
      amount,
      currency,
      customer: input.customerRef,
      payment_method: input.paymentMethodRef,
      // Card only: avoids redirect-based methods that would need a customer-facing return_url.
      "payment_method_types[]": "card",
      off_session: true,
      confirm: true,
      description: `Agent Marketplace demo order ${input.orderId} (sandbox, no real funds)`,
      "metadata[order_id]": input.orderId,
      "metadata[demo]": "true",
    }, input.idempotencyKey);
    if (result.ok) return mapPaymentIntent(result.body);

    const error = result.body.error;
    const intent = error?.payment_intent;
    // Off-session SCA: the bank wants the cardholder present. Stop; never try to bypass authentication.
    if (error?.code === "authentication_required" || error?.decline_code === "authentication_required" || intent?.status === "requires_action") {
      if (intent) return { status: "requires_action", providerPaymentId: intent.id };
      return { status: "failed", code: "authentication_required" };
    }
    const code = error?.decline_code ?? error?.code ?? "card_declined";
    return intent ? { status: "failed", providerPaymentId: intent.id, code } : { status: "failed", code };
  }
}
