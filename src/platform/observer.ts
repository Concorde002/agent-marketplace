import { AsyncLocalStorage } from "node:async_hooks";
import type { ActorContext } from "../contracts.js";

/**
 * Human-readable trace of every endpoint call, for the observer dashboard (docs/observer-stream.md).
 * Messages are built from an explicit allowlist of response/request fields per operation. Private
 * mandate limits, request budgets, credentials, headers, payment method ids and webhook secrets are
 * never read into a message.
 */
export interface ObserverLog {
  type: "log";
  v: 1;
  id: string;
  seq: number;
  at: string;
  requestId: string;
  parentRequestId?: string;
  source: "http" | "mcp" | "stripe" | "system";
  level: "debug" | "info" | "warn" | "error";
  operation: string;
  method: string;
  route: string;
  status: number;
  outcome: "ok" | "refused" | "error";
  code?: string;
  durationMs: number;
  actor?: { participantId: string; role: "buyer" | "supplier" };
  subject?: Subject;
  message: string;
}

/** Ids a log concerns. Undefined fields are dropped before the log is sent. */
export interface Subject {
  requestId?: string | undefined;
  offerId?: string | undefined;
  orderId?: string | undefined;
  discoveryId?: string | undefined;
  counterpartyId?: string | undefined;
  tool?: string | undefined;
}

type Listener = (log: ObserverLog) => void;

// MVP_LIMIT: in-process fan-out. Clients see only calls handled by the same server instance, so run
// Cloud Run with --max-instances=1 for the demo. Upgrade path: Postgres LISTEN/NOTIFY between instances.
export class ObserverBus {
  private seq = 0;
  private readonly listeners = new Set<Listener>();
  private readonly recentLogs: ObserverLog[] = [];

  constructor(private readonly backlogSize = 200) {}

  emit(log: Omit<ObserverLog, "type" | "v" | "id" | "seq">): ObserverLog {
    const full: ObserverLog = { type: "log", v: 1, id: crypto.randomUUID(), seq: ++this.seq, ...log };
    this.recentLogs.push(full);
    if (this.recentLogs.length > this.backlogSize) this.recentLogs.shift();
    for (const listener of this.listeners) {
      // A failing subscriber must never affect the request being handled.
      try { listener(full); } catch { /* ignored */ }
    }
    return full;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  recent(): ObserverLog[] { return [...this.recentLogs]; }
  get subscribers(): number { return this.listeners.size; }
}

/** Correlates internal calls made by an MCP tool with the /mcp call that triggered them. */
const correlation = new AsyncLocalStorage<{ requestId: string }>();

/** Stable operation names; MCP tool names where one exists. */
const ROUTES: { method: string; pattern: RegExp; route: string; operation: string }[] = [
  { method: "GET", pattern: /^\/v1\/me$/, route: "/v1/me", operation: "get_my_participant" },
  { method: "GET", pattern: /^\/v1\/events$/, route: "/v1/events", operation: "list_events" },
  { method: "GET", pattern: /^\/v1\/requests\/[^/]+$/, route: "/v1/requests/{requestId}", operation: "get_request" },
  { method: "GET", pattern: /^\/v1\/offers\/[^/]+$/, route: "/v1/offers/{offerId}", operation: "get_offer" },
  { method: "GET", pattern: /^\/v1\/orders\/[^/]+$/, route: "/v1/orders/{orderId}", operation: "get_order" },
  { method: "GET", pattern: /^\/v1\/discoveries\/[^/]+$/, route: "/v1/discoveries/{discoveryId}", operation: "get_discovery" },
  { method: "GET", pattern: /^\/v1\/discoveries\/[^/]+\/evidence$/, route: "/v1/discoveries/{discoveryId}/evidence", operation: "get_discovery_evidence" },
  { method: "GET", pattern: /^\/v1\/discoveries\/[^/]+\/sources\/[^/]+$/, route: "/v1/discoveries/{discoveryId}/sources/{sourceId}", operation: "read_discovery_source" },
  { method: "POST", pattern: /^\/v1\/participants$/, route: "/v1/participants", operation: "register_participant" },
  { method: "POST", pattern: /^\/v1\/requests$/, route: "/v1/requests", operation: "create_request" },
  { method: "POST", pattern: /^\/v1\/sources\/buyer-notices\/search$/, route: "/v1/sources/buyer-notices/search", operation: "search_buyer_notices" },
  { method: "POST", pattern: /^\/v1\/requests\/[^/]+\/discover$/, route: "/v1/requests/{requestId}/discover", operation: "start_discovery" },
  { method: "POST", pattern: /^\/v1\/requests\/[^/]+\/quote-requests$/, route: "/v1/requests/{requestId}/quote-requests", operation: "request_quote" },
  { method: "POST", pattern: /^\/v1\/requests\/[^/]+\/offers$/, route: "/v1/requests/{requestId}/offers", operation: "submit_offer" },
  { method: "POST", pattern: /^\/v1\/discoveries\/[^/]+\/assessments$/, route: "/v1/discoveries/{discoveryId}/assessments", operation: "submit_discovery_assessment" },
  { method: "POST", pattern: /^\/v1\/discoveries\/[^/]+\/resolve$/, route: "/v1/discoveries/{discoveryId}/resolve", operation: "resolve_discovery_participants" },
  { method: "POST", pattern: /^\/v1\/offers\/[^/]+\/acceptances$/, route: "/v1/offers/{offerId}/acceptances", operation: "accept_offer" },
  { method: "POST", pattern: /^\/v1\/orders\/[^/]+\/settle$/, route: "/v1/orders/{orderId}/settle", operation: "settle_order" },
  { method: "POST", pattern: /^\/mcp$/, route: "/mcp", operation: "mcp" },
  { method: "POST", pattern: /^\/webhooks\/stripe$/, route: "/webhooks/stripe", operation: "stripe_webhook" },
  { method: "GET", pattern: /^\/health$/, route: "/health", operation: "health" },
  { method: "GET", pattern: /^\/(agent|llms)\.txt$/, route: "/agent.txt", operation: "agent_instructions" },
  { method: "GET", pattern: /^\/openapi\.json$/, route: "/openapi.json", operation: "openapi" },
];

/** Path segments after the route prefix, e.g. the request id in /v1/requests/{id}/offers. */
function segment(path: string, index: number): string | undefined {
  try { return decodeURIComponent(path.split("/").filter(Boolean)[index] ?? "") || undefined; } catch { return undefined; }
}

export function routeOf(method: string, path: string): { route: string; operation: string } {
  const match = ROUTES.find((r) => r.method === method && r.pattern.test(path));
  if (match) return { route: match.route, operation: match.operation };
  // Unknown paths are summarised, never echoed: a path can carry arbitrary caller text.
  return { route: path.startsWith("/v1/") ? "/v1/…" : "(unknown)", operation: "unknown_route" };
}

const MAX_TEXT = 120;
function text(value: unknown): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return clean.length > MAX_TEXT ? `${clean.slice(0, MAX_TEXT - 1)}…` : clean;
}
function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
/** Offer terms and order totals are shareable presentation data; mandate limits and budgets never reach here. */
export function money(value: unknown): string | undefined {
  const m = record(value);
  if (!m || typeof m.amountMinor !== "number" || !Number.isSafeInteger(m.amountMinor) || typeof m.currency !== "string" || !/^[A-Z]{3}$/.test(m.currency)) return undefined;
  try {
    const format = new Intl.NumberFormat("en-GB", { style: "currency", currency: m.currency });
    const digits = format.resolvedOptions().maximumFractionDigits ?? 2;
    return format.format(m.amountMinor / 10 ** digits);
  } catch { return undefined; }
}
function date(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const t = Date.parse(value);
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : undefined;
}

/** Authenticated routes name the participant; public routes have no caller identity to name. */
function who(actor: ObserverLog["actor"], path: string): string {
  if (actor) return `${actor.role === "buyer" ? "Buyer" : "Supplier"} ${actor.participantId}`;
  return path.startsWith("/v1/") || path === "/mcp" ? "An unauthenticated caller" : "A client";
}

interface CallFacts {
  operation: string;
  path: string;
  status: number;
  code?: string;
  actor?: ObserverLog["actor"];
  request?: unknown;
  response?: unknown;
}

/** Turns one call into a sentence and the ids it concerns. Reads only allowlisted fields. */
export function describe(facts: CallFacts): { message: string; subject: Subject } {
  const { operation, path, status, actor } = facts;
  const req = record(facts.request), res = record(facts.response);
  const subject: Subject = {};
  const actorName = who(actor, path);
  const failed = status >= 400;

  switch (operation) {
    case "get_request": case "start_discovery": case "request_quote": case "submit_offer":
      subject.requestId = segment(path, 2); break;
    case "get_offer": case "accept_offer": subject.offerId = segment(path, 2); break;
    case "get_order": case "settle_order": subject.orderId = segment(path, 2); break;
    case "get_discovery": case "get_discovery_evidence": case "read_discovery_source":
    case "submit_discovery_assessment": case "resolve_discovery_participants": subject.discoveryId = segment(path, 2); break;
  }

  if (failed) {
    const verb = operation === "unknown_route" ? "call an unknown route" : operation.replaceAll("_", " ");
    const reason = facts.code ?? `HTTP ${status}`;
    const kind = status >= 500 ? "failed" : "was refused";
    return { message: `${actorName} tried to ${verb} and ${kind}: ${reason}.`, subject };
  }

  switch (operation) {
    case "get_my_participant": return { message: `${actorName} read its own participant profile.`, subject };
    case "register_participant": {
      const company = text(record(req?.company)?.name);
      return { message: `${actorName} registered${company ? ` as ${company}` : ""}.`, subject };
    }
    case "list_events": {
      const n = Array.isArray(res?.events) ? res.events.length : 0;
      return { message: `${actorName} checked for new events: ${n === 0 ? "none" : `${n} new`}.`, subject };
    }
    case "create_request": {
      subject.requestId = text(res?.id);
      // The request's maximumDeliveredTotal is the buyer's budget ceiling and is deliberately omitted.
      const what = [res?.quantity, text(res?.unit), text(res?.category) ? `of ${text(res?.category)}` : undefined].filter(Boolean).join(" ");
      const to = text(res?.destination), by = date(res?.deliverBy);
      return { message: `${actorName} created request ${subject.requestId ?? ""}: ${what}${to ? ` to ${to}` : ""}${by ? `, deliver by ${by}` : ""}.`, subject };
    }
    case "get_request": return { message: `${actorName} read request ${subject.requestId}.`, subject };
    case "search_buyer_notices": {
      const query = text(req?.query);
      const n = Array.isArray(res?.notices) ? res.notices.length : Array.isArray(res?.results) ? res.results.length : undefined;
      return { message: `${actorName} searched public TED notices${query ? ` for "${query}"` : ""}${n === undefined ? "" : `: ${n} found`}.`, subject };
    }
    case "start_discovery": {
      subject.discoveryId = text(res?.discoveryId);
      return { message: `${actorName} started live discovery ${subject.discoveryId ?? ""} for request ${subject.requestId}.`, subject };
    }
    case "get_discovery": {
      const n = Array.isArray(res?.candidates) ? res.candidates.length : 0;
      return { message: `${actorName} read discovery ${subject.discoveryId}: ${text(res?.status) ?? "unknown"}, ${n} ranked candidate${n === 1 ? "" : "s"}.`, subject };
    }
    case "get_discovery_evidence": return { message: `${actorName} read the collected public evidence for discovery ${subject.discoveryId}.`, subject };
    case "read_discovery_source": return { message: `${actorName} read a public source page for discovery ${subject.discoveryId}.`, subject };
    case "submit_discovery_assessment": {
      const candidates = Array.isArray(res?.candidates) ? res.candidates : [];
      const top = text(record(record(record(candidates[0])?.candidate)?.company)?.name);
      return { message: `${actorName} submitted its assessment for discovery ${subject.discoveryId}: ${candidates.length} candidate${candidates.length === 1 ? "" : "s"} ranked${top ? `, top: ${top}` : ""}.`, subject };
    }
    case "resolve_discovery_participants": {
      const rows = Array.isArray(res?.resolutions) ? res.resolutions : [];
      const connected = rows.filter((r) => record(r)?.connected === true).length;
      return { message: `${actorName} looked up connected accounts for discovery ${subject.discoveryId}: ${connected} of ${rows.length} candidate${rows.length === 1 ? "" : "s"} can be asked for a quote.`, subject };
    }
    case "request_quote": {
      subject.counterpartyId = text(req?.supplierId);
      return { message: `${actorName} asked supplier ${subject.counterpartyId ?? "?"} for a quote on request ${subject.requestId}.`, subject };
    }
    case "submit_offer": {
      subject.offerId = text(res?.id);
      const isCounter = typeof res?.previousOfferId === "string";
      if (actor) subject.counterpartyId = text(actor.role === "buyer" ? res?.supplierId : res?.buyerId);
      const terms = `${res?.quantity ?? "?"} ${text(res?.unit) ?? ""} for ${money(res?.deliveredTotal) ?? "an unknown total"}`.replace(/\s+/g, " ");
      const delivery = date(res?.deliveryAt);
      return { message: `${actorName} ${isCounter ? "made a counteroffer" : "made an offer"} on request ${subject.requestId}: ${terms}${delivery ? `, delivery ${delivery}` : ""} (offer ${subject.offerId ?? "?"}).`, subject };
    }
    case "get_offer": return { message: `${actorName} read offer ${subject.offerId}.`, subject };
    case "accept_offer": {
      const order = record(res?.order);
      if (res?.state === "agreed" && order) {
        subject.orderId = text(order.id);
        const total = money(record(order.acceptedOffer)?.deliveredTotal);
        return { message: `${actorName} accepted offer ${subject.offerId}. Both sides agreed: order ${subject.orderId}${total ? ` for ${total}` : ""}.`, subject };
      }
      return { message: `${actorName} accepted offer ${subject.offerId}; waiting for the other side to accept.`, subject };
    }
    case "settle_order": case "get_order": {
      const payment = text(res?.paymentStatus) ?? "unknown";
      const receipt = text(res?.sandboxPaymentId);
      const verb = operation === "settle_order" ? "started sandbox payment for" : "read";
      return { message: `${actorName} ${verb} order ${subject.orderId}: payment ${payment.replaceAll("_", " ")}${receipt ? ` (sandbox receipt ${receipt})` : ""}.`, subject };
    }
    case "mcp": {
      const method = text(req?.method);
      const tool = method === "tools/call" ? text(record(req?.params)?.name) : undefined;
      if (tool) subject.tool = tool;
      const isError = record(res?.result)?.isError === true || res?.error !== undefined;
      if (tool) return { message: `${actorName} called MCP tool ${tool}${isError ? " and got an error" : ""}.`, subject };
      return { message: `${actorName} sent MCP ${method ?? "message"}.`, subject };
    }
    case "stripe_webhook": {
      const object = record(record(req?.data)?.object);
      subject.orderId = text(record(object?.metadata)?.order_id);
      const result = text(res?.result);
      return { message: `Stripe reported ${text(req?.type) ?? "an event"}${subject.orderId ? ` for order ${subject.orderId}` : ""}${result ? `: ${result}` : ": acknowledged"}.`, subject };
    }
    case "health": return { message: "Health check.", subject };
    case "agent_instructions": return { message: "Agent instructions were read.", subject };
    case "openapi": return { message: "The API description was read.", subject };
    default: return { message: `${actorName} called ${operation}.`, subject };
  }
}

const READ_ONLY = new Set(["get_my_participant", "list_events", "get_request", "get_offer", "get_order", "get_discovery",
  "get_discovery_evidence", "read_discovery_source", "health", "agent_instructions", "openapi", "search_buyer_notices"]);

function levelOf(operation: string, status: number): ObserverLog["level"] {
  if (status >= 500) return "error";
  if (status >= 400) return "warn";
  return READ_ONLY.has(operation) ? "debug" : "info";
}

const MAX_CAPTURE_BYTES = 64 * 1024;
/** Bounded JSON capture of a request or response clone, for allowlisted message fields only. */
async function capture(message: Request | Response): Promise<unknown> {
  try {
    if (!message.headers.get("content-type")?.includes("application/json")) return undefined;
    const declared = Number(message.headers.get("content-length") ?? 0);
    if (declared > MAX_CAPTURE_BYTES) return undefined;
    const raw = await message.text();
    return raw.length > MAX_CAPTURE_BYTES ? undefined : JSON.parse(raw);
  } catch { return undefined; }
}

export interface ObservedCall { response: Response; actor?: ActorContext | undefined }

/**
 * Runs one call, then emits exactly one log. Nested calls (an MCP tool calling the same router)
 * record the outer call as their parent. Observation never changes or delays the response's content.
 */
export async function observe(bus: ObserverBus | undefined, request: Request, source: ObserverLog["source"], run: (request: Request) => Promise<ObservedCall>): Promise<Response> {
  if (!bus) return (await run(request)).response;
  const started = Date.now();
  const parent = correlation.getStore();
  const requestId = crypto.randomUUID();
  const path = new URL(request.url).pathname;
  const { route, operation } = routeOf(request.method, path);
  const wantsBody = request.method === "POST" && (operation === "mcp" || operation === "stripe_webhook" || operation === "request_quote"
    || operation === "search_buyer_notices" || operation === "register_participant");
  const requestCopy = wantsBody ? request.clone() : undefined;
  let call: ObservedCall | undefined;
  try {
    call = await correlation.run({ requestId }, () => run(request));
    return call.response;
  } finally {
    const status = call?.response.status ?? 500;
    const [requestJson, responseJson] = await Promise.all([
      requestCopy ? capture(requestCopy) : undefined,
      call ? capture(call.response.clone()) : undefined,
    ]);
    const code = status >= 400 ? text(record(responseJson)?.code) ?? text(record(responseJson)?.error) : undefined;
    const actor = call?.actor ? { participantId: call.actor.participantId, role: call.actor.role } : undefined;
    const { message, subject } = describe({ operation, path, status, actor, request: requestJson, response: responseJson, ...(code ? { code } : {}) });
    const nested = parent !== undefined;
    bus.emit({
      at: new Date().toISOString(), requestId, ...(nested ? { parentRequestId: parent.requestId } : {}),
      source: nested ? "mcp" : source, level: levelOf(operation, status), operation, method: request.method, route, status,
      outcome: status >= 500 ? "error" : status >= 400 ? "refused" : "ok", ...(code ? { code } : {}),
      durationMs: Date.now() - started, ...(actor ? { actor } : {}),
      ...(Object.values(subject).some((v) => v !== undefined) ? { subject: Object.fromEntries(Object.entries(subject).filter(([, v]) => v !== undefined)) } : {}),
      message,
    });
  }
}
