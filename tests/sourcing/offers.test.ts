import assert from "node:assert/strict";
import { test } from "node:test";
import type { Offer, SourcingRequest } from "../../src/contracts.js";
import { OfferRanker } from "../../src/matching/offers.js";

const now = "2026-10-30T12:00:00.000Z";
const request: SourcingRequest = {
  id: "request-1",
  buyerId: "buyer-1",
  category: "components",
  description: "Electronic components",
  quantity: 5,
  unit: "box",
  destination: "Paris",
  maximumDeliveredTotal: { amountMinor: 10_000, currency: "EUR" },
  deliverBy: "2026-11-10T12:00:00.000Z",
  requirements: [
    { key: "compliant", description: "Compliant", mandatory: true },
    { key: "recycled", description: "Recycled", mandatory: false },
  ],
  demo: true,
};

function offer(overrides: Partial<Offer> = {}): Offer {
  return {
    id: "offer-1",
    requestId: request.id,
    buyerId: request.buyerId,
    supplierId: "supplier-1",
    quantity: request.quantity,
    unit: request.unit,
    destination: request.destination,
    deliveredTotal: { amountMinor: 5_000, currency: "EUR" },
    taxMinor: 500,
    deliveryMinor: 250,
    deliveryAt: "2026-11-05T12:00:00.000Z",
    expiresAt: "2026-10-31T12:00:00.000Z",
    confirmedRequirementKeys: ["compliant"],
    termsOrigin: "demo-supplier-declaration",
    demo: true,
    ...overrides,
  };
}

function rank(offers: Offer[], inputRequest: unknown = request, clock: Date = new Date(now)): Offer[] {
  return new OfferRanker({ now: () => clock }).rankOffers(inputRequest as SourcingRequest, offers);
}

test("ranks qualifying received offers by total, delivery time, then Unicode codepoint ID", () => {
  const early = offer({ id: "delivery-early", deliveredTotal: { amountMinor: 4_000, currency: "EUR" } });
  const late = offer({ id: "delivery-late", deliveredTotal: { amountMinor: 4_000, currency: "EUR" }, deliveryAt: "2026-11-06T12:00:00.000Z" });
  const nonBmpId = offer({ id: "\u{10000}", deliveredTotal: { amountMinor: 3_000, currency: "EUR" } });
  const bmpId = offer({ id: "\uE000", deliveredTotal: { amountMinor: 3_000, currency: "EUR" } });
  const moreExpensive = offer({ id: "more-expensive", deliveredTotal: { amountMinor: 4_001, currency: "EUR" } });

  assert.deepEqual(rank([moreExpensive, late, nonBmpId, early, bmpId]).map(({ id }) => id), [
    "\uE000", "\u{10000}", "delivery-early", "delivery-late", "more-expensive",
  ]);
});

test("filters malformed, incompatible, expired, or incomplete offers", () => {
  const invalid: Offer[] = [
    offer({ id: " " }),
    offer({ requestId: "another-request" }),
    offer({ buyerId: "another-buyer" }),
    offer({ supplierId: request.buyerId }),
    offer({ quantity: request.quantity - 1 }),
    offer({ unit: "each" }),
    offer({ destination: "Lyon" }),
    offer({ demo: false as unknown as true }),
    offer({ termsOrigin: "public-lead" as Offer["termsOrigin"] }),
    offer({ deliveredTotal: { amountMinor: 10_001, currency: "EUR" } }),
    offer({ deliveredTotal: { amountMinor: 5_000, currency: "USD" } }),
    offer({ deliveredTotal: { amountMinor: Number.MAX_SAFE_INTEGER + 1, currency: "EUR" } }),
    offer({ taxMinor: -1 }),
    offer({ deliveryMinor: -1 }),
    offer({ taxMinor: 4_751, deliveryMinor: 250 }),
    offer({ taxMinor: Number.MAX_SAFE_INTEGER, deliveryMinor: 1 }),
    offer({ deliveryAt: "2026-10-30T11:59:59.999Z" }),
    offer({ deliveryAt: "2026-11-11T12:00:00.000Z" }),
    offer({ deliveryAt: "2026-11-05T12:00:00" }),
    offer({ deliveryAt: "2026-02-30T12:00:00Z" }),
    offer({ expiresAt: now }),
    offer({ expiresAt: "2026-10-31T12:00:00" }),
    offer({ confirmedRequirementKeys: [] }),
    offer({ confirmedRequirementKeys: ["compliant", "compliant"] }),
    offer({ confirmedRequirementKeys: ["compliant", "unrequested"] }),
    Object.assign(offer(), { previousOfferId: "   " }),
  ];

  const accepted = offer({ id: "accepted" });
  for (const candidate of invalid) {
    assert.deepEqual(rank([candidate, accepted]).map(({ id }) => id), ["accepted"]);
  }
});

test("accepts delivery at now and optional confirmations while treating tax and delivery as included components", () => {
  const atBoundary = offer({
    deliveredTotal: { amountMinor: 10_000, currency: "EUR" },
    taxMinor: 9_000,
    deliveryMinor: 1_000,
    deliveryAt: now,
    confirmedRequirementKeys: ["compliant", "recycled"],
  });
  assert.deepEqual(rank([atBoundary]), [atBoundary]);
});

test("collapses identical IDs, but excludes every variant of a conflicting ID", () => {
  const one = offer({ id: "same" });
  const duplicate = { ...offer({ id: "same" }), privateMetadata: "must not leak" } as Offer;
  assert.equal(rank([one, duplicate]).length, 1);

  const conflicting = offer({ id: "same", deliveredTotal: { amountMinor: 4_999, currency: "EUR" } });
  assert.deepEqual(rank([one, conflicting]), []);

  const otherwiseInvalidConflict = offer({ id: "same", quantity: request.quantity + 1 });
  assert.deepEqual(rank([one, otherwiseInvalidConflict]), []);
});

test("copies only shared offer fields and leaves request and offer inputs unchanged", () => {
  const input = { ...offer(), privateMetadata: { secret: "never return" }, registered: true } as Offer;
  const before = structuredClone(input);
  const result = rank([input]);

  assert.deepEqual(input, before);
  assert.notStrictEqual(result[0], input);
  assert.notStrictEqual(result[0]!.deliveredTotal, input.deliveredTotal);
  assert.notStrictEqual(result[0]!.confirmedRequirementKeys, input.confirmedRequirementKeys);
  assert.deepEqual(Object.keys(result[0]!), [
    "id", "requestId", "buyerId", "supplierId", "quantity", "unit", "destination", "deliveredTotal",
    "taxMinor", "deliveryMinor", "deliveryAt", "expiresAt", "confirmedRequirementKeys", "termsOrigin", "demo",
  ]);
  assert.deepEqual(request, {
    id: "request-1", buyerId: "buyer-1", category: "components", description: "Electronic components", quantity: 5,
    unit: "box", destination: "Paris", maximumDeliveredTotal: { amountMinor: 10_000, currency: "EUR" },
    deliverBy: "2026-11-10T12:00:00.000Z", requirements: [
      { key: "compliant", description: "Compliant", mandatory: true },
      { key: "recycled", description: "Recycled", mandatory: false },
    ], demo: true,
  });

  assert.equal(rank([offer({ previousOfferId: "prior-offer" })])[0]!.previousOfferId, "prior-offer");
});

test("throws a generic TypeError for invalid comparator request fields", () => {
  const invalidRequests: unknown[] = [
    { ...request, id: " " },
    { ...request, buyerId: "" },
    ...[0, -1, Number.NaN, Number.POSITIVE_INFINITY].map((quantity) => ({ ...request, quantity })),
    { ...request, unit: " " },
    { ...request, destination: "" },
    { ...request, demo: false },
    { ...request, maximumDeliveredTotal: { amountMinor: 0, currency: "EUR" } },
    { ...request, maximumDeliveredTotal: { amountMinor: Number.MAX_SAFE_INTEGER + 1, currency: "EUR" } },
    ...["eur", "EURO", "E1R"].map((currency) => ({ ...request, maximumDeliveredTotal: { amountMinor: 10_000, currency } })),
    { ...request, deliverBy: "2026-10-30T12:00:00.000Z" },
    { ...request, deliverBy: "2026-11-10T12:00:00" },
    { ...request, deliverBy: "2026-02-30T12:00:00Z" },
    { ...request, deliverBy: "2026-11-10T12:00:00+14:30" },
    { ...request, requirements: [{ key: " ", description: "x", mandatory: true }] },
    { ...request, requirements: [request.requirements[0], request.requirements[0]] },
    { ...request, requirements: [{ key: "other", description: "x", mandatory: "yes" }] },
  ];

  for (const input of invalidRequests) {
    assert.throws(() => rank([], input), (error: unknown) => {
      assert.ok(error instanceof TypeError);
      assert.equal(error.message.includes("request-1"), false);
      return true;
    });
  }
});

test("rejects invalid clocks and a non-array offer collection explicitly", () => {
  assert.throws(() => rank([], request, new Date(Number.NaN)), TypeError);
  assert.throws(() => new OfferRanker({ now: "not-a-clock" as unknown as () => Date }).rankOffers(request, []), TypeError);
  assert.throws(() => new OfferRanker().rankOffers(request, null as unknown as Offer[]), TypeError);
});
