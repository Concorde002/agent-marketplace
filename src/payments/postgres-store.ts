import type { OrderId, ParticipantId } from "../contracts.js";
import type { AttemptUpdate, PaymentStore } from "./settlement.js";
import type { PaymentAttempt, PaymentCredential, PaymentStatus } from "./types.js";

/** The subset of a pg Pool/Client (or PGlite) this store needs. */
export interface Queryable {
  query<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: R[] }>;
}

interface AttemptRow {
  order_id: string;
  buyer_id: string;
  supplier_id: string;
  amount_minor: string | number;
  currency: string;
  idempotency_key: string;
  status: PaymentStatus;
  provider_payment_id: string | null;
  failure_code: string | null;
  created_at: Date | string;
}

/** node-postgres returns bigint as a string; comparing that with Stripe's numeric amount would never match. */
function toMinor(value: string | number): number {
  const amount = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(amount)) throw new RangeError(`amount ${value} is not a safe integer`);
  return amount;
}

function toAttempt(row: AttemptRow): PaymentAttempt {
  const attempt: PaymentAttempt = {
    orderId: row.order_id,
    buyerId: row.buyer_id,
    supplierId: row.supplier_id,
    amount: { amountMinor: toMinor(row.amount_minor), currency: row.currency },
    idempotencyKey: row.idempotency_key,
    status: row.status,
    createdAt: new Date(row.created_at).toISOString(),
  };
  if (row.provider_payment_id) attempt.providerPaymentId = row.provider_payment_id;
  if (row.failure_code) attempt.failureCode = row.failure_code;
  return attempt;
}

const ATTEMPT_COLUMNS = "order_id, buyer_id, supplier_id, amount_minor, currency, idempotency_key, status, provider_payment_id, failure_code, created_at";

/**
 * PaymentStore over supabase/migrations/20261030120000_initial_schema.sql. Connect as a login role in
 * `marketplace_app`; the database, not this class, enforces one attempt per order and the run total.
 */
export class PostgresPaymentStore implements PaymentStore {
  constructor(private readonly db: Queryable) {}

  async getCredential(participantId: ParticipantId): Promise<PaymentCredential | undefined> {
    const { rows } = await this.db.query<{ participant_id: string; stripe_customer_id: string; stripe_payment_method_id: string }>(
      "select participant_id, stripe_customer_id, stripe_payment_method_id from marketplace.payment_credentials where participant_id = $1",
      [participantId],
    );
    const row = rows[0];
    return row && { participantId: row.participant_id, stripeCustomerId: row.stripe_customer_id, stripePaymentMethodId: row.stripe_payment_method_id, sandboxOnly: true };
  }

  async claimAttempt(attempt: PaymentAttempt, maxCommittedMinor: number) {
    // The function takes the amount from the accepted offer itself and locks the buyer's mandate row.
    const { rows } = await this.db.query<{ outcome: "claimed" | "exists" | "run_total_exceeded" }>(
      "select marketplace.claim_payment_attempt($1, $2, $3) as outcome",
      [attempt.orderId, attempt.idempotencyKey, maxCommittedMinor],
    );
    const outcome = rows[0]?.outcome;
    if (outcome === "claimed") return { claimed: true as const };
    if (outcome === "run_total_exceeded") return { claimed: false as const, reason: "run_total_exceeded" as const };
    const existing = await this.getAttempt(attempt.orderId);
    if (outcome !== "exists" || !existing) throw new Error(`unexpected claim outcome ${String(outcome)} for order ${attempt.orderId}`);
    return { claimed: false as const, reason: "exists" as const, existing };
  }

  async getAttempt(orderId: OrderId): Promise<PaymentAttempt | undefined> {
    const { rows } = await this.db.query<AttemptRow>(`select ${ATTEMPT_COLUMNS} from marketplace.payment_attempts where order_id = $1`, [orderId]);
    return rows[0] && toAttempt(rows[0]);
  }

  async updateAttempt(orderId: OrderId, expected: PaymentStatus, next: AttemptUpdate): Promise<boolean> {
    const { rows } = await this.db.query(
      `update marketplace.payment_attempts
          set status = $3, provider_payment_id = coalesce($4, provider_payment_id), failure_code = $5
        where order_id = $1 and status = $2
        returning order_id`,
      [orderId, expected, next.status, next.providerPaymentId ?? null, next.failureCode ?? null],
    );
    return rows.length === 1;
  }

  async hasWebhookEvent(eventId: string): Promise<boolean> {
    const { rows } = await this.db.query("select 1 from marketplace.webhook_events where stripe_event_id = $1", [eventId]);
    return rows.length > 0;
  }

  async recordWebhookEvent(eventId: string, type: string): Promise<void> {
    await this.db.query("insert into marketplace.webhook_events (stripe_event_id, type) values ($1, $2) on conflict (stripe_event_id) do nothing", [eventId, type]);
  }

  async emitPaymentUpdated(attempt: PaymentAttempt): Promise<void> {
    await this.db.query(
      `select marketplace.emit_participant_events(array[o.buyer_id, o.supplier_id], 'payment_updated', o.request_id, o.id, $2)
         from marketplace.orders o where o.id = $1`,
      [attempt.orderId, `payment_updated:${attempt.orderId}:${attempt.status}`],
    );
  }
}
