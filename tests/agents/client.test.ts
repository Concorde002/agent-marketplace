import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PlatformClient,
  PlatformClientError,
  type PlatformClientOptions,
} from "../../src/agents/client.js";
import type { Offer, SourcingRequest } from "../../src/contracts.js";
import {
  createFakePlatform,
  defaultBuyerRegistration,
  defaultSupplierRegistration,
  type FakePlatform,
} from "./support/fake-platform.js";

function clientFor(fake: FakePlatform, token: string): PlatformClient {
  return new PlatformClient({
    baseUrl: `${fake.url}/`,
    token,
    retry: { attempts: 2, baseDelayMs: 1 },
  });
}

function requestInput(): Omit<SourcingRequest, "id" | "buyerId"> {
  return {
    category: "industrial-parts",
    description: "Ten demo widgets for the local test double",
    quantity: 10,
    unit: "unit",
    destination: "Berlin, DE",
    maximumDeliveredTotal: { amountMinor: 200_000, currency: "EUR" },
    deliverBy: futureIso(180),
    requirements: [{ key: "iso-9001", description: "ISO 9001 certificate", mandatory: true }],
    demo: true,
  };
}

function offerInput(
  request: SourcingRequest,
  buyerId: string,
  supplierId: string,
  overrides: Partial<Omit<Offer, "id">> = {},
): Omit<Offer, "id"> {
  return {
    requestId: request.id,
    buyerId,
    supplierId,
    quantity: request.quantity,
    unit: request.unit,
    destination: request.destination,
    deliveredTotal: { amountMinor: 150_000, currency: request.maximumDeliveredTotal.currency },
    taxMinor: 0,
    deliveryMinor: 0,
    deliveryAt: futureIso(30),
    expiresAt: futureIso(7),
    confirmedRequirementKeys: ["iso-9001"],
    termsOrigin: "demo-supplier-declaration",
    demo: true,
    ...overrides,
  };
}

function futureIso(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

async function expectPlatformError(
  promise: Promise<unknown>,
  code: string,
  status: number,
): Promise<PlatformClientError> {  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof PlatformClientError, "expected a PlatformClientError");
    assert.equal(error.code, code);
    assert.equal(error.status, status);
    return error;
  }
  throw new Error(`expected ${code} but the call succeeded`);
}

async function collectEventTypes(client: PlatformClient): Promise<string[]> {
  const types: string[] = [];
  let cursor = "0";
  for (let pageIndex = 0; pageIndex < 20; pageIndex += 1) {
    const page = await client.listEvents(cursor);
    for (const event of page.events) {
      types.push(event.type);
    }
    cursor = page.nextCursor;
    if (page.events.length === 0) {
      break;
    }
  }
  return types;
}

async function registerBoth(
  fake: FakePlatform,
): Promise<{ buyer: PlatformClient; supplier: PlatformClient; buyerId: string; supplierId: string }> {
  const buyer = clientFor(fake, fake.tokens.buyer);
  const supplier = clientFor(fake, fake.tokens.supplier);
  const buyerRegistration = await buyer.registerParticipant(defaultBuyerRegistration());
  const supplierRegistration = await supplier.registerParticipant(defaultSupplierRegistration());
  return {
    buyer,
    supplier,
    buyerId: buyerRegistration.participantId,
    supplierId: supplierRegistration.participantId,
  };
}

test("client authenticates with a bearer token and surfaces 401 without leaking the token", async () => {
  const fake = await createFakePlatform();
  try {
    const client = clientFor(fake, fake.tokens.buyer);
    const result = await client.registerParticipant(defaultBuyerRegistration());
    assert.ok(result.participantId.startsWith("pt_buyer_"));
    assert.equal(fake.state.participants.size, 1);

    const secret = "not-an-issued-token-value";
    const unknown = clientFor(fake, secret);
    const error = await expectPlatformError(unknown.listEvents(), "UNAUTHORIZED", 401);
    assert.equal(error.message.includes(secret), false);
    assert.equal(JSON.stringify(error).includes(secret), false);
  } finally {
    await fake.close();
  }
});

test("client drives discovery, quote request, offer, acceptance, settlement and scoped reads", async () => {
  const fake = await createFakePlatform();
  try {
    const { buyer, supplier, buyerId, supplierId } = await registerBoth(fake);

    const request = await buyer.createRequest(requestInput());
    assert.equal(request.buyerId, buyerId);
    assert.equal((await buyer.getRequest(request.id)).id, request.id);

    const started = await buyer.startDiscovery(request.id);
    const statuses: string[] = [];
    let discovery = await buyer.getDiscovery(started.discoveryId);
    for (let poll = 0; poll < 10; poll += 1) {
      statuses.push(discovery.status);
      if (discovery.status === "complete" || discovery.status === "failed") {
        break;
      }
      discovery = await buyer.getDiscovery(started.discoveryId);
    }
    assert.deepEqual(statuses.slice(0, 3), ["running", "running", "complete"]);
    assert.equal(discovery.candidates[0]?.rank, 1);
    assert.ok(
      discovery.candidates.some(
        (candidate) => candidate.candidate.company.officialDomain === "supplier.example",
      ),
    );

    const quote = await buyer.requestQuote(request.id, supplierId);
    assert.ok(quote.eventId.startsWith("evt_"));
    const supplierEvents = await supplier.listEvents();
    assert.equal(supplierEvents.events[0]?.type, "quote_requested");
    assert.equal(supplierEvents.events[0]?.requestId, request.id);
    assert.equal((await supplier.getRequest(request.id)).id, request.id);

    const offer = await supplier.submitOffer(offerInput(request, buyerId, supplierId));
    assert.equal(offer.previousOfferId, undefined);
    assert.equal(offer.termsOrigin, "demo-supplier-declaration");
    assert.deepEqual(await buyer.getOffer(offer.id), offer);

    const buyerEvents = await buyer.listEvents();
    assert.ok(
      buyerEvents.events.some(
        (event) => event.type === "offer_received" && event.resourceId === offer.id,
      ),
    );
    assert.ok(buyerEvents.events.every((event) => event.type !== "quote_requested"));

    const acceptance = await buyer.acceptOffer(offer.id);
    assert.equal(acceptance.state, "agreed");
    if (acceptance.state !== "agreed") {
      throw new Error("expected an agreement");
    }
    const order = acceptance.order;
    assert.equal(order.acceptedOffer.id, offer.id);
    assert.equal(order.agreementStatus, "agreed");
    assert.equal(fake.getOrders().length, 1);

    const settled = await supplier.settleOrder(order.id);
    assert.equal(settled.paymentStatus, "succeeded");
    assert.ok((settled.sandboxPaymentId ?? "").length > 0);
    assert.equal(settled.demoInvoice?.demo, true);

    const buyerOrder = await buyer.getOrder(order.id);
    assert.equal(buyerOrder.paymentStatus, "succeeded");
    assert.equal(buyerOrder.sandboxPaymentId, settled.sandboxPaymentId);

    const finalEvents = await buyer.listEvents();
    assert.deepEqual(
      finalEvents.events.map((event) => event.type),
      ["offer_received", "agreement_created", "payment_updated"],
    );

    const replay = await supplier.settleOrder(order.id);
    assert.equal(replay.sandboxPaymentId, settled.sandboxPaymentId);
    assert.equal(fake.getOrders().length, 1);
  } finally {
    await fake.close();
  }
});

test("client retries 503 with the same idempotency key and applies the mutation once", async () => {
  const fake = await createFakePlatform();
  try {
    const { buyer } = await registerBoth(fake);
    fake.failNextRequest(503, "SERVICE_UNAVAILABLE", 1, "/v1/requests");
    const request = await buyer.createRequest(requestInput());
    // One registration attempt plus the failing request attempt plus the successful retry.
    assert.equal(buyer.requestCount, 3);
    assert.equal(fake.state.requests.size, 1);

    const keys = fake.state.mutationLog
      .filter((entry) => entry.path === "/v1/requests")
      .map((entry) => entry.key);
    assert.equal(keys.length, 2);
    assert.equal(new Set(keys).size, 1);
    assert.equal(request.id, [...fake.state.requests.keys()][0]);
  } finally {
    await fake.close();
  }
});

test("client retries a network error with the same idempotency key", async () => {
  const fake = await createFakePlatform();
  try {
    await registerBoth(fake);
    const seenKeys: string[] = [];
    let calls = 0;
    const flakyFetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      calls += 1;
      const key = new Headers(init?.headers).get("idempotency-key");
      if (key !== null) {
        seenKeys.push(key);
      }
      if (calls === 1) {
        throw new Error("simulated socket reset");
      }
      return fetch(input, init);
    }) as typeof fetch;

    const buyer = new PlatformClient({
      baseUrl: fake.url,
      token: fake.tokens.buyer,
      fetchImpl: flakyFetch,
      retry: { attempts: 2, baseDelayMs: 1 },
    });
    const request = await buyer.createRequest(requestInput());
    assert.equal(buyer.requestCount, 2);
    assert.equal(fake.state.requests.size, 1);
    assert.equal(fake.state.requests.has(request.id), true);
    assert.equal(seenKeys.length, 2);
    assert.equal(seenKeys[0], seenKeys[1]);
  } finally {
    await fake.close();
  }
});

test("client reuses a deterministic idempotency key for the same logical mutation", async () => {
  const fake = await createFakePlatform();
  try {
    const { buyer } = await registerBoth(fake);
    const input = requestInput();
    const first = await buyer.createRequest(input);
    const second = await buyer.createRequest(input);
    assert.equal(first.id, second.id);
    assert.equal(fake.state.requests.size, 1);

    const keys = fake.state.mutationLog
      .filter((entry) => entry.path === "/v1/requests")
      .map((entry) => entry.key);
    assert.equal(keys.length, 2);
    assert.equal(new Set(keys).size, 1);

    await buyer.createRequest(input, { idempotencyKey: "fixed-logical-request" });
    await expectPlatformError(
      buyer.createRequest(
        { ...input, description: "A different logical request" },
        { idempotencyKey: "fixed-logical-request" },
      ),
      "IDEMPOTENCY_KEY_REUSED",
      409,
    );
  } finally {
    await fake.close();
  }
});

test("client never retries 4xx and maps forbidden/validation errors", async () => {
  const fake = await createFakePlatform();
  try {
    const { buyer, supplier } = await registerBoth(fake);
    const forbiddenError = await expectPlatformError(supplier.createRequest(requestInput()), "FORBIDDEN", 403);
    assert.equal(forbiddenError.idempotencyKey !== undefined, true);
    // Registration plus exactly one forbidden attempt: no retry on 403.
    assert.equal(supplier.requestCount, 2);

    const before = buyer.requestCount;
    const invalidBody = {} as unknown as Omit<SourcingRequest, "id" | "buyerId">;
    await expectPlatformError(buyer.createRequest(invalidBody), "INVALID_REQUEST", 400);
    assert.equal(buyer.requestCount, before + 1);
  } finally {
    await fake.close();
  }
});

test("client times out via AbortSignal and reports TIMEOUT without the token", async () => {
  const fake = await createFakePlatform();
  try {
    await registerBoth(fake);
    fake.delayNextRequest(150, "/v1/events");
    const options: PlatformClientOptions = {
      baseUrl: fake.url,
      token: fake.tokens.buyer,
      timeoutMs: 20,
      retry: { attempts: 1, baseDelayMs: 0 },
    };
    const client = new PlatformClient(options);
    const error = await expectPlatformError(client.listEvents(), "TIMEOUT", 0);
    assert.equal(error.message.includes(fake.tokens.buyer), false);
    assert.equal(client.requestCount, 1);
  } finally {
    await fake.close();
  }
});

test("discovery failure is reported and no quote can be manufactured", async () => {
  const fake = await createFakePlatform();
  try {
    const { buyer } = await registerBoth(fake);
    const request = await buyer.createRequest(requestInput());
    fake.setDiscoveryFailure("source fetch timed out");
    const started = await buyer.startDiscovery(request.id);
    const discovery = await buyer.getDiscovery(started.discoveryId);
    assert.equal(discovery.status, "failed");
    assert.equal(discovery.candidates.length, 0);
    assert.equal(discovery.sourceErrors[0]?.message, "source fetch timed out");
  } finally {
    await fake.close();
  }
});

test("quote routing refuses a supplier with no connected representative", async () => {
  const fake = await createFakePlatform();
  try {
    const seeded = fake.seedCase();
    const buyer = clientFor(fake, seeded.buyerToken);
    const otherToken = fake.issueToken("supplier");
    const other = clientFor(fake, otherToken);
    const otherRegistration = await other.registerParticipant(
      defaultSupplierRegistration("other.example"),
    );

    await expectPlatformError(
      buyer.requestQuote(seeded.requestId, otherRegistration.participantId),
      "NO_CONNECTED_REPRESENTATIVE",
      409,
    );

    await buyer.requestQuote(seeded.requestId, seeded.supplierId);
    assert.equal((await buyer.getRequest(seeded.requestId)).id, seeded.requestId);
    await expectPlatformError(other.getRequest(seeded.requestId), "FORBIDDEN", 403);
  } finally {
    await fake.close();
  }
});

test("scoped reads reject participants that are not parties", async () => {
  const fake = await createFakePlatform();
  try {
    const seeded = fake.seedCase();
    const buyer = clientFor(fake, seeded.buyerToken);
    const supplier = clientFor(fake, seeded.supplierToken);
    const otherToken = fake.issueToken("supplier");
    const outsider = clientFor(fake, otherToken);
    await outsider.registerParticipant(defaultSupplierRegistration("other.example"));

    await expectPlatformError(supplier.getRequest(seeded.requestId), "FORBIDDEN", 403);

    await buyer.requestQuote(seeded.requestId, seeded.supplierId);
    assert.equal((await supplier.getRequest(seeded.requestId)).id, seeded.requestId);

    const offer = await supplier.submitOffer(
      offerInput(seeded.request, seeded.buyerId, seeded.supplierId),
    );
    await expectPlatformError(outsider.getOffer(offer.id), "FORBIDDEN", 403);
    assert.equal((await supplier.getOffer(offer.id)).id, offer.id);
    assert.equal((await buyer.getOffer(offer.id)).id, offer.id);
  } finally {
    await fake.close();
  }
});

test("concurrent acceptances from both sides create exactly one order", async () => {
  const fake = await createFakePlatform();
  try {
    const seeded = fake.seedCase({ withOffer: true });
    assert.ok(seeded.offer !== undefined);
    const buyer = clientFor(fake, seeded.buyerToken);
    const supplier = clientFor(fake, seeded.supplierToken);

    const [buyerResult, supplierResult] = await Promise.all([
      buyer.acceptOffer(seeded.offer.id),
      supplier.acceptOffer(seeded.offer.id),
    ]);

    assert.equal(fake.getOrders().length, 1);
    const orders = fake.getOrders();
    const order = orders[0];
    assert.ok(order !== undefined);
    assert.equal(order.acceptedOffer.id, seeded.offer.id);
    assert.ok(buyerResult.state === "agreed" || supplierResult.state === "agreed");

    const repeated = await buyer.acceptOffer(seeded.offer.id);
    assert.equal(repeated.state, "agreed");
    if (repeated.state === "agreed") {
      assert.equal(repeated.order.id, order.id);
    }
  } finally {
    await fake.close();
  }
});

test("stale revisions are rejected after a counteroffer", async () => {
  const fake = await createFakePlatform();
  try {
    const seeded = fake.seedCase({ withOffer: true });
    assert.ok(seeded.offer !== undefined);
    const buyer = clientFor(fake, seeded.buyerToken);
    const supplier = clientFor(fake, seeded.supplierToken);

    const counter = await buyer.submitOffer(
      offerInput(seeded.request, seeded.buyerId, seeded.supplierId, {
        previousOfferId: seeded.offer.id,
        deliveredTotal: { amountMinor: 140_000, currency: "EUR" },
      }),
    );
    assert.equal(counter.previousOfferId, seeded.offer.id);

    await expectPlatformError(supplier.acceptOffer(seeded.offer.id), "STALE_OFFER", 409);

    await supplier.submitOffer(
      offerInput(seeded.request, seeded.buyerId, seeded.supplierId, {
        previousOfferId: counter.id,
        deliveredTotal: { amountMinor: 145_000, currency: "EUR" },
      }),
    );

    await expectPlatformError(
      buyer.submitOffer(
        offerInput(seeded.request, seeded.buyerId, seeded.supplierId, {
          previousOfferId: seeded.offer.id,
          deliveredTotal: { amountMinor: 130_000, currency: "EUR" },
        }),
      ),
      "STALE_OFFER",
      409,
    );
  } finally {
    await fake.close();
  }
});

test("revision limit stops the negotiation", async () => {
  const fake = await createFakePlatform({ revisionLimit: 2 });
  try {
    const seeded = fake.seedCase({ withOffer: true });
    assert.ok(seeded.offer !== undefined);
    const buyer = clientFor(fake, seeded.buyerToken);
    const supplier = clientFor(fake, seeded.supplierToken);

    const counter = await buyer.submitOffer(
      offerInput(seeded.request, seeded.buyerId, seeded.supplierId, {
        previousOfferId: seeded.offer.id,
        deliveredTotal: { amountMinor: 140_000, currency: "EUR" },
      }),
    );

    await expectPlatformError(
      supplier.submitOffer(
        offerInput(seeded.request, seeded.buyerId, seeded.supplierId, {
          previousOfferId: counter.id,
          deliveredTotal: { amountMinor: 145_000, currency: "EUR" },
        }),
      ),
      "REVISION_LIMIT",
      409,
    );
  } finally {
    await fake.close();
  }
});

test("sandbox payment failure can be injected and then retried successfully", async () => {
  const fake = await createFakePlatform();
  try {
    const seeded = fake.seedCase({ withOffer: true, withAgreement: true });
    assert.ok(seeded.order !== undefined);
    const supplier = clientFor(fake, seeded.supplierToken);
    const buyer = clientFor(fake, seeded.buyerToken);

    fake.forcePaymentFailure();
    const failed = await supplier.settleOrder(seeded.order.id);
    assert.equal(failed.paymentStatus, "failed");
    assert.equal(failed.sandboxPaymentId, undefined);

    fake.setPaymentOutcome("succeeded");
    // A failed payment is retried as a new logical mutation, so it needs a fresh key.
    const succeeded = await supplier.settleOrder(seeded.order.id, {
      idempotencyKey: "settle-payment-retry-1",
    });
    assert.equal(succeeded.paymentStatus, "succeeded");
    assert.ok((succeeded.sandboxPaymentId ?? "").length > 0);
    assert.equal((await buyer.getOrder(seeded.order.id)).paymentStatus, "succeeded");
  } finally {
    await fake.close();
  }
});

test("events are participant-scoped and paginated by cursor", async () => {
  const fake = await createFakePlatform({ eventPageSize: 1 });
  try {
    const seeded = fake.seedCase({ withSettlement: true });
    const buyer = clientFor(fake, seeded.buyerToken);
    const supplier = clientFor(fake, seeded.supplierToken);

    const buyerTypes: string[] = [];
    let cursor = "0";
    for (let pageIndex = 0; pageIndex < 10; pageIndex += 1) {
      const page = await buyer.listEvents(cursor);
      assert.ok(page.events.length <= 1);
      for (const event of page.events) {
        buyerTypes.push(event.type);
      }
      cursor = page.nextCursor;
      if (page.events.length === 0) {
        break;
      }
    }
    assert.deepEqual(buyerTypes, ["offer_received", "agreement_created", "payment_updated"]);

    const supplierTypes = await collectEventTypes(supplier);
    assert.deepEqual(supplierTypes, [
      "quote_requested",
      "agreement_created",
      "payment_updated",
    ]);
    const supplierEvents = await supplier.listEvents();
    assert.equal(supplierEvents.events.every((event) => event.requestId === seeded.requestId), true);
  } finally {
    await fake.close();
  }
});

test("role authorization rejects cross-role and uninvited mutations", async () => {
  const fake = await createFakePlatform();
  try {
    const seeded = fake.seedCase({ withQuoteRequest: true });
    const supplier = clientFor(fake, seeded.supplierToken);
    const otherToken = fake.issueToken("supplier");
    const other = clientFor(fake, otherToken);
    const otherRegistration = await other.registerParticipant(
      defaultSupplierRegistration("other.example"),
    );
    const buyer = clientFor(fake, seeded.buyerToken);

    await expectPlatformError(
      buyer.submitOffer(
        offerInput(seeded.request, seeded.buyerId, otherRegistration.participantId),
      ),
      "FORBIDDEN",
      403,
    );
    await expectPlatformError(supplier.createRequest(requestInput()), "FORBIDDEN", 403);
    await expectPlatformError(
      supplier.startDiscovery(seeded.requestId),
      "FORBIDDEN",
      403,
    );
  } finally {
    await fake.close();
  }
});

test("every fake response is marked as a test double", async () => {
  const fake = await createFakePlatform();
  try {
    const seeded = fake.seedCase();
    const response = await fetch(`${fake.url}/v1/events`, {
      headers: { Authorization: `Bearer ${seeded.buyerToken}` },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-test-double"), "true");
    assert.equal((await response.json() as { events: unknown[] }).events.length, 0);
  } finally {
    await fake.close();
  }
});
