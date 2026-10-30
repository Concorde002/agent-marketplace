import { join } from "node:path";

import type { DiscoveryResult, Offer, Order, ParticipantId, RegistrationInput, SourcingRequest } from "../contracts.js";
import { BuyerRunner, type BuyerOutcome } from "./buyer.js";
import { registerSupplierParticipant } from "./cli/supplier.js";
import { PlatformClient, stableHash, type MutationOptions, type PlatformClientOptions } from "./client.js";
import {
  DEFAULT_PAYMENT_WAIT_MS,
  type BuyerAgentConfig,
  type RequirementConfig,
  type SupplierAgentConfig,
  type SupplierMandateConfig,
} from "./config.js";
import { SupplierListener } from "./listener.js";
import { DEFAULT_NEGOTIATION_DEADLINE_MS, MAX_NEGOTIATION_REVISIONS } from "./policy.js";
import { ReportLedger, type ReportChannel } from "./reporter.js";
import { FileAgentStateStore, agentStateFilePath, type AgentStateStore } from "./store.js";
import type { AgentLogger } from "./types.js";

/**
 * Hosts the deterministic buyer and supplier runtimes behind participant
 * tokens, so a chat bot (Grok Bot over MCP, Instinct through a sheet bridge)
 * only starts a purchase, reads its status and relays completion messages.
 * Limits, offers, acceptance and the three result literals stay in code; the
 * bot cannot raise a limit or invent a result.
 *
 * MVP_LIMIT: one process, in-memory job table, file-backed state per participant.
 * Upgrade: run the same runtimes against the hosted platform with a durable store.
 */

const OUTBOX_KEY = "chat:outbox";
const MAX_OUTBOX = 50;
const MAX_PROGRESS_LINES = 40;
const MAX_TEXT = 500;
const GRANT_DAYS = 30;

/** What a buyer bot passes when its human asks it to source something. */
export interface PurchaseInput {
  item: string;
  category: string;
  quantity: number;
  unit: string;
  destination: string;
  /** ISO 8601 with timezone. */
  deliverBy: string;
  /** Highest delivered total the human allows, in minor units. */
  maxTotalMinor: number;
  currency: string;
  requirements?: RequirementConfig[];
}

export interface HostedParticipant {
  token: string;
  role: "buyer" | "supplier";
  companyName: string;
  companyDomain: string;
  /** Operator grant for a buyer: no purchase may exceed this total, whatever the bot asks. */
  maxOrderMinor?: number;
  /** Operator-provisioned terms for a supplier. Its listener starts with the host. */
  supplier?: SupplierMandateConfig;
}

export interface RuntimeHostOptions {
  marketplaceUrl: string;
  currency: string;
  stateRoot: string;
  participants: readonly HostedParticipant[];
  pollIntervalMs?: number;
  pollMaxIntervalMs?: number;
  negotiationDeadlineMs?: number;
  paymentWaitMs?: number;
  requestTimeoutMs?: number;
  logger?: AgentLogger;
  /** Human-readable activity lines for the operator console. Never contains a token. */
  onActivity?: (line: string) => void;
  /** Test seam. */
  clientOptions?: Partial<PlatformClientOptions>;
  now?: () => number;
}

export type PurchaseState = "running" | "done" | "error";

export interface PurchaseStatus {
  runId: string;
  state: PurchaseState;
  /** Readable negotiation steps so far, oldest first. */
  progress: string[];
  /** The final chat message: starts with "agreed and sandbox-paid", "no match" or "payment failed". */
  result?: string;
  outcome?: BuyerOutcome["status"];
  orderId?: string;
}

export interface SupplierStatus {
  listening: boolean;
  ticks: number;
  lastTickAt?: string;
  /** New completion messages since the last read; relay them verbatim. */
  messages: string[];
}

/** Error with a stable code the MCP gateway passes through. */
export class HostError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "HostError";
    this.code = code;
  }
}

interface BuyerJob {
  runId: string;
  state: PurchaseState;
  progress: string[];
  result?: string;
  outcome?: BuyerOutcome["status"];
  orderId?: string;
  done: Promise<void>;
}

interface Runtime {
  participant: HostedParticipant;
  label: string;
  store: AgentStateStore;
  client: PlatformClient;
  participantId?: ParticipantId;
  jobs: Map<string, BuyerJob>;
  latestRunId?: string;
  listener?: SupplierListener;
  listenerAbort?: AbortController;
  listenerLoop?: Promise<void>;
  ticks: number;
  lastTickAtMs?: number;
}

export class RuntimeHost {
  private readonly options: RuntimeHostOptions;
  private readonly runtimes = new Map<string, Runtime>();
  private readonly now: () => number;
  private runCounter = 0;

  constructor(options: RuntimeHostOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    for (const participant of options.participants) {
      if (this.runtimes.has(participant.token)) {
        throw new HostError("DUPLICATE_TOKEN", "two hosted participants share a token");
      }
      if (participant.role === "supplier" && participant.supplier === undefined) {
        throw new HostError("MISSING_TERMS", `supplier ${participant.companyName} has no terms`);
      }
      const label = `${participant.role}:${participant.companyDomain}`;
      const store = new FileAgentStateStore(
        agentStateFilePath(join(options.stateRoot, `${participant.role}-${stableHash(participant.token)}`)),
      );
      this.runtimes.set(participant.token, {
        participant,
        label,
        store,
        client: new ProgressClient(
          {
            baseUrl: options.marketplaceUrl,
            token: participant.token,
            ...(options.requestTimeoutMs === undefined ? {} : { timeoutMs: options.requestTimeoutMs }),
            ...options.clientOptions,
          },
          () => undefined,
        ),
        jobs: new Map(),
        ticks: 0,
      });
    }
  }

  /** Register every supplier and start its always-on listener. */
  async start(): Promise<void> {
    for (const runtime of this.runtimes.values()) {
      if (runtime.participant.role === "supplier") {
        await this.startSupplier(runtime);
      }
    }
  }

  async close(): Promise<void> {
    for (const runtime of this.runtimes.values()) {
      runtime.listenerAbort?.abort();
    }
    await Promise.allSettled(
      [...this.runtimes.values()].flatMap((runtime) => [
        ...(runtime.listenerLoop === undefined ? [] : [runtime.listenerLoop]),
        ...[...runtime.jobs.values()].map((job) => job.done),
      ]),
    );
  }

  /** Raw platform client for a token, for the low-level MCP tools. */
  clientFor(token: string): PlatformClient {
    return this.runtimeFor(token).client;
  }

  /** Start one buyer run in the background. One active run per buyer. */
  async startPurchase(token: string, input: PurchaseInput): Promise<PurchaseStatus> {
    const runtime = this.runtimeFor(token, "buyer");
    const running = [...runtime.jobs.values()].find((job) => job.state === "running");
    if (running !== undefined) {
      throw new HostError(
        "PURCHASE_IN_PROGRESS",
        `purchase ${running.runId} is still running; call purchase_status`,
      );
    }
    const purchase = validatePurchase(input, this.options.currency);
    const grant = runtime.participant.maxOrderMinor;
    const ceiling = grant === undefined ? purchase.maxTotalMinor : Math.min(purchase.maxTotalMinor, grant);

    this.runCounter += 1;
    const runId = `run_${this.now().toString(36)}_${this.runCounter}`;
    const job: BuyerJob = { runId, state: "running", progress: [], done: Promise.resolve() };
    const note = (line: string): void => {
      if (job.progress.at(-1) !== line) {
        job.progress.push(line);
        if (job.progress.length > MAX_PROGRESS_LINES) {
          job.progress.splice(0, job.progress.length - MAX_PROGRESS_LINES);
        }
      }
      this.activity(`${runtime.label} ${runId}: ${line}`);
    };
    if (grant !== undefined && purchase.maxTotalMinor > grant) {
      note(`budget capped at the operator grant of ${formatMinor(grant)} ${purchase.currency}`);
    }

    const config = this.buyerConfig(runtime, purchase, ceiling);
    const client = new ProgressClient(
      {
        baseUrl: this.options.marketplaceUrl,
        token,
        ...(this.options.requestTimeoutMs === undefined ? {} : { timeoutMs: this.options.requestTimeoutMs }),
        ...this.options.clientOptions,
      },
      note,
      () => this.supplierNames(),
    );
    const knownParticipantId = runtime.participantId ?? (await runtime.store.getReport("participant:id"));
    const runner = new BuyerRunner({
      config,
      client,
      store: runtime.store,
      runId,
      supplierIdsByDomain: this.supplierIdsByDomain(),
      ...(knownParticipantId === undefined ? {} : { knownParticipantId }),
      ...(this.options.logger === undefined ? {} : { logger: this.options.logger }),
      report: (outcome) => this.pushOutbox(runtime, outcome.message),
    });

    runtime.jobs.set(runId, job);
    runtime.latestRunId = runId;
    note(`started: ${purchase.quantity} ${purchase.unit} ${purchase.item} to ${purchase.destination} by ${purchase.deliverBy.slice(0, 10)}, at most ${formatMinor(ceiling)} ${purchase.currency}`);
    job.done = runner
      .run()
      .then((outcome) => {
        job.state = "done";
        job.result = outcome.message;
        job.outcome = outcome.status;
        if (outcome.status !== "no_match") {
          job.orderId = outcome.order.id;
        }
        note(`finished: ${outcome.message}`);
      })
      .catch(async (error: unknown) => {
        job.state = "error";
        job.result = `no match — platform_error: ${safeMessage(error)}`;
        note(`stopped on an error: ${safeMessage(error)}`);
        await this.pushOutbox(runtime, job.result);
      })
      .finally(async () => {
        const id = await runtime.store.getReport("participant:id");
        if (id === undefined && client.participantId !== undefined) {
          await runtime.store.putReport("participant:id", client.participantId);
        }
        if (client.participantId !== undefined) {
          runtime.participantId = client.participantId;
        }
      });
    return this.jobStatus(job);
  }

  /** Status of one run (default: the latest). Also drains new chat messages into `result`. */
  async purchaseStatus(token: string, runId?: string): Promise<PurchaseStatus> {
    const runtime = this.runtimeFor(token, "buyer");
    const id = runId ?? runtime.latestRunId;
    const job = id === undefined ? undefined : runtime.jobs.get(id);
    if (job === undefined) {
      throw new HostError("NO_PURCHASE", "no purchase has been started; call start_purchase");
    }
    if (job.state !== "running") {
      // The result message has been shown; it should not also arrive through report_pending.
      await this.drainOutbox(runtime);
    }
    return this.jobStatus(job);
  }

  /** Wait for a run to finish (tests and the terminal sandbox). */
  async waitForPurchase(token: string, runId: string): Promise<PurchaseStatus> {
    const runtime = this.runtimeFor(token, "buyer");
    const job = runtime.jobs.get(runId);
    if (job === undefined) {
      throw new HostError("NO_PURCHASE", "unknown purchase");
    }
    await job.done;
    return this.jobStatus(job);
  }

  async supplierStatus(token: string): Promise<SupplierStatus> {
    const runtime = this.runtimeFor(token, "supplier");
    return {
      listening: runtime.listenerLoop !== undefined && runtime.listenerAbort?.signal.aborted !== true,
      ticks: runtime.ticks,
      ...(runtime.lastTickAtMs === undefined ? {} : { lastTickAt: new Date(runtime.lastTickAtMs).toISOString() }),
      messages: await this.drainOutbox(runtime),
    };
  }

  /**
   * Compatibility with `supplier_listener_tick`: the always-on loop already
   * polls, so a bot-triggered tick only collects what that loop produced.
   */
  async supplierListenerTick(token: string): Promise<{ handled: string[]; reports: string[] }> {
    const status = await this.supplierStatus(token);
    return { handled: [], reports: status.messages };
  }

  /** Unread completion messages for any participant. */
  async reportPending(token: string): Promise<{ messages: string[] }> {
    return { messages: await this.drainOutbox(this.runtimeFor(token)) };
  }

  /** Identify the participant behind a token without exposing the token. */
  describe(token: string): { role: "buyer" | "supplier"; company: string; domain: string } {
    const runtime = this.runtimeFor(token);
    return {
      role: runtime.participant.role,
      company: runtime.participant.companyName,
      domain: runtime.participant.companyDomain,
    };
  }

  hasToken(token: string): boolean {
    return this.runtimes.has(token);
  }

  private async startSupplier(runtime: Runtime): Promise<void> {
    if (runtime.listenerLoop !== undefined) {
      return;
    }
    const config = this.supplierConfig(runtime);
    runtime.participantId = await registerSupplierParticipant(runtime.client, config, runtime.store);
    const channel: ReportChannel = async (message) => {
      await this.pushOutbox(runtime, message);
    };
    const listener = new SupplierListener({
      client: runtime.client,
      store: runtime.store,
      config,
      channel,
      participantId: runtime.participantId,
      ...(this.options.logger === undefined ? {} : { logger: this.options.logger }),
    });
    const abort = new AbortController();
    runtime.listener = listener;
    runtime.listenerAbort = abort;
    this.activity(`${runtime.label}: listener started (participant ${runtime.participantId})`);
    // The listener's own timers are unref'd; this keeps a host process alive while it listens.
    const keepAlive = setInterval(() => undefined, 30_000);
    runtime.listenerLoop = listener
      .run(abort.signal, (result) => {
        runtime.ticks += 1;
        runtime.lastTickAtMs = this.now();
        for (const reason of [...result.skipped, ...result.failed]) {
          if (reason.status === "failed") {
            this.activity(`${runtime.label}: event ${reason.eventType} failed (${reason.reason ?? "error"})`);
          }
        }
        for (const id of result.handled) {
          this.activity(`${runtime.label}: handled event ${id}`);
        }
        for (const decline of result.declined) {
          this.activity(`${runtime.label}: declined ${decline.requestId} (${decline.reason})`);
        }
      })
      .finally(() => clearInterval(keepAlive));
  }

  private buyerConfig(runtime: Runtime, purchase: PurchaseInput, ceiling: number): BuyerAgentConfig {
    return {
      ...this.baseConfig(runtime),
      currency: purchase.currency,
      role: "buyer",
      buyer: {
        maxOrderMinor: ceiling,
        maxRunMinor: ceiling,
        destination: purchase.destination,
        expiresAt: new Date(this.now() + GRANT_DAYS * 86_400_000).toISOString(),
        category: purchase.category,
        item: purchase.item,
        quantity: purchase.quantity,
        unit: purchase.unit,
        deliverBy: purchase.deliverBy,
        requirements: purchase.requirements ?? [],
      },
    };
  }

  private supplierConfig(runtime: Runtime): SupplierAgentConfig {
    const terms = runtime.participant.supplier;
    if (terms === undefined) {
      throw new HostError("MISSING_TERMS", "supplier has no terms");
    }
    return { ...this.baseConfig(runtime), currency: this.options.currency, role: "supplier", supplier: terms };
  }

  private baseConfig(runtime: Runtime) {
    return {
      marketplaceUrl: this.options.marketplaceUrl,
      token: runtime.participant.token,
      companyName: runtime.participant.companyName,
      companyDomain: runtime.participant.companyDomain,
      stateDir: "",
      pollIntervalMs: this.options.pollIntervalMs ?? 1_500,
      pollMaxIntervalMs: this.options.pollMaxIntervalMs ?? 5_000,
      negotiationMaxRevisions: MAX_NEGOTIATION_REVISIONS,
      negotiationDeadlineMs: this.options.negotiationDeadlineMs ?? DEFAULT_NEGOTIATION_DEADLINE_MS,
      requestTimeoutMs: this.options.requestTimeoutMs ?? 10_000,
      paymentWaitMs: this.options.paymentWaitMs ?? DEFAULT_PAYMENT_WAIT_MS,
      sandboxOnly: true as const,
    };
  }

  /**
   * MVP_LIMIT: candidate -> participant resolution is operator-supplied (hosted suppliers by
   * domain) until the platform offers a resolve call after ranking.
   */
  private supplierIdsByDomain(): Record<string, ParticipantId> {
    const map: Record<string, ParticipantId> = {};
    for (const runtime of this.runtimes.values()) {
      if (runtime.participant.role === "supplier" && runtime.participantId !== undefined) {
        map[normalizeDomain(runtime.participant.companyDomain)] = runtime.participantId;
      }
    }
    return map;
  }

  private supplierNames(): Record<string, string> {
    const names: Record<string, string> = {};
    for (const runtime of this.runtimes.values()) {
      if (runtime.participant.role === "supplier" && runtime.participantId !== undefined) {
        names[runtime.participantId] = runtime.participant.companyName;
      }
    }
    return names;
  }

  private runtimeFor(token: string, role?: "buyer" | "supplier"): Runtime {
    const runtime = this.runtimes.get(token);
    if (runtime === undefined) {
      throw new HostError("UNKNOWN_PARTICIPANT", "this token is not a hosted demo participant");
    }
    if (role !== undefined && runtime.participant.role !== role) {
      throw new HostError("WRONG_ROLE", `this tool is for a ${role}; this token is a ${runtime.participant.role}`);
    }
    return runtime;
  }

  private jobStatus(job: BuyerJob): PurchaseStatus {
    return {
      runId: job.runId,
      state: job.state,
      progress: [...job.progress],
      ...(job.result === undefined ? {} : { result: job.result }),
      ...(job.outcome === undefined ? {} : { outcome: job.outcome }),
      ...(job.orderId === undefined ? {} : { orderId: job.orderId }),
    };
  }

  private async pushOutbox(runtime: Runtime, message: string): Promise<void> {
    const outbox = parseOutbox(await runtime.store.getReport(OUTBOX_KEY));
    outbox.push(message);
    await runtime.store.putReport(OUTBOX_KEY, JSON.stringify(outbox.slice(-MAX_OUTBOX)));
    this.activity(`${runtime.label} chat <- ${message}`);
  }

  private async drainOutbox(runtime: Runtime): Promise<string[]> {
    const outbox = parseOutbox(await runtime.store.getReport(OUTBOX_KEY));
    const failed = await new ReportLedger(runtime.store).drainPending();
    if (outbox.length > 0) {
      await runtime.store.putReport(OUTBOX_KEY, "[]");
    }
    return [...outbox, ...failed.filter((message) => !outbox.includes(message))];
  }

  private activity(line: string): void {
    this.options.onActivity?.(line);
  }
}

/** Platform client that narrates the steps a chat bot can relay. */
class ProgressClient extends PlatformClient {
  participantId: string | undefined;
  private readonly note: (line: string) => void;
  private readonly names: () => Record<string, string>;
  private readonly announcedOrders = new Map<string, string>();

  constructor(
    options: PlatformClientOptions,
    note: (line: string) => void,
    names: () => Record<string, string> = () => ({}),
  ) {
    super(options);
    this.note = note;
    this.names = names;
  }

  override async registerParticipant(input: RegistrationInput, options?: MutationOptions) {
    const result = await super.registerParticipant(input, options);
    this.participantId = result.participantId;
    return result;
  }

  override async createRequest(input: Omit<SourcingRequest, "id" | "buyerId">, options?: MutationOptions) {
    const request = await super.createRequest(input, options);
    this.note(`sourcing request ${request.id} created`);
    return request;
  }

  override async getDiscovery(discoveryId: string): Promise<DiscoveryResult> {
    const result = await super.getDiscovery(discoveryId);
    if (result.status === "complete") {
      const names = result.candidates
        .slice()
        .sort((left, right) => left.rank - right.rank)
        .slice(0, 3)
        .map((candidate) => `${candidate.candidate.company.name} (${candidate.eligible})`);
      this.note(`discovery found ${result.candidates.length} candidate(s): ${names.join(", ")}`);
    } else if (result.status === "failed") {
      this.note("discovery failed");
    }
    return result;
  }

  override async requestQuote(requestId: string, supplierId: ParticipantId, options?: MutationOptions) {
    const result = await super.requestQuote(requestId, supplierId, options);
    this.note(`asked ${this.names()[supplierId] ?? supplierId} for a quote`);
    return result;
  }

  override async getOffer(offerId: string): Promise<Offer> {
    const offer = await super.getOffer(offerId);
    this.note(`offer ${offer.id} received: ${formatMinor(offer.deliveredTotal.amountMinor)} ${offer.deliveredTotal.currency}`);
    return offer;
  }

  override async submitOffer(input: Omit<Offer, "id">, options?: MutationOptions): Promise<Offer> {
    const offer = await super.submitOffer(input, options);
    this.note(`countered with ${formatMinor(offer.deliveredTotal.amountMinor)} ${offer.deliveredTotal.currency}`);
    return offer;
  }

  override async acceptOffer(offerId: string, options?: MutationOptions) {
    const result = await super.acceptOffer(offerId, options);
    this.note(
      result.state === "agreed"
        ? `accepted offer ${offerId}: order ${result.order.id} agreed`
        : `accepted offer ${offerId}; waiting for the counterparty`,
    );
    return result;
  }

  override async settleOrder(orderId: string, options?: MutationOptions): Promise<Order> {
    this.note(`starting sandbox payment for order ${orderId}`);
    return super.settleOrder(orderId, options);
  }

  override async getOrder(orderId: string): Promise<Order> {
    const order = await super.getOrder(orderId);
    if (this.announcedOrders.get(orderId) !== order.paymentStatus) {
      this.announcedOrders.set(orderId, order.paymentStatus);
      this.note(`order ${orderId} payment status: ${order.paymentStatus}`);
    }
    return order;
  }
}

function validatePurchase(input: PurchaseInput, currency: string): PurchaseInput {
  const problems: string[] = [];
  const text = (value: unknown, field: string): string => {
    if (typeof value !== "string" || value.trim() === "" || value.length > MAX_TEXT) {
      problems.push(field);
      return "";
    }
    return value.trim();
  };
  const item = text(input.item, "item");
  const category = text(input.category, "category");
  const unit = text(input.unit, "unit");
  const destination = text(input.destination, "destination");
  if (!Number.isSafeInteger(input.quantity) || input.quantity <= 0) {
    problems.push("quantity");
  }
  if (!Number.isSafeInteger(input.maxTotalMinor) || input.maxTotalMinor <= 0) {
    problems.push("maxTotalMinor");
  }
  if (input.currency !== currency) {
    problems.push(`currency (this demo trades in ${currency} only)`);
  }
  const deliverByMs = Date.parse(input.deliverBy);
  if (typeof input.deliverBy !== "string" || !Number.isFinite(deliverByMs) || !/[zZ]|[+-]\d\d:?\d\d$/.test(input.deliverBy)) {
    problems.push("deliverBy (ISO 8601 with timezone)");
  }
  const requirements = input.requirements ?? [];
  if (!Array.isArray(requirements) || requirements.length > 20) {
    problems.push("requirements");
  }
  if (problems.length > 0) {
    throw new HostError("INVALID_PURCHASE", `invalid or missing: ${problems.join(", ")}`);
  }
  return {
    item,
    category,
    quantity: input.quantity,
    unit,
    destination,
    deliverBy: new Date(deliverByMs).toISOString(),
    maxTotalMinor: input.maxTotalMinor,
    currency,
    requirements: requirements.map((requirement) => ({
      key: String(requirement.key).slice(0, 128),
      description: String(requirement.description).slice(0, MAX_TEXT),
      mandatory: requirement.mandatory === true,
    })),
  };
}

function parseOutbox(raw: string | undefined): string[] {
  if (raw === undefined) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

export function formatMinor(amountMinor: number): string {
  const absolute = Math.abs(amountMinor);
  return `${amountMinor < 0 ? "-" : ""}${Math.floor(absolute / 100)}.${String(absolute % 100).padStart(2, "0")}`;
}

function normalizeDomain(value: string): string {
  return value.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "").replace(/\.$/, "");
}

function safeMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : "unknown error";
  return text.replace(/\s+/g, " ").slice(0, 200);
}
