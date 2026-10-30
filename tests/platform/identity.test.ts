import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { authenticate, IdentityError, registerIdentity } from "../../src/platform/identity.js";
import type { ActorContext } from "../../src/contracts.js";
import type { Queryable } from "../../src/payments/postgres-store.js";

const MIGRATION = readFileSync(new URL("../../../supabase/migrations/20261030120000_initial_schema.sql", import.meta.url), "utf8");
const db = new PGlite();
const NOW = new Date("2026-10-30T12:00:00.000Z");
let fixture = 0;

const hash = (token: string) => createHash("sha256").update(token, "utf8").digest("hex");

before(async () => {
  await db.exec("create role anon nologin; create role authenticated nologin;");
  await db.exec(MIGRATION);
  await db.exec("set role marketplace_app");
});

after(async () => { await db.close(); });

async function asOperator<T>(work: () => Promise<T>): Promise<T> {
  await db.exec("reset role");
  try {
    return await work();
  } finally {
    await db.exec("set role marketplace_app");
  }
}

async function seed(role: "buyer" | "supplier", options: { grantExpiresAt?: string; token?: string; revoked?: boolean } = {}) {
  const id = ++fixture;
  const participantId = `${role}-${id}`;
  const grantId = `grant-${participantId}`;
  const token = options.token ?? `test-token-${role}-${id}`;
  await asOperator(async () => {
    if (role === "buyer") {
      await db.query(
        `insert into marketplace.operator_grants
           (id, role, currency, expires_at, allowed_categories, max_order_total_minor, max_run_total_minor, created_by)
         values ($1, 'buyer', 'EUR', $2, '{furniture,lighting}', 9000, 12000, 'fixture')`,
        [grantId, options.grantExpiresAt ?? "2027-12-31T00:00:00Z"],
      );
    } else {
      await db.query(
        `insert into marketplace.operator_grants
           (id, role, currency, expires_at, min_delivered_total_minor, max_available_quantity, created_by)
         values ($1, 'supplier', 'EUR', $2, 500, 50, 'fixture')`,
        [grantId, options.grantExpiresAt ?? "2027-12-31T00:00:00Z"],
      );
    }
    await db.query("insert into marketplace.participants (id, grant_id, role) values ($1, $2, $3)", [participantId, grantId, role]);
    await db.query("insert into marketplace.api_credentials (token_hash, participant_id, revoked_at) values ($1, $2, $3)", [hash(token), participantId, options.revoked ? NOW.toISOString() : null]);
  });
  return { participantId, token };
}

function buyerRegistration(overrides: Record<string, unknown> = {}) {
  return {
    company: { name: "Buyer Example Ltd", officialDomain: "https://BUYER.example/", publicOrganizationId: "EU-123" },
    role: "buyer",
    mandate: {
      maximumOrderTotal: { amountMinor: 8000, currency: "EUR" },
      maximumRunTotal: { amountMinor: 11000, currency: "EUR" },
      allowedCategories: ["furniture"],
      destination: "Warsaw, PL",
      expiresAt: "2027-06-01T00:00:00.000Z",
      sandboxOnly: true,
    },
    demo: true,
    ...overrides,
  };
}

function supplierRegistration(overrides: Record<string, unknown> = {}) {
  return {
    company: { name: "Supplier Example Ltd", officialDomain: "supplier.example" },
    role: "supplier",
    mandate: {
      minimumDeliveredTotal: { amountMinor: 500, currency: "EUR" },
      availableQuantity: 40,
      unit: "pcs",
      earliestDeliveryAt: "2026-11-01T00:00:00.000Z",
      expiresAt: "2027-06-01T00:00:00.000Z",
      sandboxOnly: true,
    },
    demo: true,
    ...overrides,
  };
}

function expectIdentity(error: unknown, status: number, code: string) {
  assert.ok(error instanceof IdentityError);
  assert.equal(error.status, status);
  assert.equal(error.code, code);
  return true;
}

/** The API owner supplies this transaction in production. The module must never commit it. */
async function register(actor: ActorContext, input: unknown, connection = db as unknown as Queryable) {
  await db.exec("begin");
  try {
    const result = await registerIdentity(connection, actor, input, NOW);
    await db.exec("commit");
    return result;
  } catch (error) {
    await db.exec("rollback");
    throw error;
  }
}

test("authenticate rejects unknown, revoked, expired, empty, and oversized credentials without leaking them", async () => {
  const active = await seed("buyer", { token: "credential-that-must-not-leak" });
  const revoked = await seed("supplier", { revoked: true });
  const expired = await seed("buyer", { grantExpiresAt: "2026-01-01T00:00:00Z" });

  for (const token of ["unknown-token", revoked.token, expired.token, "", " ", "x".repeat(4097)]) {
    await assert.rejects(authenticate(db as unknown as Queryable, token, NOW), (error) => expectIdentity(error, 401, "INVALID_CREDENTIAL"));
  }
  await assert.rejects(
    authenticate({ query: async () => { throw new Error(`database rejected ${active.token}`); } }, active.token, NOW),
    (error) => {
      assert.ok(error instanceof IdentityError);
      assert.equal(error.status, 503);
      assert.doesNotMatch(error.message, /credential-that-must-not-leak|database rejected|[0-9a-f]{64}/i);
      return true;
    },
  );
});

test("authenticate derives valid buyer and supplier contexts only from persisted authority", async () => {
  const buyer = await seed("buyer");
  const supplier = await seed("supplier");
  assert.deepEqual(await authenticate(db as unknown as Queryable, buyer.token, NOW), { participantId: buyer.participantId, role: "buyer", demo: true });
  assert.deepEqual(await authenticate(db as unknown as Queryable, supplier.token, NOW), { participantId: supplier.participantId, role: "supplier", demo: true });
});

test("registerIdentity creates a bounded buyer mandate and normalized company identity as marketplace_app", async () => {
  const seeded = await seed("buyer");
  const actor = await authenticate(db as unknown as Queryable, seeded.token, NOW);
  assert.deepEqual(await register(actor, buyerRegistration()), { participantId: seeded.participantId });
  const { rows } = await db.query<{ company_name: string; official_domain: string; public_org_id: string; registered_at: Date; max_order_total_minor: number; max_run_total_minor: number; allowed_categories: string[]; destination: string }>(
    `select p.company_name, p.official_domain, p.public_org_id, p.registered_at,
            m.max_order_total_minor, m.max_run_total_minor, m.allowed_categories, m.destination
       from marketplace.participants p join marketplace.mandates m on m.participant_id = p.id
      where p.id = $1`,
    [seeded.participantId],
  );
  assert.deepEqual(rows[0], {
    company_name: "Buyer Example Ltd", official_domain: "buyer.example", public_org_id: "EU-123",
    registered_at: NOW, max_order_total_minor: 8000, max_run_total_minor: 11000,
    allowed_categories: ["furniture"], destination: "Warsaw, PL",
  });
});

test("registerIdentity creates a supplier mandate but returns no private floor", async () => {
  const seeded = await seed("supplier");
  const actor = await authenticate(db as unknown as Queryable, seeded.token, NOW);
  const result = await register(actor, supplierRegistration());
  assert.deepEqual(result, { participantId: seeded.participantId });
  assert.deepEqual(Object.keys(result), ["participantId"]);
  const { rows } = await db.query<{ min_delivered_total_minor: number; available_quantity: number; official_domain: string }>(
    `select m.min_delivered_total_minor, m.available_quantity, p.official_domain
       from marketplace.mandates m join marketplace.participants p on p.id = m.participant_id where p.id = $1`,
    [seeded.participantId],
  );
  assert.deepEqual(rows[0], { min_delivered_total_minor: 500, available_quantity: 40, official_domain: "supplier.example" });
});

test("registerIdentity rejects role override, unexpected actor data, and mandate ceiling escalation", async () => {
  const seeded = await seed("buyer");
  const actor = await authenticate(db as unknown as Queryable, seeded.token, NOW);
  await assert.rejects(register(actor, buyerRegistration({ role: "supplier" })), (error) => expectIdentity(error, 403, "ROLE_MISMATCH"));
  await assert.rejects(register(actor, buyerRegistration({ actor: { participantId: "supplier-override", role: "supplier" } })), (error) => expectIdentity(error, 400, "INVALID_REGISTRATION"));
  await assert.rejects(
    register(actor, buyerRegistration({ mandate: { ...buyerRegistration().mandate, maximumOrderTotal: { amountMinor: 9001, currency: "EUR" } } })),
    (error) => expectIdentity(error, 403, "MANDATE_EXCEEDS_GRANT"),
  );
});

test("registerIdentity rejects invalid calendar dates and unsafe money without partial persistence", async () => {
  const seeded = await seed("buyer");
  const actor = await authenticate(db as unknown as Queryable, seeded.token, NOW);
  await db.exec("begin");
  try {
    await assert.rejects(
      registerIdentity(db as unknown as Queryable, actor, buyerRegistration({ mandate: { ...buyerRegistration().mandate, expiresAt: "2027-02-29T00:00:00Z" } }), NOW),
      (error) => expectIdentity(error, 400, "INVALID_REGISTRATION"),
    );
    await assert.rejects(
      registerIdentity(db as unknown as Queryable, actor, buyerRegistration({ mandate: { ...buyerRegistration().mandate, maximumOrderTotal: { amountMinor: Number.MAX_SAFE_INTEGER + 1, currency: "EUR" } } }), NOW),
      (error) => expectIdentity(error, 400, "INVALID_REGISTRATION"),
    );
  } finally {
    await db.exec("rollback");
  }
  const { rows } = await db.query<{ registered_at: string | null; mandates: number }>(
    `select p.registered_at, (select count(*)::int from marketplace.mandates where participant_id = p.id) as mandates
       from marketplace.participants p where p.id = $1`,
    [seeded.participantId],
  );
  assert.deepEqual(rows[0], { registered_at: null, mandates: 0 });
});

test("registerIdentity makes company registration immutable", async () => {
  const seeded = await seed("buyer");
  const actor = await authenticate(db as unknown as Queryable, seeded.token, NOW);
  await register(actor, buyerRegistration());
  await assert.rejects(register(actor, buyerRegistration()), (error) => expectIdentity(error, 409, "ALREADY_REGISTERED"));
  await assert.rejects(
    register(actor, buyerRegistration({ company: { name: "Takeover Ltd", officialDomain: "https://takeover.example" } })),
    (error) => expectIdentity(error, 409, "ALREADY_REGISTERED"),
  );
  const { rows } = await db.query<{ company_name: string; official_domain: string }>("select company_name, official_domain from marketplace.participants where id = $1", [seeded.participantId]);
  assert.deepEqual(rows[0], { company_name: "Buyer Example Ltd", official_domain: "buyer.example" });
});

test("registration rejects every unrecognized authority field and strict nested shape violation", async () => {
  const seeded = await seed("buyer");
  const actor = await authenticate(db as unknown as Queryable, seeded.token, NOW);
  const inputs = [
    null, [], "buyer", {},
    buyerRegistration({ participantId: "someone-else" }),
    buyerRegistration({ grantId: "someone-else" }),
    buyerRegistration({ demo: false }),
    buyerRegistration({ demo: "true" }),
    buyerRegistration({ role: "admin" }),
    buyerRegistration({ company: { ...buyerRegistration().company, actor: "other" } }),
    buyerRegistration({ company: { ...buyerRegistration().company, publicOrganizationId: 123 } }),
    buyerRegistration({ company: { name: " ", officialDomain: "buyer.example" } }),
    buyerRegistration({ company: { name: "x".repeat(201), officialDomain: "buyer.example" } }),
    buyerRegistration({ mandate: { ...buyerRegistration().mandate, sandboxOnly: false } }),
    buyerRegistration({ mandate: { ...buyerRegistration().mandate, maximumRunTotal: { amountMinor: 100, currency: "EUR", actor: "other" } } }),
    buyerRegistration({ mandate: { ...buyerRegistration().mandate, minimumDeliveredTotal: { amountMinor: 0, currency: "EUR" } } }),
    buyerRegistration({ mandate: { ...buyerRegistration().mandate, allowedCategories: [] } }),
    buyerRegistration({ mandate: { ...buyerRegistration().mandate, allowedCategories: ["furniture", "furniture"] } }),
    buyerRegistration({ mandate: { ...buyerRegistration().mandate, destination: "\u0000" } }),
    buyerRegistration({ mandate: { ...buyerRegistration().mandate, destination: 123 } }),
  ];
  for (const input of inputs) {
    await assert.rejects(register(actor, input), (error) => expectIdentity(error, 400, "INVALID_REGISTRATION"));
  }
});

test("official domains reject credentials, HTTP, IP encodings, local names and non-domain URL components", async () => {
  const seeded = await seed("buyer");
  const actor = await authenticate(db as unknown as Queryable, seeded.token, NOW);
  for (const officialDomain of [
    "http://buyer.example", "https://user:pass@buyer.example", "https://@buyer.example",
    "https://buyer.example/path", "https://buyer.example?token=secret", "https://buyer.example/#fragment",
    "https://buyer.example:8443", "https://127.0.0.1", "https://[::1]", "https://2130706433",
    "https://0x7f000001", "https://127.1", "https://localhost", "localhost", "foo.localhost",
    "foo.local", "foo.internal", "foo.home.arpa", "metadata.google.internal", "https://buyer.example\\@localhost",
    "https://buyer.example\n", "single-label", "https://buyer.example//", "//buyer.example",
  ]) {
    await assert.rejects(register(actor, buyerRegistration({ company: { name: "Buyer", officialDomain } })), (error) => expectIdentity(error, 400, "INVALID_REGISTRATION"));
  }
});

test("buyer grant currency, categories, run total and expiry cannot be expanded", async () => {
  const seeded = await seed("buyer");
  const actor = await authenticate(db as unknown as Queryable, seeded.token, NOW);
  for (const change of [
    { maximumRunTotal: { amountMinor: 12001, currency: "EUR" } },
    { maximumOrderTotal: { amountMinor: 8000, currency: "USD" }, maximumRunTotal: { amountMinor: 11000, currency: "USD" } },
    { allowedCategories: ["unapproved"] },
    { expiresAt: "2028-01-01T00:00:00Z" },
  ]) {
    await assert.rejects(register(actor, buyerRegistration({ mandate: { ...buyerRegistration().mandate, ...change } })), (error) => expectIdentity(error, 403, "MANDATE_EXCEEDS_GRANT"));
  }
});

test("supplier floor cannot be lowered and capacity cannot exceed its operator grant", async () => {
  const seeded = await seed("supplier");
  const actor = await authenticate(db as unknown as Queryable, seeded.token, NOW);
  for (const change of [
    { minimumDeliveredTotal: { amountMinor: 499, currency: "EUR" } },
    { availableQuantity: 51 },
    { minimumDeliveredTotal: { amountMinor: 500, currency: "USD" } },
    { expiresAt: "2028-01-01T00:00:00Z" },
  ]) {
    await assert.rejects(register(actor, supplierRegistration({ mandate: { ...supplierRegistration().mandate, ...change } })), (error) => expectIdentity(error, 403, "MANDATE_EXCEEDS_GRANT"));
  }
});

test("invalid dates reject calendar normalization, missing timezone, invalid offsets and ordering", async () => {
  const seeded = await seed("supplier");
  const actor = await authenticate(db as unknown as Queryable, seeded.token, NOW);
  for (const expiresAt of [
    "2027-02-29T00:00:00Z", "2027-04-31T00:00:00Z", "2027-06-01", "2027-06-01T00:00:00",
    "2027-06-01T24:00:00Z", "2027-06-01T00:60:00Z", "2027-06-01T00:00:60Z",
    "2027-06-01T00:00:00+25:00", "2027-06-01T00:00:00+01:60", "garbage", 123,
  ]) {
    await assert.rejects(register(actor, supplierRegistration({ mandate: { ...supplierRegistration().mandate, expiresAt } })), (error) => expectIdentity(error, 400, "INVALID_REGISTRATION"));
  }
  await assert.rejects(register(actor, supplierRegistration({ mandate: { ...supplierRegistration().mandate, earliestDeliveryAt: "2027-07-01T00:00:00Z" } })), (error) => expectIdentity(error, 400, "INVALID_REGISTRATION"));
});

test("money and quantity require safe integers and currencies must agree", async () => {
  const buyer = await seed("buyer");
  const buyerActor = await authenticate(db as unknown as Queryable, buyer.token, NOW);
  for (const amountMinor of [-1, 0, 1.5, "100", null, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(register(buyerActor, buyerRegistration({ mandate: { ...buyerRegistration().mandate, maximumOrderTotal: { amountMinor, currency: "EUR" } } })), (error) => expectIdentity(error, 400, "INVALID_REGISTRATION"));
  }
  await assert.rejects(register(buyerActor, buyerRegistration({ mandate: { ...buyerRegistration().mandate, maximumRunTotal: { amountMinor: 11000, currency: "USD" } } })), (error) => expectIdentity(error, 400, "INVALID_REGISTRATION"));
  await assert.rejects(register(buyerActor, buyerRegistration({ mandate: { ...buyerRegistration().mandate, maximumOrderTotal: { amountMinor: 8000, currency: "eur" } } })), (error) => expectIdentity(error, 400, "INVALID_REGISTRATION"));
  await assert.rejects(register(buyerActor, buyerRegistration({ mandate: { ...buyerRegistration().mandate, maximumRunTotal: { amountMinor: 7999, currency: "EUR" } } })), (error) => expectIdentity(error, 400, "INVALID_REGISTRATION"));
  const supplier = await seed("supplier");
  const supplierActor = await authenticate(db as unknown as Queryable, supplier.token, NOW);
  for (const availableQuantity of [0, -1, 0.1, "40", null, 2147483648]) {
    await assert.rejects(register(supplierActor, supplierRegistration({ mandate: { ...supplierRegistration().mandate, availableQuantity } })), (error) => expectIdentity(error, 400, "INVALID_REGISTRATION"));
  }
});

test("expired mandates and grants are refused even after successful authentication", async () => {
  const seeded = await seed("buyer");
  const actor = await authenticate(db as unknown as Queryable, seeded.token, NOW);
  await assert.rejects(register(actor, buyerRegistration({ mandate: { ...buyerRegistration().mandate, expiresAt: NOW.toISOString() } })), (error) => expectIdentity(error, 403, "MANDATE_EXPIRED"));
  await asOperator(() => db.query("update marketplace.operator_grants set expires_at = $1 where id = $2", [NOW.toISOString(), `grant-${seeded.participantId}`]));
  await assert.rejects(register(actor, buyerRegistration()), (error) => expectIdentity(error, 403, "GRANT_EXPIRED"));
});

test("failed writes are sanitized and rolled back by the caller without a partial company or mandate", async () => {
  const seeded = await seed("supplier");
  const actor = await authenticate(db as unknown as Queryable, seeded.token, NOW);
  let inserted = false;
  const broken: Queryable = {
    async query<R>(sql: string, params?: unknown[]) {
      if (/update marketplace\.participants/i.test(sql)) throw new Error("SQL failure, private floor=500, credential=not-for-clients");
      const result = await (db as unknown as Queryable).query<R>(sql, params);
      if (/insert into marketplace\.mandates/i.test(sql)) inserted = true;
      assert.doesNotMatch(sql, /\b(begin|commit|rollback)\b/i);
      return result;
    },
  };
  await assert.rejects(register(actor, supplierRegistration(), broken), (error) => {
    expectIdentity(error, 503, "IDENTITY_UNAVAILABLE");
    assert.doesNotMatch(String(error), /private floor|not-for-clients|SQL failure/);
    return true;
  });
  assert.equal(inserted, true, "fault must happen after an actual write");
  const { rows } = await db.query("select * from marketplace.mandates where participant_id = $1", [seeded.participantId]);
  assert.equal(rows.length, 0);
  const participant = await db.query<{ registered_at: null }>("select registered_at from marketplace.participants where id = $1", [seeded.participantId]);
  assert.equal(participant.rows[0]?.registered_at, null);
});

test("registration rechecks the trusted actor's persisted role and never updates another participant", async () => {
  const buyer = await seed("buyer");
  const supplier = await seed("supplier");
  await assert.rejects(register({ participantId: supplier.participantId, role: "buyer", demo: true }, buyerRegistration()), (error) => expectIdentity(error, 403, "ROLE_MISMATCH"));
  await assert.rejects(register({ participantId: "missing", role: "buyer", demo: true }, buyerRegistration()), (error) => expectIdentity(error, 403, "IDENTITY_NOT_AUTHORIZED"));
  const actor = await authenticate(db as unknown as Queryable, buyer.token, NOW);
  await register(actor, buyerRegistration());
  const { rows } = await db.query<{ registered_at: null }>("select registered_at from marketplace.participants where id = $1", [supplier.participantId]);
  assert.equal(rows[0]?.registered_at, null);
});

test("explicit timezone offsets and valid leap days are accepted without mutating input", async () => {
  const seeded = await seed("supplier");
  const actor = await authenticate(db as unknown as Queryable, seeded.token, NOW);
  const input = supplierRegistration({ mandate: { ...supplierRegistration().mandate, earliestDeliveryAt: "2024-02-29T01:15:00+01:00", expiresAt: "2027-06-01T02:00:00+02:00" } });
  const original = structuredClone(input);
  await register(actor, input);
  assert.deepEqual(input, original);
  const { rows } = await db.query<{ earliest_delivery_at: Date; expires_at: Date }>("select earliest_delivery_at, expires_at from marketplace.mandates where participant_id = $1", [seeded.participantId]);
  assert.deepEqual(rows[0], { earliest_delivery_at: new Date("2024-02-29T00:15:00.000Z"), expires_at: new Date("2027-06-01T00:00:00.000Z") });
});

test("authentication sends only the SHA256 hash to SQL and rejects malformed tokens before any query", async () => {
  const seeded = await seed("buyer");
  const calls: { sql: string; params: unknown[] | undefined }[] = [];
  const recorded: Queryable = {
    async query<R>(sql: string, params?: unknown[]) {
      calls.push({ sql, params });
      return (db as unknown as Queryable).query<R>(sql, params);
    },
  };
  const actor = await authenticate(recorded, seeded.token, NOW);
  assert.deepEqual(actor, { participantId: seeded.participantId, role: "buyer", demo: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.params?.[0], hash(seeded.token));
  assert.equal(calls[0]?.params?.includes(seeded.token), false);
  assert.equal(calls[0]?.sql.includes(seeded.token), false);
  assert.equal(JSON.stringify(actor).includes(hash(seeded.token)), false);
  calls.length = 0;
  for (const token of ["", "\t", "x".repeat(4097), "token with spaces", null, 123]) {
    await assert.rejects(authenticate(recorded, token as string, NOW), (error) => expectIdentity(error, 401, "INVALID_CREDENTIAL"));
  }
  assert.equal(calls.length, 0);
  const broken: Queryable = { async query() { throw new Error(`${seeded.token} ${hash(seeded.token)}`); } };
  await assert.rejects(authenticate(broken, seeded.token, NOW), (error) => {
    expectIdentity(error, 503, "IDENTITY_UNAVAILABLE");
    assert.equal(String(error).includes(seeded.token), false);
    assert.equal(String(error).includes(hash(seeded.token)), false);
    assert.equal(Object.hasOwn(error as object, "cause"), false);
    return true;
  });
});

test("runtime queries use marketplace_app, lock before writes, and cannot provision authority", async () => {
  const seeded = await seed("buyer");
  const role = await db.query<{ current_user: string; rolsuper: boolean }>("select current_user, rolsuper from pg_roles where rolname = current_user");
  assert.deepEqual(role.rows, [{ current_user: "marketplace_app", rolsuper: false }]);
  const actor = await authenticate(db as unknown as Queryable, seeded.token, NOW);
  let locked = false;
  const observed: Queryable = {
    async query<R>(sql: string, params?: unknown[]) {
      assert.doesNotMatch(sql, /\b(begin|commit|rollback)\b/i);
      if (/for update of p\b/i.test(sql)) {
        assert.equal(params?.[0], actor.participantId);
        locked = true;
      }
      if (/\b(insert|update)\b/i.test(sql) && !/for update of p\b/i.test(sql)) assert.equal(locked, true);
      return (db as unknown as Queryable).query<R>(sql, params);
    },
  };
  await register(actor, buyerRegistration(), observed);
  assert.equal(locked, true);
  await db.exec("begin");
  try {
    await assert.rejects(db.query("insert into marketplace.api_credentials (token_hash, participant_id) values ($1, $2)", [hash("unauthorized-token"), seeded.participantId]), /permission denied/);
  } finally {
    await db.exec("rollback");
  }
});

test("grant escalation is refused before any insert, including node-postgres int8 string rows", async () => {
  const seeded = await seed("supplier");
  const actor = await authenticate(db as unknown as Queryable, seeded.token, NOW);
  let writes = 0;
  const pgNumbers: Queryable = {
    async query<R>(sql: string, params?: unknown[]) {
      if (/\b(insert|update marketplace\.)\b/i.test(sql)) writes++;
      const result = await (db as unknown as Queryable).query<Record<string, unknown>>(sql, params);
      for (const row of result.rows) {
        for (const key of ["max_order_total_minor", "max_run_total_minor", "min_delivered_total_minor"]) {
          if (row[key] !== null && row[key] !== undefined) row[key] = String(row[key]);
        }
      }
      return result as { rows: R[] };
    },
  };
  await assert.rejects(register(actor, supplierRegistration({ mandate: { ...supplierRegistration().mandate, minimumDeliveredTotal: { amountMinor: 499, currency: "EUR" } } }), pgNumbers), (error) => expectIdentity(error, 403, "MANDATE_EXCEEDS_GRANT"));
  assert.equal(writes, 0);
  await register(actor, supplierRegistration(), pgNumbers);
  assert.equal(writes, 2);
});

test("a grant expiring exactly now cannot authenticate and registered policy cannot be changed", async () => {
  const expired = await seed("buyer", { grantExpiresAt: NOW.toISOString() });
  await assert.rejects(authenticate(db as unknown as Queryable, expired.token, NOW), (error) => expectIdentity(error, 401, "INVALID_CREDENTIAL"));
  const seeded = await seed("supplier");
  const actor = await authenticate(db as unknown as Queryable, seeded.token, NOW);
  await register(actor, supplierRegistration());
  await assert.rejects(register(actor, supplierRegistration({ mandate: { ...supplierRegistration().mandate, availableQuantity: 49 } })), (error) => expectIdentity(error, 409, "ALREADY_REGISTERED"));
  const { rows } = await db.query<{ available_quantity: number }>("select available_quantity from marketplace.mandates where participant_id = $1", [seeded.participantId]);
  assert.equal(rows[0]?.available_quantity, 40);
});
