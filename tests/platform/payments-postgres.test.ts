import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import type { ActorContext, BuyerMandate, Order } from "../../src/contracts.js";
import { handleRequest } from "../../src/index.js";
import { PostgresPaymentStore, type Queryable } from "../../src/payments/postgres-store.js";
import { PaymentRefusedError, SettlementService } from "../../src/payments/settlement.js";
import type { PaymentAttemptInput, PaymentOutcome, PaymentProvider } from "../../src/payments/types.js";
import { databaseSsl } from "../../src/server.js";
import { MAX_BODY_BYTES, toNodeListener } from "../../src/server-adapter.js";

// Disposable in-process Postgres (PGlite) with the real migration. No network, no shared database.
const MIGRATION = readFileSync(new URL("../../../supabase/migrations/20261030120000_initial_schema.sql", import.meta.url), "utf8");
const WEBHOOK_SECRET = "whsec_disposableFixtureSecret";
const db = new PGlite();
let fixture = 0;

before(async () => {
  await db.exec("create role anon nologin; create role authenticated nologin;");
  await db.exec(MIGRATION);
});
after(async () => { await db.close(); });

/** Test double. Like Stripe, every order gets its own PaymentIntent id: pi_<orderId>. */
class FakeProvider implements PaymentProvider {
  readonly sandboxOnly = true as const;
  calls: PaymentAttemptInput[] = [];
  constructor(public outcome: PaymentOutcome) {}
  async createPayment(input: PaymentAttemptInput): Promise<PaymentOutcome> {
    this.calls.push(input);
    return this.outcome.providerPaymentId ? { ...this.outcome, providerPaymentId: `pi_${input.orderId}` } : this.outcome;
  }
}

/** Seeds a buyer, supplier, and one fully accepted order as the operator, then acts as the backend role. */
async function seed(options: { runMax?: number; orders?: number; amount?: number } = {}) {
  const n = ++fixture;
  const [buyerId, supplierId] = [`buyer-${n}`, `supplier-${n}`];
  const amount = options.amount ?? 420_000;
  await db.exec("reset role");
  await db.query(`insert into marketplace.operator_grants (id, role, currency, expires_at, allowed_categories, max_order_total_minor, max_run_total_minor, created_by)
                  values ($1,'buyer','EUR','2099-01-02Z','{furniture}',500000,$2,'op')`, [`g-${buyerId}`, options.runMax ?? 800_000]);
  await db.query(`insert into marketplace.operator_grants (id, role, currency, expires_at, min_delivered_total_minor, max_available_quantity, created_by)
                  values ($1,'supplier','EUR','2099-01-02Z',1,1000,'op')`, [`g-${supplierId}`]);
  await db.query(`insert into marketplace.participants (id, grant_id, role) values ($1,$2,'buyer'), ($3,$4,'supplier')`, [buyerId, `g-${buyerId}`, supplierId, `g-${supplierId}`]);
  await db.query(`insert into marketplace.mandates (participant_id, role, currency, expires_at, max_order_total_minor, max_run_total_minor, allowed_categories, destination)
                  values ($1,'buyer','EUR','2099-01-01Z',500000,$2,'{furniture}','Warsaw, PL')`, [buyerId, options.runMax ?? 800_000]);
  await db.query(`insert into marketplace.mandates (participant_id, role, currency, expires_at, min_delivered_total_minor, available_quantity, unit, earliest_delivery_at)
                  values ($1,'supplier','EUR','2099-01-01Z',1,1000,'pcs','2026-11-15Z')`, [supplierId]);
  await db.query(`insert into marketplace.payment_credentials (participant_id, stripe_customer_id, stripe_payment_method_id) values ($1,'cus_fixture','pm_fixture')`, [buyerId]);
  const orders: Order[] = [];
  for (let i = 1; i <= (options.orders ?? 1); i++) {
    const [requestId, offerId, orderId] = [`r-${n}-${i}`, `o-${n}-${i}`, `ord-${n}-${i}`];
    await db.query(`insert into marketplace.sourcing_requests (id, buyer_id, category, description, quantity, unit, destination, max_delivered_total_minor, currency, deliver_by)
                    values ($1,$2,'furniture','chairs',100,'pcs','Warsaw, PL',500000,'EUR','2099-01-01Z')`, [requestId, buyerId]);
    await db.query(`insert into marketplace.offers (id, request_id, buyer_id, supplier_id, revision, created_by, quantity, unit, destination, delivered_total_minor, currency, tax_minor, delivery_minor, delivery_at, expires_at)
                    values ($1,$2,$3,$4,1,$4,100,'pcs','Warsaw, PL',$5,'EUR',0,0,'2098-12-01Z','2099-01-01Z')`, [offerId, requestId, buyerId, supplierId, amount]);
    await db.query(`insert into marketplace.offer_acceptances (offer_id, participant_id) values ($1,$2), ($1,$3)`, [offerId, buyerId, supplierId]);
    await db.query(`insert into marketplace.orders (id, offer_id, request_id, buyer_id, supplier_id) values ($1,$2,$3,$4,$5)`, [orderId, offerId, requestId, buyerId, supplierId]);
    orders.push({
      id: orderId, agreementStatus: "agreed", paymentStatus: "not_started", demo: true,
      acceptedOffer: {
        id: offerId, requestId, buyerId, supplierId, quantity: 100, unit: "pcs", destination: "Warsaw, PL",
        deliveredTotal: { amountMinor: amount, currency: "EUR" }, taxMinor: 0, deliveryMinor: 0,
        deliveryAt: "2098-12-01T00:00:00Z", expiresAt: "2099-01-01T00:00:00Z",
        confirmedRequirementKeys: [], termsOrigin: "demo-supplier-declaration", demo: true,
      },
    });
  }
  // Everything after seeding runs with the backend's privileges, as in production.
  await db.exec("set role marketplace_app");
  const buyer: ActorContext = { participantId: buyerId, role: "buyer", demo: true };
  const mandate: BuyerMandate = {
    maximumOrderTotal: { amountMinor: 500_000, currency: "EUR" }, maximumRunTotal: { amountMinor: options.runMax ?? 800_000, currency: "EUR" },
    allowedCategories: ["furniture"], destination: "Warsaw, PL", expiresAt: "2099-01-01T00:00:00Z", sandboxOnly: true,
  };
  return { buyer, mandate, orders, order: orders[0]! };
}

const owner = async <T>(sql: string, params?: unknown[]) => {
  await db.exec("reset role");
  try { return (await db.query<T>(sql, params)).rows; } finally { await db.exec("set role marketplace_app"); }
};

async function sign(body: string, timestamp = Math.floor(Date.now() / 1000), secret = WEBHOOK_SECRET) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${body}`));
  return `t=${timestamp},v1=${Buffer.from(mac).toString("hex")}`;
}

function intentEvent(eventId: string, orderId: string, status: string, amount = 420_000) {
  // Pretty-printed with non-ASCII text, like real Stripe payloads: any re-encoding breaks the signature.
  return JSON.stringify({
    id: eventId, type: "payment_intent.succeeded",
    data: { object: { id: `pi_${orderId}`, object: "payment_intent", status, amount, currency: "eur", description: "Zamówienie demo – krzesła", metadata: { order_id: orderId, demo: "true" } } },
  }, null, 2);
}

async function listen(handler: (request: Request) => Promise<Response>, log?: (m: string) => void): Promise<{ url: string; server: Server }> {
  const server = createServer(toNodeListener(handler, log));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server };
}

const post = (url: string, body: string, signature?: string) =>
  fetch(`${url}/webhooks/stripe`, { method: "POST", headers: { "Content-Type": "application/json", ...(signature ? { "Stripe-Signature": signature } : {}) }, body });

// ---- store ----

test("Postgres store: settle records one attempt with a numeric amount and one event per party", async () => {
  const { buyer, mandate, order } = await seed();
  const store = new PostgresPaymentStore(db as unknown as Queryable);
  const provider = new FakeProvider({ status: "succeeded", providerPaymentId: "pi_fixture_1" });
  const attempt = await new SettlementService(store, provider).settle(buyer, order, mandate);
  assert.equal(attempt.status, "succeeded");
  const stored = await store.getAttempt(order.id);
  assert.equal(typeof stored?.amount.amountMinor, "number", "bigint must come back as a number");
  assert.deepEqual(stored?.amount, { amountMinor: 420_000, currency: "EUR" });
  assert.equal(stored?.providerPaymentId, `pi_${order.id}`);
  assert.equal(provider.calls.length, 1);
  const events = await owner<{ participant_id: string }>("select participant_id from marketplace.participant_events where resource_id = $1 order by participant_id", [order.id]);
  assert.deepEqual(events.map((e) => e.participant_id), [order.acceptedOffer.buyerId, order.acceptedOffer.supplierId].sort());
  // A retry is answered from the database without another provider call.
  assert.equal((await new SettlementService(store, provider).settle(buyer, order, mandate)).status, "succeeded");
  assert.equal(provider.calls.length, 1);
});

test("Postgres store: the database refuses a second order past the buyer run total", async () => {
  const { buyer, mandate, orders } = await seed({ runMax: 800_000, orders: 2 });
  const service = new SettlementService(new PostgresPaymentStore(db as unknown as Queryable), new FakeProvider({ status: "succeeded", providerPaymentId: "pi_fixture_1" }));
  await service.settle(buyer, orders[0]!, mandate);
  await assert.rejects(service.settle(buyer, orders[1]!, mandate), (e: unknown) => e instanceof PaymentRefusedError && e.code === "run_total_exceeds_mandate");
});

test("Postgres store: a declined payment is stored with its failure code", async () => {
  const { buyer, mandate, order } = await seed();
  const store = new PostgresPaymentStore(db as unknown as Queryable);
  await new SettlementService(store, new FakeProvider({ status: "failed", providerPaymentId: "pi_declined", code: "generic_decline" })).settle(buyer, order, mandate);
  const stored = await store.getAttempt(order.id);
  assert.equal(stored?.status, "failed");
  assert.equal(stored?.failureCode, "generic_decline");
});

test("Postgres store: bigint amounts from node-postgres arrive as strings and are converted", async () => {
  // node-postgres returns int8 as a string; PGlite returns a number, so this case needs its own stub.
  const row = { order_id: "o", buyer_id: "b", supplier_id: "s", amount_minor: "420000", currency: "EUR", idempotency_key: "k", status: "pending", provider_payment_id: "pi_1", failure_code: null, created_at: "2026-10-30T12:00:00Z" };
  const store = new PostgresPaymentStore({ query: async () => ({ rows: [row] as never[] }) });
  const attempt = await store.getAttempt("o");
  assert.equal(attempt?.amount.amountMinor, 420_000);
  assert.equal(typeof attempt?.amount.amountMinor, "number");
  const unsafe = new PostgresPaymentStore({ query: async () => ({ rows: [{ ...row, amount_minor: "9007199254740993" }] as never[] }) });
  await assert.rejects(unsafe.getAttempt("o"), RangeError);
});

test("Postgres store: an update only applies while the status is still the expected one", async () => {
  const { buyer, mandate, order } = await seed();
  const store = new PostgresPaymentStore(db as unknown as Queryable);
  await new SettlementService(store, new FakeProvider({ status: "pending", providerPaymentId: "pi_fixture_1" })).settle(buyer, order, mandate);
  // A stale writer that still believes the attempt is "creating" must not overwrite "pending".
  assert.equal(await store.updateAttempt(order.id, "creating", { status: "failed", failureCode: "stale_writer" }), false);
  assert.equal((await store.getAttempt(order.id))?.status, "pending");
  assert.equal(await store.updateAttempt(order.id, "pending", { status: "succeeded", providerPaymentId: `pi_${order.id}` }), true);
});

// ---- webhook route over real HTTP ----

test("webhook over HTTP: a signed event moves a pending payment to succeeded, once", async () => {
  const { buyer, mandate, order } = await seed();
  const store = new PostgresPaymentStore(db as unknown as Queryable);
  const settlement = new SettlementService(store, new FakeProvider({ status: "pending", providerPaymentId: "pi_fixture_1" }));
  assert.equal((await settlement.settle(buyer, order, mandate)).status, "pending");
  const { url, server } = await listen((request) => handleRequest(request, { stripeWebhook: { settlement, secret: WEBHOOK_SECRET } }));
  try {
    const body = intentEvent(`evt_ok_${order.id}`, order.id, "succeeded");
    const first = await post(url, body, await sign(body));
    assert.equal(first.status, 200);
    assert.deepEqual(await first.json(), { received: true, result: "applied" });
    const again = await post(url, body, await sign(body));
    assert.deepEqual(await again.json(), { received: true, result: "duplicate" });
    assert.equal((await store.getAttempt(order.id))?.status, "succeeded");
    assert.equal(await store.hasWebhookEvent(`evt_ok_${order.id}`), true);
    const events = await owner<{ n: number }>("select count(*)::int as n from marketplace.participant_events where resource_id = $1 and dedup_key like '%:succeeded:%'", [order.id]);
    assert.equal(events[0]?.n, 2, "one succeeded event each for buyer and supplier");
  } finally { server.close(); }
});

test("webhook over HTTP: an invalid signature is rejected and nothing is recorded", async () => {
  const { buyer, mandate, order } = await seed();
  const store = new PostgresPaymentStore(db as unknown as Queryable);
  const settlement = new SettlementService(store, new FakeProvider({ status: "pending", providerPaymentId: "pi_fixture_1" }));
  await settlement.settle(buyer, order, mandate);
  const { url, server } = await listen((request) => handleRequest(request, { stripeWebhook: { settlement, secret: WEBHOOK_SECRET } }));
  try {
    const body = intentEvent(`evt_forged_${order.id}`, order.id, "succeeded");
    assert.equal((await post(url, body, await sign(body, undefined, "whsec_attacker"))).status, 400);
    assert.equal((await post(url, body)).status, 400);
    assert.equal((await store.getAttempt(order.id))?.status, "pending");
    assert.equal(await store.hasWebhookEvent(`evt_forged_${order.id}`), false);
  } finally { server.close(); }
});

test("webhook over HTTP: a database failure returns 500 so Stripe retries, without recording the event", async () => {
  const { buyer, mandate, order } = await seed();
  const real = new PostgresPaymentStore(db as unknown as Queryable);
  await new SettlementService(real, new FakeProvider({ status: "pending", providerPaymentId: "pi_fixture_1" })).settle(buyer, order, mandate);
  const broken = new PostgresPaymentStore(db as unknown as Queryable);
  broken.updateAttempt = async () => { throw new Error("connection terminated unexpectedly"); };
  const settlement = new SettlementService(broken, new FakeProvider({ status: "pending", providerPaymentId: "pi_fixture_1" }));
  const logged: string[] = [];
  const { url, server } = await listen((request) => handleRequest(request, { stripeWebhook: { settlement, secret: WEBHOOK_SECRET } }), (m) => logged.push(m));
  try {
    const body = intentEvent(`evt_retry_${order.id}`, order.id, "succeeded");
    const response = await post(url, body, await sign(body));
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: "INTERNAL" });
    assert.equal(await real.hasWebhookEvent(`evt_retry_${order.id}`), false, "Stripe's retry must be able to apply it");
    assert.match(logged.join("\n"), /connection terminated/);
  } finally { server.close(); }
});

test("webhook over HTTP: oversized bodies are refused before parsing", async () => {
  const { url, server } = await listen(async () => { throw new Error("handler must not run"); });
  try {
    const response = await fetch(`${url}/webhooks/stripe`, { method: "POST", body: "x".repeat(MAX_BODY_BYTES + 1) });
    assert.equal(response.status, 413);
  } finally { server.close(); }
});

test("webhook over HTTP: a streamed body with no declared length is also capped", async () => {
  const { url, server } = await listen(async () => { throw new Error("handler must not run"); });
  try {
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(`${url}/webhooks/stripe`, { method: "POST", headers: { "Transfer-Encoding": "chunked" } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
      req.on("error", (error: NodeJS.ErrnoException) => (error.code === "ECONNRESET" || error.code === "EPIPE" ? resolve(-1) : reject(error)));
      const chunk = "x".repeat(64 * 1024);
      for (let sent = 0; sent <= MAX_BODY_BYTES; sent += chunk.length) req.write(chunk);
      req.end();
    });
    assert.ok(status === 413 || status === -1, `expected 413 or a closed connection, got ${status}`);
  } finally { server.close(); }
});

test("webhook stays 501 when the server has no webhook secret configured", async () => {
  const response = await handleRequest(new Request("https://example.test/webhooks/stripe", { method: "POST", body: "{}" }));
  assert.equal(response.status, 501);
});

// ---- database TLS configuration ----

test("database TLS is verified unless explicitly disabled for localhost", () => {
  assert.equal(databaseSsl({}, "postgresql://u:p@db.example.com:5432/postgres"), true);
  assert.throws(() => databaseSsl({ DB_SSL: "disable" }, "postgresql://u:p@db.example.com:5432/postgres"), /only allowed for a database on localhost/);
  assert.equal(databaseSsl({ DB_SSL: "disable" }, "postgresql://u:p@127.0.0.1:55432/postgres"), false);
  assert.throws(() => databaseSsl({}, "postgresql://u:p@db.example.com:5432/postgres?sslmode=no-verify"), /remove sslmode/);
});
