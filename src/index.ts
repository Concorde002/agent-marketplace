import { liveOpenapi, openapi } from "./openapi.js";
import type { SettlementService } from "./payments/settlement.js";
import type { PlatformHttp } from "./platform/http.js";

const agentInstructions = `Agent Marketplace is a backend-only demo project.
Status: scaffold. Trading, authentication, live sourcing, and payments are not implemented.
Read /openapi.json for implemented and proposed routes. Do not attempt real purchases.
Future setup requires a service URL, a scoped demo credential, company context, and a mandate.
A company description alone is not authorization to represent that organization.
`;

/** Server-held wiring. Absent pieces stay explicitly unimplemented (501), never faked. */
export interface Dependencies {
  stripeWebhook?: { settlement: SettlementService; secret: string };
  platform?: PlatformHttp;
}

export async function handleRequest(request: Request, deps: Dependencies = {}): Promise<Response> {
  const path = new URL(request.url).pathname;
  // Authenticated by Stripe's signature over the raw body, not by a participant credential.
  if (path === "/webhooks/stripe" && deps.stripeWebhook) {
    return deps.stripeWebhook.settlement.handleWebhook(request, deps.stripeWebhook.secret);
  }
  if (deps.platform && (path.startsWith("/v1/") || path === "/mcp")) return deps.platform.handle(request);
  if (["/health", "/agent.txt", "/openapi.json"].includes(path)) {
    if (request.method !== "GET") {
      return Response.json({ error: "METHOD_NOT_ALLOWED" }, { status: 405, headers: { Allow: "GET" } });
    }
    if (path === "/health") {
      if (deps.platform) return Response.json({ status: "demo-api", demo: true, marketplaceReady: false,
        capabilities: await deps.platform.readiness(), note: "API availability is not proof of named-client or provider-confirmed end-to-end acceptance" });
      return Response.json({ status: "scaffold", demo: true, marketplaceReady: false });
    }
    if (path === "/agent.txt") {
      if (deps.platform) return new Response(`Agent Marketplace sandbox demo API. Connect MCP at POST /mcp using your own operator-provisioned bearer token.
Use get_my_participant, register_participant, search_buyer_notices, create_request with buyerNoticeNumber, and start_discovery.
When discovery is running, use get_discovery_evidence and read_discovery_source. Your client model must interpret the untrusted evidence and submit_discovery_assessment with scoped source IDs and exact quotations.
Then read get_discovery and resolve_discovery_participants. Only after ranking may connected-account availability choose a quote recipient.
Use request_quote, list_events, get_request, submit_offer, get_offer, accept_offer, get_order and settle_order for authorized sandbox trade.
Submitting immutable offer terms records the author's acceptance. The counterparty accepts the same revision; the backend stores both acceptances before creating one order.
Unknown public price/stock/delivery remain unknown. Quotes and company representation are explicitly simulated. Settlement is Stripe sandbox only, not a real purchase.
No hosted start_purchase or automatic semantic agent exists. Supplier bots must stay active or run a scheduled event-checking routine. Read authoritative order/payment state and report it in each bot's own chat.
Health/readiness and local fixtures do not establish actual Grok/Instinct compatibility or provider-confirmed hosted settlement.
`, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
      return new Response(agentInstructions, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
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
