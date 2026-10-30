import type { ActorContext } from "../contracts.js";
import { PlatformClient } from "../agents/client.js";
import { LIVE_AGENT_INSTRUCTIONS } from "../agents/instructions.js";
import { createMcpBackend } from "../mcp/backend.js";
import { createMcpHandler } from "../mcp/gateway.js";
import { MCP_TOOLS, findTool, validateJsonSchema } from "../mcp/tools.js";
import { DiscoveryInputError } from "../sourcing/discovery.js";
import { PaymentRefusedError, PaymentUnavailableError } from "../payments/settlement.js";
import { IdentityError, authenticate, registerIdentity } from "./identity.js";
import { PlatformError, type Database } from "./database.js";
import { Marketplace } from "./marketplace.js";
import { observe, type ObserverBus } from "./observer.js";

export interface PlatformHttp {
  handle(request: Request): Promise<Response>;
  readiness(): Promise<{ sourcingReady: boolean; sandboxPaymentConfigured: boolean; endToEndVerified: false }>;
}

/** HTTP and MCP use the same authenticated route implementation, without a network self-call. */
export function createPlatformHttp(db: Database, market: Marketplace, options: { now?: () => Date; paymentConfigured?: boolean; observer?: ObserverBus } = {}): PlatformHttp {
  const now = options.now ?? (() => new Date());
  const supported = MCP_TOOLS.filter((tool) => !["start_purchase", "purchase_status", "supplier_status", "supplier_listener_tick", "report_pending"].includes(tool.name));
  const mcp = createMcpHandler(createMcpBackend({ clientForToken: (token) => new PlatformClient({
    baseUrl: "https://internal.marketplace", token, timeoutMs: 60_000, retry: { attempts: 1, baseDelayMs: 0 },
    fetchImpl: (input, init) => handle(new Request(input, init)),
  }) }), { tools: supported, instructions: LIVE_AGENT_INSTRUCTIONS });

  /** Every call, including the internal ones an MCP tool makes, emits one observer log. */
  async function handle(request: Request): Promise<Response> {
    return observe(options.observer, request, "http", async (observed) => {
      let actor: ActorContext | undefined;
      const response = await dispatch(observed, (authenticated) => { actor = authenticated; });
      return { response, actor };
    });
  }

  async function dispatch(request: Request, onActor: (actor: ActorContext) => void): Promise<Response> {
    let actor: ActorContext | undefined;
    try {
      const bearer = /^Bearer ([^\s]+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];
      if (!bearer) throw new IdentityError(401, "INVALID_CREDENTIAL");
      actor = await authenticate(db, bearer, now());
      onActor(actor);
      const url = new URL(request.url);
      if (url.pathname === "/mcp") {
        if (request.method !== "POST") return methodNotAllowed("POST");
        const { raw } = await jsonBody(request);
        return mcp(new Request(request.url, { method: "POST", headers: request.headers, body: raw, signal: request.signal }));
      }
      const parts = url.pathname.split("/").filter(Boolean).map((value) => decodeURIComponent(value));
      if (parts.some((part) => !/^[A-Za-z0-9:_-]{1,128}$/.test(part))) throw new PlatformError(400, "INVALID_PATH");
      if (request.method === "GET") {
        if (url.pathname === "/v1/me") return json(await market.me(actor));
        if (url.pathname === "/v1/events") return json(await market.events(actor, url.searchParams.get("after") ?? "0"));
        if (parts[0] === "v1" && parts[1] === "requests" && parts.length === 3) return json(await market.getRequest(actor, parts[2]!));
        if (parts[0] === "v1" && parts[1] === "offers" && parts.length === 3) return json(await market.getOffer(actor, parts[2]!));
        if (parts[0] === "v1" && parts[1] === "orders" && parts.length === 3) return json(await market.getOrder(actor, parts[2]!));
        if (parts[0] === "v1" && parts[1] === "discoveries") {
          const id = parts[2]!;
          if (parts.length === 3) return json(await market.getDiscovery(actor, id));
          if (parts.length === 4 && parts[3] === "evidence") return json(await market.evidence(actor, id));
          if (parts.length === 5 && parts[3] === "sources") return json(await market.source(actor, id, parts[4]!,
            url.searchParams.has("offset") ? Number(url.searchParams.get("offset")) : 0,
            url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : 8000));
        }
        throw new PlatformError(404, "NOT_FOUND");
      }
      if (request.method !== "POST") return methodNotAllowed("GET, POST");
      const { body } = await jsonBody(request);
      const key = request.headers.get("idempotency-key") ?? "";
      if (url.pathname === "/v1/participants") {
        return json(await market.mutate(actor, key, "register_participant", body, (tx) => registerIdentity(tx, actor!, body, now())));
      }
      if (url.pathname === "/v1/requests") return json(await market.createRequest(actor, body, key));
      if (url.pathname === "/v1/sources/buyer-notices/search") {
        validateTool("search_buyer_notices", body);
        const args = body as { query: string; limit?: number };
        return json(await market.searchBuyerNotices(args.query, args.limit));
      }
      if (parts[0] === "v1" && parts[1] === "requests" && parts.length === 4) {
        const id = parts[2]!;
        if (parts[3] === "discover") { emptyBody(body); return json(await market.startDiscovery(actor, id, key)); }
        if (parts[3] === "quote-requests") {
          if (!record(body) || Object.keys(body).length !== 1 || typeof body.supplierId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(body.supplierId)) throw new PlatformError(400, "INVALID_INPUT");
          return json(await market.requestQuote(actor, id, body.supplierId, key));
        }
        if (parts[3] === "offers") {
          if (!record(body) || body.requestId !== id) throw new PlatformError(400, "REQUEST_MISMATCH");
          return json(await market.submitOffer(actor, body, key));
        }
      }
      if (parts[0] === "v1" && parts[1] === "discoveries" && parts.length === 4) {
        const id = parts[2]!;
        if (parts[3] === "assessments") return json(await market.submitAssessment(actor, id, body, key));
        if (parts[3] === "resolve") { emptyBody(body); return json(await market.resolve(actor, id)); }
      }
      if (parts[0] === "v1" && parts[1] === "offers" && parts.length === 4 && parts[3] === "acceptances") {
        emptyBody(body); return json(await market.acceptOffer(actor, parts[2]!, key));
      }
      if (parts[0] === "v1" && parts[1] === "orders" && parts.length === 4 && parts[3] === "settle") {
        emptyBody(body); return json(await market.settle(actor, parts[2]!));
      }
      throw new PlatformError(404, "NOT_FOUND");
    } catch (error) {
      if (error instanceof PlatformError || error instanceof IdentityError) return json({ error: error.code, code: error.code,
        ...(error.code === "ALREADY_REGISTERED" && actor ? { participantId: actor.participantId } : {}) }, error.status);
      if (error instanceof DiscoveryInputError) return json({ error: error.code, code: error.code }, error.code === "FORBIDDEN" ? 403 : 400);
      if (error instanceof PaymentRefusedError) return json({ error: error.code, code: error.code }, 403);
      if (error instanceof PaymentUnavailableError) return json({ error: "SANDBOX_PAYMENT_UNAVAILABLE" }, 503);
      if (error instanceof URIError) return json({ error: "INVALID_PATH" }, 400);
      // SQL/provider text, stacks, tokens and private limits never cross the public error boundary.
      return json({ error: "PLATFORM_UNAVAILABLE", code: "PLATFORM_UNAVAILABLE" }, 503);
    }
  }
  return { handle, async readiness() {
    let sourcingReady = false;
    try {
      await db.query("select buyer_notice_number from marketplace.sourcing_requests limit 0");
      await db.query("select evidence_bundle,result from marketplace.discovery_runs limit 0");
      sourcingReady = true;
    } catch { /* Missing migrations/DB remain unavailable, not silently replaced by memory state. */ }
    return { sourcingReady, sandboxPaymentConfigured: options.paymentConfigured === true, endToEndVerified: false };
  } };
}

function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function emptyBody(body: unknown): void { if (!record(body) || Object.keys(body).length) throw new PlatformError(400, "INVALID_INPUT"); }
function json(value: unknown, status = 200): Response { return Response.json(value, { status, headers: { "cache-control": "no-store" } }); }
function methodNotAllowed(method: string): Response { return Response.json({ error: "METHOD_NOT_ALLOWED" }, { status: 405, headers: { allow: method } }); }
function validateTool(name: string, value: unknown): void {
  const tool = findTool(name);
  if (!tool || !validateJsonSchema(tool.inputSchema, value, "input").ok) throw new PlatformError(400, "INVALID_INPUT");
}

/** Bound both HTTP and MCP JSON before any schema traversal, hashing or database call. */
async function jsonBody(request: Request): Promise<{ raw: string; body: unknown }> {
  if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") throw new PlatformError(415, "JSON_REQUIRED");
  if (!request.body) throw new PlatformError(400, "JSON_REQUIRED");
  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const read = async () => {
    let raw = "", bytes = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 256 * 1024) throw new PlatformError(413, "BODY_TOO_LARGE");
      raw += decoder.decode(value, { stream: true });
    }
    raw += decoder.decode();
    let body: unknown;
    try { body = JSON.parse(raw); } catch { throw new PlatformError(400, "INVALID_JSON"); }
    const stack: { value: unknown; depth: number }[] = [{ value: body, depth: 0 }];
    while (stack.length) {
      const current = stack.pop()!;
      if (current.depth > 16) throw new PlatformError(400, "JSON_TOO_DEEP");
      if (typeof current.value === "object" && current.value !== null) for (const value of Object.values(current.value)) stack.push({ value, depth: current.depth + 1 });
    }
    return { raw, body };
  };
  try {
    return await Promise.race([read(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new PlatformError(408, "BODY_TIMEOUT")), 5000);
    })]);
  } finally { clearTimeout(timer); void reader.cancel().catch(() => {}); }
}
