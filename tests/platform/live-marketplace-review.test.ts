import assert from "node:assert/strict";
import { test } from "node:test";
import { buyer, fixture, offerTerms, quotedRequest, supplier, SUPPLIER_FLOOR_MINOR } from "./support/live-fixture.js";

// Review findings for PR #12 (issue #11). Disposable PGlite fixtures only.

test("a buyer counteroffer below the supplier's private floor is not refused, so the floor cannot be probed", async () => {
  const { db, market } = await fixture();
  try {
    const request = await quotedRequest(market);
    const offer = await market.submitOffer(supplier, offerTerms(request.id, 15000), "supplier-offer-1");
    // Probing just below and just above the floor must look identical to the buyer.
    const below = await market.submitOffer(buyer, offerTerms(request.id, SUPPLIER_FLOOR_MINOR - 1, { previousOfferId: offer.id }), "buyer-counter-1");
    assert.equal(below.deliveredTotal.amountMinor, SUPPLIER_FLOOR_MINOR - 1);
    assert.doesNotMatch(JSON.stringify(below), new RegExp(String(SUPPLIER_FLOOR_MINOR) + "\\b"));
    // The supplier is still protected: its acceptance of a below-floor revision is refused and creates no order.
    await assert.rejects(market.acceptOffer(supplier, below.id, "supplier-accept-1"), { code: "POLICY_REFUSAL" });
    assert.equal((await db.query("select * from marketplace.orders")).rows.length, 0);
  } finally { await db.close(); }
});

test("a buyer counteroffer before the supplier's private earliest delivery date is not refused either", async () => {
  const { db, market } = await fixture();
  try {
    const request = await quotedRequest(market);
    const offer = await market.submitOffer(supplier, offerTerms(request.id, 15000), "supplier-offer-1");
    await db.exec("reset role");
    await db.exec("update marketplace.mandates set earliest_delivery_at='2097-06-01Z' where participant_id='supplier'");
    await db.exec("set role marketplace_app");
    const early = await market.submitOffer(buyer, offerTerms(request.id, 14000, { previousOfferId: offer.id, deliveryAt: "2097-01-01T00:00:00Z" }), "buyer-counter-1");
    assert.equal(Date.parse(early.deliveryAt), Date.parse("2097-01-01T00:00:00Z"));
    await assert.rejects(market.acceptOffer(supplier, early.id, "supplier-accept-1"), { code: "POLICY_REFUSAL" });
  } finally { await db.close(); }
});

test("a supplier's own offer outside its own limits is still refused at submission", async () => {
  const { db, market } = await fixture();
  try {
    const request = await quotedRequest(market);
    await assert.rejects(market.submitOffer(supplier, offerTerms(request.id, SUPPLIER_FLOOR_MINOR - 1), "supplier-low-1"), { code: "POLICY_REFUSAL" });
  } finally { await db.close(); }
});

test("offers and acceptances on a closed request return 409 REQUEST_CLOSED, not a retryable 503", async () => {
  const { db, market, call } = await fixture();
  try {
    const request = await quotedRequest(market);
    const offer = await market.submitOffer(supplier, offerTerms(request.id, 15000), "supplier-offer-1");
    assert.equal((await market.acceptOffer(buyer, offer.id, "buyer-accept-1")).state, "agreed");
    const late = await call(`/v1/requests/${request.id}/offers`, offerTerms(request.id, 14000), "fixture-supplier-token");
    assert.equal(late.status, 409);
    assert.equal((await late.json() as { code: string }).code, "REQUEST_CLOSED");
    // With capacity left, only the database trigger stops it; that must not surface as a retryable outage.
    await db.exec("reset role");
    await db.exec("update marketplace.operator_grants set max_available_quantity=20 where id='gs'; update marketplace.mandates set available_quantity=20 where participant_id='supplier'");
    await db.exec("set role marketplace_app");
    const withCapacity = await call(`/v1/requests/${request.id}/offers`, offerTerms(request.id, 14000), "fixture-supplier-token");
    assert.equal(withCapacity.status, 409, `got ${withCapacity.status} ${JSON.stringify(await withCapacity.clone().json())}`);
  } finally { await db.close(); }
});

test("legacy clients may send buyerId/supplierId only when they equal the server-derived parties", async () => {
  const { db, market, call } = await fixture();
  try {
    const request = await quotedRequest(market);
    // The CLI runtimes build Omit<Offer, "id">, which includes both participant ids.
    const legacy = await call(`/v1/requests/${request.id}/offers`, offerTerms(request.id, 15000, { buyerId: buyer.participantId, supplierId: supplier.participantId }), "fixture-supplier-token");
    assert.equal(legacy.status, 200);
    const stored = (await db.query<{ buyer_id: string; supplier_id: string; created_by: string }>("select buyer_id,supplier_id,created_by from marketplace.offers")).rows;
    assert.deepEqual(stored, [{ buyer_id: buyer.participantId, supplier_id: supplier.participantId, created_by: supplier.participantId }]);
    // Identifiers are never authority: a mismatch is refused, and nothing is stored.
    for (const forged of [{ buyerId: "someone-else" }, { supplierId: buyer.participantId }]) {
      const response = await call(`/v1/requests/${request.id}/offers`, offerTerms(request.id, 14000, { buyerId: buyer.participantId, supplierId: supplier.participantId, ...forged }), "fixture-supplier-token");
      assert.equal(response.status, 403);
      assert.equal((await response.json() as { code: string }).code, "PARTICIPANT_MISMATCH");
    }
    assert.equal((await db.query("select * from marketplace.offers")).rows.length, 1);
    // Other unknown fields remain refused.
    assert.equal((await call(`/v1/requests/${request.id}/offers`, offerTerms(request.id, 14000, { actor: "x" }), "fixture-supplier-token")).status, 400);
  } finally { await db.close(); }
});

test("a legacy offer replay with the same key returns the same offer", async () => {
  const { db, market, call } = await fixture();
  try {
    const request = await quotedRequest(market);
    const body = offerTerms(request.id, 15000, { buyerId: buyer.participantId, supplierId: supplier.participantId });
    const first = await (await call(`/v1/requests/${request.id}/offers`, body, "fixture-supplier-token", "legacy-offer-key-1")).json() as { id: string };
    const again = await (await call(`/v1/requests/${request.id}/offers`, body, "fixture-supplier-token", "legacy-offer-key-1")).json() as { id: string };
    assert.equal(again.id, first.id);
    assert.equal((await db.query("select * from marketplace.offers")).rows.length, 1);
  } finally { await db.close(); }
});
