import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { DiscoveryResult, Offer, ParticipantId } from "../../contracts.js";
import { PlatformClient, type MutationOptions, type PlatformClientOptions } from "../client.js";
import { loadConfig, type AgentEnvironment } from "../config.js";
import { REPORT_PAID_PREFIX } from "../reporter.js";
import {
  FileAgentStateStore,
  agentStateFilePath,
} from "../store.js";
import { buyerOutcomeLine, runBuyerOnce, type BuyerCliRun } from "./buyer.js";
import {
  registerSupplierParticipant,
  runSupplierLoop,
  type SupplierCliRun,
} from "./supplier.js";

const SHARED_KEYS = [
  "MARKETPLACE_URL",
  "CURRENCY",
  "POLL_INTERVAL_MS",
  "POLL_MAX_INTERVAL_MS",
  "NEGOTIATION_MAX_REVISIONS",
  "NEGOTIATION_DEADLINE_MS",
  "REQUEST_TIMEOUT_MS",
] as const;

const PERSONA_KEYS = [
  "MARKETPLACE_TOKEN",
  "COMPANY_NAME",
  "COMPANY_DOMAIN",
  "COMPANY_ORG_ID",
  "AGENT_STATE_DIR",
] as const;

const BUYER_KEYS = [
  "BUYER_MAX_ORDER_MINOR",
  "BUYER_MAX_RUN_MINOR",
  "BUYER_DESTINATION",
  "BUYER_EXPIRES_AT",
  "BUYER_CATEGORY",
  "BUYER_ITEM",
  "BUYER_QUANTITY",
  "BUYER_UNIT",
  "BUYER_DELIVER_BY",
  "BUYER_REQUIREMENTS_JSON",
  "BUYER_SUPPLIER_IDS_JSON",
] as const;

const SUPPLIER_KEYS = [
  "SUPPLIER_MIN_TOTAL_MINOR",
  "SUPPLIER_QUANTITY",
  "SUPPLIER_UNIT",
  "SUPPLIER_EARLIEST_DELIVERY",
  "SUPPLIER_EXPIRES_AT",
] as const;

const SUPPLIER_REPORT_TIMEOUT_MS = 10_000;
const POLL_SLICE_MS = 25;

interface DemoEvidence {
  discoveryStatus: string | undefined;
  candidateCount: number;
  quoteRequests: { requestId: string; supplierId: string }[];
  offers: Map<string, Offer>;
}

/** Records the typed evidence the transcript prints; never inspects raw text. */
class DemoClient extends PlatformClient {
  private readonly evidence: DemoEvidence;

  constructor(options: PlatformClientOptions, evidence: DemoEvidence) {
    super(options);
    this.evidence = evidence;
  }

  override async getDiscovery(discoveryId: string): Promise<DiscoveryResult> {
    const result = await super.getDiscovery(discoveryId);
    this.evidence.discoveryStatus = result.status;
    this.evidence.candidateCount = result.candidates.length;
    return result;
  }

  override async requestQuote(
    requestId: string,
    supplierId: ParticipantId,
    options: MutationOptions = {},
  ): Promise<{ eventId: string }> {
    const result = await super.requestQuote(requestId, supplierId, options);
    const known = this.evidence.quoteRequests.some(
      (entry) => entry.requestId === requestId && entry.supplierId === supplierId,
    );
    if (!known) {
      this.evidence.quoteRequests.push({ requestId, supplierId });
    }
    return result;
  }

  override async submitOffer(
    input: Omit<Offer, "id">,
    options: MutationOptions = {},
  ): Promise<Offer> {
    const offer = await super.submitOffer(input, options);
    this.evidence.offers.set(offer.id, offer);
    return offer;
  }

  override async getOffer(offerId: string): Promise<Offer> {
    const offer = await super.getOffer(offerId);
    this.evidence.offers.set(offer.id, offer);
    return offer;
  }
}

function emptyEvidence(): DemoEvidence {
  return {
    discoveryStatus: undefined,
    candidateCount: 0,
    quoteRequests: [],
    offers: new Map<string, Offer>(),
  };
}

/**
 * Build a persona-scoped environment from `BUYER_*` / `SUPPLIER_*` variables.
 * The participant token and company identity are never shared between the two
 * personas; connection settings may be.
 */
function buildPersonaEnv(
  env: AgentEnvironment,
  role: "buyer" | "supplier",
): AgentEnvironment {
  const prefix = role === "buyer" ? "BUYER" : "SUPPLIER";
  const personaKeys: readonly string[] = role === "buyer" ? BUYER_KEYS : SUPPLIER_KEYS;
  const result: AgentEnvironment = {};

  for (const key of SHARED_KEYS) {
    const value = env[`${prefix}_${key}`] ?? env[key];
    if (value !== undefined) {
      result[key] = value;
    }
  }
  for (const key of PERSONA_KEYS) {
    const value = env[`${prefix}_${key}`];
    if (value !== undefined) {
      result[key] = value;
    }
  }
  for (const key of personaKeys) {
    // Mandate variables already carry the role prefix; also accept the doubled
    // form used by a fully prefixed template.
    const value = env[`${prefix}_${key}`] ?? env[key];
    if (value !== undefined) {
      result[key] = value;
    }
  }
  result.PARTICIPANT_ROLE = role;
  return result;
}

async function main(): Promise<number> {
  try {
    const buyerEnv = buildPersonaEnv(process.env, "buyer");
    const supplierEnv = buildPersonaEnv(process.env, "supplier");
    buyerEnv.AGENT_STATE_DIR ??= await mkdtemp(
      join(tmpdir(), "agent-demo-buyer-"),
    );
    supplierEnv.AGENT_STATE_DIR ??= await mkdtemp(
      join(tmpdir(), "agent-demo-supplier-"),
    );

    const buyerConfig = loadConfig(buyerEnv);
    const supplierConfig = loadConfig(supplierEnv);
    if (buyerConfig.role !== "buyer" || supplierConfig.role !== "supplier") {
      throw new Error("the demo requires one buyer and one supplier persona");
    }

    const evidence = emptyEvidence();
    const buyerClient = new DemoClient(
      {
        baseUrl: buyerConfig.marketplaceUrl,
        token: buyerConfig.token,
        timeoutMs: buyerConfig.requestTimeoutMs,
      },
      evidence,
    );
    const supplierClient = new DemoClient(
      {
        baseUrl: supplierConfig.marketplaceUrl,
        token: supplierConfig.token,
        timeoutMs: supplierConfig.requestTimeoutMs,
      },
      evidence,
    );
    const buyerStore = new FileAgentStateStore(
      agentStateFilePath(buyerConfig.stateDir),
    );
    const supplierStore = new FileAgentStateStore(
      agentStateFilePath(supplierConfig.stateDir),
    );

    const supplierId = await registerSupplierParticipant(
      supplierClient,
      supplierConfig,
      supplierStore,
    );

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

    let buyerRun: BuyerCliRun;
    try {
      buyerRun = await runBuyerOnce({
        env: buyerEnv,
        client: buyerClient,
        store: buyerStore,
        supplierIdsByDomain: {
          [normalizeDomain(supplierConfig.companyDomain)]: supplierId,
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
    const exitCode = demoExitCode(buyerRun, supplierMessages);
    printTranscript(
      buyerRun,
      supplierRun,
      evidence,
      supplierMessages,
      exitCode,
    );
    return exitCode;
  } catch (error) {
    console.error(
      JSON.stringify({
        role: "demo",
        status: "error",
        message: describeError(error),
      }),
    );
    return 1;
  }
}

function demoExitCode(
  buyerRun: BuyerCliRun,
  supplierMessages: readonly string[],
): number {
  const supplierPaid = supplierMessages.some((message) =>
    message.startsWith(REPORT_PAID_PREFIX),
  );
  if (buyerRun.outcome.status === "agreed_and_paid" && supplierPaid) {
    return 0;
  }
  if (buyerRun.exitCode !== 0) {
    return buyerRun.exitCode;
  }
  return 1;
}

function printTranscript(
  buyerRun: BuyerCliRun,
  supplierRun: SupplierCliRun,
  evidence: DemoEvidence,
  supplierMessages: readonly string[],
  exitCode: number,
): void {
  const order =
    buyerRun.outcome.status === "no_match" ? undefined : buyerRun.outcome.order;
  const revisions = [...evidence.offers.values()].sort(compareOfferIds);
  const quoteRequest =
    evidence.quoteRequests.length === 0
      ? "none"
      : evidence.quoteRequests
          .map((entry) => `${entry.requestId} -> ${entry.supplierId}`)
          .join(", ");
  const revisionSummary =
    revisions.length === 0
      ? "none"
      : revisions
          .map(
            (offer) =>
              `${offer.id} ${offer.deliveredTotal.amountMinor} ${offer.deliveredTotal.currency}`,
          )
          .join(", ");

  const lines = [
    `demo — ${buyerRun.config.marketplaceUrl} (sandbox only; local test double expected)`,
    `discovery: ${evidence.discoveryStatus ?? "unknown"}, ${evidence.candidateCount} candidate(s)`,
    `quote request: ${quoteRequest}`,
    `offer revisions: ${revisionSummary}`,
    `order: ${order?.id ?? "none"}`,
    `payment: ${order?.paymentStatus ?? "none"}${
      order?.sandboxPaymentId === undefined ? "" : ` (${order.sandboxPaymentId})`
    }`,
    `document: ${order?.demoInvoice?.id ?? "none"}`,
    `buyer: ${buyerRun.outcome.message}`,
    `supplier: ${supplierMessages[0] ?? "no supplier report observed"}`,
    `supplier ticks: ${supplierRun.ticks}, handled events: ${supplierRun.handled}`,
    `outcome: ${exitCode === 0 ? "ok" : "failed"}`,
  ];
  for (const line of lines) {
    console.log(line);
  }
  console.log(
    JSON.stringify({
      role: "demo",
      buyer: buyerOutcomeLine(buyerRun),
      supplierReport: supplierMessages[0] ?? null,
      exitCode,
    }),
  );
}

function compareOfferIds(left: Offer, right: Offer): number {
  return numericSuffix(left.id) - numericSuffix(right.id);
}

function numericSuffix(value: string): number {
  const match = /(\d+)$/.exec(value);
  return match === null ? 0 : Number(match[1]);
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

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return true;
    }
    await sleep(POLL_SLICE_MS);
  }
  return predicate();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message.slice(0, 300);
  }
  return "unknown error";
}

function isMainModule(): boolean {
  const invoked = process.argv[1];
  return (
    invoked !== undefined &&
    resolve(invoked) === fileURLToPath(import.meta.url)
  );
}

if (isMainModule()) {
  void main().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
