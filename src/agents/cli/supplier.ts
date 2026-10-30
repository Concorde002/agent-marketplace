import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { ParticipantId, RegistrationInput } from "../../contracts.js";
import { PlatformClient, PlatformClientError, stableHash } from "../client.js";
import {
  loadConfig,
  type AgentEnvironment,
  type SupplierAgentConfig,
} from "../config.js";
import {
  SupplierListener,
  type ListenerTickResult,
} from "../listener.js";
import { PARTICIPANT_ID_STATE_KEY } from "../reporter.js";
import {
  FileAgentStateStore,
  agentStateFilePath,
  type AgentStateStore,
} from "../store.js";
import type { AgentLogger } from "../types.js";

export interface SupplierCliRunOptions {
  env?: AgentEnvironment;
  client?: PlatformClient;
  store?: AgentStateStore;
  /** Participant id already registered by an earlier step or process. */
  participantId?: string;
  /** Stops the loop; the process wires SIGINT/SIGTERM to this signal. */
  signal?: AbortSignal;
  /**
   * The supplier bot's conversation. The terminal harness prints each message;
   * a bot integration passes its own transport. A throwing channel queues the
   * message for `report_pending` instead of losing it.
   */
  channel?: (message: string) => Promise<void>;
  /** Called after every tick, before the backoff delay. */
  onTick?: (result: ListenerTickResult, tick: number) => void | Promise<void>;
  logger?: AgentLogger;
}

export interface SupplierCliRun {
  listener: SupplierListener;
  participantId: string;
  config: SupplierAgentConfig;
  ticks: number;
  handled: number;
  reports: string[];
  aborted: boolean;
}

/**
 * Register the supplier participant once and persist its id so later restarts
 * (and the listener's `participant:id` fallback) reuse it.
 */
export async function registerSupplierParticipant(
  client: PlatformClient,
  config: SupplierAgentConfig,
  store: AgentStateStore,
): Promise<ParticipantId> {
  const stored = await store.getReport(PARTICIPANT_ID_STATE_KEY);
  if (stored !== undefined && stored.trim() !== "") {
    return stored.trim();
  }

  const registration = buildSupplierRegistration(config);
  try {
    const { participantId } = await client.registerParticipant(registration, {
      idempotencyKey: `agent-register-supplier-${registrationKey(config)}-${stableHash(registration)}`,
    });
    await store.putReport(PARTICIPANT_ID_STATE_KEY, participantId);
    return participantId;
  } catch (error) {
    if (
      error instanceof PlatformClientError &&
      error.code === "ALREADY_REGISTERED"
    ) {
      if (error.participantId !== undefined) {
        await store.putReport(PARTICIPANT_ID_STATE_KEY, error.participantId);
        return error.participantId;
      }
      throw new Error(
        "supplier token is already registered and neither the platform nor AGENT_STATE_DIR supplied its participant id; ask the platform owner for the existing id",
      );
    }
    throw error;
  }
}

/**
 * Run the supplier listener until the signal aborts. The loop keeps polling
 * after an agreement, so later payment updates are still observed and reported.
 */
export async function runSupplierLoop(
  options: SupplierCliRunOptions = {},
): Promise<SupplierCliRun> {
  const env = options.env ?? process.env;
  const config = loadConfig(env);
  if (config.role !== "supplier") {
    throw new Error("PARTICIPANT_ROLE must be supplier for the supplier entrypoint");
  }

  const store =
    options.store ??
    new FileAgentStateStore(agentStateFilePath(config.stateDir));
  const client =
    options.client ??
    new PlatformClient({
      baseUrl: config.marketplaceUrl,
      token: config.token,
      timeoutMs: config.requestTimeoutMs,
    });

  const participantId =
    options.participantId ??
    (await registerSupplierParticipant(client, config, store));

  const reports: string[] = [];
  let handled = 0;
  let ticks = 0;

  const listener = new SupplierListener({
    client,
    store,
    config,
    channel:
      options.channel ??
      (async (message: string): Promise<void> => {
        console.log(`[supplier chat] ${message}`);
      }),
    participantId,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });

  // The listener's backoff timer is unref'd, so an idle loop would otherwise
  // let the process exit. A ref'd keep-alive timer holds it open until abort.
  const keepAlive = setInterval(() => undefined, 30_000);
  try {
    await listener.run(options.signal, (result) => {
      ticks += 1;
      handled += result.handled.length;
      reports.push(...result.reports);
      return options.onTick === undefined
        ? undefined
        : options.onTick(result, ticks);
    });
  } finally {
    clearInterval(keepAlive);
  }

  return {
    listener,
    participantId,
    config,
    ticks,
    handled,
    reports,
    aborted: options.signal?.aborted === true,
  };
}

function buildSupplierRegistration(
  config: SupplierAgentConfig,
): RegistrationInput {
  const company =
    config.companyOrgId === undefined
      ? {
          name: config.companyName,
          officialDomain: config.companyDomain,
        }
      : {
          name: config.companyName,
          officialDomain: config.companyDomain,
          publicOrganizationId: config.companyOrgId,
        };

  return {
    company,
    role: "supplier",
    mandate: {
      minimumDeliveredTotal: {
        amountMinor: config.supplier.minTotalMinor,
        currency: config.currency,
      },
      availableQuantity: config.supplier.quantity,
      unit: config.supplier.unit,
      earliestDeliveryAt: config.supplier.earliestDeliveryAt,
      expiresAt: config.supplier.expiresAt,
      sandboxOnly: true,
    },
    demo: true,
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

function registrationKey(config: SupplierAgentConfig): string {
  const domain = normalizeDomain(config.companyDomain);
  const company = config.companyName.trim().toLowerCase().replace(/\s+/g, "-");
  return `${domain}-${company}`;
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message.slice(0, 300);
  }
  return "unknown error";
}

async function main(): Promise<void> {
  const controller = new AbortController();
  const stop = (): void => {
    controller.abort();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  try {
    const run = await runSupplierLoop({
      signal: controller.signal,
      onTick: (result, tick) => {
        console.log(
          JSON.stringify({
            role: "supplier",
            tick,
            handled: result.handled.length,
            eventIds: result.handled,
            reports: result.reports,
            failed: result.failed.length,
            skipped: result.skipped.length,
            productive: result.productive,
          }),
        );
      },
    });
    console.log(
      JSON.stringify({
        role: "supplier",
        event: "shutdown",
        ticks: run.ticks,
        handled: run.handled,
        reports: run.reports.length,
        aborted: run.aborted,
      }),
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        role: "supplier",
        event: "error",
        message: describeError(error),
      }),
    );
    process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
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
  void main();
}
