import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  Offer,
  ParticipantEvent,
  SourcingRequest,
} from "../../src/contracts.js";
import { PlatformClient } from "../../src/agents/client.js";
import type { SupplierAgentConfig } from "../../src/agents/config.js";
import {
  MAX_REJECTED_EVENT_ATTEMPTS,
  SupplierListener,
  type ListenerTickResult,
  type SupplierListenerOptions,
} from "../../src/agents/listener.js";
import {
  REPORT_NO_MATCH_PREFIX,
  REPORT_PAID_PREFIX,
  REPORT_PAYMENT_FAILED_PREFIX,
  type ReportChannel,
} from "../../src/agents/reporter.js";
import { MemoryAgentStateStore } from "../../src/agents/store.js";
import {
  createFakePlatform,
  type FakePlatform,
  type PaymentOutcome,
  type SeedCase,
  type SeedCaseOptions,
} from "./support/fake-platform.js";

function futureIso(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

function supplierConfig(
  overrides: Partial<SupplierAgentConfig> = {},
): SupplierAgentConfig {
  return {
    role: "supplier",
    marketplaceUrl: "http://127.0.0.1:1",
    token: "test-supplier-token",
    companyName: "Supplier Demo GmbH",
    companyDomain: "supplier.example",
    currency: "EUR",
    stateDir: ".agent-state",
    pollIntervalMs: 100,
    pollMaxIntervalMs: 400,
    negotiationMaxRevisions: 3,
    negotiationDeadlineMs: 300_000,
    requestTimeoutMs: 2_000,
    sandboxOnly: true,
    supplier: {
      minTotalMinor: 100_000,
      quantity: 50,
      unit: "unit",
      earliestDeliveryAt: futureIso(1),
      expiresAt: futureIso(365),
    },
    ...overrides,
  };
}

function requestInput(
  description: string,
): Omit<SourcingRequest, "id" | "buyerId"> {
  return {
    category: "industrial-parts",
    description,
    quantity: 10,
    unit: "unit",
    destination: "Berlin, DE",
    maximumDeliveredTotal: { amountMinor: 200_000, currency: "EUR" },
    deliverBy: futureIso(180),
    requirements: [
      { key: "iso-9001", description: "ISO 9001 certificate", mandatory: true },
    ],
    demo: true,
  };
}

interface HarnessOptions {
  seed?: SeedCaseOptions;
  paymentOutcome?: PaymentOutcome;
  revisionLimit?: number;
  maxRevisions?: number;
  channel?: ReportChannel;
  store?: MemoryAgentStateStore;
}

interface Harness {
  fake: FakePlatform;
  buyer: PlatformClient;
  supplier: PlatformClient;
  store: MemoryAgentStateStore;
  seed: SeedCase;
  channel: ReportChannel;
  messages: string[];
  config: SupplierAgentConfig;
  listener: SupplierListener;
  close(): Promise<void>;
}

type HarnessContext = Omit<Harness, "listener">;

async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const fake = await createFakePlatform({
    ...(options.paymentOutcome === undefined
      ? {}
      : { paymentOutcome: options.paymentOutcome }),
    ...(options.revisionLimit === undefined
      ? {}
      : { revisionLimit: options.revisionLimit }),
  });
  const seed = fake.seedCase(options.seed ?? {});
  const buyer = new PlatformClient({
    baseUrl: fake.url,
    token: fake.tokens.buyer,
    timeoutMs: 2_000,
    retry: { attempts: 1, baseDelayMs: 1 },
  });
  const supplier = new PlatformClient({
    baseUrl: fake.url,
    token: fake.tokens.supplier,
    timeoutMs: 2_000,
    retry: { attempts: 1, baseDelayMs: 1 },
  });
  const store = options.store ?? new MemoryAgentStateStore();
  const messages: string[] = [];
  const channel: ReportChannel =
    options.channel ??
    (async (message: string): Promise<void> => {
      messages.push(message);
    });
  const config = supplierConfig({
    negotiationMaxRevisions: options.maxRevisions ?? 3,
  });
  const context: HarnessContext = {
    fake,
    buyer,
    supplier,
    store,
    seed,
    channel,
    messages,
    config,
    close: () => fake.close(),
  };
  return { ...context, listener: listenerFor(context) };
}

function listenerFor(
  context: HarnessContext,
  overrides: Partial<SupplierListenerOptions> = {},
): SupplierListener {
  return new SupplierListener({
    client: context.supplier,
    store: context.store,
    config: context.config,
    channel: context.channel,
    participantId: context.seed.supplierId,
    ...overrides,
  });
}

async function buyerCounter(
  harness: Harness,
  previous: Offer,
  amountMinor: number,
): Promise<Offer> {
  return harness.buyer.submitOffer({
    requestId: harness.seed.requestId,
    buyerId: harness.seed.buyerId,
    supplierId: harness.seed.supplierId,
    previousOfferId: previous.id,
    quantity: harness.seed.request.quantity,
    unit: harness.seed.request.unit,
    destination: harness.seed.request.destination,
    deliveredTotal: {
      amountMinor,
      currency: harness.seed.request.maximumDeliveredTotal.currency,
    },
    taxMinor: 0,
    deliveryMinor: 0,
    deliveryAt: futureIso(30),
    expiresAt: futureIso(7),
    confirmedRequirementKeys: ["iso-9001"],
    termsOrigin: "demo-supplier-declaration",
    demo: true,
  });
}

function findSkipped(
  tick: ListenerTickResult,
  eventId: string,
): string | undefined {
  return tick.skipped.find((entry) => entry.eventId === eventId)?.reason;
}

test("supplier quotes, accepts a counter, never settles, and reports the buyer's payment once", async () => {
  const harness = await createHarness({ seed: { withQuoteRequest: true } });
  try {
    const first = await harness.listener.tick();
    assert.equal(first.failed.length, 0);
    assert.equal(first.handled.length, 1);
    assert.equal(first.reports.length, 0);

    const offers = harness.fake.getOffers();
    assert.equal(offers.length, 1);
    const initial = offers[0];
    assert.ok(initial);
    assert.equal(initial.deliveredTotal.amountMinor, 110_000);
    assert.equal(initial.supplierId, harness.seed.supplierId);

    const counter = await buyerCounter(harness, initial, 120_000);
    const second = await harness.listener.tick();
    assert.equal(second.failed.length, 0);
    assert.ok(second.handled.length >= 1);

    const order = harness.fake.getOrders()[0];
    assert.ok(order);
    assert.equal(order.acceptedOffer.id, counter.id);
    assert.equal(order.paymentStatus, "not_started");

    // Settlement is the buyer's action.
    await harness.buyer.settleOrder(order.id);

    const third = await harness.listener.tick();
    assert.equal(third.failed.length, 0);
    assert.equal(third.reports.length, 1);
    const message = third.reports[0];
    assert.ok(message);
    assert.ok(message.startsWith(REPORT_PAID_PREFIX));
    assert.match(message, new RegExp(`order ${order.id}`));
    assert.match(message, new RegExp(`document inv_${order.id}`));
    assert.match(message, new RegExp(`payment pi_sandbox_${order.id}`));

    const fourth = await harness.listener.tick();
    assert.equal(fourth.reports.length, 0);
    assert.equal(harness.messages.length, 1);
    assert.equal(harness.fake.state.paymentAttempts.get(order.id), 1);
    const supplierSettles = harness.fake.state.mutationLog.filter(
      (entry) => entry.path.endsWith("/settle") && entry.key.startsWith("listener:"),
    );
    assert.equal(supplierSettles.length, 0);
  } finally {
    await harness.close();
  }
});

test("a restart with a persisted cursor does not duplicate offers or responses", async () => {
  const harness = await createHarness({ seed: { withQuoteRequest: true } });
  try {
    const first = await harness.listener.tick();
    assert.equal(first.handled.length, 1);
    assert.equal(await harness.store.getCursor(), "1");
    assert.equal(harness.fake.getOffers().length, 1);

    const restarted = listenerFor(harness);
    const second = await restarted.tick();
    assert.equal(second.handled.length, 0);
    assert.equal(second.failed.length, 0);
    assert.equal(harness.fake.getOffers().length, 1);
    assert.equal(await harness.store.getCursor(), "1");
    const listenerMutations = harness.fake.state.mutationLog.filter(
      (entry) =>
        entry.path.includes("/offers") && entry.key.startsWith("listener:"),
    );
    assert.equal(listenerMutations.length, 1);

    // A cursor rollback (or a platform replay) must not repeat the response.
    await harness.store.setCursor("0");
    const replay = await restarted.tick();
    assert.equal(replay.handled.length, 0);
    assert.equal(harness.fake.getOffers().length, 1);
    assert.equal(harness.messages.length, 0);
    assert.equal(await harness.store.getCursor(), "1");
  } finally {
    await harness.close();
  }
});

test("backoff grows from the poll interval to the maximum", async () => {
  const harness = await createHarness();
  try {
    const controller = new AbortController();
    const delays: number[] = [];
    const listener = listenerFor(harness, {
      pollIntervalMs: 100,
      pollMaxIntervalMs: 400,
      sleep: async (ms: number): Promise<void> => {
        delays.push(ms);
        if (delays.length >= 4) {
          controller.abort();
        }
      },
    });

    await listener.run(controller.signal);

    assert.deepEqual(delays, [100, 200, 400, 400]);
    assert.equal(listener.tickCount, 4);
  } finally {
    await harness.close();
  }
});

test("a productive tick resets the backoff to the base interval", async () => {
  const harness = await createHarness();
  try {
    const controller = new AbortController();
    const delays: number[] = [];
    let seeded = false;
    const listener = listenerFor(harness, {
      pollIntervalMs: 100,
      pollMaxIntervalMs: 400,
      sleep: async (ms: number): Promise<void> => {
        delays.push(ms);
        if (delays.length >= 3) {
          controller.abort();
        }
      },
    });

    await listener.run(controller.signal, async () => {
      if (!seeded) {
        seeded = true;
        await harness.buyer.requestQuote(
          harness.seed.requestId,
          harness.seed.supplierId,
        );
      }
    });

    // Tick 1 is empty (100), tick 2 handles the quote (100), tick 3 is empty
    // again and must still wait the base interval because backoff reset.
    assert.deepEqual(delays, [100, 100, 100]);
    assert.equal(harness.fake.getOffers().length, 1);
  } finally {
    await harness.close();
  }
});

test("a failed payment is reported as payment failed, never as paid", async () => {
  const harness = await createHarness({
    seed: { withQuoteRequest: true },
    paymentOutcome: "failed",
  });
  try {
    await harness.listener.tick();
    const offer = harness.fake.getOffers()[0];
    assert.ok(offer);
    const acceptance = await harness.buyer.acceptOffer(offer.id);
    assert.equal(acceptance.state, "agreed");
    if (acceptance.state === "agreed") {
      await harness.buyer.settleOrder(acceptance.order.id);
    }

    const settled = await harness.listener.tick();
    assert.equal(settled.failed.length, 0);
    assert.equal(settled.reports.length, 1);
    const message = settled.reports[0];
    assert.ok(message);
    assert.ok(message.startsWith(REPORT_PAYMENT_FAILED_PREFIX));
    assert.ok(!message.includes(REPORT_PAID_PREFIX));

    const order = harness.fake.getOrders()[0];
    assert.ok(order);
    assert.equal(order.paymentStatus, "failed");

    const paymentEvent = await harness.listener.tick();
    assert.equal(paymentEvent.reports.length, 0);
    assert.equal(harness.messages.length, 1);
    assert.ok(
      harness.messages.every((entry) => !entry.startsWith(REPORT_PAID_PREFIX)),
    );
    // The supplier never retries the buyer's declined charge.
    assert.equal(harness.fake.state.paymentAttempts.get(order.id), 1);
  } finally {
    await harness.close();
  }
});

test("the listener keeps polling after agreement and through payment updates", async () => {
  const harness = await createHarness({ seed: { withQuoteRequest: true } });
  try {
    const controller = new AbortController();
    const delays: number[] = [];
    const ticks: ListenerTickResult[] = [];
    const listener = listenerFor(harness, {
      pollIntervalMs: 100,
      pollMaxIntervalMs: 400,
      sleep: async (ms: number): Promise<void> => {
        delays.push(ms);
        if (delays.length >= 4) {
          controller.abort();
        }
      },
    });

    let orderId: string | undefined;
    await listener.run(controller.signal, async (result) => {
      ticks.push(result);
      if (ticks.length === 1) {
        const offer = harness.fake.getOffers()[0];
        assert.ok(offer);
        const acceptance = await harness.buyer.acceptOffer(offer.id);
        if (acceptance.state === "agreed") {
          orderId = acceptance.order.id;
        }
      } else if (ticks.length === 2 && orderId !== undefined) {
        // The buyer settles only after the supplier has seen the agreement.
        await harness.buyer.settleOrder(orderId);
      }
    });

    assert.equal(listener.tickCount, 4);
    assert.equal(harness.messages.length, 1);
    assert.ok(harness.messages[0]?.startsWith(REPORT_PAID_PREFIX));
    assert.ok(ticks.length >= 4);

    const atAgreement = ticks[1];
    assert.ok(atAgreement);
    assert.ok(
      atAgreement.skipped.some((entry) => entry.reason?.startsWith("awaiting_payment:")),
      "expected the agreement to wait for payment instead of settling",
    );
    assert.equal(atAgreement.reports.length, 0);

    const afterPayment = ticks[2];
    assert.ok(afterPayment);
    assert.equal(afterPayment.reports.length, 1);
  } finally {
    await harness.close();
  }
});

test("unknown event types are skipped with a reason", async () => {
  const harness = await createHarness();
  try {
    const events = harness.fake.state.events.get(harness.seed.supplierId);
    assert.ok(events);
    events.push({
      id: "evt_unknown_1",
      cursor: String(events.length + 1),
      type: "mystery_event" as ParticipantEvent["type"],
      requestId: harness.seed.requestId,
      resourceId: harness.seed.requestId,
    });

    const tick = await harness.listener.tick();
    assert.equal(tick.handled.length, 0);
    assert.equal(tick.failed.length, 0);
    assert.equal(
      findSkipped(tick, "evt_unknown_1"),
      "unknown_event_type:mystery_event",
    );
    assert.equal(tick.cursor, "1");
    assert.equal(harness.fake.getOffers().length, 0);
  } finally {
    await harness.close();
  }
});

test("one failing event does not block the rest of the page", async () => {
  const harness = await createHarness({ seed: { withQuoteRequest: true } });
  try {
    const secondRequest = await harness.buyer.createRequest(
      requestInput("Second demo request for the same supplier"),
    );
    const discovery = await harness.buyer.startDiscovery(secondRequest.id);
    let discoveryResult = await harness.buyer.getDiscovery(
      discovery.discoveryId,
    );
    let discoveryPolls = 0;
    while (
      (discoveryResult.status === "pending" ||
        discoveryResult.status === "running") &&
      discoveryPolls < 10
    ) {
      discoveryResult = await harness.buyer.getDiscovery(discovery.discoveryId);
      discoveryPolls += 1;
    }
    assert.equal(discoveryResult.status, "complete");
    await harness.buyer.requestQuote(secondRequest.id, harness.seed.supplierId);

    const supplierEvents = harness.fake.getEvents(harness.seed.supplierId);
    assert.equal(supplierEvents.length, 2);
    const firstEvent = supplierEvents[0];
    const secondEvent = supplierEvents[1];
    assert.ok(firstEvent);
    assert.ok(secondEvent);

    harness.fake.failNextRequest(
      500,
      "INJECTED_FAILURE",
      1,
      `/v1/requests/${harness.seed.requestId}`,
    );

    const tick = await harness.listener.tick();
    assert.equal(tick.failed.length, 1);
    assert.equal(tick.failed[0]?.eventId, firstEvent.id);
    assert.equal(tick.handled.length, 1);
    assert.equal(tick.handled[0], secondEvent.id);
    assert.ok(tick.lastError !== undefined);
    assert.equal(tick.cursor, "");

    const offers = harness.fake.getOffers();
    assert.equal(offers.length, 1);
    assert.equal(offers[0]?.requestId, secondRequest.id);

    const retried = await harness.listener.tick();
    assert.equal(retried.failed.length, 0);
    assert.equal(retried.handled.length, 1);
    assert.equal(retried.handled[0], firstEvent.id);
    assert.equal(harness.fake.getOffers().length, 2);
    assert.equal(await harness.store.getCursor(), "2");
  } finally {
    await harness.close();
  }
});

test("the revision cap declines the negotiation and ignores later offers", async () => {
  const harness = await createHarness({
    seed: { withQuoteRequest: true },
    revisionLimit: 10,
    maxRevisions: 2,
  });
  try {
    await harness.listener.tick();
    const initial = harness.fake.getOffers()[0];
    assert.ok(initial);
    assert.equal(initial.deliveredTotal.amountMinor, 110_000);

    await buyerCounter(harness, initial, 90_000);
    await harness.listener.tick();
    const countered = harness.fake.getOffers();
    assert.equal(countered.length, 3);
    const finalOffer = countered[2];
    assert.ok(finalOffer);
    assert.equal(finalOffer.deliveredTotal.amountMinor, 100_000);

    await buyerCounter(harness, finalOffer, 95_000);
    const declined = await harness.listener.tick();
    assert.equal(harness.fake.getOffers().length, 4);
    assert.equal(declined.declined.length, 1);
    const decline = declined.declined[0];
    assert.ok(decline);
    assert.match(decline.reason, /revision_limit/);
    assert.equal(declined.reports.length, 1);
    assert.ok(declined.reports[0]?.startsWith(REPORT_NO_MATCH_PREFIX));
    assert.equal(
      await harness.listener.declinedReason(harness.seed.requestId),
      decline.reason,
    );

    const offersAfterDecline = harness.fake.getOffers();
    const latest = offersAfterDecline[offersAfterDecline.length - 1];
    assert.ok(latest);
    const supplierEvents = harness.fake.state.events.get(
      harness.seed.supplierId,
    );
    assert.ok(supplierEvents);
    supplierEvents.push({
      id: "evt_late_offer",
      cursor: String(supplierEvents.length + 1),
      type: "offer_received",
      requestId: harness.seed.requestId,
      resourceId: latest.id,
    });
    const ignored = await harness.listener.tick();
    assert.equal(ignored.handled.length, 0);
    assert.equal(harness.fake.getOffers().length, 4);
    const ignoredEvent = ignored.skipped.find((entry) =>
      entry.reason?.startsWith("declined:"),
    );
    assert.ok(ignoredEvent);
  } finally {
    await harness.close();
  }
});

test("a channel failure does not alter order state and queues the report", async () => {
  let offline = true;
  const delivered: string[] = [];
  const channel: ReportChannel = async (message: string): Promise<void> => {
    if (offline) {
      throw new Error("chat transport offline");
    }
    delivered.push(message);
  };
  const harness = await createHarness({
    seed: { withQuoteRequest: true },
    channel,
  });
  try {
    await harness.listener.tick();
    const offer = harness.fake.getOffers()[0];
    assert.ok(offer);
    const acceptance = await harness.buyer.acceptOffer(offer.id);
    assert.equal(acceptance.state, "agreed");
    const order = harness.fake.getOrders()[0];
    assert.ok(order);
    await harness.buyer.settleOrder(order.id);

    const failedTick = await harness.listener.tick();
    assert.equal(failedTick.failed.length, 0);
    assert.equal(failedTick.reports.length, 0);
    assert.equal(delivered.length, 0);

    const settled = harness.fake.getOrders()[0];
    assert.ok(settled);
    assert.equal(settled.paymentStatus, "succeeded");
    assert.equal(settled.agreementStatus, "agreed");
    assert.equal(settled.acceptedOffer.id, offer.id);

    const pending = await harness.listener.pendingReports();
    assert.equal(pending.length, 1);
    assert.ok(pending[0]?.startsWith(REPORT_PAID_PREFIX));

    const snapshot = JSON.stringify(settled);
    offline = false;
    const recovered = listenerFor(harness);
    const paymentTick = await recovered.tick();
    assert.equal(paymentTick.reports.length, 1);
    assert.equal(delivered.length, 1);
    assert.ok(delivered[0]?.startsWith(REPORT_PAID_PREFIX));
    assert.equal(JSON.stringify(harness.fake.getOrders()[0]), snapshot);
    assert.equal(harness.fake.state.paymentAttempts.get(order.id), 1);
    // Delivered from the queue exactly once; nothing left and nothing repeated.
    assert.deepEqual(await recovered.pendingReports(), []);
    const quiet = await recovered.tick();
    assert.equal(quiet.reports.length, 0);
    assert.equal(delivered.length, 1);
  } finally {
    await harness.close();
  }
});




test("an event the platform keeps rejecting is skipped after bounded attempts", async () => {
  const harness = await createHarness({ seed: { withQuoteRequest: true } });
  try {
    harness.fake.failNextRequest(
      400,
      "INVALID_REQUEST",
      10,
      `/v1/requests/${harness.seed.requestId}`,
    );
    const attempts: ListenerTickResult[] = [];
    for (let index = 0; index < MAX_REJECTED_EVENT_ATTEMPTS; index += 1) {
      attempts.push(await harness.listener.tick());
    }
    // Retried while attempts remain, then skipped so the cursor can move on.
    assert.ok(attempts.slice(0, -1).every((tick) => tick.failed.length === 1));
    const last = attempts.at(-1);
    assert.ok(last);
    assert.match(last.failed[0]?.reason ?? "", /skipped_after_3_attempts/);
    assert.equal(await harness.store.getCursor(), "1");

    const after = await harness.listener.tick();
    assert.equal(after.failed.length, 0);
    assert.equal(harness.fake.getOffers().length, 0);
  } finally {
    await harness.close();
  }
});
