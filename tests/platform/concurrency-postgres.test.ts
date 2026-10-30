import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import pg from "pg";
import type { ActorContext } from "../../src/contracts.js";
import { postgresDatabase } from "../../src/platform/database.js";
import { Marketplace } from "../../src/platform/marketplace.js";

/*
 * Real simultaneous connections, which PGlite (one connection) cannot exercise. Opt-in: set
 * MARKETPLACE_TEST_ADMIN_URL to a superuser URL of a DISPOSABLE Postgres server, for example
 *   docker run -d --rm -e POSTGRES_PASSWORD=x -p 127.0.0.1:55434:5432 postgres:17-alpine
 *   MARKETPLACE_TEST_ADMIN_URL=postgres://postgres:x@127.0.0.1:55434/postgres npm run test:platform
 * Each run creates and drops its own database. Never point this at a shared or hosted database.
 */
const ADMIN_URL = process.env.MARKETPLACE_TEST_ADMIN_URL;
const skip = ADMIN_URL ? false : "set MARKETPLACE_TEST_ADMIN_URL to a disposable Postgres server to run";
const MIGRATIONS = ["20261030120000_initial_schema.sql", "20261030133000_live_marketplace_api.sql"]
  .map((name) => readFileSync(new URL(`../../../supabase/migrations/${name}`, import.meta.url), "utf8"));

const buyer: ActorContext = { participantId: "buyer", role: "buyer", demo: true };
const s1: ActorContext = { participantId: "supplier-1", role: "supplier", demo: true };
const s2: ActorContext = { participantId: "supplier-2", role: "supplier", demo: true };
const s3: ActorContext = { participantId: "supplier-3", role: "supplier", demo: true };
const dbName = `marketplace_concurrency_${process.pid}_${Date.now()}`;
let admin: pg.Client, owner: pg.Pool, app: pg.Pool, market: Marketplace;
let n = 0;

const outcome = (p: Promise<unknown>) => p.then((v) => ({ ok: true as const, v: v as Record<string, any> }), (e: { code?: string; message: string }) => ({ ok: false as const, code: e.code ?? e.message }));
const count = async (sql: string, params: unknown[] = []) => Number((await owner.query(sql, params)).rows[0].n);
const requestInput = (quantity: number) => ({ category: "components", description: "Steel components", quantity, unit: "box", destination: "EU",
  maximumDeliveredTotal: { amountMinor: 20000, currency: "EUR" }, deliverBy: "2099-01-01T00:00:00Z", requirements: [], demo: true });
const terms = (requestId: string, quantity: number, amountMinor: number) => ({ requestId, quantity, unit: "box", destination: "EU",
  deliveredTotal: { amountMinor, currency: "EUR" }, taxMinor: 0, deliveryMinor: 0, deliveryAt: "2098-01-01T00:00:00Z",
  expiresAt: "2098-01-01T00:00:00Z", confirmedRequirementKeys: [], termsOrigin: "demo-supplier-declaration", demo: true });
async function invited(quantity: number, ...suppliers: ActorContext[]) {
  const request = await market.createRequest(buyer, requestInput(quantity), `request-${++n}-key`);
  // Discovery and ranking are covered by the PGlite tests; the operator row stands in for the resolved invitation.
  for (const s of suppliers) await owner.query("insert into marketplace.quote_requests(id,request_id,supplier_id) values($1,$2,$3)", [`q-${n}-${s.participantId}`, request.id, s.participantId]);
  return request;
}

before(async () => {
  if (!ADMIN_URL) return;
  admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`create database ${dbName}`);
  const url = new URL(ADMIN_URL); url.pathname = `/${dbName}`;
  owner = new pg.Pool({ connectionString: url.href, max: 2 });
  // The final forced drop terminates idle connections; that is expected, not a test failure.
  owner.on("error", () => {});
  await owner.query(`do $$ begin
    if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; create role authenticated nologin; end if;
    if not exists (select 1 from pg_roles where rolname='concurrency_backend') then create role concurrency_backend login password 'disposable-local-only'; end if;
  end $$`);
  for (const sql of MIGRATIONS) await owner.query(sql);
  await owner.query("grant marketplace_app to concurrency_backend");
  await owner.query(`
    insert into marketplace.operator_grants(id,role,currency,expires_at,allowed_categories,max_order_total_minor,max_run_total_minor,created_by) values ('gb','buyer','EUR','2099-01-02Z','{components}',20000,400000,'fixture');
    insert into marketplace.operator_grants(id,role,currency,expires_at,min_delivered_total_minor,max_available_quantity,created_by) values ('gs1','supplier','EUR','2099-01-02Z',1000,10,'fixture'), ('gs2','supplier','EUR','2099-01-02Z',1000,10,'fixture'), ('gs3','supplier','EUR','2099-01-02Z',1000,5,'fixture');
    insert into marketplace.participants(id,grant_id,role,company_name,official_domain,registered_at) values ('buyer','gb','buyer','Example Buyer','buyer.example.com',now()), ('supplier-1','gs1','supplier','Alpha','alpha.example.com',now()), ('supplier-2','gs2','supplier','Beta','beta.example.com',now()), ('supplier-3','gs3','supplier','Gamma','gamma.example.com',now());
    insert into marketplace.mandates(participant_id,role,currency,expires_at,max_order_total_minor,max_run_total_minor,allowed_categories,destination) values ('buyer','buyer','EUR','2099-01-02Z',20000,400000,'{components}','EU');
    insert into marketplace.mandates(participant_id,role,currency,expires_at,min_delivered_total_minor,available_quantity,unit,earliest_delivery_at) values ('supplier-1','supplier','EUR','2099-01-02Z',1000,10,'box','2026-01-01Z'), ('supplier-2','supplier','EUR','2099-01-02Z',1000,10,'box','2026-01-01Z'), ('supplier-3','supplier','EUR','2099-01-02Z',1000,5,'box','2026-01-01Z');`);
  url.username = "concurrency_backend"; url.password = "disposable-local-only";
  app = new pg.Pool({ connectionString: url.href, max: 12 });
  app.on("error", () => {});
  market = new Marketplace(postgresDatabase(app));
});

after(async () => {
  if (!ADMIN_URL) return;
  await app?.end(); await owner?.end();
  await admin.query(`drop database if exists ${dbName} with (force)`);
  await admin.end();
});

test("simultaneous acceptances of one offer with different keys all return the same agreed order", { skip }, async () => {
  const request = await invited(5, s1);
  const offer = await market.submitOffer(s1, terms(request.id, 5, 15000), "offer-a-key");
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) => outcome(market.acceptOffer(buyer, offer.id, `accept-a-${i}-key`))));
  assert.deepEqual(results.map((r) => (r.ok ? r.v.state : r.code)), Array(8).fill("agreed"));
  assert.equal(new Set(results.map((r) => r.ok && r.v.order.id)).size, 1);
  assert.equal(await count("select count(*) n from marketplace.orders where offer_id=$1", [offer.id]), 1);
  assert.equal(await count("select allocated_quantity n from marketplace.mandates where participant_id='supplier-1'"), 5);
});

test("two suppliers' offers on one request accepted at once create one order; the loser gets REQUEST_CLOSED", { skip }, async () => {
  const request = await invited(3, s1, s2);
  const o1 = await market.submitOffer(s1, terms(request.id, 3, 14000), "offer-b1-key");
  const o2 = await market.submitOffer(s2, terms(request.id, 3, 13000), "offer-b2-key");
  const results = await Promise.all([outcome(market.acceptOffer(buyer, o1.id, "accept-b1-key")), outcome(market.acceptOffer(buyer, o2.id, "accept-b2-key"))]);
  assert.deepEqual(results.map((r) => (r.ok ? r.v.state : r.code)).sort(), ["REQUEST_CLOSED", "agreed"]);
  assert.equal(await count("select count(*) n from marketplace.orders where request_id=$1", [request.id]), 1);
});

test("simultaneous orders cannot oversell a supplier; the loser is a policy refusal, not an outage", { skip }, async () => {
  const ra = await invited(4, s3), rb = await invited(4, s3);
  const oa = await market.submitOffer(s3, terms(ra.id, 4, 12000), "offer-ca-key");
  const ob = await market.submitOffer(s3, terms(rb.id, 4, 12000), "offer-cb-key");
  const results = await Promise.all([outcome(market.acceptOffer(buyer, oa.id, "accept-ca-key")), outcome(market.acceptOffer(buyer, ob.id, "accept-cb-key"))]);
  assert.deepEqual(results.map((r) => (r.ok ? r.v.state : r.code)).sort(), ["POLICY_REFUSAL", "agreed"]);
  const m = (await owner.query("select allocated_quantity a, available_quantity c from marketplace.mandates where participant_id='supplier-3'")).rows[0];
  assert.ok(m.a <= m.c, `${m.a}/${m.c}`);
});

test("simultaneous identical requests with one idempotency key create one request", { skip }, async () => {
  const results = await Promise.all(Array.from({ length: 6 }, () => outcome(market.createRequest(buyer, requestInput(2), "same-create-key"))));
  assert.ok(results.every((r) => r.ok));
  assert.equal(new Set(results.map((r) => r.ok && r.v.id)).size, 1);
  assert.equal(await count("select count(*) n from marketplace.idempotency_keys where key='same-create-key'"), 1);
  const reused = await outcome(market.createRequest(buyer, requestInput(3), "same-create-key"));
  assert.equal(reused.ok ? "ok" : reused.code, "IDEMPOTENCY_KEY_REUSED");
});

test("a counteroffer racing an acceptance of the same revision has exactly one winner", { skip }, async () => {
  const request = await invited(1, s2);
  const offer = await market.submitOffer(s2, terms(request.id, 1, 9000), "offer-e-key");
  const [counter, accept] = await Promise.all([
    outcome(market.submitOffer(buyer, { ...terms(request.id, 1, 8000), previousOfferId: offer.id }, "counter-e-key")),
    outcome(market.acceptOffer(buyer, offer.id, "accept-e-key"))]);
  const wins = (counter.ok ? 1 : 0) + (accept.ok && accept.v.state === "agreed" ? 1 : 0);
  assert.equal(wins, 1, `counter=${counter.ok ? "ok" : counter.code} accept=${accept.ok ? accept.v.state : accept.code}`);
  const orders = await count("select count(*) n from marketplace.orders where request_id=$1", [request.id]);
  const current = await count("select count(*) n from marketplace.offers where request_id=$1 and status='current'", [request.id]);
  assert.ok(!(orders === 1 && current === 1));
});
