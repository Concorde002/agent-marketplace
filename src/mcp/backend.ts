import type { DiscoveryResult, EventPage, Offer, Order, RegistrationInput, SourcingRequest } from "../contracts.js";
import type {
  AcceptanceResult,
  CreateRequestInput,
  McpToolBackend,
  PendingReportResult,
  PurchaseToolInput,
  PurchaseToolStatus,
  SubmitOfferInput,
  SupplierTickResult,
  SupplierToolStatus,
} from "./gateway.js";

/**
 * The platform surface the MCP gateway needs. `PlatformClient` in `src/agents/client.ts`
 * satisfies this structurally; keeping it as an interface lets this adapter be reviewed and
 * tested without depending on the agent runtime.
 */
export interface PlatformToolClient {
  registerParticipant(input: RegistrationInput): Promise<{ participantId: string }>;
  createRequest(input: CreateRequestInput): Promise<SourcingRequest>;
  startDiscovery(requestId: string): Promise<{ discoveryId: string }>;
  getDiscovery(discoveryId: string): Promise<DiscoveryResult>;
  requestQuote(requestId: string, supplierId: string): Promise<{ eventId: string }>;
  submitOffer(input: SubmitOfferInput): Promise<Offer>;
  acceptOffer(offerId: string): Promise<AcceptanceResult>;
  settleOrder(orderId: string): Promise<Order>;
  getOrder(orderId: string): Promise<Order>;
  listEvents(after?: string): Promise<EventPage>;
  getRequest(requestId: string): Promise<SourcingRequest>;
  getOffer(offerId: string): Promise<Offer>;
}

/**
 * Optional per-participant long-running behaviour. The gateway is stateless; listeners, cursors
 * and report ledgers belong to the caller's runtime and are keyed by participant token.
 */
export interface ToolRuntimeHooks {
  supplierListenerTick?: (token: string) => Promise<SupplierTickResult>;
  reportPending?: (token: string) => Promise<PendingReportResult>;
  startPurchase?: (token: string, input: PurchaseToolInput) => Promise<PurchaseToolStatus>;
  purchaseStatus?: (token: string, runId?: string) => Promise<PurchaseToolStatus>;
  supplierStatus?: (token: string) => Promise<SupplierToolStatus>;
}

export interface McpBackendOptions {
  clientForToken: (token: string) => PlatformToolClient;
  hooks?: ToolRuntimeHooks;
}

/**
 * Build the MCP tool backend for `createMcpHandler`.
 *
 * The participant token from the HTTP request selects the client and the runtime hooks, so a
 * tool argument can never switch identity. No business rule lives here: settlement amounts,
 * policies and offer revisions are enforced by the platform client and the backend.
 */
export function createMcpBackend(options: McpBackendOptions): McpToolBackend {
  const { clientForToken, hooks } = options;

  return {
    registerParticipant: (token, input) => clientForToken(token).registerParticipant(input),
    createRequest: (token, input) => clientForToken(token).createRequest(input),
    startDiscovery: (token, requestId) => clientForToken(token).startDiscovery(requestId),
    getDiscovery: (token, discoveryId) => clientForToken(token).getDiscovery(discoveryId),
    requestQuote: (token, requestId, supplierId) =>
      clientForToken(token).requestQuote(requestId, supplierId),
    submitOffer: (token, input) => clientForToken(token).submitOffer(input),
    acceptOffer: (token, offerId) => clientForToken(token).acceptOffer(offerId),
    settleOrder: (token, orderId) => clientForToken(token).settleOrder(orderId),
    getOrder: (token, orderId) => clientForToken(token).getOrder(orderId),
    listEvents: (token, after) => clientForToken(token).listEvents(after),
    getRequest: (token, requestId) => clientForToken(token).getRequest(requestId),
    getOffer: (token, offerId) => clientForToken(token).getOffer(offerId),

    supplierListenerTick: async (token) => {
      const tick = hooks?.supplierListenerTick;
      if (tick === undefined) {
        throw new ToolUnavailableError(
          "supplier_listener_tick is unavailable: this deployment has no active supplier listener runtime.",
        );
      }
      return tick(token);
    },

    reportPending: async (token) => {
      const pending = hooks?.reportPending;
      if (pending === undefined) {
        return { messages: [] };
      }
      return pending(token);
    },

    startPurchase: async (token, input) => requireHook(hooks?.startPurchase, "start_purchase")(token, input),
    purchaseStatus: async (token, runId) =>
      requireHook(hooks?.purchaseStatus, "purchase_status")(token, runId),
    supplierStatus: async (token) => requireHook(hooks?.supplierStatus, "supplier_status")(token),
  };
}

function requireHook<T>(hook: T | undefined, tool: string): T {
  if (hook === undefined) {
    throw new ToolUnavailableError(`${tool} is unavailable: this deployment hosts no agent runtime.`);
  }
  return hook;
}

/** Raised when a tool needs a runtime hook this deployment did not configure. */
export class ToolUnavailableError extends Error {
  readonly code = "TOOL_UNAVAILABLE";

  constructor(message: string) {
    super(message);
    this.name = "ToolUnavailableError";
  }
}
