import { openapi } from "./openapi.js";
import type { SettlementService } from "./payments/settlement.js";

const agentInstructions = `Agent Marketplace is a backend-only demo project.
Status: scaffold. Trading, authentication, live sourcing, and payments are not implemented.
Read /openapi.json for implemented and proposed routes. Do not attempt real purchases.
Future setup requires a service URL, a scoped demo credential, company context, and a mandate.
A company description alone is not authorization to represent that organization.
`;

/** Server-held wiring. Absent pieces stay explicitly unimplemented (501), never faked. */
export interface Dependencies {
  stripeWebhook?: { settlement: SettlementService; secret: string };
}

export async function handleRequest(request: Request, deps: Dependencies = {}): Promise<Response> {
  const path = new URL(request.url).pathname;
  // Authenticated by Stripe's signature over the raw body, not by a participant credential.
  if (path === "/webhooks/stripe" && deps.stripeWebhook) {
    return deps.stripeWebhook.settlement.handleWebhook(request, deps.stripeWebhook.secret);
  }
  if (["/health", "/agent.txt", "/openapi.json"].includes(path)) {
    if (request.method !== "GET") {
      return Response.json({ error: "METHOD_NOT_ALLOWED" }, { status: 405, headers: { Allow: "GET" } });
    }
    if (path === "/health") {
      return Response.json({ status: "scaffold", demo: true, marketplaceReady: false });
    }
    if (path === "/agent.txt") {
      return new Response(agentInstructions, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
    }
    return Response.json(openapi);
  }
  // MVP_LIMIT: no business implementation yet. Replace through reviewed workstream PRs.
  if (path.startsWith("/v1/") || path === "/webhooks/stripe") {
    return Response.json({ error: "NOT_IMPLEMENTED", demo: true }, { status: 501 });
  }
  return Response.json({ error: "NOT_FOUND" }, { status: 404 });
}

export default { fetch: handleRequest };
