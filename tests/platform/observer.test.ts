import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import WebSocket from "ws";
import { handleRequest, type Dependencies } from "../../src/index.js";
import { createPlatformHttp } from "../../src/platform/http.js";
import { ObserverBus, describe as describeCall, type ObserverLog } from "../../src/platform/observer.js";
import { attachObserverSocket, OBSERVER_PATH, OBSERVER_PROTOCOL } from "../../src/platform/observer-socket.js";
import { toNodeListener } from "../../src/server-adapter.js";
import { buyer, fixture, now, offerTerms, requestInput, supplier } from "./support/live-fixture.js";

// Observer log stream. Disposable PGlite fixture and loopback sockets only.
// A broken socket safeguard must fail a test, not hang the suite waiting for a close that never comes.
const limit = { timeout: 10_000 };

async function observed() {
  const base = await fixture();
  const bus = new ObserverBus();
  const logs: ObserverLog[] = [];
  bus.subscribe((log) => logs.push(log));
  const platform = createPlatformHttp({ query: (sql, params) => base.db.query(sql, params), transaction: (action) => base.db.transaction((tx) => action(tx)) }, base.market, { now, observer: bus });
  const deps = { platform, observer: bus } as unknown as Dependencies;
  let keys = 0;
  const call = (path: string, body?: unknown, token = "fixture-buyer-token", method = body === undefined ? "GET" : "POST") =>
    handleRequest(new Request(`https://marketplace.example.com${path}`, {
      method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "idempotency-key": `observer-key-${++keys}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }), deps);
  return { ...base, bus, logs, call, deps };
}

/** Runs the real negotiation path over HTTP, one call per step. */
async function negotiate(call: Awaited<ReturnType<typeof observed>>["call"]) {
  const request = await (await call("/v1/requests", requestInput)).json() as { id: string };
  const { discoveryId } = await (await call(`/v1/requests/${request.id}/discover`, {})).json() as { discoveryId: string };
  await call(`/v1/discoveries/${discoveryId}/evidence`);
  await call(`/v1/discoveries/${discoveryId}/assessments`, { discoveryId, buyerNoticeNumber: requestInput.buyerNoticeNumber,
    candidates: [{ company: { name: "Alpha Components", officialDomain: "alpha.example.com" },
      identity: { sourceId: `${discoveryId}:source-1`, quotation: "Alpha Components manufactures steel components." },
      claims: [{ requirementKey: "quality", outcome: "match", sourceId: `${discoveryId}:source-1`, quotation: "ISO 9001:2015 certified." }] }] });
  await call(`/v1/discoveries/${discoveryId}/resolve`, {});
  await call(`/v1/requests/${request.id}/quote-requests`, { supplierId: supplier.participantId });
  const offer = await (await call(`/v1/requests/${request.id}/offers`, offerTerms(request.id, 15000), "fixture-supplier-token")).json() as { id: string };
  const accepted = await (await call(`/v1/offers/${offer.id}/acceptances`, {})).json() as { order: { id: string } };
  await call(`/v1/orders/${accepted.order.id}`);
  return { request, discoveryId, offer, orderId: accepted.order.id };
}

test("every platform endpoint call emits exactly one log, in order, with the authenticated actor", limit, async () => {
  const { db, logs, call } = await observed();
  try {
    await call("/v1/me");
    const { orderId } = await negotiate(call);
    await call("/v1/events?after=0", undefined, "fixture-supplier-token");
    assert.deepEqual(logs.map((l) => l.operation), ["get_my_participant", "create_request", "start_discovery", "get_discovery_evidence",
      "submit_discovery_assessment", "resolve_discovery_participants", "request_quote", "submit_offer", "accept_offer", "get_order", "list_events"]);
    assert.ok(logs.every((l) => l.type === "log" && l.v === 1 && l.source === "http" && l.outcome === "ok" && l.status === 200));
    assert.deepEqual(logs.map((l) => l.seq), logs.map((_, i) => i + 1));
    assert.equal(logs.find((l) => l.operation === "submit_offer")?.actor?.role, "supplier");
    const agreed = logs.find((l) => l.operation === "accept_offer")!;
    assert.equal(agreed.subject?.orderId, orderId);
    assert.match(agreed.message, /^Buyer buyer accepted offer .+\. Both sides agreed: order .+ for €150\.00\.$/);
    assert.match(logs.find((l) => l.operation === "submit_offer")!.message, /^Supplier supplier made an offer on request .+: 10 box for €150\.00, delivery 2098-01-01/);
    assert.equal(logs.find((l) => l.operation === "get_my_participant")?.level, "debug");
    assert.equal(logs.find((l) => l.operation === "create_request")?.level, "info");
  } finally { await db.close(); }
});

test("logs never carry private limits, budgets, credentials or headers", limit, async () => {
  const { db, logs, call } = await observed();
  try {
    await negotiate(call);
    await call("/v1/me", undefined, "fixture-wrong-token");
    const all = JSON.stringify(logs);
    // Fixture: buyer request budget 20000 minor (€200.00), supplier floor 1000 minor (€10.00), capacity 10.
    for (const secret of ["€200.00", "20000", "€10.00", "maximumDeliveredTotal", "min_delivered", "fixture-buyer-token", "fixture-supplier-token",
      "fixture-wrong-token", "Bearer", "authorization", "idempotency", "mandate"]) {
      assert.equal(all.includes(secret), false, `log stream contains ${secret}`);
    }
    assert.doesNotMatch(logs.find((l) => l.operation === "create_request")!.message, /€/);
  } finally { await db.close(); }
});

test("refusals and failed authentication are logged with their code, never with the token", limit, async () => {
  const { db, logs, call } = await observed();
  try {
    await call("/v1/requests", requestInput, "fixture-supplier-token");
    await call("/v1/me", undefined, "not-a-real-token");
    const [forbidden, unauthenticated] = logs;
    assert.equal(forbidden?.outcome, "refused");
    assert.equal(forbidden?.level, "warn");
    assert.equal(forbidden?.code, "FORBIDDEN");
    assert.equal(forbidden?.message, "Supplier supplier tried to create request and was refused: FORBIDDEN.");
    assert.equal(unauthenticated?.actor, undefined);
    assert.equal(unauthenticated?.message, "An unauthenticated caller tried to get my participant and was refused: INVALID_CREDENTIAL.");
  } finally { await db.close(); }
});

test("an MCP tool call logs the tool and its internal call, correlated by parentRequestId", limit, async () => {
  const { db, logs, call, market } = await observed();
  try {
    const request = await market.createRequest(buyer, requestInput, "seed-request-1");
    await call("/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_request", arguments: { requestId: request.id } } });
    const outer = logs.find((l) => l.operation === "mcp")!;
    const inner = logs.find((l) => l.operation === "get_request")!;
    assert.equal(outer.subject?.tool, "get_request");
    assert.equal(outer.message, "Buyer buyer called MCP tool get_request.");
    assert.equal(outer.source, "http");
    assert.equal(inner.source, "mcp");
    assert.equal(inner.parentRequestId, outer.requestId);
    assert.equal(inner.subject?.requestId, request.id);
    assert.ok(inner.seq < outer.seq, "the inner call finishes first");
  } finally { await db.close(); }
});

test("non-platform endpoints are logged too, and unknown paths are not echoed", limit, async () => {
  const bus = new ObserverBus();
  const logs: ObserverLog[] = [];
  bus.subscribe((l) => logs.push(l));
  const deps = { observer: bus } as unknown as Dependencies;
  await handleRequest(new Request("https://x.test/health"), deps);
  await handleRequest(new Request("https://x.test/openapi.json"), deps);
  await handleRequest(new Request("https://x.test/webhooks/stripe", { method: "POST", body: "{}" }), deps);
  await handleRequest(new Request("https://x.test/some/<script>alert(1)</script>"), deps);
  assert.deepEqual(logs.map((l) => [l.operation, l.source, l.status]), [["health", "system", 200], ["openapi", "system", 200],
    ["stripe_webhook", "stripe", 501], ["unknown_route", "system", 404]]);
  const all = JSON.stringify(logs);
  assert.equal(all.includes("<script") || all.includes("alert(1)"), false, "the hostile path is not echoed");
  assert.equal(logs[3]?.message, "A client tried to call an unknown route and was refused: NOT_FOUND.");
});

test("observation does not change responses, and a failing subscriber cannot break a request", limit, async () => {
  const plain = await (await handleRequest(new Request("https://x.test/health"))).json();
  const bus = new ObserverBus();
  bus.subscribe(() => { throw new Error("subscriber bug"); });
  const response = await handleRequest(new Request("https://x.test/health"), { observer: bus } as unknown as Dependencies);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), plain);
});

test("Stripe webhook logs name the event and order from the payload", limit, () => {
  const { message, subject } = describeCall({ operation: "stripe_webhook", path: "/webhooks/stripe", status: 200,
    request: { type: "payment_intent.succeeded", data: { object: { metadata: { order_id: "ord-1" } } } }, response: { received: true, result: "applied" } });
  assert.equal(message, "Stripe reported payment_intent.succeeded for order ord-1: applied.");
  assert.equal(subject.orderId, "ord-1");
});

// ---- WebSocket transport ----

async function socketServer(token?: string) {
  const bus = new ObserverBus();
  const server = createServer(toNodeListener((request) => handleRequest(request, { observer: bus } as unknown as Dependencies)));
  const stream = attachObserverSocket(server, bus, { token, heartbeatMs: 60_000 });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return { bus, server, stream, port, close: async () => { await stream.close(); for (const ws of opened.splice(0)) ws.terminate(); server.closeAllConnections(); await new Promise((r) => server.close(r)); } };
}

/** Every client a test opens, so cleanup can terminate it even after a failed assertion. */
const opened: WebSocket[] = [];

/** Opens a client and collects its messages. Resolves "rejected <status>" if the upgrade is refused. */
function connect(port: number, protocols: string[], headers: Record<string, string> = {}, path = OBSERVER_PATH) {
  return new Promise<{ ws: WebSocket; messages: Record<string, unknown>[]; next: (n: number) => Promise<Record<string, unknown>[]> } | string>((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, protocols, { headers });
    opened.push(ws);
    // A refused upgrade or a cleanup terminate is expected here; the outcome is asserted by the test.
    ws.on("error", () => {});
    const messages: Record<string, unknown>[] = [];
    const waiters: (() => void)[] = [];
    ws.on("message", (data) => { messages.push(JSON.parse(String(data))); waiters.splice(0).forEach((w) => w()); });
    ws.on("unexpected-response", (_req, res) => resolve(`rejected ${res.statusCode}`));
    ws.on("open", () => resolve({ ws, messages, next: (n) => new Promise((done) => {
      const check = () => (messages.length >= n ? done(messages.slice(0, n)) : waiters.push(check));
      check();
    }) }));
  });
}

test("the stream requires the observer token when one is configured, sent as a subprotocol", limit, async () => {
  const s = await socketServer("observer-fixture-token");
  try {
    assert.equal(await connect(s.port, [OBSERVER_PROTOCOL]), "rejected 401");
    assert.equal(await connect(s.port, [OBSERVER_PROTOCOL, "bearer.wrong-token"]), "rejected 401");
    assert.equal(await connect(s.port, [OBSERVER_PROTOCOL, "bearer.observer-fixture-token"], {}, "/observer/elsewhere"), "rejected 404");
    const client = await connect(s.port, [OBSERVER_PROTOCOL, "bearer.observer-fixture-token"]);
    assert.ok(typeof client !== "string");
    assert.equal(client.ws.protocol, OBSERVER_PROTOCOL, "the token is never echoed back");
    const [hello] = await client.next(1);
    assert.equal(hello?.type, "hello");
    client.ws.close();
  } finally { await s.close(); }
});

test("without a token only direct loopback clients may connect", limit, async () => {
  const s = await socketServer(undefined);
  try {
    assert.equal(await connect(s.port, [OBSERVER_PROTOCOL], { "x-forwarded-for": "203.0.113.9" }), "rejected 401");
    const client = await connect(s.port, [OBSERVER_PROTOCOL]);
    assert.ok(typeof client !== "string");
    client.ws.close();
  } finally { await s.close(); }
});

test("every connected client receives the hello, the backlog, and each new log as it happens", limit, async () => {
  const s = await socketServer("observer-fixture-token");
  try {
    await fetch(`http://127.0.0.1:${s.port}/health`);
    const a = await connect(s.port, [OBSERVER_PROTOCOL, "bearer.observer-fixture-token"]);
    const b = await connect(s.port, [OBSERVER_PROTOCOL, "bearer.observer-fixture-token"]);
    assert.ok(typeof a !== "string" && typeof b !== "string");
    const [hello] = await a.next(1);
    assert.equal(hello?.v, 1);
    assert.deepEqual((hello?.backlog as ObserverLog[]).map((l) => l.operation), ["health"]);
    await fetch(`http://127.0.0.1:${s.port}/openapi.json`);
    for (const client of [a, b]) {
      const [, live] = await client.next(2);
      assert.equal(live?.type, "log");
      assert.equal(live?.operation, "openapi");
    }
    a.ws.close(); b.ws.close();
  } finally { await s.close(); }
});

test("the stream is read-only: client messages are ignored and oversized ones close the connection", limit, async () => {
  const s = await socketServer("observer-fixture-token");
  try {
    const client = await connect(s.port, [OBSERVER_PROTOCOL, "bearer.observer-fixture-token"]);
    assert.ok(typeof client !== "string");
    await client.next(1);
    client.ws.send(JSON.stringify({ type: "command", action: "settle" }));
    await fetch(`http://127.0.0.1:${s.port}/health`);
    const [, log] = await client.next(2);
    assert.equal(log?.operation, "health");
    // Bounded wait: if the server never closes, fail with -1 and still reach the cleanup below.
    const closed = new Promise<number>((resolve) => { client.ws.on("close", (code) => resolve(code)); setTimeout(() => resolve(-1), 3000).unref(); });
    client.ws.send("x".repeat(4096));
    assert.equal(await closed, 1009);
  } finally { await s.close(); }
});
