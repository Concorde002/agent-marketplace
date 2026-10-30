import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { ParticipantId, RegistrationInput } from "../../contracts.js";
import { BuyerRunner, type BuyerOutcome } from "../buyer.js";
import { PlatformClient, type MutationOptions } from "../client.js";
import {
  loadConfig,
  type AgentEnvironment,
  type BuyerAgentConfig,
} from "../config.js";
import { PARTICIPANT_ID_STATE_KEY } from "../reporter.js";
import {
  FileAgentStateStore,
  agentStateFilePath,
  type AgentStateStore,
} from "../store.js";
import type { AgentLogger } from "../types.js";

/** Exit codes of the one-shot buyer entrypoint. */
export type BuyerExitCode = 0 | 2 | 3;

export interface BuyerCliRunOptions {
  env?: AgentEnvironment;
  client?: PlatformClient;
  store?: AgentStateStore;
  /** Domain-to-participant mapping for platforms that do not expose the id. */
  supplierIdsByDomain?: Readonly<Record<string, ParticipantId>>;
  /** Injected chat transport, e.g. a bot conversation in the demo. */
  onReport?: (outcome: BuyerOutcome) => void | Promise<void>;
  /** Overrides the per-run id; defaults to a fresh UUID so reruns never replay. */
  runId?: string;
  logger?: AgentLogger;
}

export interface BuyerCliRun {
  outcome: BuyerOutcome;
  exitCode: BuyerExitCode;
  config: BuyerAgentConfig;
  orderId?: string;
}

/** Remember the participant id so a restart can reuse it after ALREADY_REGISTERED. */
class RegisteringClient extends PlatformClient {
  participantId: string | undefined;

  override async registerParticipant(
    input: RegistrationInput,
    options: MutationOptions = {},
  ): Promise<{ participantId: ParticipantId }> {
    const result = await super.registerParticipant(input, options);
    this.participantId = result.participantId;
    return result;
  }
}

/**
 * Run one buyer pass: load configuration, persist state under
 * `AGENT_STATE_DIR`, drive discovery/negotiation to an outcome and return the
 * authoritative result. Nothing secret is printed or returned.
 */
export async function runBuyerOnce(
  options: BuyerCliRunOptions = {},
): Promise<BuyerCliRun> {
  const env = options.env ?? process.env;
  const config = loadConfig(env);
  if (config.role !== "buyer") {
    throw new Error("PARTICIPANT_ROLE must be buyer for the buyer entrypoint");
  }

  const store =
    options.store ??
    new FileAgentStateStore(agentStateFilePath(config.stateDir));
  const client =
    options.client ??
    new RegisteringClient({
      baseUrl: config.marketplaceUrl,
      token: config.token,
      timeoutMs: config.requestTimeoutMs,
    });

  const supplierIdsByDomain =
    options.supplierIdsByDomain ?? readSupplierIds(env);
  const knownParticipantId = await store.getReport(PARTICIPANT_ID_STATE_KEY);

  const runner = new BuyerRunner({
    config,
    client,
    store,
    ...(knownParticipantId === undefined || knownParticipantId.trim() === ""
      ? {}
      : { knownParticipantId: knownParticipantId.trim() }),
    ...(supplierIdsByDomain === undefined ? {} : { supplierIdsByDomain }),
    ...(options.runId === undefined ? {} : { runId: options.runId }),
    report:
      options.onReport ??
      ((outcome: BuyerOutcome): void => {
        console.log(`[buyer chat] ${outcome.message}`);
      }),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });

  try {
    const outcome = await runner.run();
    return {
      outcome,
      exitCode: buyerExitCode(outcome),
      config,
      ...(outcome.status === "no_match" ? {} : { orderId: outcome.order.id }),
    };
  } finally {
    if (client instanceof RegisteringClient && client.participantId !== undefined) {
      await store
        .putReport(PARTICIPANT_ID_STATE_KEY, client.participantId)
        .catch(() => undefined);
    }
  }
}

/** 0 for a sandbox-paid agreement, 2 for no match, 3 for a failed payment. */
export function buyerExitCode(outcome: BuyerOutcome): BuyerExitCode {
  if (outcome.status === "agreed_and_paid") {
    return 0;
  }
  return outcome.status === "no_match" ? 2 : 3;
}

/** The single JSON line the buyer entrypoint prints; never includes the token. */
export function buyerOutcomeLine(run: BuyerCliRun): Record<string, unknown> {
  if (run.outcome.status === "no_match") {
    return {
      role: "buyer",
      status: run.outcome.status,
      reason: run.outcome.reason,
      exitCode: run.exitCode,
      message: run.outcome.message,
    };
  }
  return {
    role: "buyer",
    status: run.outcome.status,
    orderId: run.outcome.order.id,
    paymentStatus: run.outcome.order.paymentStatus,
    exitCode: run.exitCode,
    message: run.outcome.message,
  };
}

/**
 * MVP_LIMIT: operator-supplied mapping until the platform resolves a ranked
 * candidate to a connected participant: JSON object of company domain to participant id.
 */
function readSupplierIds(
  env: AgentEnvironment,
): Readonly<Record<string, ParticipantId>> | undefined {
  const raw = env.BUYER_SUPPLIER_IDS_JSON;
  if (raw === undefined || raw.trim() === "") {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("BUYER_SUPPLIER_IDS_JSON must be valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      "BUYER_SUPPLIER_IDS_JSON must be a JSON object mapping company domain to participant id",
    );
  }

  const mapping: Record<string, ParticipantId> = {};
  for (const [domain, value] of Object.entries(parsed)) {
    if (typeof value !== "string" || value.trim() === "") {
      throw new Error(
        `BUYER_SUPPLIER_IDS_JSON has an invalid participant id for domain ${domain}`,
      );
    }
    mapping[domain] = value.trim();
  }
  return mapping;
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message.slice(0, 300);
  }
  return "unknown error";
}

async function main(): Promise<number> {
  try {
    const run = await runBuyerOnce();
    console.log(JSON.stringify(buyerOutcomeLine(run)));
    return run.exitCode;
  } catch (error) {
    console.error(
      JSON.stringify({
        role: "buyer",
        status: "error",
        message: describeError(error),
      }),
    );
    return 1;
  }
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
