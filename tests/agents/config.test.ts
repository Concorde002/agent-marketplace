import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ConfigError,
  loadConfig,
  type AgentEnvironment,
  type BuyerAgentConfig,
  type SupplierAgentConfig,
} from "../../src/agents/config.js";

function supplierEnv(overrides: AgentEnvironment = {}): AgentEnvironment {
  return {
    MARKETPLACE_URL: "https://market.example",
    MARKETPLACE_TOKEN: "supplier-token-value",
    PARTICIPANT_ROLE: "supplier",
    COMPANY_NAME: "Acme Supply",
    COMPANY_DOMAIN: "Acme.Example",
    CURRENCY: "eur",
    SUPPLIER_MIN_TOTAL_MINOR: "1000",
    SUPPLIER_QUANTITY: "10",
    SUPPLIER_UNIT: "crate",
    SUPPLIER_EARLIEST_DELIVERY: "2026-11-05T00:00:00.000Z",
    SUPPLIER_EXPIRES_AT: "2026-12-01T00:00:00.000Z",
    ...overrides,
  };
}

function buyerEnv(overrides: AgentEnvironment = {}): AgentEnvironment {
  return {
    MARKETPLACE_URL: "https://market.example",
    MARKETPLACE_TOKEN: "buyer-token-value",
    PARTICIPANT_ROLE: "buyer",
    COMPANY_NAME: "Acme Buyer",
    COMPANY_DOMAIN: "buyer.example",
    CURRENCY: "EUR",
    BUYER_MAX_ORDER_MINOR: "1200",
    BUYER_MAX_RUN_MINOR: "5000",
    BUYER_DESTINATION: "Berlin",
    BUYER_EXPIRES_AT: "2026-12-31T00:00:00.000Z",
    BUYER_CATEGORY: "packaging",
    BUYER_ITEM: "wooden crates",
    BUYER_QUANTITY: "10",
    BUYER_UNIT: "crate",
    BUYER_DELIVER_BY: "2026-11-15T00:00:00.000Z",
    ...overrides,
  };
}

function expectConfigError(
  env: AgentEnvironment,
  expectedVariables: readonly string[],
): ConfigError {
  let captured: ConfigError | undefined;
  assert.throws(
    () => loadConfig(env),
    (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      captured = error;
      return true;
    },
  );
  assert.ok(captured !== undefined);
  for (const variable of expectedVariables) {
    assert.match(captured.message, new RegExp(`\\b${variable}\\b`));
    assert.ok(captured.variables.includes(variable));
  }
  return captured;
}

test("supplier config loads with defaults and normalised identity fields", () => {
  const config = loadConfig(supplierEnv()) as SupplierAgentConfig;

  assert.equal(config.role, "supplier");
  assert.equal(config.marketplaceUrl, "https://market.example");
  assert.equal(config.token, "supplier-token-value");
  assert.equal(config.companyName, "Acme Supply");
  assert.equal(config.companyDomain, "acme.example");
  assert.equal(config.currency, "EUR");
  assert.equal(config.stateDir, ".agent-state");
  assert.equal(config.pollIntervalMs, 3000);
  assert.equal(config.pollMaxIntervalMs, 30000);
  assert.equal(config.negotiationMaxRevisions, 3);
  assert.equal(config.negotiationDeadlineMs, 300000);
  assert.equal(config.requestTimeoutMs, 10000);
  assert.equal(config.sandboxOnly, true);
  assert.equal(config.supplier.minTotalMinor, 1000);
  assert.equal(config.supplier.quantity, 10);
  assert.equal(config.supplier.unit, "crate");
});

test("buyer config loads optional requirements and org id", () => {
  const config = loadConfig(
    buyerEnv({
      COMPANY_ORG_ID: "org_123",
      BUYER_REQUIREMENTS_JSON: JSON.stringify([
        { key: "cert", description: "FSC certification", mandatory: true },
        { key: "sample", description: "Sample available", mandatory: false },
      ]),
    }),
  ) as BuyerAgentConfig;

  assert.equal(config.role, "buyer");
  assert.equal(config.companyOrgId, "org_123");
  assert.equal(config.buyer.maxOrderMinor, 1200);
  assert.equal(config.buyer.maxRunMinor, 5000);
  assert.equal(config.buyer.requirements.length, 2);
  assert.deepEqual(config.buyer.requirements[0], {
    key: "cert",
    description: "FSC certification",
    mandatory: true,
  });
});

test("each role does not require the other role's mandate variables", () => {
  const supplier = loadConfig(supplierEnv()) as SupplierAgentConfig;
  const buyer = loadConfig(buyerEnv()) as BuyerAgentConfig;
  assert.equal(supplier.supplier.minTotalMinor, 1000);
  assert.equal(buyer.buyer.maxOrderMinor, 1200);
});

test("missing base variables are all named and values are never echoed", () => {
  const error = expectConfigError({}, [
    "MARKETPLACE_URL",
    "MARKETPLACE_TOKEN",
    "PARTICIPANT_ROLE",
    "COMPANY_NAME",
    "COMPANY_DOMAIN",
    "CURRENCY",
  ]);
  assert.ok(!error.message.includes("token"));
});

test("missing buyer variables are all named together", () => {
  const env = buyerEnv();
  delete env.BUYER_MAX_ORDER_MINOR;
  delete env.BUYER_DESTINATION;
  delete env.BUYER_QUANTITY;
  expectConfigError(env, [
    "BUYER_MAX_ORDER_MINOR",
    "BUYER_DESTINATION",
    "BUYER_QUANTITY",
  ]);
});

test("invalid URL and non-http protocols are rejected", () => {
  expectConfigError(supplierEnv({ MARKETPLACE_URL: "http://market.example" }), [
    "MARKETPLACE_URL",
  ]);
  expectConfigError(supplierEnv({ MARKETPLACE_URL: "ftp://market.example" }), [
    "MARKETPLACE_URL",
  ]);
  expectConfigError(supplierEnv({ MARKETPLACE_URL: "not a url" }), [
    "MARKETPLACE_URL",
  ]);
});

test("localhost http URLs are accepted for local development", () => {
  const localhost = loadConfig(
    supplierEnv({ MARKETPLACE_URL: "http://localhost:8787" }),
  );
  const loopback = loadConfig(
    supplierEnv({ MARKETPLACE_URL: "http://127.0.0.1:8787/api" }),
  );
  assert.equal(localhost.marketplaceUrl, "http://localhost:8787");
  assert.equal(loopback.marketplaceUrl, "http://127.0.0.1:8787/api");
});

test("invalid domain, currency and dates are reported by name", () => {
  expectConfigError(
    supplierEnv({
      COMPANY_DOMAIN: "https://acme.example",
      CURRENCY: "EURO",
      SUPPLIER_EARLIEST_DELIVERY: "soon",
    }),
    ["COMPANY_DOMAIN", "CURRENCY", "SUPPLIER_EARLIEST_DELIVERY"],
  );
});

test("an unknown role is reported without guessing role-specific variables", () => {
  const error = expectConfigError(
    supplierEnv({ PARTICIPANT_ROLE: "admin" }),
    ["PARTICIPANT_ROLE"],
  );
  assert.ok(!error.message.includes("SUPPLIER_MIN_TOTAL_MINOR"));
  assert.ok(!error.message.includes("BUYER_MAX_ORDER_MINOR"));
});

test("invalid numeric values are listed without leaking their values", () => {
  const error = expectConfigError(
    supplierEnv({
      POLL_INTERVAL_MS: "0",
      REQUEST_TIMEOUT_MS: "abc",
      NEGOTIATION_MAX_REVISIONS: "-1",
    }),
    [
      "POLL_INTERVAL_MS",
      "REQUEST_TIMEOUT_MS",
      "NEGOTIATION_MAX_REVISIONS",
    ],
  );
  assert.ok(!error.message.includes("abc"));
  assert.ok(!error.message.includes("-1"));
});

test("poll max interval must not be below the base interval", () => {
  expectConfigError(
    supplierEnv({ POLL_INTERVAL_MS: "5000", POLL_MAX_INTERVAL_MS: "1000" }),
    ["POLL_MAX_INTERVAL_MS"],
  );
});

test("negotiation limits are clamped to the hard ceilings", () => {
  const config = loadConfig(
    supplierEnv({
      NEGOTIATION_MAX_REVISIONS: "9",
      NEGOTIATION_DEADLINE_MS: "900000",
    }),
  );
  assert.equal(config.negotiationMaxRevisions, 3);
  assert.equal(config.negotiationDeadlineMs, 300000);

  const lowered = loadConfig(
    supplierEnv({
      NEGOTIATION_MAX_REVISIONS: "2",
      NEGOTIATION_DEADLINE_MS: "60000",
    }),
  );
  assert.equal(lowered.negotiationMaxRevisions, 2);
  assert.equal(lowered.negotiationDeadlineMs, 60000);
});

test("malformed buyer requirements are rejected by variable name", () => {
  expectConfigError(
    buyerEnv({ BUYER_REQUIREMENTS_JSON: "not-json" }),
    ["BUYER_REQUIREMENTS_JSON"],
  );
  expectConfigError(
    buyerEnv({
      BUYER_REQUIREMENTS_JSON: JSON.stringify([
        { key: "", description: "missing key", mandatory: true },
      ]),
    }),
    ["BUYER_REQUIREMENTS_JSON"],
  );
});

test("empty token and state dir fall back appropriately", () => {
  expectConfigError(supplierEnv({ MARKETPLACE_TOKEN: "   " }), [
    "MARKETPLACE_TOKEN",
  ]);
  const config = loadConfig(supplierEnv({ AGENT_STATE_DIR: "  " }));
  assert.equal(config.stateDir, ".agent-state");
});
