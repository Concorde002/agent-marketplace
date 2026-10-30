import assert from "node:assert/strict";
import { test } from "node:test";
import { derivePhase, operationFor } from "../../src/platform/observer-runs.js";
import { issueObserverKey } from "../../src/platform/observer-cli.js";
import { announceMcpClient, createObserverPlatform, driveRun, PRIVATE, sha256, type ObserverPlatform } from "./support/platform.js";

type Json = Record<string, any>;

async function observe(platform: ObserverPlatform, path: string, token = platform.tokens.observer, init: RequestInit = {}): Promise<{ status: number; body: Json; headers: Headers }> {
  const response = await fetch(`${platform.url}/v1/observer/${path}`, { ...init, headers: { authorization: `Bearer ${token}`, ...(init.headers as Record<string, string> ?? {}) } });
  const text = await response.text();
  return { status: response.status, body: text === "" ? {} : JSON.parse(text) as Json, headers: response.headers };
}

async function count(platform: ObserverPlatform, table: string): Promise<number> {
  return Number(((await platform.db.query(`select count(*)::int as n from marketplace.${table}`)).rows[0] as { n: number }).n);
}

test("a paid run is projected with both lanes, observed clients and a provider receipt", async () => {
  const platform = await createObserverPlatform();
  try {
    await announceMcpClient(platform, platform.tokens.buyer, "grok-bot", "2026.10");
    const { requestId, orderId } = await driveRun(platform, { counter: true });
    const { status, body } = await observe(platform, `runs/${requestId}`);
    assert.equal(status, 200);
    assert.equal(body.environment, "local-fixture");
    assert.equal(body.run.phase, "paid");
    assert.equal(body.run.terminal, true);
    assert.equal(body.order.id, orderId);
    assert.equal(body.order.payment.status, "succeeded");
    assert.match(body.order.payment.receiptReference, /^pi_fixture_/);

    const buyerOps = body.traces.filter((t: Json) => t.lane === "buyer").map((t: Json) => t.operation);
    const supplierOps = body.traces.filter((t: Json) => t.lane === "supplier").map((t: Json) => t.operation);
    for (const op of ["create_request", "start_discovery", "get_discovery_evidence", "read_discovery_source", "submit_discovery_assessment",
      "resolve_discovery_participants", "request_quote", "submit_offer", "settle_order"]) assert.ok(buyerOps.includes(op), `buyer lane has ${op}`);
    for (const op of ["get_request", "submit_offer", "accept_offer", "get_order"]) assert.ok(supplierOps.includes(op), `supplier lane has ${op}`);
    assert.ok(!buyerOps.includes("list_events") && !supplierOps.includes("list_events"), "polling is not a trace row");

    const buyerClient = body.clients.find((c: Json) => c.role === "buyer");
    assert.equal(buyerClient.configuredName, "Example Buyer");
    assert.deepEqual(buyerClient.observed.map((o: Json) => [o.channel, o.clientName, o.clientVersion]).sort(),
      [["http", "observer-fixture-driver/1.0", null], ["mcp", "grok-bot", "2026.10"]]);

    assert.equal(body.discovery.collection.returnedCount, 1);
    assert.match(body.discovery.collection.sources[0].contentHash, /^sha256:/);
    assert.equal(body.discovery.collection.notices[0].publicationNumber, "123456-2026");
    assert.ok(Date.parse(body.discovery.collection.notices[0].retrievedAt), "notice retrieval time is recorded");
    assert.equal(body.discovery.collection.cpvCodes, null, "CPV is reported as not recorded, not as empty");
    assert.equal(body.discovery.ranking.candidates[0].eligible, "yes");
    assert.equal(body.resolution[0].connected, true);
    assert.deepEqual(body.offers.map((o: Json) => [o.revision, o.author, o.status]), [[1, "supplier", "superseded"], [2, "buyer", "accepted"]]);
    assert.deepEqual(body.offers[1].acceptances.map((a: Json) => a.by).sort(), ["buyer", "supplier"]);
  } finally {
    await platform.close();
  }
});

test("no private limit, credential or payment method reaches the observer", async () => {
  const platform = await createObserverPlatform();
  try {
    const { requestId } = await driveRun(platform);
    const text = JSON.stringify((await observe(platform, `runs/${requestId}`)).body) + JSON.stringify((await observe(platform, "runs")).body);
    for (const secret of [String(PRIVATE.buyerMaxOrder), String(PRIVATE.buyerMaxRun), String(PRIVATE.supplierFloor), String(PRIVATE.requestMax),
      platform.tokens.buyer, platform.tokens.supplier, platform.tokens.observer, "pm_fixture", "cus_fixture", sha256(platform.tokens.observer)]) {
      assert.ok(!text.includes(secret), `observer output must not contain ${secret.slice(0, 12)}…`);
    }
  } finally {
    await platform.close();
  }
});

test("the observer session sees only its buyer's runs and only through observer routes", async () => {
  const platform = await createObserverPlatform();
  try {
    const own = await driveRun(platform);
    const other = await (async () => {
      const original = platform.tokens.buyer;
      platform.tokens.buyer = platform.tokens.otherBuyer;
      try { return await driveRun(platform); } finally { platform.tokens.buyer = original; }
    })().catch(() => undefined);
    const list = await observe(platform, "runs");
    assert.deepEqual(list.body.runs.map((r: Json) => r.id), [own.requestId]);
    assert.ok(other, "the other buyer completed a run");
    assert.equal((await observe(platform, `runs/${other.requestId}`)).status, 404);

    assert.equal((await observe(platform, "runs", platform.tokens.buyer)).status, 401, "a participant token is not an observer session");
    const asParticipant = await fetch(`${platform.url}/v1/me`, { headers: { authorization: `Bearer ${platform.tokens.observer}` } });
    assert.equal(asParticipant.status, 401, "an observer session is not a participant credential");
    assert.equal((await observe(platform, "runs", "")).status, 401);
    assert.equal((await observe(platform, "runs", platform.tokens.observer, { method: "POST" })).status, 405);

    await platform.db.query("reset role");
    await platform.db.query("update marketplace.observer_sessions set created_at = now() - interval '2 hours', expires_at = now() - interval '1 hour'");
    await platform.db.query("set role marketplace_app");
    const expired = await observe(platform, "runs");
    assert.equal(expired.status, 401);
    assert.equal(expired.body.code, "OBSERVER_SESSION_EXPIRED");
  } finally {
    await platform.close();
  }
});

test("observer polling is read-only: no traces, events, orders or payment attempts are created", async () => {
  const platform = await createObserverPlatform();
  try {
    const { requestId } = await driveRun(platform);
    const before = await Promise.all(["agent_traces", "participant_events", "orders", "payment_attempts", "client_sightings"].map((t) => count(platform, t)));
    for (let i = 0; i < 5; i += 1) { await observe(platform, "runs"); await observe(platform, `runs/${requestId}`); }
    const after = await Promise.all(["agent_traces", "participant_events", "orders", "payment_attempts", "client_sightings"].map((t) => count(platform, t)));
    assert.deepEqual(after, before);
  } finally {
    await platform.close();
  }
});

test("failed and pending payments never show a receipt", async () => {
  const failed = await createObserverPlatform({ payment: "failed" });
  try {
    const { requestId } = await driveRun(failed);
    const { body } = await observe(failed, `runs/${requestId}`);
    assert.equal(body.run.phase, "payment_failed");
    assert.equal(body.order.payment.receiptReference, null);
    assert.equal(body.order.payment.failureCode, "card_declined");
    assert.ok(body.traces.some((t: Json) => t.operation === "settle_order"), "the settle attempt is traced");
  } finally {
    await failed.close();
  }
  const pending = await createObserverPlatform({ payment: "pending" });
  try {
    const { requestId } = await driveRun(pending);
    const { body } = await observe(pending, `runs/${requestId}`);
    assert.equal(body.run.phase, "payment_pending");
    assert.equal(body.run.terminal, false);
    assert.equal(body.order.payment.receiptReference, null);
  } finally {
    await pending.close();
  }
});

test("a conditional candidate stays an unquoted lead: no quote, offer or order", async () => {
  const platform = await createObserverPlatform();
  try {
    const { requestId, orderId } = await driveRun(platform, { unknownRequirement: true });
    assert.equal(orderId, undefined);
    const { body } = await observe(platform, `runs/${requestId}`);
    assert.equal(body.discovery.ranking.candidates[0].eligible, "conditional");
    assert.deepEqual([body.quotes.length, body.offers.length, body.order], [0, 0, null]);
    assert.equal(body.run.phase, "resolved");
  } finally {
    await platform.close();
  }
});

test("CORS is granted only to configured observer origins", async () => {
  const platform = await createObserverPlatform({ allowedOrigins: ["https://agentmarketplace-observer.pages.dev"] });
  try {
    const allowed = await fetch(`${platform.url}/v1/observer/runs`, { method: "OPTIONS", headers: { origin: "https://agentmarketplace-observer.pages.dev" } });
    assert.equal(allowed.status, 204);
    assert.equal(allowed.headers.get("access-control-allow-origin"), "https://agentmarketplace-observer.pages.dev");
    assert.equal(allowed.headers.get("access-control-allow-methods"), "GET");
    const denied = await fetch(`${platform.url}/v1/observer/runs`, { method: "OPTIONS", headers: { origin: "https://evil.example" } });
    assert.equal(denied.status, 403);
    assert.equal(denied.headers.get("access-control-allow-origin"), null);
    const read = await observe(platform, "runs", platform.tokens.observer, { headers: { origin: "https://evil.example" } });
    assert.equal(read.headers.get("access-control-allow-origin"), null);
    const participant = await fetch(`${platform.url}/v1/me`, { headers: { origin: "https://agentmarketplace-observer.pages.dev", authorization: `Bearer ${platform.tokens.buyer}` } });
    assert.equal(participant.headers.get("access-control-allow-origin"), null, "participant routes are never cross-origin");
  } finally {
    await platform.close();
  }
});

test("phase follows authoritative state only", () => {
  const base = { requestStatus: "open", hasEvidence: false, hasRanking: false, hasResolution: false, quoteCount: 0, offerCount: 0, hasOrder: false };
  assert.equal(derivePhase(base), "request_created");
  assert.equal(derivePhase({ ...base, discoveryStatus: "running" }), "retrieving_sources");
  assert.equal(derivePhase({ ...base, discoveryStatus: "running", hasEvidence: true }), "awaiting_assessment");
  assert.equal(derivePhase({ ...base, discoveryStatus: "failed" }), "discovery_failed");
  assert.equal(derivePhase({ ...base, hasRanking: true }), "ranked");
  assert.equal(derivePhase({ ...base, offerCount: 2 }), "negotiating");
  assert.equal(derivePhase({ ...base, hasOrder: true }), "agreed");
  assert.equal(derivePhase({ ...base, hasOrder: true, paymentStatus: "creating" }), "payment_pending");
  assert.equal(derivePhase({ ...base, hasOrder: true, paymentStatus: "requires_action" }), "payment_requires_action");
  assert.equal(derivePhase({ ...base, requestStatus: "cancelled", offerCount: 1 }), "closed_without_agreement");
  assert.equal(operationFor("GET", ["v1", "events"])?.polling, true);
  assert.equal(operationFor("POST", ["v1", "offers", "x", "acceptances"])?.operation, "accept_offer");
  assert.equal(operationFor("DELETE", ["v1", "requests"]), undefined);
});

test("the operator key command stores only a hash and refuses unsafe input", () => {
  const issued = issueObserverKey({ buyer: "buyer", label: "Demo 31 Oct", hours: 8, createdBy: "test", now: new Date("2026-10-30T12:00:00Z") });
  assert.match(issued.token, /^obs_[A-Za-z0-9_-]{43}$/);
  assert.ok(issued.sql.includes(sha256(issued.token)));
  assert.ok(!issued.sql.includes(issued.token));
  assert.equal(issued.expiresAt, "2026-10-30T20:00:00.000Z");
  assert.throws(() => issueObserverKey({ buyer: "buyer'; drop", label: "x", hours: 1, createdBy: "t" }));
  assert.throws(() => issueObserverKey({ buyer: "buyer", label: "it's", hours: 1, createdBy: "t" }));
  assert.throws(() => issueObserverKey({ buyer: "buyer", label: "x", hours: 1000, createdBy: "t" }));
});

test("an offer the platform refuses is traced as a refusal and creates no order or payment", async () => {
  const platform = await createObserverPlatform();
  try {
    // Below the supplier's private floor: the platform refuses it.
    await assert.rejects(driveRun(platform, { askMinor: 500 }));
    const list = await observe(platform, "runs");
    const runId = list.body.runs[0].id as string;
    const { body } = await observe(platform, `runs/${runId}`);
    const refused = body.traces.find((t: Json) => t.operation === "submit_offer");
    assert.equal(refused.lane, "supplier");
    assert.equal(refused.ok, false);
    assert.equal(refused.errorCode, "POLICY_REFUSAL");
    assert.deepEqual([body.offers.length, body.order], [0, null]);
    assert.equal(await count(platform, "payment_attempts"), 0);
    assert.ok(!JSON.stringify(body).includes(String(PRIVATE.supplierFloor)), "the refusal does not reveal the floor");
  } finally {
    await platform.close();
  }
});
