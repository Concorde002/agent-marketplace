import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { MESSAGES_TAB, REQUESTS_TAB, REQUEST_COLUMNS, SheetBridge } from "../../src/agents/bridge.js";
import { RuntimeHost, type PurchaseInput } from "../../src/agents/host.js";
import { MemoryRowTable } from "../../src/agents/sheets.js";
import { createMcpBackend } from "../../src/mcp/backend.js";
import { createMcpHandler } from "../../src/mcp/gateway.js";
import { createFakePlatform, type FakePlatform } from "./support/fake-platform.js";

const TIMEOUT = 30_000;
const DAY_MS = 86_400_000;
const iso = (days: number): string => new Date(Date.now() + days * DAY_MS).toISOString();

interface World {
  fake: FakePlatform;
  host: RuntimeHost;
  activity: string[];
  close(): Promise<void>;
}

async function startWorld(options: { buyerGrantMinor?: number; deadlineMs?: number } = {}): Promise<World> {
  const fake = await createFakePlatform();
  const root = await mkdtemp(join(tmpdir(), "agent-host-"));
  const activity: string[] = [];
  const host = new RuntimeHost({
    marketplaceUrl: fake.url,
    currency: "EUR",
    stateRoot: root,
    pollIntervalMs: 20,
    pollMaxIntervalMs: 50,
    paymentWaitMs: 2_000,
    negotiationDeadlineMs: options.deadlineMs ?? 10_000,
    clientOptions: { retry: { attempts: 1, baseDelayMs: 1 } },
    onActivity: (line) => activity.push(line),
    participants: [
      {
        token: fake.tokens.buyer,
        role: "buyer",
        companyName: "Buyer Demo GmbH",
        companyDomain: "buyer.example",
        ...(options.buyerGrantMinor === undefined ? {} : { maxOrderMinor: options.buyerGrantMinor }),
      },
      {
        token: fake.tokens.supplier,
        role: "supplier",
        companyName: "Supplier Demo GmbH",
        companyDomain: "supplier.example",
        supplier: {
          minTotalMinor: 440_000,
          quantity: 60,
          unit: "unit",
          earliestDeliveryAt: iso(1),
          expiresAt: iso(365),
        },
      },
    ],
  });
  await host.start();
  return {
    fake,
    host,
    activity,
    async close() {
      await host.close();
      await fake.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

function purchase(overrides: Partial<PurchaseInput> = {}): PurchaseInput {
  return {
    item: "height-adjustable desks",
    category: "office-equipment",
    quantity: 40,
    unit: "unit",
    destination: "Warsaw",
    deliverBy: iso(20),
    maxTotalMinor: 500_000,
    currency: "EUR",
    ...overrides,
  };
}

async function eventually<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = await read();
  while (!done(value) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    value = await read();
  }
  return value;
}

test("hosted buyer and always-on supplier close one sandbox-paid order and both get one message", { timeout: TIMEOUT }, async () => {
  const world = await startWorld();
  try {
    const started = await world.host.startPurchase(world.fake.tokens.buyer, purchase());
    assert.equal(started.state, "running");
    const finished = await world.host.waitForPurchase(world.fake.tokens.buyer, started.runId);
    assert.equal(finished.state, "done");
    assert.equal(finished.outcome, "agreed_and_paid");
    assert.match(finished.result ?? "", /^agreed and sandbox-paid — order ord_1; total 4598\.00 EUR/);
    // Ask 4840.00, buyer opens at 4356.00, supplier meets halfway at 4598.00.
    assert.ok(finished.progress.some((line) => line.includes("countered with 4356.00 EUR")));

    const supplier = await eventually(
      () => world.host.supplierStatus(world.fake.tokens.supplier),
      (status) => status.messages.length > 0,
    );
    assert.equal(supplier.listening, true);
    assert.deepEqual(supplier.messages.length, 1);
    assert.match(supplier.messages[0] ?? "", /^agreed and sandbox-paid — order ord_1/);
    assert.deepEqual((await world.host.supplierStatus(world.fake.tokens.supplier)).messages, []);

    // The supplier never initiated a charge.
    const settles = world.fake.state.mutationLog.filter((entry) => entry.path.endsWith("/settle"));
    assert.equal(settles.length, 1);
    assert.ok(world.activity.every((line) => !line.includes(world.fake.tokens.buyer)));
  } finally {
    await world.close();
  }
});

test("the operator grant caps whatever budget the bot passes", { timeout: TIMEOUT }, async () => {
  const world = await startWorld({ buyerGrantMinor: 450_000 });
  try {
    const started = await world.host.startPurchase(world.fake.tokens.buyer, purchase({ maxTotalMinor: 99_000_000 }));
    const finished = await world.host.waitForPurchase(world.fake.tokens.buyer, started.runId);
    assert.ok(finished.progress[0]?.includes("capped at the operator grant of 4500.00 EUR"));
    const request = [...world.fake.state.requests.values()][0]?.request;
    assert.equal(request?.maximumDeliveredTotal.amountMinor, 450_000);
    const order = world.fake.getOrders()[0];
    assert.ok(order !== undefined && order.acceptedOffer.deliveredTotal.amountMinor <= 450_000);
  } finally {
    await world.close();
  }
});

test("a budget below the supplier floor ends in no match on both sides and no order", { timeout: TIMEOUT }, async () => {
  const world = await startWorld({ deadlineMs: 1_500 });
  try {
    const started = await world.host.startPurchase(world.fake.tokens.buyer, purchase({ maxTotalMinor: 300_000 }));
    const finished = await world.host.waitForPurchase(world.fake.tokens.buyer, started.runId);
    assert.equal(finished.outcome, "no_match");
    assert.match(finished.result ?? "", /^no match/);
    assert.equal(world.fake.getOrders().length, 0);
    const supplier = await eventually(
      () => world.host.supplierStatus(world.fake.tokens.supplier),
      (status) => status.messages.length > 0,
    );
    assert.match(supplier.messages[0] ?? "", /^no match — buyer_budget_below_minimum/);
  } finally {
    await world.close();
  }
});

test("tools enforce roles and reject a second concurrent purchase", { timeout: TIMEOUT }, async () => {
  const world = await startWorld();
  try {
    await assert.rejects(
      () => world.host.startPurchase(world.fake.tokens.supplier, purchase()),
      (error: unknown) => (error as { code?: string }).code === "WRONG_ROLE",
    );
    await assert.rejects(
      () => world.host.startPurchase("not-a-token", purchase()),
      (error: unknown) => (error as { code?: string }).code === "UNKNOWN_PARTICIPANT",
    );
    await assert.rejects(
      () => world.host.startPurchase(world.fake.tokens.buyer, purchase({ currency: "USD" })),
      (error: unknown) => (error as { code?: string }).code === "INVALID_PURCHASE",
    );
    const first = await world.host.startPurchase(world.fake.tokens.buyer, purchase());
    await assert.rejects(
      () => world.host.startPurchase(world.fake.tokens.buyer, purchase()),
      (error: unknown) => (error as { code?: string }).code === "PURCHASE_IN_PROGRESS",
    );
    await world.host.waitForPurchase(world.fake.tokens.buyer, first.runId);
  } finally {
    await world.close();
  }
});

test("an MCP client completes a purchase with start_purchase and purchase_status over HTTP", { timeout: TIMEOUT }, async () => {
  const world = await startWorld();
  try {
    const handler = createMcpHandler(
      createMcpBackend({
        clientForToken: (token) => world.host.clientFor(token),
        hooks: {
          startPurchase: (token, input) => world.host.startPurchase(token, input),
          purchaseStatus: (token, runId) => world.host.purchaseStatus(token, runId),
          supplierStatus: (token) => world.host.supplierStatus(token),
          supplierListenerTick: (token) => world.host.supplierListenerTick(token),
          reportPending: (token) => world.host.reportPending(token),
        },
      }),
    );
    let id = 0;
    const call = async (token: string, name: string, args: Record<string, unknown>) => {
      id += 1;
      const response = await handler(
        new Request("https://sandbox.example/mcp", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
          },
          body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }),
        }),
      );
      const body = (await response.json()) as { result: { isError: boolean; structuredContent: Record<string, unknown> } };
      return body.result;
    };

    const started = await call(world.fake.tokens.buyer, "start_purchase", {
      item: "height-adjustable desks",
      category: "office-equipment",
      quantity: 40,
      unit: "unit",
      destination: "Warsaw",
      deliverBy: iso(20).slice(0, 10),
      maxTotal: 5000,
      currency: "EUR",
    });
    assert.equal(started.isError, false);
    const runId = started.structuredContent.runId as string;

    const finished = await eventually(
      () => call(world.fake.tokens.buyer, "purchase_status", { runId }),
      (result) => result.structuredContent.state !== "running",
    );
    assert.match(String(finished.structuredContent.result), /^agreed and sandbox-paid/);

    const supplier = await eventually(
      () => call(world.fake.tokens.supplier, "supplier_status", {}),
      (result) => (result.structuredContent.messages as string[]).length > 0,
    );
    assert.match((supplier.structuredContent.messages as string[])[0] ?? "", /^agreed and sandbox-paid/);

    const wrongRole = await call(world.fake.tokens.supplier, "start_purchase", {
      item: "x", category: "x", quantity: 1, unit: "unit", destination: "x", deliverBy: "2026-12-01", maxTotal: 1, currency: "EUR",
    });
    assert.equal(wrongRole.isError, true);
    assert.equal(wrongRole.structuredContent.error, "WRONG_ROLE");
  } finally {
    await world.close();
  }
});

test("Instinct-style sheet bridges: a buyer row becomes a paid order and both sheets get the result", { timeout: TIMEOUT }, async () => {
  const world = await startWorld();
  try {
    const buyerSheet = new MemoryRowTable();
    const supplierSheet = new MemoryRowTable();
    const buyerBridge = new SheetBridge({ table: buyerSheet, host: world.host, token: world.fake.tokens.buyer, currency: "EUR" });
    const supplierBridge = new SheetBridge({ table: supplierSheet, host: world.host, token: world.fake.tokens.supplier, currency: "EUR" });
    await buyerBridge.prepare();
    await supplierBridge.prepare();
    assert.ok(buyerSheet.tab("How to use").some((row) => row[0]?.includes("Requests")));

    // What the Instinct bot does through its Google Sheets connector: append one row.
    const row = Object.fromEntries(REQUEST_COLUMNS.map((name) => [name, ""])) as Record<string, string>;
    Object.assign(row, {
      item: "height-adjustable desks",
      category: "office-equipment",
      quantity: "40",
      unit: "unit",
      destination: "Warsaw",
      deliver_by: iso(20).slice(0, 10),
      max_total: "5,000.00",
      currency: "EUR",
    });
    await buyerSheet.appendRow(REQUESTS_TAB, REQUEST_COLUMNS.map((name) => row[name] ?? ""));
    // A malformed row is rejected without starting anything.
    await buyerSheet.appendRow(REQUESTS_TAB, ["desks", "office", "lots", "unit", "Warsaw", "soon", "cheap", "EUR"]);

    const statusOf = (rowIndex: number) => buyerSheet.tab(REQUESTS_TAB)[rowIndex]?.[REQUEST_COLUMNS.indexOf("status")];
    await eventually(
      async () => {
        await buyerBridge.tick();
        return statusOf(1);
      },
      (status) => status === "done",
    );
    assert.equal(statusOf(1), "done");
    assert.equal(statusOf(2), "invalid");
    const buyerMessages = buyerSheet.tab(MESSAGES_TAB).slice(1);
    assert.equal(buyerMessages.length, 1);
    assert.match(buyerMessages[0]?.[1] ?? "", /^agreed and sandbox-paid/);

    await eventually(
      async () => {
        await supplierBridge.tick();
        return supplierSheet.tab(MESSAGES_TAB).length;
      },
      (length) => length > 1,
    );
    const supplierMessages = supplierSheet.tab(MESSAGES_TAB).slice(1);
    assert.equal(supplierMessages.length, 1);
    assert.match(supplierMessages[0]?.[1] ?? "", /^agreed and sandbox-paid/);

    // Further ticks add nothing.
    await buyerBridge.tick();
    await supplierBridge.tick();
    assert.equal(buyerSheet.tab(MESSAGES_TAB).length, 2);
    assert.equal(supplierSheet.tab(MESSAGES_TAB).length, 2);
    assert.equal(world.fake.getOrders().length, 1);
  } finally {
    await world.close();
  }
});
