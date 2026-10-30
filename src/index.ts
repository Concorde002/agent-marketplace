import { liveOpenapi, openapi } from "./openapi.js";
import { LIVE_AGENT_INSTRUCTIONS, SCAFFOLD_AGENT_INSTRUCTIONS } from "./agents/instructions.js";
import type { SettlementService } from "./payments/settlement.js";
import type { PlatformHttp } from "./platform/http.js";
import { observe, type ObserverBus } from "./platform/observer.js";

/** Server-held wiring. Absent pieces stay explicitly unimplemented (501), never faked. */
export interface Dependencies {
  stripeWebhook?: { settlement: SettlementService; secret: string };
  platform?: PlatformHttp;
  /** Receives one human-readable log per endpoint call; see docs/observer-stream.md. */
  observer?: ObserverBus;
}

export async function handleRequest(request: Request, deps: Dependencies = {}): Promise<Response> {
  const path = new URL(request.url).pathname;
  // The platform router logs its own calls, so they are not observed twice here.
  if (deps.platform && (path.startsWith("/v1/") || path === "/mcp")) return deps.platform.handle(request);
  const source = path === "/webhooks/stripe" ? "stripe" : path.startsWith("/v1/") || path === "/mcp" ? "http" : "system";
  return observe(deps.observer, request, source, async (observed) => ({ response: await route(observed, deps) }));
}

async function route(request: Request, deps: Dependencies): Promise<Response> {
  const path = new URL(request.url).pathname;
  // Authenticated by Stripe's signature over the raw body, not by a participant credential.
  if (path === "/webhooks/stripe" && deps.stripeWebhook) {
    return deps.stripeWebhook.settlement.handleWebhook(request, deps.stripeWebhook.secret);
  }
  if (["/health", "/agent.txt", "/llms.txt", "/openapi.json"].includes(path)) {
    if (request.method !== "GET") {
      return Response.json({ error: "METHOD_NOT_ALLOWED" }, { status: 405, headers: { Allow: "GET" } });
    }
    if (path === "/health") {
      if (deps.platform) return Response.json({ status: "demo-api", demo: true, marketplaceReady: false,
        capabilities: await deps.platform.readiness(), note: "API availability is not proof of named-client or provider-confirmed end-to-end acceptance" });
      return Response.json({ status: "scaffold", demo: true, marketplaceReady: false });
    }
    if (path === "/agent.txt" || path === "/llms.txt") {
      const instructions = deps.platform ? LIVE_AGENT_INSTRUCTIONS : SCAFFOLD_AGENT_INSTRUCTIONS;
      return new Response(instructions, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
    }
    return Response.json(deps.platform ? liveOpenapi() : openapi);
  }
  // MVP_LIMIT: no business implementation yet. Replace through reviewed workstream PRs.
  if (path.startsWith("/v1/") || path === "/webhooks/stripe") {
    return Response.json({ error: "NOT_IMPLEMENTED", demo: true }, { status: 501 });
  }
  return Response.json({ error: "NOT_FOUND" }, { status: 404 });
}

export default { fetch: handleRequest };
