// Regression tests for the PR #1 review findings: reruns, slow payments,
// supplier-initiated charges, and buyer report delivery.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { BuyerOutcome } from "../../src/agents/buyer.js";
import { runBuyerOnce } from "../../src/agents/cli/buyer.js";
import { registerSupplierParticipant, runSupplierLoop } from "../../src/agents/cli/supplier.js";
import { PlatformClient } from "../../src/agents/client.js";
import { loadConfig } from "../../src/agents/config.js";
import { FileAgentStateStore, agentStateFilePath } from "../../src/agents/store.js";
import { createFakePlatform, type FakePlatform, type PaymentOutcome } from "./support/fake-platform.js";

const TEST_TIMEOUT_MS = 30_000;
const DAY_MS = 86_400_000;
// Fixed day-aligned dates so identical runs send byte-identical bodies.
const DAY0 = Math.floor(Date.now() / DAY_MS) * DAY_MS;
const iso = (days: number): string => new Date(DAY0 + days * DAY_MS).toISOString();

interface World {
  fake: FakePlatform;
  root: string;
  supplierId: string;
  supplierMessages: string[];
  stop(): Promise<void>;
}

function buyerEnv(fake: FakePlatform, dir: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    MARKETPLACE_URL: fake.url,
    MARKETPLACE_TOKEN: fake.tokens.buyer,
    PARTICIPANT_ROLE: "buyer",
    COMPANY_NAME: "Buyer Demo GmbH",
    COMPANY_DOMAIN: "buyer.example",
    CURRENCY: "EUR",
    AGENT_STATE_DIR: dir,
    POLL_INTERVAL_MS: "20",
    POLL_MAX_INTERVAL_MS: "50",
    REQUEST_TIMEOUT_MS: "2000",
    NEGOTIATION_DEADLINE_MS: "5000",
    PAYMENT_WAIT_MS: "3000",
    BUYER_MAX_ORDER_MINOR: "200000",
    BUYER_MAX_RUN_MINOR: "1000000",
    BUYER_DESTINATION: "Berlin, DE",
    BUYER_EXPIRES_AT: iso(365),
    BUYER_CATEGORY: "industrial-parts",
    BUYER_ITEM: "industrial bearings",
    BUYER_QUANTITY: "10",
    BUYER_UNIT: "unit",
    BUYER_DELIVER_BY: iso(60),
    BUYER_REQUIREMENTS_JSON: "[]",
    ...extra,
  };
}

async function startWorld(paymentOutcome?: PaymentOutcome): Promise<World> {
  const fake = await createFakePlatform(paymentOutcome === undefined ? {} : { paymentOutcome });
  const root = await mkdtemp(join(tmpdir(), "agent-rerun-"));
  const dir = join(root, "supplier");
  const env = {
    MARKETPLACE_URL: fake.url,
    MARKETPLACE_TOKEN: fake.tokens.supplier,
    PARTICIPANT_ROLE: "supplier",
    COMPANY_NAME: "Supplier Demo GmbH",
    COMPANY_DOMAIN: "supplier.example",
    CURRENCY: "EUR",
    AGENT_STATE_DIR: dir,
    POLL_INTERVAL_MS: "20",
    POLL_MAX_INTERVAL_MS: "50",
    REQUEST_TIMEOUT_MS: "2000",
    SUPPLIER_MIN_TOTAL_MINOR: "100000",
    SUPPLIER_QUANTITY: "50",
    SUPPLIER_UNIT: "unit",
    SUPPLIER_EARLIEST_DELIVERY: iso(1),
    SUPPLIER_EXPIRES_AT: iso(365),
  };
  const config = loadConfig(env);
  if (config.role !== "supplier") {
    throw new Error("supplier config expected");
  }
  const client = new PlatformClient({ baseUrl: fake.url, token: fake.tokens.supplier, retry: { attempts: 1, baseDelayMs: 1 } });
  const store = new FileAgentStateStore(agentStateFilePath(dir));
  const supplierId = await registerSupplierParticipant(client, config, store);
  const supplierMessages: string[] = [];
  const controller = new AbortController();
  const loop = runSupplierLoop({
    env,
    client,
    store,
    participantId: supplierId,
    signal: controller.signal,
    channel: async (message) => {
      supplierMessages.push(message);
    },
  });
  return {
    fake,
    root,
    supplierId,
    supplierMessages,
    async stop() {
      controller.abort();
      await loop;
      await fake.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function runBuyer(
  world: World,
  options: { stateDir: string; extra?: Record<string, string>; fetchImpl?: typeof fetch; onReport?: (outcome: BuyerOutcome) => void | Promise<void> },
) {
  const client = new PlatformClient({
    baseUrl: world.fake.url,
    token: world.fake.tokens.buyer,
    retry: { attempts: 1, baseDelayMs: 1 },
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  });
  return runBuyerOnce({
    env: buyerEnv(world.fake, options.stateDir, options.extra),
    client,
    store: new FileAgentStateStore(agentStateFilePath(options.stateDir)),
    supplierIdsByDomain: { "supplier.example": world.supplierId },
    onReport: options.onReport ?? (() => undefined),
  });
}

test("a rerun with a changed budget is a new run, not an idempotency conflict", { timeout: TEST_TIMEOUT_MS }, async () => {
  const world = await startWorld();
  try {
    const stateDir = join(world.root, "buyer");
    const first = await runBuyer(world, { stateDir });
    assert.equal(first.outcome.status, "agreed_and_paid");

    const second = await runBuyer(world, { stateDir, extra: { BUYER_MAX_ORDER_MINOR: "150000" } });
    assert.equal(second.outcome.status, "agreed_and_paid");
    assert.equal(world.fake.getOrders().length, 2);
    assert.notEqual(second.orderId, first.orderId);
    assert.equal(world.fake.state.requests.size, 2);
  } finally {
    await world.stop();
  }
});

test("an identical rerun sources and negotiates again instead of replaying the old order", { timeout: TEST_TIMEOUT_MS }, async () => {
  const world = await startWorld();
  try {
    const stateDir = join(world.root, "buyer");
    const first = await runBuyer(world, { stateDir });
    const second = await runBuyer(world, { stateDir });
    assert.equal(first.outcome.status, "agreed_and_paid");
    assert.equal(second.outcome.status, "agreed_and_paid");
    assert.notEqual(second.orderId, first.orderId);
    assert.equal(world.fake.getOrders().length, 2);
    assert.equal(world.fake.state.discoveries.size, 2);
  } finally {
    await world.stop();
  }
});

test("a payment that is still pending for a few seconds is reported as paid once it succeeds", { timeout: TEST_TIMEOUT_MS }, async () => {
  const world = await startWorld();
  try {
    // The backend payment succeeds, but the first reads still say pending (slow webhook).
    let pendingReads = 0;
    const slowWebhook: typeof fetch = async (input, init) => {
      const response = await fetch(input, init);
      const isOrderRead = (init?.method ?? "GET") === "GET" && /\/v1\/orders\/[^/]+$/.test(String(input));
      if (isOrderRead && pendingReads < 10) {
        pendingReads += 1;
        const body = (await response.json()) as Record<string, unknown>;
        return Response.json({ ...body, paymentStatus: "pending" });
      }
      return response;
    };
    const run = await runBuyer(world, { stateDir: join(world.root, "buyer"), fetchImpl: slowWebhook });
    assert.equal(pendingReads, 10);
    assert.equal(run.outcome.status, "agreed_and_paid");
    assert.match(run.outcome.message, /^agreed and sandbox-paid/);
  } finally {
    await world.stop();
  }
});

test("a payment still pending after the window is reported as failed, never as paid", { timeout: TEST_TIMEOUT_MS }, async () => {
  const world = await startWorld();
  try {
    const neverSettles: typeof fetch = async (input, init) => {
      const response = await fetch(input, init);
      if ((init?.method ?? "GET") === "GET" && /\/v1\/orders\/[^/]+$/.test(String(input))) {
        const body = (await response.json()) as Record<string, unknown>;
        return Response.json({ ...body, paymentStatus: "pending" });
      }
      return response;
    };
    const run = await runBuyer(world, {
      stateDir: join(world.root, "buyer"),
      fetchImpl: neverSettles,
      extra: { PAYMENT_WAIT_MS: "300" },
    });
    assert.equal(run.outcome.status, "payment_failed");
    assert.match(run.outcome.message, /^payment failed — payment still pending/);
  } finally {
    await world.stop();
  }
});

test("on a declined payment only the buyer charges once and both sides report payment failed", { timeout: TEST_TIMEOUT_MS }, async () => {
  const world = await startWorld("failed");
  try {
    const run = await runBuyer(world, { stateDir: join(world.root, "buyer") });
    assert.equal(run.outcome.status, "payment_failed");
    const order = world.fake.getOrders()[0];
    assert.ok(order);
    assert.equal(world.fake.state.paymentAttempts.get(order.id), 1);
    const settles = world.fake.state.mutationLog.filter((entry) => entry.path.endsWith("/settle"));
    assert.equal(settles.length, 1);
    assert.ok(settles[0]?.key.startsWith("agent-settle-"));

    const deadline = Date.now() + 5_000;
    while (world.supplierMessages.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(world.supplierMessages.length, 1);
    assert.match(world.supplierMessages[0] ?? "", /^payment failed/);
  } finally {
    await world.stop();
  }
});

test("the buyer negotiates below the opening ask and the agreed price stays within budget", { timeout: TEST_TIMEOUT_MS }, async () => {
  const world = await startWorld();
  try {
    const run = await runBuyer(world, { stateDir: join(world.root, "buyer") });
    assert.equal(run.outcome.status, "agreed_and_paid");
    const amounts = world.fake.getOffers().map((offer) => offer.deliveredTotal.amountMinor);
    // Floor 100000: ask 110000, buyer opens at 99000, supplier meets halfway at 104500.
    assert.deepEqual(amounts, [110_000, 99_000, 104_500]);
    const accepted = world.fake.getOrders()[0]?.acceptedOffer;
    assert.equal(accepted?.deliveredTotal.amountMinor, 104_500);
    assert.equal(accepted?.taxMinor, 0);
    assert.equal(accepted?.deliveryMinor, 0);
  } finally {
    await world.stop();
  }
});

test("a failed buyer chat delivery is queued and not repeated on the same order", { timeout: TEST_TIMEOUT_MS }, async () => {
  const world = await startWorld();
  try {
    const stateDir = join(world.root, "buyer");
    const run = await runBuyer(world, {
      stateDir,
      onReport: () => {
        throw new Error("chat transport offline");
      },
    });
    assert.equal(run.outcome.status, "agreed_and_paid");
    const store = new FileAgentStateStore(agentStateFilePath(stateDir));
    const pending = JSON.parse((await store.getReport("pending:reports")) ?? "[]") as { message: string }[];
    assert.equal(pending.length, 1);
    assert.match(pending[0]?.message ?? "", /^agreed and sandbox-paid/);
  } finally {
    await world.stop();
  }
});
