import assert from "node:assert/strict";
import { test } from "node:test";
import type { Offer, Order } from "../../src/contracts.js";
import {
  REPORT_NO_MATCH_PREFIX,
  REPORT_PAID_PREFIX,
  REPORT_PAYMENT_FAILED_PREFIX,
  ReportLedger,
  ResultReporter,
  buildReport,
  reportOrder,
  type ReportChannel,
} from "../../src/agents/reporter.js";
import { MemoryAgentStateStore } from "../../src/agents/store.js";

function futureIso(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

function demoOffer(overrides: Partial<Offer> = {}): Offer {
  return {
    id: "off_1",
    requestId: "req_1",
    buyerId: "pt_buyer_1",
    supplierId: "pt_supplier_1",
    quantity: 10,
    unit: "unit",
    destination: "Berlin, DE",
    deliveredTotal: { amountMinor: 120_000, currency: "EUR" },
    taxMinor: 0,
    deliveryMinor: 0,
    deliveryAt: futureIso(30),
    expiresAt: futureIso(7),
    confirmedRequirementKeys: ["iso-9001"],
    termsOrigin: "demo-supplier-declaration",
    demo: true,
    ...overrides,
  };
}

function demoOrder(overrides: Partial<Order> = {}): Order {
  return {
    id: "ord_1",
    acceptedOffer: demoOffer(),
    agreementStatus: "agreed",
    paymentStatus: "not_started",
    demo: true,
    ...overrides,
  };
}

function paidOrder(): Order {
  return demoOrder({
    paymentStatus: "succeeded",
    sandboxPaymentId: "pi_sandbox_ord_1",
    demoInvoice: {
      id: "inv_ord_1",
      text: "Demo document — not a tax invoice",
      demo: true,
    },
  });
}

interface ChannelLog {
  messages: string[];
  channel: ReportChannel;
}

function loggingChannel(): ChannelLog {
  const messages: string[] = [];
  return {
    messages,
    channel: async (message: string): Promise<void> => {
      messages.push(message);
    },
  };
}

test("buildReport produces exactly the three literal prefixes from authoritative status", () => {
  const paid = buildReport(paidOrder());
  assert.ok(paid.report);
  assert.equal(paid.outcome, "paid");
  assert.ok(paid.message.startsWith(REPORT_PAID_PREFIX));
  assert.match(paid.message, /order ord_1/);
  assert.match(paid.message, /document inv_ord_1/);
  assert.match(paid.message, /payment pi_sandbox_ord_1/);

  const failed = buildReport(demoOrder({ paymentStatus: "failed" }));
  assert.ok(failed.report);
  assert.equal(failed.outcome, "payment_failed");
  assert.ok(failed.message.startsWith(REPORT_PAYMENT_FAILED_PREFIX));
  assert.match(failed.message, /order ord_1/);
  assert.ok(!failed.message.includes(REPORT_PAID_PREFIX));

  const noMatch = buildReport({
    kind: "no_match",
    reason: "supplier declined: below_minimum",
  });
  assert.ok(noMatch.report);
  assert.equal(noMatch.outcome, "no_match");
  assert.ok(noMatch.message.startsWith(REPORT_NO_MATCH_PREFIX));
  assert.match(noMatch.message, /below_minimum/);
});

test("a succeeded payment without a sandbox reference is never reported as paid", async () => {
  const missing = demoOrder({ paymentStatus: "succeeded" });
  assert.deepEqual(buildReport(missing), {
    report: false,
    reason: "missing_payment_reference",
  });

  const blank = demoOrder({
    paymentStatus: "succeeded",
    sandboxPaymentId: "   ",
  });
  assert.deepEqual(buildReport(blank), {
    report: false,
    reason: "missing_payment_reference",
  });

  const log = loggingChannel();
  const result = await reportOrder(
    missing,
    log.channel,
    new ReportLedger(new MemoryAgentStateStore()),
  );
  assert.equal(result.reported, false);
  if (!result.reported) {
    assert.equal(result.reason, "missing_payment_reference");
  }
  assert.equal(log.messages.length, 0);
});

test("requires_action is reported at once as a failed payment needing action", () => {
  const decision = buildReport(demoOrder({ paymentStatus: "requires_action" }));
  assert.ok(decision.report);
  assert.equal(decision.outcome, "payment_failed");
  assert.match(decision.message, /^payment failed — payment requires further action/);
  assert.ok(!decision.message.includes(REPORT_PAID_PREFIX));
});

test("not_started and pending stay unreported until the reporting deadline", async () => {
  for (const paymentStatus of ["not_started", "pending"] as const) {
    const order = demoOrder({ paymentStatus });
    assert.deepEqual(buildReport(order), {
      report: false,
      reason: "not_terminal",
    });

    const log = loggingChannel();
    const early = await reportOrder(
      order,
      log.channel,
      new ReportLedger(new MemoryAgentStateStore()),
      { nowMs: 1_000, paymentDeadlineAtMs: 5_000 },
    );
    assert.equal(early.reported, false);
    if (!early.reported) {
      assert.equal(early.reason, "not_terminal");
    }
    assert.equal(log.messages.length, 0);

    const late = buildReport(order, {
      nowMs: 6_000,
      paymentDeadlineAtMs: 5_000,
    });
    assert.ok(late.report);
    assert.equal(late.outcome, "payment_failed");
    assert.ok(late.message.startsWith(REPORT_PAYMENT_FAILED_PREFIX));
    assert.match(late.message, new RegExp(`still ${paymentStatus} after the reporting window`));
    assert.ok(!late.message.includes(REPORT_PAID_PREFIX));
  }
});

test("failed payments report payment failed and never the paid prefix", async () => {
  const order = demoOrder({
    paymentStatus: "failed",
    sandboxPaymentId: "pi_sandbox_failed_attempt",
  });
  const log = loggingChannel();
  const result = await reportOrder(
    order,
    log.channel,
    new ReportLedger(new MemoryAgentStateStore()),
  );
  assert.equal(result.reported, true);
  if (result.reported) {
    assert.equal(result.outcome, "payment_failed");
  }
  assert.equal(log.messages.length, 1);
  const message = log.messages[0];
  assert.ok(message !== undefined);
  assert.ok(message.startsWith(REPORT_PAYMENT_FAILED_PREFIX));
  assert.ok(!message.includes(REPORT_PAID_PREFIX));
});

test("no match reports keep the literal prefix and bound untrusted reason text", async () => {
  const longReason = `${"supplier refused ".repeat(40)}\nsecond line`;
  const decision = buildReport({ kind: "no_match", reason: longReason });
  assert.ok(decision.report);
  assert.ok(decision.message.startsWith(REPORT_NO_MATCH_PREFIX));
  assert.ok(!decision.message.includes("\n"));
  assert.ok(decision.message.length <= REPORT_NO_MATCH_PREFIX.length + 204);

  const empty = buildReport({ kind: "no_match", reason: "   " });
  assert.ok(empty.report);
  assert.match(empty.message, /no qualifying supplier or agreement/);

  const log = loggingChannel();
  const reporter = new ResultReporter({
    store: new MemoryAgentStateStore(),
    channel: log.channel,
  });
  const first = await reporter.reportNoMatch("refused", {
    subjectKey: "request:req_1",
  });
  assert.equal(first.reported, true);
  const second = await reporter.reportNoMatch("refused again", {
    subjectKey: "request:req_1",
  });
  assert.equal(second.reported, false);
  if (!second.reported) {
    assert.equal(second.reason, "duplicate");
  }
  assert.equal(log.messages.length, 1);
});

test("reports deduplicate by order outcome and by event id", async () => {
  const ledger = new ReportLedger(new MemoryAgentStateStore());
  const log = loggingChannel();
  const order = paidOrder();

  const first = await reportOrder(order, log.channel, ledger, {
    eventId: "evt_1",
  });
  assert.equal(first.reported, true);

  const repeatedOutcome = await reportOrder(order, log.channel, ledger, {
    eventId: "evt_2",
  });
  assert.equal(repeatedOutcome.reported, false);
  if (!repeatedOutcome.reported) {
    assert.equal(repeatedOutcome.reason, "duplicate");
  }

  const repeatedEvent = await reportOrder(
    demoOrder({
      id: "ord_2",
      paymentStatus: "succeeded",
      sandboxPaymentId: "pi_sandbox_ord_2",
    }),
    log.channel,
    ledger,
    { eventId: "evt_1" },
  );
  assert.equal(repeatedEvent.reported, false);
  if (!repeatedEvent.reported) {
    assert.equal(repeatedEvent.reason, "duplicate");
  }

  const differentOutcome = await reportOrder(
    demoOrder({
      id: "ord_1",
      paymentStatus: "failed",
    }),
    log.channel,
    ledger,
  );
  assert.equal(differentOutcome.reported, true);
  assert.equal(log.messages.length, 2);
});

test("a missing demo document still reports the paid prefix with the payment reference", () => {
  const order = demoOrder({
    paymentStatus: "succeeded",
    sandboxPaymentId: "pi_sandbox_ord_1",
  });
  const decision = buildReport(order);
  assert.ok(decision.report);
  assert.ok(decision.message.startsWith(REPORT_PAID_PREFIX));
  assert.match(decision.message, /order ord_1/);
  assert.match(decision.message, /payment pi_sandbox_ord_1/);
  assert.ok(!decision.message.includes("document"));
});

test("a throwing channel returns reported false, queues the message and can be retried", async () => {
  const store = new MemoryAgentStateStore();
  const ledger = new ReportLedger(store);
  const order = paidOrder();
  const snapshot = JSON.stringify(order);
  const messages: string[] = [];
  let offline = true;
  const channel: ReportChannel = async (message: string): Promise<void> => {
    if (offline) {
      throw new Error("chat transport offline");
    }
    messages.push(message);
  };

  const failed = await reportOrder(order, channel, ledger, { eventId: "evt_1" });
  assert.equal(failed.reported, false);
  if (!failed.reported) {
    assert.equal(failed.reason, "channel_failed");
  }
  assert.equal(messages.length, 0);
  assert.equal(JSON.stringify(order), snapshot);

  const pending = await ledger.listPending();
  assert.equal(pending.length, 1);
  assert.ok(pending[0]?.startsWith(REPORT_PAID_PREFIX));

  const drained = await ledger.drainPending();
  assert.deepEqual(drained, pending);
  assert.deepEqual(await ledger.drainPending(), []);

  offline = false;
  const retried = await reportOrder(order, channel, ledger, {
    eventId: "evt_1",
  });
  assert.equal(retried.reported, true);
  assert.equal(messages.length, 1);
  assert.equal(JSON.stringify(order), snapshot);
});

