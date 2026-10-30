import assert from "node:assert/strict";
import { test } from "node:test";

import type { Offer } from "../../src/contracts.js";
import {
  buyerCounterAmount,
  supplierCounterAmount,
  canSubmitRevision,
  checkBuyerOffer,
  checkSupplierOffer,
  createNegotiationState,
  decideBuyerOffer,
  decideSupplierOffer,
  mandatoryRequirementKeys,
  negotiationStatus,
  recordOfferRevision,
  remainingRunTotal,
  resolveNegotiationLimits,
  supplierInitialAskAmount,
  type BuyerPolicy,
  type SupplierPolicy,
} from "../../src/agents/policy.js";

const NOW = Date.parse("2026-10-30T12:00:00.000Z");

function makeOffer(overrides: Partial<Offer> = {}): Offer {
  return {
    id: "offer-1",
    requestId: "request-1",
    buyerId: "buyer-1",
    supplierId: "supplier-1",
    quantity: 10,
    unit: "crate",
    destination: "Berlin",
    deliveredTotal: { amountMinor: 1100, currency: "EUR" },
    taxMinor: 0,
    deliveryMinor: 0,
    deliveryAt: "2026-11-10T00:00:00.000Z",
    expiresAt: "2026-12-01T00:00:00.000Z",
    confirmedRequirementKeys: ["cert"],
    termsOrigin: "demo-supplier-declaration",
    demo: true,
    ...overrides,
  };
}

function buyerPolicy(overrides: Partial<BuyerPolicy> = {}): BuyerPolicy {
  return {
    maximumOrderTotalMinor: 1200,
    remainingRunTotalMinor: 5000,
    currency: "EUR",
    destination: "Berlin",
    quantity: 10,
    unit: "crate",
    deliverBy: "2026-11-15T00:00:00.000Z",
    mandatoryRequirementKeys: ["cert"],
    expiresAt: "2026-12-31T00:00:00.000Z",
    ...overrides,
  };
}

function supplierPolicy(overrides: Partial<SupplierPolicy> = {}): SupplierPolicy {
  return {
    minimumDeliveredTotalMinor: 1000,
    availableQuantity: 10,
    earliestDeliveryAt: "2026-11-05T00:00:00.000Z",
    expiresAt: "2026-12-31T00:00:00.000Z",
    unit: "crate",
    currency: "EUR",
    ...overrides,
  };
}

test("buyer accepts an offer on every boundary", () => {
  const check = checkBuyerOffer(
    makeOffer({
      deliveredTotal: { amountMinor: 1200, currency: "EUR" },
      deliveryAt: "2026-11-15T00:00:00.000Z",
      expiresAt: "2026-10-30T12:00:00.001Z",
    }),
    buyerPolicy({ remainingRunTotalMinor: 1200 }),
    NOW,
  );
  assert.deepEqual(check, { ok: true, reasons: [] });
});

test("buyer refusal matrix names every failed check", () => {
  const cases: Array<[string, Offer, BuyerPolicy]> = [
    ["quantity_mismatch", makeOffer({ quantity: 9 }), buyerPolicy()],
    ["unit_mismatch", makeOffer({ unit: "pallet" }), buyerPolicy()],
    [
      "destination_mismatch",
      makeOffer({ destination: "Hamburg" }),
      buyerPolicy(),
    ],
    [
      "currency_mismatch",
      makeOffer({ deliveredTotal: { amountMinor: 1100, currency: "USD" } }),
      buyerPolicy(),
    ],
    [
      "order_total_exceeded",
      makeOffer({ deliveredTotal: { amountMinor: 1201, currency: "EUR" } }),
      buyerPolicy(),
    ],
    [
      "run_total_exceeded",
      makeOffer({ deliveredTotal: { amountMinor: 901, currency: "EUR" } }),
      buyerPolicy({ remainingRunTotalMinor: 900 }),
    ],
    [
      "delivery_after_deadline",
      makeOffer({ deliveryAt: "2026-11-16T00:00:00.000Z" }),
      buyerPolicy(),
    ],
    [
      "offer_expired",
      makeOffer({ expiresAt: "2026-10-30T12:00:00.000Z" }),
      buyerPolicy(),
    ],
    [
      "mandate_expired",
      makeOffer(),
      buyerPolicy({ expiresAt: "2026-10-30T11:59:59.000Z" }),
    ],
    [
      "missing_mandatory_requirement",
      makeOffer({ confirmedRequirementKeys: [] }),
      buyerPolicy(),
    ],
  ];

  for (const [reason, offer, policy] of cases) {
    const check = checkBuyerOffer(offer, policy, NOW);
    assert.equal(check.ok, false, reason);
    assert.deepEqual(check.reasons, [reason], reason);
  }
});

test("buyer reports multiple independent refusals", () => {
  const check = checkBuyerOffer(
    makeOffer({
      quantity: 1,
      unit: "pallet",
      destination: "Hamburg",
      deliveredTotal: { amountMinor: 5000, currency: "USD" },
      deliveryAt: "2026-12-01T00:00:00.000Z",
      expiresAt: "2026-01-01T00:00:00.000Z",
      confirmedRequirementKeys: ["other"],
    }),
    buyerPolicy({ remainingRunTotalMinor: 1000 }),
    NOW,
  );

  assert.deepEqual(check.reasons, [
    "quantity_mismatch",
    "unit_mismatch",
    "destination_mismatch",
    "currency_mismatch",
    "order_total_exceeded",
    "run_total_exceeded",
    "delivery_after_deadline",
    "offer_expired",
    "missing_mandatory_requirement",
  ]);
});

test("supplier accepts an offer at floor, capacity and earliest delivery", () => {
  const check = checkSupplierOffer(
    makeOffer({
      deliveredTotal: { amountMinor: 1000, currency: "EUR" },
      quantity: 10,
      deliveryAt: "2026-11-05T00:00:00.000Z",
      expiresAt: "2026-10-30T12:00:00.001Z",
    }),
    supplierPolicy(),
    NOW,
  );
  assert.deepEqual(check, { ok: true, reasons: [] });
});

test("supplier refusal matrix names every failed check", () => {
  const cases: Array<[string, Offer, SupplierPolicy]> = [
    [
      "below_minimum",
      makeOffer({ deliveredTotal: { amountMinor: 999, currency: "EUR" } }),
      supplierPolicy(),
    ],
    ["quantity_unavailable", makeOffer({ quantity: 11 }), supplierPolicy()],
    [
      "delivery_before_earliest",
      makeOffer({ deliveryAt: "2026-11-04T23:59:59.000Z" }),
      supplierPolicy(),
    ],
    ["unit_mismatch", makeOffer({ unit: "pallet" }), supplierPolicy()],
    [
      "currency_mismatch",
      makeOffer({ deliveredTotal: { amountMinor: 1100, currency: "USD" } }),
      supplierPolicy(),
    ],
    [
      "offer_expired",
      makeOffer({ expiresAt: "2026-10-30T12:00:00.000Z" }),
      supplierPolicy(),
    ],
    [
      "mandate_expired",
      makeOffer(),
      supplierPolicy({ expiresAt: "2026-10-30T11:59:59.000Z" }),
    ],
  ];

  for (const [reason, offer, policy] of cases) {
    const check = checkSupplierOffer(offer, policy, NOW);
    assert.equal(check.ok, false, reason);
    assert.deepEqual(check.reasons, [reason], reason);
  }
});

test("supplier initial ask is ceil(minimum * 1.10) in integer minor units", () => {
  assert.equal(supplierInitialAskAmount(1000), 1100);
  assert.equal(supplierInitialAskAmount(1001), 1102);
  assert.equal(supplierInitialAskAmount(1), 2);
  assert.equal(supplierInitialAskAmount(0), 0);
  assert.equal(supplierInitialAskAmount(999_999_999), 1_099_999_999);
  assert.throws(() => supplierInitialAskAmount(-1), RangeError);
  assert.throws(() => supplierInitialAskAmount(1.5), RangeError);
});

test("buyer counter opens 10% below the lower of ask and budget, never at the budget", () => {
  assert.equal(buyerCounterAmount(800, 1000), 720);
  assert.equal(buyerCounterAmount(801, 1000), 720);
  assert.equal(buyerCounterAmount(1000, 1000), 900);
  assert.equal(buyerCounterAmount(1100, 1000), 900);
  assert.equal(buyerCounterAmount(1300, 1200), 1080);
  assert.equal(buyerCounterAmount(0, 1000), 0);
  assert.throws(() => buyerCounterAmount(-1, 1000), RangeError);
  assert.throws(() => buyerCounterAmount(1000, 1.5), RangeError);
});

test("supplier counter splits the difference, never below the floor or above a feasible budget", () => {
  // Ask 484000, bid 435600, floor 440000: meet halfway.
  assert.equal(
    supplierCounterAmount({ minimumDeliveredTotalMinor: 440_000, buyerBidMinor: 435_600, previousAskMinor: 484_000 }),
    459_800,
  );
  // Halfway is under the floor: hold the floor.
  assert.equal(
    supplierCounterAmount({ minimumDeliveredTotalMinor: 500_000, buyerBidMinor: 180_000, previousAskMinor: 550_000 }),
    500_000,
  );
  // A stated budget between floor and halfway caps the reply so the deal is not lost.
  assert.equal(
    supplierCounterAmount({
      minimumDeliveredTotalMinor: 440_000,
      buyerBidMinor: 420_000,
      previousAskMinor: 484_000,
      buyerBudgetMinor: 445_000,
    }),
    445_000,
  );
  // A budget below the floor never pulls the reply under the floor.
  assert.equal(
    supplierCounterAmount({
      minimumDeliveredTotalMinor: 440_000,
      buyerBidMinor: 300_000,
      previousAskMinor: 484_000,
      buyerBudgetMinor: 400_000,
    }),
    440_000,
  );
  // No previous ask known: the floor.
  assert.equal(supplierCounterAmount({ minimumDeliveredTotalMinor: 440_000, buyerBidMinor: 1 }), 440_000);
});

test("negotiation limits default to the hard ceilings and cannot be raised", () => {
  assert.deepEqual(resolveNegotiationLimits(), {
    maxRevisions: 3,
    deadlineMs: 300000,
  });
  assert.deepEqual(resolveNegotiationLimits({ maxRevisions: 9, deadlineMs: 900000 }), {
    maxRevisions: 3,
    deadlineMs: 300000,
  });
  assert.deepEqual(resolveNegotiationLimits({ maxRevisions: 2, deadlineMs: 60000 }), {
    maxRevisions: 2,
    deadlineMs: 60000,
  });
  assert.deepEqual(resolveNegotiationLimits({ maxRevisions: 0, deadlineMs: 0 }), {
    maxRevisions: 3,
    deadlineMs: 300000,
  });
});

test("negotiation status stops at the revision and deadline caps", () => {
  const start = createNegotiationState(NOW);
  assert.deepEqual(negotiationStatus(start, {}, NOW), { open: true });
  assert.equal(canSubmitRevision(start, {}, NOW), true);

  const revisionCapped = { revisions: 3, startedAtMs: NOW };
  assert.deepEqual(negotiationStatus(revisionCapped, {}, NOW), {
    open: false,
    reason: "revision_limit",
  });

  assert.deepEqual(
    negotiationStatus(start, { deadlineMs: 1000 }, NOW + 999),
    { open: true },
  );
  assert.deepEqual(
    negotiationStatus(start, { deadlineMs: 1000 }, NOW + 1000),
    { open: false, reason: "deadline_exceeded" },
  );
});

test("recording revisions stops at the configured cap", () => {
  let state = createNegotiationState(NOW);
  assert.equal(state.revisions, 0);
  state = recordOfferRevision(state, { maxRevisions: 3 });
  state = recordOfferRevision(state, { maxRevisions: 3 });
  state = recordOfferRevision(state, { maxRevisions: 3 });
  assert.equal(state.revisions, 3);
  state = recordOfferRevision(state, { maxRevisions: 3 });
  assert.equal(state.revisions, 3);
  assert.equal(state.startedAtMs, NOW);
});

test("buyer opens below an affordable ask, accepts it when no reply fits, and counters an over-budget ask", () => {
  // The supplier's first ask is revision 1; a counter (2) and a reply (3) still fit.
  const opening = { revisions: 1, startedAtMs: NOW };
  assert.deepEqual(
    decideBuyerOffer({ offer: makeOffer(), policy: buyerPolicy(), state: opening, nowMs: NOW }),
    { kind: "counter", amountMinor: 990, reasons: [] },
  );

  // The supplier's reply is revision 3: nothing left to counter, so accept a valid offer.
  assert.deepEqual(
    decideBuyerOffer({
      offer: makeOffer(),
      policy: buyerPolicy(),
      state: { revisions: 3, startedAtMs: NOW },
      nowMs: NOW,
    }),
    { kind: "accept" },
  );

  const decision = decideBuyerOffer({
    offer: makeOffer({ deliveredTotal: { amountMinor: 1300, currency: "EUR" } }),
    policy: buyerPolicy(),
    state: opening,
    nowMs: NOW,
  });
  assert.deepEqual(decision, {
    kind: "counter",
    amountMinor: 1080,
    reasons: ["order_total_exceeded"],
  });

  // Exactly one revision left: the final counter is the full ceiling.
  const final = decideBuyerOffer({
    offer: makeOffer({ deliveredTotal: { amountMinor: 1300, currency: "EUR" } }),
    policy: buyerPolicy(),
    state: { revisions: 2, startedAtMs: NOW },
    nowMs: NOW,
  });
  assert.deepEqual(final, {
    kind: "counter",
    amountMinor: 1200,
    reasons: ["order_total_exceeded"],
  });
});

test("buyer refuses when the revision cap is exhausted", () => {
  const decision = decideBuyerOffer({
    offer: makeOffer({ deliveredTotal: { amountMinor: 1300, currency: "EUR" } }),
    policy: buyerPolicy(),
    state: { revisions: 3, startedAtMs: NOW },
    nowMs: NOW,
  });
  assert.equal(decision.kind, "refuse");
  if (decision.kind === "refuse") {
    assert.deepEqual(decision.reasons, [
      "order_total_exceeded",
      "revision_limit",
    ]);
  }
});

test("buyer refuses a valid offer after the deadline but accepts at the revision cap", () => {
  const deadlineDecision = decideBuyerOffer({
    offer: makeOffer(),
    policy: buyerPolicy(),
    state: createNegotiationState(NOW),
    nowMs: NOW + 300000,
  });
  assert.deepEqual(deadlineDecision, {
    kind: "refuse",
    reasons: ["deadline_exceeded"],
  });

  const revisionDecision = decideBuyerOffer({
    offer: makeOffer(),
    policy: buyerPolicy(),
    state: { revisions: 3, startedAtMs: NOW },
    nowMs: NOW,
  });
  assert.deepEqual(revisionDecision, { kind: "accept" });
});

test("buyer refuses a structurally invalid offer instead of countering it", () => {
  const decision = decideBuyerOffer({
    offer: makeOffer({ deliveredTotal: { amountMinor: -1, currency: "EUR" } }),
    policy: buyerPolicy(),
    state: createNegotiationState(NOW),
    nowMs: NOW,
  });
  assert.deepEqual(decision, { kind: "refuse", reasons: ["invalid_offer"] });
});

test("supplier asks 110% on revision one and settles at the minimum later", () => {
  const initial = decideSupplierOffer({
    policy: supplierPolicy(),
    state: createNegotiationState(NOW),
    nowMs: NOW,
  });
  assert.deepEqual(initial, { kind: "offer", amountMinor: 1100 });

  const belowFloor = decideSupplierOffer({
    offer: makeOffer({ deliveredTotal: { amountMinor: 999, currency: "EUR" } }),
    policy: supplierPolicy(),
    state: { revisions: 1, startedAtMs: NOW },
    nowMs: NOW,
  });
  assert.deepEqual(belowFloor, {
    kind: "offer",
    amountMinor: 1000,
    reasons: ["below_minimum"],
  });

  const atFloor = decideSupplierOffer({
    offer: makeOffer({ deliveredTotal: { amountMinor: 1000, currency: "EUR" } }),
    policy: supplierPolicy(),
    state: { revisions: 1, startedAtMs: NOW },
    nowMs: NOW,
  });
  assert.deepEqual(atFloor, { kind: "accept" });
});

test("supplier never offers below the minimum and refuses incompatible terms", () => {
  const unavailable = decideSupplierOffer({
    offer: makeOffer({
      quantity: 11,
      deliveredTotal: { amountMinor: 1500, currency: "EUR" },
    }),
    policy: supplierPolicy(),
    state: { revisions: 1, startedAtMs: NOW },
    nowMs: NOW,
  });
  assert.deepEqual(unavailable, {
    kind: "refuse",
    reasons: ["quantity_unavailable"],
  });

  const capped = decideSupplierOffer({
    offer: makeOffer({ deliveredTotal: { amountMinor: 999, currency: "EUR" } }),
    policy: supplierPolicy(),
    state: { revisions: 3, startedAtMs: NOW },
    nowMs: NOW,
  });
  assert.deepEqual(capped, {
    kind: "refuse",
    reasons: ["below_minimum", "revision_limit"],
  });
});

test("supplier accepts a valid final offer at the revision cap and refuses after the deadline", () => {
  const accepted = decideSupplierOffer({
    offer: makeOffer({ deliveredTotal: { amountMinor: 1000, currency: "EUR" } }),
    policy: supplierPolicy(),
    state: { revisions: 3, startedAtMs: NOW },
    nowMs: NOW,
  });
  assert.deepEqual(accepted, { kind: "accept" });

  const expired = decideSupplierOffer({
    policy: supplierPolicy(),
    state: createNegotiationState(NOW),
    nowMs: NOW + 300000,
  });
  assert.deepEqual(expired, {
    kind: "refuse",
    reasons: ["deadline_exceeded"],
  });
});

test("requirement and run-total helpers derive safe policy inputs", () => {
  assert.deepEqual(
    mandatoryRequirementKeys([
      { key: "cert", mandatory: true },
      { key: "sample", mandatory: false },
      { key: "origin", mandatory: true },
    ]),
    ["cert", "origin"],
  );
  assert.equal(remainingRunTotal(5000, 1200), 3800);
  assert.equal(remainingRunTotal(5000, 6000), 0);
  assert.throws(() => remainingRunTotal(-1, 0), RangeError);
});

test("buyer refuses instead of countering every non-price refusal", () => {
  const cases: Array<[string, Offer, BuyerPolicy]> = [
    ["quantity_mismatch", makeOffer({ quantity: 9 }), buyerPolicy()],
    ["unit_mismatch", makeOffer({ unit: "pallet" }), buyerPolicy()],
    [
      "destination_mismatch",
      makeOffer({ destination: "Hamburg" }),
      buyerPolicy(),
    ],
    [
      "currency_mismatch",
      makeOffer({ deliveredTotal: { amountMinor: 1100, currency: "USD" } }),
      buyerPolicy(),
    ],
    [
      "delivery_after_deadline",
      makeOffer({ deliveryAt: "2026-11-16T00:00:00.000Z" }),
      buyerPolicy(),
    ],
    [
      "offer_expired",
      makeOffer({ expiresAt: "2026-10-30T12:00:00.000Z" }),
      buyerPolicy(),
    ],
    [
      "mandate_expired",
      makeOffer(),
      buyerPolicy({ expiresAt: "2026-10-30T11:59:59.000Z" }),
    ],
    [
      "missing_mandatory_requirement",
      makeOffer({ confirmedRequirementKeys: [] }),
      buyerPolicy(),
    ],
  ];

  for (const [reason, offer, policy] of cases) {
    const decision = decideBuyerOffer({
      offer,
      policy,
      state: createNegotiationState(NOW),
      nowMs: NOW,
    });
    assert.equal(decision.kind, "refuse", reason);
    if (decision.kind === "refuse") {
      assert.deepEqual(decision.reasons, [reason], reason);
    }
  }
});

test("buyer counters only when every failed check is a price reason", () => {
  const overBudget = decideBuyerOffer({
    offer: makeOffer({ deliveredTotal: { amountMinor: 1300, currency: "EUR" } }),
    policy: buyerPolicy(),
    state: createNegotiationState(NOW),
    nowMs: NOW,
  });
  assert.deepEqual(overBudget, {
    kind: "counter",
    amountMinor: 1080,
    reasons: ["order_total_exceeded"],
  });

  const overRun = decideBuyerOffer({
    offer: makeOffer({ deliveredTotal: { amountMinor: 901, currency: "EUR" } }),
    policy: buyerPolicy({ remainingRunTotalMinor: 900 }),
    state: createNegotiationState(NOW),
    nowMs: NOW,
  });
  assert.deepEqual(overRun, {
    kind: "counter",
    amountMinor: 810,
    reasons: ["run_total_exceeded"],
  });

  const bothPriceReasons = decideBuyerOffer({
    offer: makeOffer({ deliveredTotal: { amountMinor: 1300, currency: "EUR" } }),
    policy: buyerPolicy({ remainingRunTotalMinor: 1000 }),
    state: createNegotiationState(NOW),
    nowMs: NOW,
  });
  assert.deepEqual(bothPriceReasons, {
    kind: "counter",
    amountMinor: 900,
    reasons: ["order_total_exceeded", "run_total_exceeded"],
  });
});

test("buyer refuses a mixed price and non-price refusal", () => {
  const decision = decideBuyerOffer({
    offer: makeOffer({
      quantity: 9,
      deliveredTotal: { amountMinor: 1300, currency: "EUR" },
    }),
    policy: buyerPolicy(),
    state: createNegotiationState(NOW),
    nowMs: NOW,
  });
  assert.deepEqual(decision, {
    kind: "refuse",
    reasons: ["quantity_mismatch", "order_total_exceeded"],
  });
});

test("buyer refuses a price failure once the revision or deadline cap is exhausted", () => {
  const atRevisionCap = decideBuyerOffer({
    offer: makeOffer({ deliveredTotal: { amountMinor: 1300, currency: "EUR" } }),
    policy: buyerPolicy(),
    state: { revisions: 3, startedAtMs: NOW },
    nowMs: NOW,
  });
  assert.deepEqual(atRevisionCap, {
    kind: "refuse",
    reasons: ["order_total_exceeded", "revision_limit"],
  });

  const afterDeadline = decideBuyerOffer({
    offer: makeOffer({ deliveredTotal: { amountMinor: 1300, currency: "EUR" } }),
    policy: buyerPolicy(),
    state: createNegotiationState(NOW),
    nowMs: NOW + 300000,
  });
  assert.deepEqual(afterDeadline, {
    kind: "refuse",
    reasons: ["order_total_exceeded", "deadline_exceeded"],
  });
});
