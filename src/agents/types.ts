import type { Offer, OfferId, RequestId, SourcingRequest } from "../contracts.js";

/** Agent-facing role, mirroring the platform participant roles. */
export type ParticipantRole = "buyer" | "supplier";

/**
 * Minimal logger shape so agents can accept an injected logger without
 * depending on a particular logging implementation.
 */
export interface AgentLogger {
  debug?(message: string, context?: Record<string, unknown>): void;
  info?(message: string, context?: Record<string, unknown>): void;
  warn?(message: string, context?: Record<string, unknown>): void;
  error?(message: string, context?: Record<string, unknown>): void;
}

/** Injected clock. Returns epoch milliseconds. */
export interface AgentClock {
  now(): number;
}

/** Injected sleep, used by polling loops and retry backoff in tests. */
export type SleepFn = (ms: number) => Promise<void>;

/** Normalised agent-side error. Never carries a credential. */
export interface AgentError {
  code: string;
  message: string;
  status?: number;
  retryable?: boolean;
}

/** Small result union for operations that should return rather than throw. */
export type Result<T> = { ok: true; value: T } | { ok: false; error: AgentError };

/**
 * Proposed participant-scoped read routes. `src/contracts.ts` does not yet
 * expose these; the agent client needs them to inspect an event's resource.
 */
export interface ScopedReadClient {
  getRequest(requestId: RequestId): Promise<SourcingRequest>;
  getOffer(offerId: OfferId): Promise<Offer>;
}
