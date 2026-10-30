/** Draft v0.1 boundary owned by platform. These types do not validate untrusted input. */
export type ParticipantId = string;
export type RequestId = string;
export type DiscoveryId = string;
export type OfferId = string;
export type OrderId = string;
export type IsoDateTime = string;

export interface Money {
  amountMinor: number;
  currency: string;
}

export interface CompanyIdentity {
  name: string;
  officialDomain: string;
  publicOrganizationId?: string;
}

/** Trusted backend context after authentication, never accepted from a tool payload. */
export interface ActorContext {
  participantId: ParticipantId;
  role: "buyer" | "supplier";
  demo: true;
}

export interface BuyerMandate {
  maximumOrderTotal: Money;
  maximumRunTotal: Money;
  allowedCategories: string[];
  destination: string;
  expiresAt: IsoDateTime;
  sandboxOnly: true;
}

export interface SupplierMandate {
  minimumDeliveredTotal: Money;
  availableQuantity: number;
  unit: string;
  earliestDeliveryAt: IsoDateTime;
  expiresAt: IsoDateTime;
  sandboxOnly: true;
}

/** Operator grants bound registration. Agents cannot create or expand grants. */
export type RegistrationInput =
  | { company: CompanyIdentity; role: "buyer"; mandate: BuyerMandate; demo: true }
  | { company: CompanyIdentity; role: "supplier"; mandate: SupplierMandate; demo: true };

export interface Evidence {
  url: string;
  retrievedAt: IsoDateTime;
  quotation: string;
  contentHash: string;
}

export interface Requirement {
  key: string;
  description: string;
  mandatory: boolean;
  evidence?: Evidence;
}

export interface SourcingRequest {
  id: RequestId;
  buyerId: ParticipantId;
  category: string;
  description: string;
  quantity: number;
  unit: string;
  destination: string;
  maximumDeliveredTotal: Money;
  deliverBy: IsoDateTime;
  requirements: Requirement[];
  demo: true;
}

/** No account-availability field is allowed in evidence-ranking inputs. */
export interface Candidate {
  company: CompanyIdentity;
  claims: { requirementKey: string; outcome: "match" | "mismatch" | "unknown"; evidence?: Evidence }[];
}

export interface RankedCandidate {
  candidate: Candidate;
  eligible: "yes" | "conditional" | "no";
  rank: number;
  explanation: string;
}

export interface DiscoveryResult {
  id: DiscoveryId;
  requestId: RequestId;
  status: "pending" | "running" | "complete" | "failed";
  candidates: RankedCandidate[];
  sourceErrors: { url: string; message: string }[];
}

export interface Offer {
  id: OfferId;
  requestId: RequestId;
  buyerId: ParticipantId;
  supplierId: ParticipantId;
  previousOfferId?: OfferId;
  quantity: number;
  unit: string;
  destination: string;
  deliveredTotal: Money;
  taxMinor: number;
  deliveryMinor: number;
  deliveryAt: IsoDateTime;
  expiresAt: IsoDateTime;
  confirmedRequirementKeys: string[];
  termsOrigin: "demo-supplier-declaration";
  demo: true;
}

export interface Order {
  id: OrderId;
  acceptedOffer: Offer;
  agreementStatus: "agreed";
  paymentStatus: "not_started" | "pending" | "succeeded" | "failed" | "requires_action";
  notificationStatus: "not_started" | "pending" | "sent" | "failed";
  sandboxPaymentId?: string;
  demoInvoice?: { id: string; text: string; demo: true };
  demo: true;
}

export interface ParticipantEvent {
  id: string;
  cursor: string;
  type: "quote_requested" | "offer_received" | "agreement_created" | "payment_updated";
  requestId: RequestId;
  resourceId: string;
}

export interface EventPage {
  events: ParticipantEvent[];
  nextCursor: string;
}

/** Owner C implements. All results are stored/read through the platform boundary. */
export interface SourcingService {
  discover(actor: ActorContext, request: SourcingRequest): Promise<DiscoveryResult>;
}

export interface MatchingService {
  rankEvidence(request: SourcingRequest, candidates: Candidate[]): RankedCandidate[];
  rankOffers(request: SourcingRequest, offers: Offer[]): Offer[];
}

/** Owner A implements; Owner B's tool clients call the corresponding HTTP routes. */
export interface PlatformService {
  registerParticipant(actor: ActorContext, input: RegistrationInput): Promise<{ participantId: ParticipantId }>;
  createRequest(actor: ActorContext, input: Omit<SourcingRequest, "id" | "buyerId">): Promise<SourcingRequest>;
  startDiscovery(actor: ActorContext, requestId: RequestId): Promise<{ discoveryId: DiscoveryId }>;
  getDiscovery(actor: ActorContext, discoveryId: DiscoveryId): Promise<DiscoveryResult>;
  requestQuote(actor: ActorContext, requestId: RequestId, supplierId: ParticipantId): Promise<{ eventId: string }>;
  submitOffer(actor: ActorContext, input: Omit<Offer, "id">): Promise<Offer>;
  acceptOffer(actor: ActorContext, offerId: OfferId): Promise<{ state: "awaiting_counterparty" } | { state: "agreed"; order: Order }>;
  settleOrder(actor: ActorContext, orderId: OrderId): Promise<Order>;
  getOrder(actor: ActorContext, orderId: OrderId): Promise<Order>;
  listEvents(actor: ActorContext, after?: string): Promise<EventPage>;
}

export interface NotificationService {
  notifyOrder(order: Order): Promise<{ status: "sent" | "failed" }>;
}
