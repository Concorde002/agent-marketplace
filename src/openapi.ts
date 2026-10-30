const plannedRoutes = [
  ["/v1/participants", "post", "registerParticipant"],
  ["/v1/requests", "post", "createRequest"],
  ["/v1/requests/{requestId}/discover", "post", "startDiscovery"],
  ["/v1/discoveries/{discoveryId}", "get", "getDiscovery"],
  ["/v1/events", "get", "listEvents"],
  ["/v1/requests/{requestId}/quote-requests", "post", "requestQuote"],
  ["/v1/requests/{requestId}/offers", "post", "submitOffer"],
  ["/v1/offers/{offerId}/acceptances", "post", "acceptOffer"],
  ["/v1/orders/{orderId}/settle", "post", "settleOrder"],
  ["/v1/orders/{orderId}", "get", "getOrder"],
] as const;

export const openapi = {
  openapi: "3.1.0",
  info: {
    title: "Agent Marketplace",
    version: "0.1.0",
    description: "Scaffold only. Planned business routes are not callable integrations yet; typed draft contracts are in src/contracts.ts.",
  },
  components: {
    securitySchemes: { participantToken: { type: "http", scheme: "bearer" } },
  },
  paths: {
    "/health": { get: { operationId: "health", "x-implemented": true, responses: { "200": { description: "Scaffold status, not marketplace readiness" } } } },
    "/agent.txt": { get: { operationId: "agentInstructions", "x-implemented": true, responses: { "200": { description: "Plain-text integration status" } } } },
    "/openapi.json": { get: { operationId: "openapi", "x-implemented": true, responses: { "200": { description: "Draft API description" } } } },
    ...Object.fromEntries(plannedRoutes.map(([path, method, operationId]) => [path, {
      [method]: {
        operationId,
        "x-implemented": false,
        description: "Planned. Returns 501 until implemented; schemas must be completed by the owner before client integration.",
        security: [{ participantToken: [] }],
        parameters: Array.from(path.matchAll(/\{([^}]+)\}/g), (match) => ({ name: match[1], in: "path", required: true, schema: { type: "string" } })),
        responses: { "501": { description: "Not implemented" } },
      },
    }])),
    "/webhooks/stripe": { post: { operationId: "stripeWebhook", "x-implemented": false, description: "Planned: Stripe signature authentication, not participant authentication.", responses: { "501": { description: "Not implemented" } } } },
  },
};
