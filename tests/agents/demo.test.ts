import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { BuyerOutcome } from "../../src/agents/buyer.js";
import { runBuyerOnce, type BuyerCliRun } from "../../src/agents/cli/buyer.js";
import {
  registerSupplierParticipant,
  runSupplierLoop,
  type SupplierCliRun,
} from "../../src/agents/cli/supplier.js";
import { PlatformClient } from "../../src/agents/client.js";
import { loadConfig } from "../../src/agents/config.js";
import {
  REPORT_NO_MATCH_PREFIX,
  REPORT_PAID_PREFIX,
  REPORT_PAYMENT_FAILED_PREFIX,
} from "../../src/agents/reporter.js";
import {
  FileAgentStateStore,
  agentStateFilePath,
} from "../../src/agents/store.js";
import type { Order } from "../../src/contracts.js";
import {
  createFakePlatform,
  type FakePlatform,
  type PaymentOutcome,
} from "./support/fake-platform.js";

const TEST_TIMEOUT_MS = 30_000;
const SUPPLIER_REPORT_TIMEOUT_MS = 10_000;

interface ScenarioOptions {
  paymentOutcome?: PaymentOutcome;
  buyerOverrides?: Record<string, string>;
  supplierOverrides?: Record<string, string>;
}

interface Scenario {
  fake: FakePlatform;
  root: string;
  buyerReports: BuyerOutcome[];
  supplierMessages: string[];
  duplicateTickMessages: string[];
  buyerRun: BuyerCliRun;
  supplierRun: SupplierCliRun;
  orders: Order[];
}

async function withScenario(
  options: ScenarioOptions,
  body: (scenario: Scenario) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "agent-demo-test-"));
  const fake = await createFakePlatform(
    options.paymentOutcome === undefined
      ? {}
      : { paymentOutcome: options.paymentOutcome },
  );
  try {
    const scenario = await runScenario(fake, root, options);
    await body(scenario);
  } finally {
    await fake.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function runScenario(
  fake: FakePlatform,
  root: string,
  options: ScenarioOptions,
): Promise<Scenario> {
  const buyerDir = join(root, "buyer");
  const supplierDir = join(root, "supplier");
  const buyerEnv: Record<string, string> = {
    ...baseBuyerEnv(fake, buyerDir),
    ...(options.buyerOverrides ?? {}),
  };
  const supplierEnv: Record<string, string> = {
    ...baseSupplierEnv(fake, supplierDir),
    ...(options.supplierOverrides ?? {}),
  };

  const supplierConfig = loadConfig(supplierEnv);
  if (supplierConfig.role !== "supplier") {
    throw new Error("test configuration did not load as a supplier");
  }

  const supplierClient = new PlatformClient({
    baseUrl: fake.url,
    token: fake.tokens.supplier,
    timeoutMs: 2_000,
    retry: { attempts: 1, baseDelayMs: 1 },
  });
  const supplierStore = new FileAgentStateStore(
    agentStateFilePath(supplierDir),
  );
  const supplierId = await registerSupplierParticipant(
    supplierClient,
    supplierConfig,
    supplierStore,
  );

  const buyerClient = new PlatformClient({
    baseUrl: fake.url,
    token: fake.tokens.buyer,
    timeoutMs: 2_000,
    retry: { attempts: 1, baseDelayMs: 1 },
  });
  const buyerStore = new FileAgentStateStore(agentStateFilePath(buyerDir));

  const controller = new AbortController();
  const supplierMessages: string[] = [];
  const supplierLoop = runSupplierLoop({
    env: supplierEnv,
    client: supplierClient,
    store: supplierStore,
    participantId: supplierId,
    signal: controller.signal,
    onTick: (result) => {
      supplierMessages.push(...result.reports);
    },
  });

  const buyerReports: BuyerOutcome[] = [];
  let buyerRun: BuyerCliRun;
  try {
    buyerRun = await runBuyerOnce({
      env: buyerEnv,
      client: buyerClient,
      store: buyerStore,
      supplierIdsByDomain: {
        [normalizeDomain(supplierConfig.companyDomain)]: supplierId,
      },
      onReport: (outcome) => {
        buyerReports.push(outcome);
      },
    });
    await waitFor(
      () => supplierMessages.length > 0,
      SUPPLIER_REPORT_TIMEOUT_MS,
    );
  } finally {
    controller.abort();
  }

  const supplierRun = await supplierLoop;

  const messagesBeforeExtraTick = supplierMessages.length;
  await supplierRun.listener.tick();

  return {
    fake,
    root,
    buyerReports,
    supplierMessages,
    duplicateTickMessages: supplierMessages.slice(messagesBeforeExtraTick),
    buyerRun,
    supplierRun,
    orders: fake.getOrders(),
  };
}

test(
  "two independent participant runtimes complete one sandbox-paid order and report once each",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    await withScenario({}, async (scenario) => {
      assert.equal(scenario.orders.length, 1);
      const [order] = scenario.orders;
      assert.ok(order);
      assert.equal(order.agreementStatus, "agreed");
      assert.equal(order.paymentStatus, "succeeded");
      assert.equal(typeof order.sandboxPaymentId, "string");
      assert.ok(order.demoInvoice !== undefined);

      assert.equal(scenario.buyerReports.length, 1);
      assert.equal(scenario.supplierMessages.length, 1);

      const buyerMessage = scenario.buyerReports[0]?.message ?? "";
      const supplierMessage = scenario.supplierMessages[0] ?? "";
      assert.ok(buyerMessage.startsWith(REPORT_PAID_PREFIX), buyerMessage);
      assert.ok(supplierMessage.startsWith(REPORT_PAID_PREFIX), supplierMessage);
      assert.ok(buyerMessage.includes(order.id));
      assert.ok(supplierMessage.includes(order.id));
      assert.equal(scenario.buyerRun.exitCode, 0);

      // The supplier keeps ticking after completion; a repeat read of the same
      // authoritative order must not produce a second chat report.
      assert.deepEqual(scenario.duplicateTickMessages, []);
      assert.equal(scenario.supplierMessages.length, 1);
      assert.ok(scenario.supplierRun.ticks > 0);
      assert.ok(scenario.supplierRun.handled >= 1);
    });
  },
);

test(
  "no match when the supplier floor is above the buyer maximum",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    await withScenario(
      {
        buyerOverrides: {
          BUYER_MAX_ORDER_MINOR: "90000",
          NEGOTIATION_DEADLINE_MS: "1200",
        },
      },
      async (scenario) => {
        assert.equal(scenario.orders.length, 0);
        assert.equal(scenario.buyerReports.length, 1);
        assert.equal(scenario.supplierMessages.length, 1);

        const buyerReport = scenario.buyerReports[0];
        assert.ok(buyerReport);
        assert.equal(buyerReport.status, "no_match");
        assert.ok(
          buyerReport.message.startsWith(REPORT_NO_MATCH_PREFIX),
          buyerReport.message,
        );
        assert.equal(scenario.buyerRun.exitCode, 2);

        const supplierMessage = scenario.supplierMessages[0] ?? "";
        assert.ok(
          supplierMessage.startsWith(REPORT_NO_MATCH_PREFIX),
          supplierMessage,
        );
        assert.deepEqual(scenario.duplicateTickMessages, []);
      },
    );
  },
);

test(
  "the injected payment failure is reported as payment failed by both sides",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    await withScenario({ paymentOutcome: "failed" }, async (scenario) => {
      assert.equal(scenario.orders.length, 1);
      const [order] = scenario.orders;
      assert.ok(order);
      assert.equal(order.paymentStatus, "failed");

      assert.equal(scenario.buyerReports.length, 1);
      assert.equal(scenario.supplierMessages.length, 1);

      const buyerReport = scenario.buyerReports[0];
      assert.ok(buyerReport);
      assert.equal(buyerReport.status, "payment_failed");
      assert.ok(
        buyerReport.message.startsWith(REPORT_PAYMENT_FAILED_PREFIX),
        buyerReport.message,
      );
      assert.equal(scenario.buyerRun.exitCode, 3);

      const supplierMessage = scenario.supplierMessages[0] ?? "";
      assert.ok(
        supplierMessage.startsWith(REPORT_PAYMENT_FAILED_PREFIX),
        supplierMessage,
      );
      assert.deepEqual(scenario.duplicateTickMessages, []);
    });
  },
);

function baseBuyerEnv(
  fake: FakePlatform,
  stateDir: string,
): Record<string, string> {
  return {
    MARKETPLACE_URL: fake.url,
    MARKETPLACE_TOKEN: fake.tokens.buyer,
    PARTICIPANT_ROLE: "buyer",
    COMPANY_NAME: "Buyer Demo GmbH",
    COMPANY_DOMAIN: "buyer.example",
    CURRENCY: "EUR",
    AGENT_STATE_DIR: stateDir,
    POLL_INTERVAL_MS: "20",
    POLL_MAX_INTERVAL_MS: "50",
    REQUEST_TIMEOUT_MS: "2000",
    NEGOTIATION_MAX_REVISIONS: "3",
    NEGOTIATION_DEADLINE_MS: "20000",
    BUYER_MAX_ORDER_MINOR: "200000",
    BUYER_MAX_RUN_MINOR: "1000000",
    BUYER_DESTINATION: "Berlin, DE",
    BUYER_EXPIRES_AT: futureIso(365),
    BUYER_CATEGORY: "industrial-parts",
    BUYER_ITEM: "industrial bearings",
    BUYER_QUANTITY: "10",
    BUYER_UNIT: "unit",
    BUYER_DELIVER_BY: futureIso(60),
  };
}

function baseSupplierEnv(
  fake: FakePlatform,
  stateDir: string,
): Record<string, string> {
  return {
    MARKETPLACE_URL: fake.url,
    MARKETPLACE_TOKEN: fake.tokens.supplier,
    PARTICIPANT_ROLE: "supplier",
    COMPANY_NAME: "Supplier Demo GmbH",
    COMPANY_DOMAIN: "supplier.example",
    CURRENCY: "EUR",
    AGENT_STATE_DIR: stateDir,
    POLL_INTERVAL_MS: "20",
    POLL_MAX_INTERVAL_MS: "50",
    REQUEST_TIMEOUT_MS: "2000",
    NEGOTIATION_MAX_REVISIONS: "3",
    NEGOTIATION_DEADLINE_MS: "20000",
    SUPPLIER_MIN_TOTAL_MINOR: "100000",
    SUPPLIER_QUANTITY: "50",
    SUPPLIER_UNIT: "unit",
    SUPPLIER_EARLIEST_DELIVERY: futureIso(1),
    SUPPLIER_EXPIRES_AT: futureIso(365),
  };
}

function normalizeDomain(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/^www\./, "")
    .replace(/\.$/, "");
}

function futureIso(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return true;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 20);
    });
  }
  return predicate();
}
