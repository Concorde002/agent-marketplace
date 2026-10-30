import assert from "node:assert/strict";
import { test } from "node:test";
import type { ActorContext, BuyerMandate, Order } from "../../src/contracts.js";
import { PaymentConfigError, readStripeConfig } from "../../src/payments/config.js";
import { PaymentRefusedError, PaymentUnavailableError, RESUME_AFTER_MS, SettlementService, withPayment, type AttemptUpdate, type PaymentStore } from "../../src/payments/settlement.js";
import { StripeApiError, StripeClient, StripeSandboxProvider } from "../../src/payments/stripe.js";
import type { PaymentAttempt, PaymentAttemptInput, PaymentCredential, PaymentOutcome, PaymentProvider, PaymentStatus } from "../../src/payments/types.js";
import { verifyStripeSignature } from "../../src/payments/webhook.js";

// ---- disposable test doubles; never production providers ----

const TEST_KEY = "sk_test_disposableFixtureKey123";
const WEBHOOK_SECRET = "whsec_disposableFixtureSecret";
const NOW = new Date("2026-10-30T12:00:00Z");

class MemoryStore implements PaymentStore {
  credentials = new Map<string, PaymentCredential>();
  attempts = new Map<string, PaymentAttempt>();
  webhookEvents = new Set<string>();
  emitted: { orderId: string; status: PaymentStatus }[] = [];

  async getCredential(participantId: string) { return this.credentials.get(participantId); }
  async claimAttempt(attempt: PaymentAttempt, maxCommittedMinor: number) {
    // No await between check and write: atomic, like a single guarded INSERT.
    const existing = this.attempts.get(attempt.orderId);
    if (existing) return { claimed: false as const, reason: "exists" as const, existing };
    const committed = [...this.attempts.values()]
      .filter((a) => a.buyerId === attempt.buyerId && a.amount.currency === attempt.amount.currency && a.status !== "failed")
      .reduce((sum, a) => sum + a.amount.amountMinor, 0);
    if (committed + attempt.amount.amountMinor > maxCommittedMinor) return { claimed: false as const, reason: "run_total_exceeded" as const };
    this.attempts.set(attempt.orderId, { ...attempt });
    return { claimed: true as const };
  }
  async getAttempt(orderId: string) { const a = this.attempts.get(orderId); return a && { ...a }; }
  async updateAttempt(orderId: string, expected: PaymentStatus, next: AttemptUpdate) {
    const current = this.attempts.get(orderId);
    if (!current || current.status !== expected) return false;
    this.attempts.set(orderId, { ...current, ...next });
    return true;
  }
  async hasWebhookEvent(eventId: string) { return this.webhookEvents.has(eventId); }
  async recordWebhookEvent(eventId: string) { this.webhookEvents.add(eventId); }
  async emitPaymentUpdated(attempt: PaymentAttempt) {
    if (!this.emitted.some((e) => e.orderId === attempt.orderId && e.status === attempt.status)) this.emitted.push({ orderId: attempt.orderId, status: attempt.status });
  }
}

/** Mimics Stripe idempotency: one outcome per key, however often it is called. */
class FakeProvider implements PaymentProvider {
  readonly sandboxOnly = true as const;
  calls: PaymentAttemptInput[] = [];
  byKey = new Map<string, PaymentOutcome>();
  failNext = false;
  constructor(public outcome: PaymentOutcome = { status: "succeeded", providerPaymentId: "pi_fixture_1" }) {}
  async createPayment(input: PaymentAttemptInput) {
    this.calls.push(input);
    await new Promise((resolve) => setTimeout(resolve, 5));
    if (this.failNext) { this.failNext = false; throw new StripeApiError("Stripe request failed: network", undefined, undefined); }
    const known = this.byKey.get(input.idempotencyKey);
    if (known) return known;
    this.byKey.set(input.idempotencyKey, this.outcome);
    return this.outcome;
  }
  get uniqueCharges() { return this.byKey.size; }
}

const buyer: ActorContext = { participantId: "buyer-1", role: "buyer", demo: true };
const supplier: ActorContext = { participantId: "supplier-1", role: "supplier", demo: true };

function makeOrder(id = "order-1", amountMinor = 420_000): Order {
  return {
    id,
    agreementStatus: "agreed",
    paymentStatus: "not_started",
    demo: true,
    acceptedOffer: {
      id: `offer-${id}`, requestId: "request-1", buyerId: "buyer-1", supplierId: "supplier-1",
      quantity: 100, unit: "pcs", destination: "Warsaw, PL",
      deliveredTotal: { amountMinor, currency: "EUR" }, taxMinor: 0, deliveryMinor: 0,
      deliveryAt: "2026-11-20T12:00:00Z", expiresAt: "2026-11-01T12:00:00Z",
      confirmedRequirementKeys: [], termsOrigin: "demo-supplier-declaration", demo: true,
    },
  };
}

const mandate: BuyerMandate = {
  maximumOrderTotal: { amountMinor: 500_000, currency: "EUR" },
  maximumRunTotal: { amountMinor: 800_000, currency: "EUR" },
  allowedCategories: ["furniture"], destination: "Warsaw, PL",
  expiresAt: "2026-11-01T00:00:00Z", sandboxOnly: true,
};

function setup(outcome?: PaymentOutcome) {
  const store = new MemoryStore();
  store.credentials.set("buyer-1", { participantId: "buyer-1", stripeCustomerId: "cus_fixture", stripePaymentMethodId: "pm_fixture", sandboxOnly: true });
  const provider = new FakeProvider(outcome);
  const clock = { now: NOW };
  return { store, provider, clock, service: new SettlementService(store, provider, () => clock.now) };
}

async function sign(body: string, timestamp: number, secret = WEBHOOK_SECRET) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${body}`));
  return `t=${timestamp},v1=${Buffer.from(mac).toString("hex")}`;
}

function intentEvent(eventId: string, type: string, status: string, overrides: { pi?: string; orderId?: string; amount?: number; currency?: string; lastError?: { code?: string; decline_code?: string } } = {}) {
  return JSON.stringify({
    id: eventId, type,
    data: { object: { id: overrides.pi ?? "pi_fixture_1", object: "payment_intent", status, amount: overrides.amount ?? 420_000, currency: overrides.currency ?? "eur", metadata: { order_id: overrides.orderId ?? "order-1", demo: "true" }, last_payment_error: overrides.lastError ?? null } },
  });
}

async function webhook(service: SettlementService, body: string, signature?: string) {
  const headers = new Headers();
  headers.set("Stripe-Signature", signature ?? await sign(body, Math.floor(NOW.getTime() / 1000)));
  return service.handleWebhook(new Request("https://example.test/webhooks/stripe", { method: "POST", headers, body }), WEBHOOK_SECRET);
}

// ---- configuration ----

test("config accepts sandbox keys and refuses live or missing keys", () => {
  assert.equal(readStripeConfig({ STRIPE_SECRET_KEY: TEST_KEY }).secretKey, TEST_KEY);
  assert.equal(readStripeConfig({ STRIPE_SECRET_KEY: "rk_test_restricted1" }).secretKey, "rk_test_restricted1");
  assert.throws(() => readStripeConfig({ STRIPE_SECRET_KEY: "sk_live_realmoney1" }), PaymentConfigError);
  assert.throws(() => readStripeConfig({}), PaymentConfigError);
  assert.throws(() => readStripeConfig({ STRIPE_SECRET_KEY: TEST_KEY, STRIPE_WEBHOOK_SECRET: "nope" }), PaymentConfigError);
  assert.throws(() => readStripeConfig({ STRIPE_SECRET_KEY: TEST_KEY }, { requireWebhookSecret: true }), PaymentConfigError);
});

// ---- Stripe provider, against a recorded fetch ----

function stripeWith(status: number, body: unknown) {
  const requests: { url: string; init: RequestInit }[] = [];
  const client = new StripeClient({ secretKey: TEST_KEY }, async (url, init) => {
    requests.push({ url, init });
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  });
  return { requests, provider: new StripeSandboxProvider(client) };
}

const chargeInput: PaymentAttemptInput = { orderId: "order-1", amount: { amountMinor: 420_000, currency: "EUR" }, customerRef: "cus_fixture", paymentMethodRef: "pm_fixture", idempotencyKey: "order:order-1:v1" };

test("provider sends one confirmed off-session card PaymentIntent with an idempotency key", async () => {
  const { requests, provider } = stripeWith(200, { id: "pi_1", object: "payment_intent", status: "succeeded" });
  assert.deepEqual(await provider.createPayment(chargeInput), { status: "succeeded", providerPaymentId: "pi_1" });
  assert.equal(requests.length, 1);
  const { url, init } = requests[0]!;
  assert.equal(url, "https://api.stripe.com/v1/payment_intents");
  const headers = init.headers as Record<string, string>;
  assert.equal(headers["Idempotency-Key"], "order:order-1:v1");
  assert.equal(headers.Authorization, `Bearer ${TEST_KEY}`);
  const params = new URLSearchParams(String(init.body));
  assert.equal(params.get("amount"), "420000");
  assert.equal(params.get("currency"), "eur");
  assert.equal(params.get("customer"), "cus_fixture");
  assert.equal(params.get("payment_method"), "pm_fixture");
  assert.equal(params.get("off_session"), "true");
  assert.equal(params.get("confirm"), "true");
  assert.equal(params.get("payment_method_types[]"), null, "rejected by current Stripe API versions");
  assert.equal(params.get("automatic_payment_methods[enabled]"), "true");
  assert.equal(params.get("automatic_payment_methods[allow_redirects]"), "never");
  assert.equal(params.get("metadata[order_id]"), "order-1");
});

test("provider maps off-session authentication demand to requires_action, not success", async () => {
  const { provider } = stripeWith(402, { error: { type: "card_error", code: "authentication_required", decline_code: "authentication_required", payment_intent: { id: "pi_2", object: "payment_intent", status: "requires_payment_method" } } });
  assert.deepEqual(await provider.createPayment(chargeInput), { status: "requires_action", providerPaymentId: "pi_2" });
});

test("provider maps a card decline to failed with the decline code", async () => {
  const { provider } = stripeWith(402, { error: { type: "card_error", code: "card_declined", decline_code: "generic_decline", payment_intent: { id: "pi_3", object: "payment_intent", status: "requires_payment_method" } } });
  assert.deepEqual(await provider.createPayment(chargeInput), { status: "failed", providerPaymentId: "pi_3", code: "generic_decline" });
});

test("provider treats auth and server errors as unknown outcomes and never leaks the key", async () => {
  const { provider } = stripeWith(401, { error: { type: "invalid_request_error", message: `Invalid API Key provided: ${TEST_KEY}` } });
  await assert.rejects(provider.createPayment(chargeInput), (error: unknown) => {
    assert.ok(error instanceof StripeApiError);
    assert.equal(error.httpStatus, 401);
    assert.doesNotMatch(error.message, /sk_test_/);
    return true;
  });
});

test("provider rejects non-integer or non-positive amounts before calling Stripe", async () => {
  const { requests, provider } = stripeWith(200, {});
  await assert.rejects(provider.createPayment({ ...chargeInput, amount: { amountMinor: 10.5, currency: "EUR" } }), RangeError);
  await assert.rejects(provider.createPayment({ ...chargeInput, amount: { amountMinor: 0, currency: "EUR" } }), RangeError);
  assert.equal(requests.length, 0);
});

// ---- settlement invariants ----

test("settle charges exactly the accepted offer total and emits one payment update", async () => {
  const { store, provider, service } = setup();
  const attempt = await service.settle(buyer, makeOrder(), mandate);
  assert.equal(attempt.status, "succeeded");
  assert.deepEqual(provider.calls[0]?.amount, { amountMinor: 420_000, currency: "EUR" });
  assert.equal(provider.calls[0]?.customerRef, "cus_fixture");
  assert.deepEqual(store.emitted, [{ orderId: "order-1", status: "succeeded" }]);
  const order = withPayment(makeOrder(), attempt);
  assert.equal(order.paymentStatus, "succeeded");
  assert.equal(order.sandboxPaymentId, "pi_fixture_1");
});

test("concurrent settle calls on one order create exactly one charge", async () => {
  const { store, provider, service } = setup();
  const results = await Promise.all(Array.from({ length: 5 }, () => service.settle(buyer, makeOrder(), mandate)));
  // One Stripe request in total: in-flight attempts are reported, not re-sent (Stripe would answer 409).
  assert.equal(provider.calls.length, 1);
  assert.equal(store.attempts.size, 1);
  assert.equal(results.filter((r) => r.status === "succeeded").length, 1);
  assert.ok(results.every((r) => r.status === "succeeded" || r.status === "creating"));
  assert.equal(withPayment(makeOrder(), results.find((r) => r.status === "creating")!).paymentStatus, "pending");
  assert.deepEqual(store.emitted, [{ orderId: "order-1", status: "succeeded" }]);
});

test("a retried settle returns the recorded result without another provider call", async () => {
  const { provider, service } = setup();
  await service.settle(buyer, makeOrder(), mandate);
  const again = await service.settle(buyer, makeOrder(), mandate);
  assert.equal(again.status, "succeeded");
  assert.equal(provider.calls.length, 1);
});

test("an unknown provider result leaves the attempt resumable with the same idempotency key", async () => {
  const { store, provider, clock, service } = setup();
  provider.failNext = true;
  await assert.rejects(service.settle(buyer, makeOrder(), mandate), PaymentUnavailableError);
  assert.equal(store.attempts.get("order-1")?.status, "creating");
  assert.equal((await service.settle(buyer, makeOrder(), mandate)).status, "creating", "too recent to resume");
  assert.equal(provider.calls.length, 1);
  clock.now = new Date(NOW.getTime() + RESUME_AFTER_MS);
  const resumed = await service.settle(buyer, makeOrder(), mandate);
  assert.equal(resumed.status, "succeeded");
  assert.equal(provider.calls.length, 2);
  assert.equal(provider.calls[0]?.idempotencyKey, provider.calls[1]?.idempotencyKey);
  assert.equal(provider.uniqueCharges, 1);
});

test("policy refusals happen before any provider call or stored attempt", async () => {
  const cases: [RefusalExpectation, () => Promise<unknown>][] = [];
  type RefusalExpectation = string;
  const { store, provider, service } = setup();
  cases.push(["not_order_buyer", () => service.settle(supplier, makeOrder(), mandate)]);
  cases.push(["not_order_buyer", () => service.settle({ ...buyer, participantId: "buyer-2" }, makeOrder(), mandate)]);
  cases.push(["order_total_exceeds_mandate", () => service.settle(buyer, makeOrder("order-big", 500_001), mandate)]);
  cases.push(["mandate_expired", () => service.settle(buyer, makeOrder(), { ...mandate, expiresAt: "2026-10-30T11:59:59Z" })]);
  cases.push(["currency_mismatch", () => service.settle(buyer, makeOrder(), { ...mandate, maximumOrderTotal: { amountMinor: 500_000, currency: "PLN" } })]);
  cases.push(["mandate_not_sandbox", () => service.settle(buyer, makeOrder(), { ...mandate, sandboxOnly: false as unknown as true })]);
  for (const [code, run] of cases) {
    await assert.rejects(run(), (error: unknown) => error instanceof PaymentRefusedError && error.code === code, code);
  }
  const noCredential = new SettlementService(new MemoryStore(), provider, () => NOW);
  await assert.rejects(noCredential.settle(buyer, makeOrder(), mandate), (e: unknown) => e instanceof PaymentRefusedError && e.code === "payment_credential_missing");
  assert.equal(provider.calls.length, 0);
  assert.equal(store.attempts.size, 0);
});

test("run total across concurrent orders cannot exceed the buyer mandate", async () => {
  const { provider, service } = setup();
  // Two orders of 4,200 EUR fit the 5,000 per-order limit; together they exceed the 8,000 run limit.
  const results = await Promise.allSettled([service.settle(buyer, makeOrder("order-a"), mandate), service.settle(buyer, makeOrder("order-b"), mandate)]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
  assert.equal((rejected.reason as PaymentRefusedError).code, "run_total_exceeds_mandate");
  assert.equal(provider.calls.length, 1);
});

test("a failed payment frees its run-total budget", async () => {
  const { provider, service } = setup({ status: "failed", providerPaymentId: "pi_declined", code: "generic_decline" });
  assert.equal((await service.settle(buyer, makeOrder("order-a"), mandate)).status, "failed");
  provider.outcome = { status: "succeeded", providerPaymentId: "pi_ok" };
  assert.equal((await service.settle(buyer, makeOrder("order-b"), mandate)).status, "succeeded");
});

test("authentication demand yields requires_action and never a success update", async () => {
  const { store, service } = setup({ status: "requires_action", providerPaymentId: "pi_sca" });
  const attempt = await service.settle(buyer, makeOrder(), mandate);
  assert.equal(attempt.status, "requires_action");
  assert.equal(withPayment(makeOrder(), attempt).agreementStatus, "agreed");
  assert.ok(!store.emitted.some((e) => e.status === "succeeded"));
});

test("a decline yields failed with its code and the agreement preserved", async () => {
  const { service } = setup({ status: "failed", providerPaymentId: "pi_declined", code: "generic_decline" });
  const attempt = await service.settle(buyer, makeOrder(), mandate);
  assert.equal(attempt.status, "failed");
  assert.equal(attempt.failureCode, "generic_decline");
  assert.equal(withPayment(makeOrder(), attempt).agreementStatus, "agreed");
});

// ---- webhook ----

test("signature verification accepts Stripe's scheme and rejects tampering, wrong secrets, and stale timestamps", async () => {
  const body = intentEvent("evt_1", "payment_intent.succeeded", "succeeded");
  const now = Math.floor(NOW.getTime() / 1000);
  assert.equal(await verifyStripeSignature(body, await sign(body, now), WEBHOOK_SECRET, now), true);
  assert.equal(await verifyStripeSignature(`${body} `, await sign(body, now), WEBHOOK_SECRET, now), false);
  assert.equal(await verifyStripeSignature(body, await sign(body, now, "whsec_other"), WEBHOOK_SECRET, now), false);
  assert.equal(await verifyStripeSignature(body, await sign(body, now - 301), WEBHOOK_SECRET, now), false);
  assert.equal(await verifyStripeSignature(body, null, WEBHOOK_SECRET, now), false);
  assert.equal(await verifyStripeSignature(body, `t=${now},v1=zz`, WEBHOOK_SECRET, now), false);
  // Rotation: any matching v1 entry is enough.
  const valid = (await sign(body, now)).split(",v1=")[1];
  assert.equal(await verifyStripeSignature(body, `t=${now},v1=${"0".repeat(64)},v1=${valid}`, WEBHOOK_SECRET, now), true);
});

test("webhook with an invalid signature is rejected without changing payment state", async () => {
  const { store, service } = setup({ status: "pending", providerPaymentId: "pi_fixture_1" });
  await service.settle(buyer, makeOrder(), mandate);
  const body = intentEvent("evt_forged", "payment_intent.succeeded", "succeeded");
  const response = await webhook(service, body, await sign(body, Math.floor(NOW.getTime() / 1000), "whsec_attacker"));
  assert.equal(response.status, 400);
  assert.equal(store.attempts.get("order-1")?.status, "pending");
  assert.equal(store.webhookEvents.size, 0);
});

test("verified webhook moves a pending payment to succeeded once, even when delivered twice", async () => {
  const { store, service } = setup({ status: "pending", providerPaymentId: "pi_fixture_1" });
  await service.settle(buyer, makeOrder(), mandate);
  const body = intentEvent("evt_ok", "payment_intent.succeeded", "succeeded");
  assert.equal((await (await webhook(service, body)).json() as { result: string }).result, "applied");
  assert.equal((await (await webhook(service, body)).json() as { result: string }).result, "duplicate");
  assert.equal(store.attempts.get("order-1")?.status, "succeeded");
  assert.deepEqual(store.emitted.map((e) => e.status), ["pending", "succeeded"]);
});

test("the payment_failed webhook for an off-session SCA demand keeps requires_action, not failed", async () => {
  // Shape observed from the Stripe sandbox: status requires_payment_method with authentication_required.
  const { store, service } = setup({ status: "requires_action", providerPaymentId: "pi_fixture_1" });
  await service.settle(buyer, makeOrder(), mandate);
  await webhook(service, intentEvent("evt_sca", "payment_intent.payment_failed", "requires_payment_method", { lastError: { code: "authentication_required", decline_code: "authentication_required" } }));
  assert.equal(store.attempts.get("order-1")?.status, "requires_action");
  assert.ok(!store.emitted.some((e) => e.status === "failed"));
});

test("the payment_failed webhook for a decline moves the payment to failed with its code", async () => {
  const { store, service } = setup({ status: "pending", providerPaymentId: "pi_fixture_1" });
  await service.settle(buyer, makeOrder(), mandate);
  await webhook(service, intentEvent("evt_decline", "payment_intent.payment_failed", "requires_payment_method", { lastError: { code: "card_declined", decline_code: "generic_decline" } }));
  assert.equal(store.attempts.get("order-1")?.status, "failed");
  assert.equal(store.attempts.get("order-1")?.failureCode, "generic_decline");
});

test("a late non-terminal webhook cannot move a terminal payment backwards", async () => {
  const { store, service } = setup();
  await service.settle(buyer, makeOrder(), mandate);
  const late = await webhook(service, intentEvent("evt_late", "payment_intent.processing", "processing"));
  assert.equal((await late.json() as { result: string }).result, "ignored");
  assert.equal(store.attempts.get("order-1")?.status, "succeeded");
});

test("webhooks for unknown orders, foreign PaymentIntents, or mismatched amounts are ignored", async () => {
  const { store, service } = setup({ status: "pending", providerPaymentId: "pi_fixture_1" });
  await service.settle(buyer, makeOrder(), mandate);
  for (const body of [
    intentEvent("evt_a", "payment_intent.succeeded", "succeeded", { orderId: "order-unknown" }),
    intentEvent("evt_b", "payment_intent.succeeded", "succeeded", { pi: "pi_someone_else" }),
    intentEvent("evt_c", "payment_intent.succeeded", "succeeded", { amount: 1 }),
    intentEvent("evt_d", "payment_intent.succeeded", "succeeded", { currency: "usd" }),
  ]) {
    const response = await webhook(service, body);
    assert.equal(response.status, 200);
    assert.equal((await response.json() as { result: string }).result, "ignored");
  }
  assert.equal(store.attempts.get("order-1")?.status, "pending");
});

test("a webhook that arrives before the settle response is recorded is authoritative", async () => {
  const { store, provider, service } = setup({ status: "pending", providerPaymentId: "pi_fixture_1" });
  // Stripe answers "processing" to the API call, but its success webhook lands first.
  const original = provider.createPayment.bind(provider);
  provider.createPayment = async (input) => {
    const outcome = await original(input);
    await webhook(service, intentEvent("evt_race", "payment_intent.succeeded", "succeeded"));
    return outcome;
  };
  const attempt = await service.settle(buyer, makeOrder(), mandate);
  assert.equal(attempt.status, "succeeded");
  assert.equal(store.attempts.get("order-1")?.status, "succeeded");
});

test("verified events this flow does not handle are acknowledged and ignored", async () => {
  const { service } = setup();
  const response = await webhook(service, JSON.stringify({ id: "evt_x", type: "customer.created", data: { object: { id: "cus_1", object: "customer" } } }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { received: true });
});

test("no payment output exposes Stripe secrets or saved-card references", async () => {
  const { store, service } = setup();
  const attempt = await service.settle(buyer, makeOrder(), mandate);
  const order = withPayment(makeOrder(), attempt);
  const visible = JSON.stringify({ order, emitted: store.emitted });
  assert.doesNotMatch(visible, /sk_(test|live)_|whsec_|cus_|pm_/);
  assert.match(visible, /pi_fixture_1/, "the sandbox PaymentIntent id is intentional demo evidence");
});
