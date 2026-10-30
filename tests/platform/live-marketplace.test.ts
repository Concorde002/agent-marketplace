import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import type { ActorContext } from "../../src/contracts.js";
import type { Database } from "../../src/platform/database.js";
import { Marketplace } from "../../src/platform/marketplace.js";
import { createPlatformHttp } from "../../src/platform/http.js";
import { handleRequest, type Dependencies } from "../../src/index.js";
import { ApiEvidenceCollector } from "../../src/sourcing/discovery.js";
import { TedClient } from "../../src/sourcing/ted.js";
import { TavilySearch } from "../../src/sourcing/search.js";
import { TavilyExtract } from "../../src/sourcing/extract.js";

const now = () => new Date("2026-10-30T12:00:00Z");
const buyer: ActorContext = { participantId: "buyer", role: "buyer", demo: true };
const supplier: ActorContext = { participantId: "supplier", role: "supplier", demo: true };
const input = { category: "components", description: "Steel components", quantity: 10, unit: "box", destination: "EU",
  maximumDeliveredTotal: { amountMinor: 20000, currency: "EUR" }, deliverBy: "2099-01-01T00:00:00Z",
  requirements: [{ key: "quality", description: "ISO 9001:2015", mandatory: true }], buyerNoticeNumber: "123456-2026", demo: true };

async function fixture() {
  const db = new PGlite();
  await db.exec("create role anon; create role authenticated;");
  for (const name of ["20261030120000_initial_schema.sql", "20261030133000_live_marketplace_api.sql"]) {
    await db.exec(readFileSync(new URL(`../../../supabase/migrations/${name}`, import.meta.url), "utf8"));
  }
  await db.exec(`insert into marketplace.operator_grants(id,role,currency,expires_at,allowed_categories,max_order_total_minor,max_run_total_minor,created_by)
    values('gb','buyer','EUR','2099-01-02Z','{components}',20000,40000,'fixture');
    insert into marketplace.operator_grants(id,role,currency,expires_at,min_delivered_total_minor,max_available_quantity,created_by)
    values('gs','supplier','EUR','2099-01-02Z',1000,10,'fixture');
    insert into marketplace.participants(id,grant_id,role,company_name,official_domain,registered_at)
    values('buyer','gb','buyer','Example Buyer','buyer.example.com',now()),('supplier','gs','supplier','Alpha Components','alpha.example.com',now());
    insert into marketplace.mandates(participant_id,role,currency,expires_at,max_order_total_minor,max_run_total_minor,allowed_categories,destination)
    values('buyer','buyer','EUR','2099-01-02Z',20000,40000,'{components}','EU');
    insert into marketplace.mandates(participant_id,role,currency,expires_at,min_delivered_total_minor,available_quantity,unit,earliest_delivery_at)
    values('supplier','supplier','EUR','2099-01-02Z',1000,10,'box','2026-01-01Z');`);
  for (const participant of [buyer, supplier]) await db.query("insert into marketplace.api_credentials(token_hash,participant_id) values($1,$2)",
    [createHash("sha256").update(`fixture-${participant.participantId}-token`).digest("hex"), participant.participantId]);
  await db.exec("set role marketplace_app");
  const database: Database = { query: (sql, params) => db.query(sql, params), transaction: (action) => db.transaction((tx) => action(tx)) };
  const fetcher = async (request: Request) => {
    if (request.url.includes("ted.europa.eu")) return Response.json({ notices: [{ "publication-number": "123456-2026", "publication-date": "2026-10-30Z",
      "notice-type": "cn-standard", "notice-title": { eng: "Steel components" }, "description-proc": { eng: "Steel components ISO 9001:2015" } }], totalNoticeCount: 1, timedOut: false });
    if (request.url.endsWith("/search")) return Response.json({ results: [{ url: "https://alpha.example.com/products", title: "Alpha", content: "Lead only" }] });
    return Response.json({ results: [{ url: "https://alpha.example.com/products", raw_content: "Alpha Components manufactures steel components. ISO 9001:2015 certified." }], failed_results: [] });
  };
  const collector = new ApiEvidenceCollector({ now, ted: new TedClient({ now, fetch: fetcher }),
    search: new TavilySearch({ now, fetch: fetcher, access: { mode: "keyless" } }), extract: new TavilyExtract({ now, fetch: fetcher, access: { mode: "keyless" } }) });
  const market = new Marketplace(database, { collector, now, ted: new TedClient({ now, fetch: fetcher }) });
  const platform = createPlatformHttp(database, market, { now });
  return { db, market, platform };
}

async function discover(market: Marketplace) {
  const request = await market.createRequest(buyer, input, "create-request-1");
  const { discoveryId } = await market.startDiscovery(buyer, request.id, "discover-request-1");
  const assessment = { discoveryId, buyerNoticeNumber: input.buyerNoticeNumber, candidates: [{ company: { name: "Alpha Components", officialDomain: "alpha.example.com" },
    identity: { sourceId: `${discoveryId}:source-1`, quotation: "Alpha Components manufactures steel components." },
    claims: [{ requirementKey: "quality", outcome: "match", sourceId: `${discoveryId}:source-1`, quotation: "ISO 9001:2015 certified." }] }] };
  await market.submitAssessment(buyer, discoveryId, assessment, "assessment-request-1");
  return { request, discoveryId, assessment };
}

test("persistent discovery ranks before resolving accounts and supports received offers without fake terms", async () => {
  const { db, market } = await fixture();
  try {
    const { request, discoveryId, assessment } = await discover(market);
    assert.equal((await market.getDiscovery(buyer, discoveryId)).candidates[0]?.eligible, "yes");
    assert.deepEqual((await db.query("select * from marketplace.candidate_accounts")).rows, []);
    const resolved = await market.resolve(buyer, discoveryId) as { resolutions: { participantId?: string }[] };
    assert.equal(resolved.resolutions[0]?.participantId, supplier.participantId);
    await assert.rejects(market.submitAssessment(buyer, discoveryId, assessment, "assessment-again-2"), /finalized|complete/i);
    const quote = await market.requestQuote(buyer, request.id, supplier.participantId, "quote-request-1");
    assert.ok(quote.eventId);
    const offer = await market.submitOffer(supplier, { requestId: request.id, quantity: 10, unit: "box", destination: "EU",
      deliveredTotal: { amountMinor: 15000, currency: "EUR" }, taxMinor: 0, deliveryMinor: 0, deliveryAt: "2098-01-01T00:00:00Z",
      expiresAt: "2098-01-01T00:00:00Z", confirmedRequirementKeys: ["quality"], termsOrigin: "demo-supplier-declaration", demo: true }, "supplier-offer-1");
    const agreed = await market.acceptOffer(buyer, offer.id, "buyer-accept-1");
    assert.equal(agreed.state, "agreed");
    const repeated = await market.acceptOffer(buyer, offer.id, "buyer-accept-1");
    assert.deepEqual(repeated, agreed);
    assert.equal((await db.query("select * from marketplace.orders")).rows.length, 1);
    assert.equal((await db.query("select * from marketplace.offer_acceptances")).rows.length, 2);
  } finally { await db.close(); }
});

test("request idempotency, tenant isolation and unmatched quote refusal survive persistent storage", async () => {
  const { db, market } = await fixture();
  try {
    const request = await market.createRequest(buyer, input, "create-request-1");
    assert.deepEqual(await market.createRequest(buyer, input, "create-request-1"), request);
    const reordered = Object.fromEntries(Object.entries({ ...input, maximumDeliveredTotal: { currency: "EUR", amountMinor: 20000 } }).reverse());
    assert.deepEqual(await market.createRequest(buyer, reordered, "create-request-1"), request);
    await assert.rejects(market.createRequest(buyer, { ...input, quantity: 11 }, "create-request-1"), /IDEMPOTENCY/);
    await assert.rejects(market.getRequest({ ...buyer, participantId: "stranger" }, request.id), /NOT_FOUND|FORBIDDEN/);
    await assert.rejects(market.requestQuote(buyer, request.id, supplier.participantId, "quote-request-1"), /qualifying|rank|candidate/i);
    await assert.rejects(market.createRequest(supplier, input, "wrong-role-1"), /FORBIDDEN/);
    await assert.rejects(market.createRequest(buyer, { ...input, maximumDeliveredTotal: { amountMinor: 999999, currency: "EUR" } }, "bad-budget-1"), /mandate|POLICY/i);
  } finally { await db.close(); }
});

test("database refuses adding public candidates after their ranking is frozen", async () => {
  const { db, market } = await fixture();
  try {
    const { discoveryId } = await discover(market);
    await assert.rejects(db.query(`insert into marketplace.candidates(discovery_id,company_name,official_domain,eligible,rank,explanation)
      values($1,'Forged extra company','extra.example.com','yes',2,'Must not alter the frozen ranking')`, [discoveryId]), /frozen|running|immutable/i);
  } finally { await db.close(); }
});

test("the real HTTP entry point mounts scoped MCP and persistent evidence routes", async () => {
  const { db, market, platform } = await fixture();
  const deps = { platform } as unknown as Dependencies;
  const call = (path: string, body?: unknown, token = "fixture-buyer-token") => handleRequest(new Request(`https://marketplace.example.com${path}`, {
    method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "idempotency-key": "http-fixture-key-1" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), deps);
  try {
    assert.equal((await call("/v1/me", undefined, "wrong-fixture-token")).status, 401);
    const own = await call("/v1/me");
    assert.equal(own.status, 200);
    assert.equal((await own.json() as { participantId: string }).participantId, buyer.participantId);
    const api = await (await call("/openapi.json")).json() as { paths: Record<string, { post?: { parameters: { name: string; in: string; required: boolean }[] } }> };
    assert.ok(api.paths["/v1/requests"]?.post?.parameters.some((parameter) => parameter.name === "Idempotency-Key" && parameter.in === "header" && parameter.required));
    const { request, discoveryId } = await discover(market);
    const evidence = await call(`/v1/discoveries/${discoveryId}/evidence`);
    assert.equal(evidence.status, 200);
    assert.equal((await evidence.json() as { semanticOwner: string }).semanticOwner, "client-agent");
    const page = await call(`/v1/discoveries/${discoveryId}/sources/${encodeURIComponent(`${discoveryId}:source-1`)}?limit=20`);
    assert.equal((await page.json() as { text: string }).text.length, 20);
    assert.equal((await call(`/v1/discoveries/${discoveryId}/evidence`, undefined, "fixture-supplier-token")).status, 403);
    const listed = await call("/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list" });
    assert.equal(listed.status, 200);
    const names = (await listed.json() as { result: { tools: { name: string }[] } }).result.tools.map((tool) => tool.name);
    assert.ok(names.includes("submit_discovery_assessment"));
    assert.equal(names.includes("start_purchase"), false);
    const viaMcp = await call("/mcp", { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_request", arguments: { requestId: request.id } } });
    const result = await viaMcp.json() as { result: { isError: boolean; structuredContent: { id: string } } };
    assert.equal(result.result.isError, false);
    assert.equal(result.result.structuredContent.id, request.id);
    const malicious = await call("/v1/requests", { ...input, actor: supplier });
    assert.equal(malicious.status, 400);
  } finally { await db.close(); }
});
