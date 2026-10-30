import { mapPaymentIntent } from "./stripe.js";
import type { PaymentOutcome } from "./types.js";

export const SIGNATURE_TOLERANCE_SECONDS = 300;

const HANDLED_EVENTS = new Set([
  "payment_intent.succeeded",
  "payment_intent.payment_failed",
  "payment_intent.requires_action",
  "payment_intent.processing",
]);

export interface PaymentWebhookEvent {
  eventId: string;
  type: string;
  orderId: string;
  paymentIntentId: string;
  amountMinor: number;
  currency: string;
  outcome: PaymentOutcome;
}

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> | undefined {
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) return undefined;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

/**
 * Verifies Stripe's `t=…,v1=…` signature over the raw body. HMAC verification through WebCrypto
 * is constant-time. Any v1 entry may match, which allows webhook secret rotation.
 */
export async function verifyStripeSignature(rawBody: string, header: string | null, secret: string, nowSeconds: number, toleranceSeconds = SIGNATURE_TOLERANCE_SECONDS): Promise<boolean> {
  if (!header) return false;
  let timestamp: number | undefined;
  const signatures: Uint8Array<ArrayBuffer>[] = [];
  for (const part of header.split(",")) {
    const separator = part.indexOf("=");
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (key === "t" && /^\d+$/.test(value)) timestamp = Number(value);
    if (key === "v1") {
      const bytes = hexToBytes(value);
      if (bytes) signatures.push(bytes);
    }
  }
  if (timestamp === undefined || signatures.length === 0) return false;
  if (Math.abs(nowSeconds - timestamp) > toleranceSeconds) return false;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const payload = encoder.encode(`${timestamp}.${rawBody}`);
  for (const signature of signatures) {
    if (await crypto.subtle.verify("HMAC", key, signature, payload)) return true;
  }
  return false;
}

/** Parses a verified event body. Returns undefined for event types or shapes this flow does not act on. */
export function parsePaymentEvent(rawBody: string): PaymentWebhookEvent | undefined {
  let event: unknown;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return undefined;
  }
  if (typeof event !== "object" || event === null) return undefined;
  const { id, type, data } = event as { id?: unknown; type?: unknown; data?: { object?: unknown } };
  if (typeof id !== "string" || typeof type !== "string" || !HANDLED_EVENTS.has(type)) return undefined;
  const intent = data?.object as { id?: unknown; object?: unknown; status?: unknown; amount?: unknown; currency?: unknown; metadata?: { order_id?: unknown }; last_payment_error?: { code?: string; decline_code?: string } | null } | undefined;
  if (!intent || intent.object !== "payment_intent" || typeof intent.id !== "string" || typeof intent.status !== "string") return undefined;
  if (typeof intent.amount !== "number" || typeof intent.currency !== "string" || typeof intent.metadata?.order_id !== "string") return undefined;
  return {
    eventId: id,
    type,
    orderId: intent.metadata.order_id,
    paymentIntentId: intent.id,
    amountMinor: intent.amount,
    currency: intent.currency.toUpperCase(),
    outcome: mapPaymentIntent({ id: intent.id, object: "payment_intent", status: intent.status, last_payment_error: intent.last_payment_error ?? null }),
  };
}
