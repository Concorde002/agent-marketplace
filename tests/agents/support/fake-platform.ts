/**
 * TEST DOUBLE — NOT A PRODUCTION BACKEND.
 *
 * This is an in-memory `node:http` platform used only by local tests and the local demo.
 * It intentionally models the agreement/payment semantics needed by the agent workstream so
 * the agents can be tested without a hosted backend. It sends `x-test-double: true` on every
 * response. Do not deploy it, and do not treat its behavior as proof of a live integration.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type {
  DiscoveryResult,
  EventPage,
  Money,
  Offer,
  Order,
  ParticipantEvent,
  ParticipantId,
  RankedCandidate,
  RegistrationInput,
  Requirement,
  SourcingRequest,
} from "../../../src/contracts.js";

export type PaymentOutcome = "succeeded" | "failed" | "requires_action";

export interface FakeCandidateSpec {
  companyName: string;
  domain: string;
  eligible?: "yes" | "conditional" | "no";
  explanation?: string;
  rank?: number;
}

export interface FakePlatformOptions {
  buyerToken?: string;
  supplierToken?: string;
  supplierDomain?: string;
  paymentOutcome?: PaymentOutcome;
  revisionLimit?: number;
  /** Number of `running` discovery polls before the result becomes `complete`. Default 2. */
  runningPolls?: number;
  eventPageSize?: number;
  candidates?: readonly FakeCandidateSpec[];
}

export interface FakeTokenRecord {
  role: "buyer" | "supplier";
  participantId?: ParticipantId;
}

export interface FakeParticipantRecord {
  id: ParticipantId;
  role: "buyer" | "supplier";
  registration: RegistrationInput;
}

export interface FakeRequestRecord {
  request: SourcingRequest;
  invitedSupplierIds: Set<ParticipantId>;
  quoteEvents: Map<ParticipantId, string>;
  offerIds: string[];
  discoveryIds: string[];
  latestOffers: Map<ParticipantId, string>;
  agreedOrderId?: string;
}

export interface FakeDiscoveryRecord {
  result: DiscoveryResult;
  polls: number;
}

export interface FakeOfferRecord {
  offer: Offer;
  authorId: ParticipantId;
  revision: number;
  stale: boolean;
  orderId?: string;
}

export interface FakeIdempotencyRecord {
  method: string;
  path: string;
  bodyHash: string;
  status: number;
  body: unknown;
}

export interface FakeMutationLogEntry {
  method: string;
  path: string;
  key: string;
}

export interface FakePlatformState {
  tokens: Map<string, FakeTokenRecord>;
  participants: Map<ParticipantId, FakeParticipantRecord>;
  participantsByToken: Map<string, ParticipantId>;
  requests: Map<string, FakeRequestRecord>;
  discoveries: Map<string, FakeDiscoveryRecord>;
  offers: Map<string, FakeOfferRecord>;
  orders: Map<string, Order>;
  events: Map<ParticipantId, ParticipantEvent[]>;
  idempotency: Map<string, FakeIdempotencyRecord>;
  mutationLog: FakeMutationLogEntry[];
  paymentAttempts: Map<string, number>;
}

export interface SeedCaseOptions {
  buyerRegistration?: RegistrationInput;
  supplierRegistration?: RegistrationInput;
  request?: Partial<Omit<SourcingRequest, "id" | "buyerId" | "demo">>;
  withQuoteRequest?: boolean;
  withOffer?: boolean;
  withAgreement?: boolean;
  withSettlement?: boolean;
}

export interface SeedCase {
  buyerToken: string;
  supplierToken: string;
  buyerId: ParticipantId;
  supplierId: ParticipantId;
  request: SourcingRequest;
  requestId: string;
  discovery: DiscoveryResult;
  discoveryId: string;
  quoteEventId?: string;
  offer?: Offer;
  order?: Order;
}

export interface FakePlatform {
  readonly url: string;
  readonly tokens: { buyer: string; supplier: string };
  readonly state: FakePlatformState;
  close(): Promise<void>;
  seedCase(options?: SeedCaseOptions): SeedCase;
  issueToken(role: "buyer" | "supplier"): string;
  getOffers(): Offer[];
  getOrders(): Order[];
  getEvents(participantOrToken: string): ParticipantEvent[];
  forcePaymentFailure(value?: boolean): void;
  setPaymentOutcome(outcome: PaymentOutcome): void;
  setDiscoveryFailure(message: string | undefined): void;
  setRevisionLimit(limit: number): void;
  failNextRequest(status: number, code?: string, times?: number, pathIncludes?: string): void;
  delayNextRequest(ms: number, pathIncludes?: string): void;
}

const DEFAULT_BUYER_TOKEN = "test-double-buyer-token";
const DEFAULT_SUPPLIER_TOKEN = "test-double-supplier-token";
const DEFAULT_SUPPLIER_DOMAIN = "supplier.example";
const MAX_BODY_BYTES = 1_000_000;

interface AuthContext {
  token: string;
  record: FakeTokenRecord;
}

type FakeRoute =
  | { kind: "registerParticipant" }
  | { kind: "createRequest" }
  | { kind: "startDiscovery"; requestId: string }
  | { kind: "getDiscovery"; discoveryId: string }
  | { kind: "listEvents" }
  | { kind: "requestQuote"; requestId: string }
  | { kind: "submitOffer"; requestId: string }
  | { kind: "acceptOffer"; offerId: string }
  | { kind: "settleOrder"; orderId: string }
  | { kind: "getOrder"; orderId: string }
  | { kind: "getRequest"; requestId: string }
  | { kind: "getOffer"; offerId: string };

interface RouteResult {
  status: number;
  body: unknown;
}

interface InjectedFailure {
  status: number;
  code: string;
  times: number;
  pathIncludes?: string;
}

interface InjectedDelay {
  ms: number;
  pathIncludes?: string;
}

export async function createFakePlatform(options: FakePlatformOptions = {}): Promise<FakePlatform> {
  const buyerToken = options.buyerToken ?? DEFAULT_BUYER_TOKEN;
  const supplierToken = options.supplierToken ?? DEFAULT_SUPPLIER_TOKEN;
  if (buyerToken === supplierToken) {
    throw new Error("buyer and supplier tokens must differ");
  }
  const supplierDomain = options.supplierDomain ?? DEFAULT_SUPPLIER_DOMAIN;
  const runningPolls = options.runningPolls ?? 2;
  const eventPageSize = options.eventPageSize ?? 50;
  const candidateSpecs: FakeCandidateSpec[] = [
    ...(options.candidates ?? defaultCandidateSpecs(supplierDomain)),
  ];

  let paymentOutcome: PaymentOutcome = options.paymentOutcome ?? "succeeded";
  let revisionLimit = options.revisionLimit ?? 3;
  let discoveryFailure: string | undefined;
  let participantCounter = 0;
  let requestCounter = 0;
  let discoveryCounter = 0;
  let offerCounter = 0;
  let orderCounter = 0;
  let eventCounter = 0;
  const injectedFailures: InjectedFailure[] = [];
  const injectedDelays: InjectedDelay[] = [];

  const state: FakePlatformState = {
    tokens: new Map(),
    participants: new Map(),
    participantsByToken: new Map(),
    requests: new Map(),
    discoveries: new Map(),
    offers: new Map(),
    orders: new Map(),
    events: new Map(),
    idempotency: new Map(),
    mutationLog: [],
    paymentAttempts: new Map(),
  };
  state.tokens.set(buyerToken, { role: "buyer" });
  state.tokens.set(supplierToken, { role: "supplier" });

  const server = createServer((request, response) => {
    void handleRequest(request, response).catch((error: unknown) => {
      sendFailure(response, error);
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      reject(error);
    };
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    await closeServer();
    throw new Error("fake platform did not bind a TCP port");
  }
  const url = `http://127.0.0.1:${address.port}`;

  async function closeServer(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
      server.closeAllConnections();
    });
  }

  async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const method = request.method ?? "GET";
    const requestUrl = new URL(request.url ?? "/", "http://test-double.invalid");
    const path = requestUrl.pathname;
    const bodyText = await readBody(request);

    if (!path.startsWith("/v1/")) {
      throw new ApiError(404, "NOT_FOUND", "unknown route");
    }

    const segments = path.split("/").filter((part) => part.length > 0);
    const route = resolveRoute(method, segments);
    const auth = authenticate(request);

    let body: unknown;
    if (method === "POST") {
      body = parseJsonBody(bodyText);
    }

    let idempotencyKey: string | undefined;
    if (method === "POST") {
      idempotencyKey = readIdempotencyKey(request);
      state.mutationLog.push({ method, path, key: idempotencyKey });
      const existing = state.idempotency.get(idempotencyCacheKey(auth.token, idempotencyKey));
      if (existing !== undefined) {
        if (existing.path !== path || existing.bodyHash !== fnv1a(bodyText)) {
          throw new ApiError(
            409,
            "IDEMPOTENCY_KEY_REUSED",
            "this idempotency key was already used for a different mutation",
          );
        }
        send(response, existing.status, existing.body);
        return;
      }
    }

    await applyInjectedDelay(path);
    const failure = nextInjectedFailure(path);
    if (failure !== undefined) {
      throw new ApiError(failure.status, failure.code, "injected failure from the local test double");
    }

    const result = executeRoute(route, auth, body, requestUrl);

    if (method === "POST" && idempotencyKey !== undefined) {
      state.idempotency.set(idempotencyCacheKey(auth.token, idempotencyKey), {
        method,
        path,
        bodyHash: fnv1a(bodyText),
        status: result.status,
        body: result.body,
      });
    }
    send(response, result.status, result.body);
  }

  function executeRoute(
    route: FakeRoute,
    auth: AuthContext,
    body: unknown,
    requestUrl: URL,
  ): RouteResult {
    if (route.kind === "registerParticipant") {
      return { status: 201, body: registerParticipantForToken(auth, body) };
    }

    const actor = requireRegisteredParticipant(auth);

    switch (route.kind) {
      case "createRequest":
        return { status: 201, body: createRequestFor(actor, body) };
      case "startDiscovery":
        return { status: 201, body: { discoveryId: startDiscoveryFor(actor, route.requestId).id } };
      case "getDiscovery":
        return { status: 200, body: advanceDiscoveryFor(actor, route.discoveryId) };
      case "listEvents":
        return {
          status: 200,
          body: listEventsFor(actor, requestUrl.searchParams.get("after")),
        };
      case "requestQuote":
        return {
          status: 201,
          body: requestQuoteFor(actor, route.requestId, body),
        };
      case "submitOffer":
        return { status: 201, body: submitOfferFor(actor, route.requestId, body) };
      case "acceptOffer":
        return { status: 200, body: acceptOfferFor(actor, route.offerId) };
      case "settleOrder":
        return { status: 200, body: settleOrderFor(actor, route.orderId) };
      case "getOrder": {
        const order = state.orders.get(route.orderId);
        if (order === undefined) {
          throw new ApiError(404, "NOT_FOUND", "order not found");
        }
        assertOrderParty(actor, order);
        return { status: 200, body: order };
      }
      case "getRequest":
        return { status: 200, body: getRequestFor(actor, route.requestId) };
      case "getOffer":
        return { status: 200, body: getOfferFor(actor, route.offerId) };
    }
  }

  function registerParticipantForToken(auth: AuthContext, body: unknown): { participantId: ParticipantId } {
    if (auth.record.participantId !== undefined) {
      throw new ApiError(409, "ALREADY_REGISTERED", "this token is already registered", {
        participantId: auth.record.participantId,
      });
    }
    const registration = parseRegistration(body, auth.record.role);
    const participant = addParticipant(auth.token, auth.record, registration);
    return { participantId: participant.id };
  }

  function addParticipant(
    token: string,
    tokenRecord: FakeTokenRecord,
    registration: RegistrationInput,
  ): FakeParticipantRecord {
    participantCounter += 1;
    const participant: FakeParticipantRecord = {
      id: `pt_${registration.role}_${participantCounter}`,
      role: registration.role,
      registration,
    };
    tokenRecord.participantId = participant.id;
    state.tokens.set(token, tokenRecord);
    state.participants.set(participant.id, participant);
    state.participantsByToken.set(token, participant.id);
    state.events.set(participant.id, []);
    return participant;
  }

  function requireRegisteredParticipant(auth: AuthContext): FakeParticipantRecord {
    const participantId = auth.record.participantId;
    if (participantId === undefined) {
      throw new ApiError(403, "FORBIDDEN", "participant is not registered");
    }
    const participant = state.participants.get(participantId);
    if (participant === undefined) {
      throw new ApiError(401, "UNAUTHORIZED", "unknown participant token");
    }
    return participant;
  }

  function createRequestFor(actor: FakeParticipantRecord, body: unknown): SourcingRequest {
    assertRole(actor, "buyer");
    const input = parseRequestInput(body);
    const request: SourcingRequest = {
      id: `req_${++requestCounter}`,
      buyerId: actor.id,
      category: input.category,
      description: input.description,
      quantity: input.quantity,
      unit: input.unit,
      destination: input.destination,
      maximumDeliveredTotal: input.maximumDeliveredTotal,
      deliverBy: input.deliverBy,
      requirements: input.requirements,
      demo: true,
    };
    state.requests.set(request.id, {
      request,
      invitedSupplierIds: new Set(),
      quoteEvents: new Map(),
      offerIds: [],
      discoveryIds: [],
      latestOffers: new Map(),
    });
    return request;
  }

  function startDiscoveryFor(actor: FakeParticipantRecord, requestId: string): DiscoveryResult {
    const meta = requireRequestRecord(requestId);
    if (meta.request.buyerId !== actor.id) {
      throw new ApiError(403, "FORBIDDEN", "only the buyer can start discovery for this request");
    }
    discoveryCounter += 1;
    const result: DiscoveryResult = {
      id: `disc_${discoveryCounter}`,
      requestId,
      status: "pending",
      candidates: [],
      sourceErrors: [],
    };
    state.discoveries.set(result.id, { result, polls: 0 });
    meta.discoveryIds.push(result.id);
    return result;
  }

  function advanceDiscoveryFor(actor: FakeParticipantRecord, discoveryId: string): DiscoveryResult {
    const record = state.discoveries.get(discoveryId);
    if (record === undefined) {
      throw new ApiError(404, "NOT_FOUND", "discovery not found");
    }
    const meta = requireRequestRecord(record.result.requestId);
    if (meta.request.buyerId !== actor.id) {
      throw new ApiError(403, "FORBIDDEN", "only the buyer can read this discovery");
    }
    if (record.result.status !== "pending" && record.result.status !== "running") {
      return record.result;
    }

    record.polls += 1;
    if (discoveryFailure !== undefined) {
      record.result = {
        ...record.result,
        status: "failed",
        candidates: [],
        sourceErrors: [{ url: "https://sources.example/failure", message: discoveryFailure }],
      };
      return record.result;
    }
    if (record.polls > runningPolls) {
      record.result = {
        ...record.result,
        status: "complete",
        candidates: buildCandidates(),
      };
      return record.result;
    }
    record.result = { ...record.result, status: "running" };
    return record.result;
  }

  function buildCandidates(): RankedCandidate[] {
    return candidateSpecs
      .map((spec, index) => ({
        candidate: {
          company: { name: spec.companyName, officialDomain: spec.domain },
          claims: [],
        },
        eligible: spec.eligible ?? "yes",
        rank: spec.rank ?? index + 1,
        explanation: spec.explanation ?? "Seeded candidate from the local test double",
      }))
      .sort((left, right) => left.rank - right.rank);
  }

  function requestQuoteFor(
    actor: FakeParticipantRecord,
    requestId: string,
    body: unknown,
  ): { eventId: string } {
    const meta = requireRequestRecord(requestId);
    if (meta.request.buyerId !== actor.id) {
      throw new ApiError(403, "FORBIDDEN", "only the buyer can request quotes for this request");
    }
    const record = requireObject(body, "quote request");
    const supplierId = requireString(record.supplierId, "supplierId");
    const supplier = state.participants.get(supplierId);
    if (supplier === undefined) {
      throw new ApiError(404, "NOT_FOUND", "supplier not found");
    }
    if (supplier.role !== "supplier") {
      throw new ApiError(400, "INVALID_REQUEST", "supplierId must reference a supplier participant");
    }
    if (!isSupplierConnected(meta, supplier)) {
      throw new ApiError(
        409,
        "NO_CONNECTED_REPRESENTATIVE",
        "the ranked company has no connected supplier participant",
      );
    }
    const existingEventId = meta.quoteEvents.get(supplierId);
    if (existingEventId !== undefined) {
      return { eventId: existingEventId };
    }
    meta.invitedSupplierIds.add(supplierId);
    const event = emitEvent(supplierId, "quote_requested", requestId, requestId);
    meta.quoteEvents.set(supplierId, event.id);
    return { eventId: event.id };
  }

  function submitOfferFor(actor: FakeParticipantRecord, requestId: string, body: unknown): Offer {
    const meta = requireRequestRecord(requestId);
    if (meta.agreedOrderId !== undefined) {
      throw new ApiError(409, "CAPACITY_CONFLICT", "this request already has an agreed order");
    }
    const input = parseOfferInput(body);
    if (input.requestId !== requestId) {
      throw new ApiError(400, "INVALID_REQUEST", "offer.requestId must match the route");
    }
    if (input.buyerId !== meta.request.buyerId) {
      throw new ApiError(403, "FORBIDDEN", "offer.buyerId does not match the request owner");
    }
    if (actor.role === "supplier") {
      if (actor.id !== input.supplierId) {
        throw new ApiError(403, "FORBIDDEN", "a supplier may only submit offers for itself");
      }
      if (!meta.invitedSupplierIds.has(actor.id)) {
        throw new ApiError(403, "FORBIDDEN", "supplier was not invited to quote");
      }
    } else {
      if (actor.id !== meta.request.buyerId) {
        throw new ApiError(403, "FORBIDDEN", "buyer does not own this request");
      }
      const supplier = state.participants.get(input.supplierId);
      if (supplier === undefined || supplier.role !== "supplier") {
        throw new ApiError(400, "INVALID_REQUEST", "offer.supplierId must reference a supplier participant");
      }
      if (!meta.invitedSupplierIds.has(input.supplierId)) {
        throw new ApiError(403, "FORBIDDEN", "supplier was not invited to quote");
      }
    }

    validateOfferAgainstRequest(meta.request, input);

    const latestOfferId = meta.latestOffers.get(input.supplierId);
    let revision = 1;
    let previous: FakeOfferRecord | undefined;
    if (input.previousOfferId !== undefined) {
      const previousRecord = state.offers.get(input.previousOfferId);
      if (previousRecord === undefined) {
        throw new ApiError(409, "STALE_OFFER", "previous offer does not exist");
      }
      if (previousRecord.offer.requestId !== requestId || previousRecord.offer.supplierId !== input.supplierId) {
        throw new ApiError(409, "STALE_OFFER", "previous offer belongs to another negotiation");
      }
      if (latestOfferId !== input.previousOfferId || previousRecord.stale) {
        throw new ApiError(409, "STALE_OFFER", "previous offer is not the current revision");
      }
      if (previousRecord.authorId === actor.id) {
        throw new ApiError(403, "FORBIDDEN", "a participant cannot counter its own offer");
      }
      revision = previousRecord.revision + 1;
      previous = previousRecord;
    } else if (latestOfferId !== undefined) {
      throw new ApiError(409, "STALE_OFFER", "a newer revision exists for this negotiation");
    }

    if (revision > revisionLimit || meta.offerIds.length + 1 > revisionLimit) {
      throw new ApiError(409, "REVISION_LIMIT", `the request allows at most ${revisionLimit} revisions`);
    }
    if (Date.parse(input.expiresAt) <= Date.now()) {
      throw new ApiError(422, "STALE_OFFER", "offer has already expired");
    }

    if (previous !== undefined) {
      previous.stale = true;
    }

    offerCounter += 1;
    const offer: Offer = {
      id: `off_${offerCounter}`,
      requestId,
      buyerId: input.buyerId,
      supplierId: input.supplierId,
      ...(input.previousOfferId === undefined ? {} : { previousOfferId: input.previousOfferId }),
      quantity: input.quantity,
      unit: input.unit,
      destination: input.destination,
      deliveredTotal: input.deliveredTotal,
      taxMinor: input.taxMinor,
      deliveryMinor: input.deliveryMinor,
      deliveryAt: input.deliveryAt,
      expiresAt: input.expiresAt,
      confirmedRequirementKeys: input.confirmedRequirementKeys,
      termsOrigin: "demo-supplier-declaration",
      demo: true,
    };

    state.offers.set(offer.id, {
      offer,
      authorId: actor.id,
      revision,
      stale: false,
    });
    meta.offerIds.push(offer.id);
    meta.latestOffers.set(offer.supplierId, offer.id);

    const counterparty = actor.role === "supplier" ? offer.buyerId : offer.supplierId;
    emitEvent(counterparty, "offer_received", requestId, offer.id);
    return offer;
  }

  function acceptOfferFor(
    actor: FakeParticipantRecord,
    offerId: string,
  ): { state: "awaiting_counterparty" } | { state: "agreed"; order: Order } {
    const record = state.offers.get(offerId);
    if (record === undefined) {
      throw new ApiError(404, "NOT_FOUND", "offer not found");
    }
    const offer = record.offer;
    if (actor.id !== offer.buyerId && actor.id !== offer.supplierId) {
      throw new ApiError(403, "FORBIDDEN", "only offer parties can accept this offer");
    }

    if (record.orderId !== undefined) {
      const existing = state.orders.get(record.orderId);
      if (existing !== undefined) {
        return { state: "agreed", order: existing };
      }
    }
    if (record.stale) {
      throw new ApiError(409, "STALE_OFFER", "offer was superseded by a newer revision");
    }
    if (Date.parse(offer.expiresAt) <= Date.now()) {
      throw new ApiError(409, "STALE_OFFER", "offer has already expired");
    }
    const meta = requireRequestRecord(offer.requestId);
    if (meta.agreedOrderId !== undefined) {
      throw new ApiError(409, "STALE_OFFER", "request already has an agreed order");
    }
    // Submitting an offer is the author's acceptance of it. The counterparty acceptance closes the deal.
    if (actor.id === record.authorId) {
      return { state: "awaiting_counterparty" };
    }

    const supplier = state.participants.get(offer.supplierId);
    if (
      supplier !== undefined &&
      supplier.registration.role === "supplier" &&
      offer.quantity > supplier.registration.mandate.availableQuantity
    ) {
      throw new ApiError(409, "CAPACITY_CONFLICT", "offer exceeds the supplier's available capacity");
    }

    // Everything below is synchronous, so concurrent acceptances cannot create two orders.
    orderCounter += 1;
    const order: Order = {
      id: `ord_${orderCounter}`,
      acceptedOffer: offer,
      agreementStatus: "agreed",
      paymentStatus: "not_started",
      demo: true,
    };
    state.orders.set(order.id, order);
    record.orderId = order.id;
    meta.agreedOrderId = order.id;
    emitEvent(offer.buyerId, "agreement_created", offer.requestId, order.id);
    emitEvent(offer.supplierId, "agreement_created", offer.requestId, order.id);
    return { state: "agreed", order };
  }

  function settleOrderFor(actor: FakeParticipantRecord, orderId: string): Order {
    const order = state.orders.get(orderId);
    if (order === undefined) {
      throw new ApiError(404, "NOT_FOUND", "order not found");
    }
    assertOrderParty(actor, order);
    if (order.paymentStatus === "succeeded") {
      return order;
    }

    state.paymentAttempts.set(orderId, (state.paymentAttempts.get(orderId) ?? 0) + 1);
    let next: Order;
    if (paymentOutcome === "succeeded") {
      next = {
        id: order.id,
        acceptedOffer: order.acceptedOffer,
        agreementStatus: "agreed",
        paymentStatus: "succeeded",
        sandboxPaymentId: `pi_sandbox_${order.id}`,
        demoInvoice: {
          id: `inv_${order.id}`,
          text: "Demo document — not a tax invoice",
          demo: true,
        },
        demo: true,
      };
    } else if (paymentOutcome === "requires_action") {
      next = {
        id: order.id,
        acceptedOffer: order.acceptedOffer,
        agreementStatus: "agreed",
        paymentStatus: "requires_action",
        demo: true,
      };
    } else {
      next = {
        id: order.id,
        acceptedOffer: order.acceptedOffer,
        agreementStatus: "agreed",
        paymentStatus: "failed",
        demo: true,
      };
    }
    state.orders.set(orderId, next);
    emitEvent(order.acceptedOffer.buyerId, "payment_updated", order.acceptedOffer.requestId, orderId);
    emitEvent(order.acceptedOffer.supplierId, "payment_updated", order.acceptedOffer.requestId, orderId);
    return next;
  }

  function getRequestFor(actor: FakeParticipantRecord, requestId: string): SourcingRequest {
    const meta = requireRequestRecord(requestId);
    if (!canReadRequest(actor, meta)) {
      throw new ApiError(403, "FORBIDDEN", "participant is not attached to this request");
    }
    return meta.request;
  }

  function getOfferFor(actor: FakeParticipantRecord, offerId: string): Offer {
    const record = state.offers.get(offerId);
    if (record === undefined) {
      throw new ApiError(404, "NOT_FOUND", "offer not found");
    }
    const offer = record.offer;
    if (actor.id !== offer.buyerId && actor.id !== offer.supplierId) {
      throw new ApiError(403, "FORBIDDEN", "participant is not a party to this offer");
    }
    return offer;
  }

  function listEventsFor(actor: FakeParticipantRecord, afterRaw: string | null): EventPage {
    let after = 0;
    if (afterRaw !== null && afterRaw !== "") {
      if (!/^\d+$/.test(afterRaw)) {
        throw new ApiError(400, "INVALID_CURSOR", "after must be a numeric cursor");
      }
      after = Number(afterRaw);
    }
    const events = state.events.get(actor.id) ?? [];
    const page = events.filter((event) => Number(event.cursor) > after).slice(0, eventPageSize);
    const last = page[page.length - 1];
    return { events: page, nextCursor: last === undefined ? String(after) : last.cursor };
  }

  function emitEvent(
    participantId: ParticipantId,
    type: ParticipantEvent["type"],
    requestId: string,
    resourceId: string,
  ): ParticipantEvent {
    eventCounter += 1;
    const events = state.events.get(participantId) ?? [];
    const event: ParticipantEvent = {
      id: `evt_${eventCounter}`,
      cursor: String(events.length + 1),
      type,
      requestId,
      resourceId,
    };
    events.push(event);
    state.events.set(participantId, events);
    return event;
  }

  function requireRequestRecord(requestId: string): FakeRequestRecord {
    const meta = state.requests.get(requestId);
    if (meta === undefined) {
      throw new ApiError(404, "NOT_FOUND", "request not found");
    }
    return meta;
  }

  function isSupplierConnected(meta: FakeRequestRecord, supplier: FakeParticipantRecord): boolean {
    const domain = normalizeDomain(supplier.registration.company.officialDomain);
    for (const discoveryId of meta.discoveryIds) {
      const discovery = state.discoveries.get(discoveryId);
      if (discovery === undefined || discovery.result.status !== "complete") {
        continue;
      }
      const connected = discovery.result.candidates.some(
        (candidate) => normalizeDomain(candidate.candidate.company.officialDomain) === domain,
      );
      if (connected) {
        return true;
      }
    }
    return false;
  }

  function canReadRequest(actor: FakeParticipantRecord, meta: FakeRequestRecord): boolean {
    if (meta.request.buyerId === actor.id || meta.invitedSupplierIds.has(actor.id)) {
      return true;
    }
    return meta.offerIds.some((offerId) => {
      const record = state.offers.get(offerId);
      return record !== undefined && record.offer.supplierId === actor.id;
    });
  }

  function assertOrderParty(actor: FakeParticipantRecord, order: Order): void {
    if (actor.id !== order.acceptedOffer.buyerId && actor.id !== order.acceptedOffer.supplierId) {
      throw new ApiError(403, "FORBIDDEN", "participant is not a party to this order");
    }
  }

  function seedCase(seedOptions: SeedCaseOptions = {}): SeedCase {
    const buyerRecord = state.tokens.get(buyerToken);
    const supplierRecord = state.tokens.get(supplierToken);
    if (buyerRecord === undefined || supplierRecord === undefined) {
      throw new Error("seed tokens are missing");
    }
    if (buyerRecord.participantId !== undefined || supplierRecord.participantId !== undefined) {
      throw new Error("seedCase can only be called before participants are registered");
    }

    const buyer = addParticipant(
      buyerToken,
      buyerRecord,
      seedOptions.buyerRegistration ?? defaultBuyerRegistration(),
    );
    const supplier = addParticipant(
      supplierToken,
      supplierRecord,
      seedOptions.supplierRegistration ?? defaultSupplierRegistration(supplierDomain),
    );

    const requestInput = {
      category: "industrial-parts",
      description: "Seeded demo request from the local test double",
      quantity: 10,
      unit: "unit",
      destination: "Berlin, DE",
      maximumDeliveredTotal: { amountMinor: 200_000, currency: "EUR" },
      deliverBy: futureIso(180),
      requirements: [
        { key: "iso-9001", description: "ISO 9001 certificate", mandatory: true },
      ] satisfies Requirement[],
      ...seedOptions.request,
    };
    const request = createRequestFor(buyer, requestInput);
    const meta = requireRequestRecord(request.id);

    discoveryCounter += 1;
    const discovery: DiscoveryResult = {
      id: `disc_${discoveryCounter}`,
      requestId: request.id,
      status: "complete",
      candidates: buildCandidates(),
      sourceErrors: [],
    };
    state.discoveries.set(discovery.id, { result: discovery, polls: runningPolls + 1 });
    meta.discoveryIds.push(discovery.id);

    const seeded: SeedCase = {
      buyerToken,
      supplierToken,
      buyerId: buyer.id,
      supplierId: supplier.id,
      request,
      requestId: request.id,
      discovery,
      discoveryId: discovery.id,
    };

    const shouldOffer =
      seedOptions.withOffer === true ||
      seedOptions.withAgreement === true ||
      seedOptions.withSettlement === true;
    const shouldQuote = seedOptions.withQuoteRequest === true || shouldOffer;
    if (shouldQuote) {
      seeded.quoteEventId = requestQuoteFor(buyer, request.id, { supplierId: supplier.id }).eventId;
    }
    if (shouldOffer) {
      const offer = submitOfferFor(supplier, request.id, buildSeedOfferInput(request, supplier.id, buyer.id));
      seeded.offer = offer;
      if (seedOptions.withAgreement === true || seedOptions.withSettlement === true) {
        const acceptance = acceptOfferFor(buyer, offer.id);
        if (acceptance.state !== "agreed") {
          throw new Error("seed agreement did not produce an order");
        }
        seeded.order = acceptance.order;
        if (seedOptions.withSettlement === true) {
          seeded.order = settleOrderFor(supplier, acceptance.order.id);
        }
      }
    }
    return seeded;
  }

  async function applyInjectedDelay(path: string): Promise<void> {
    const index = injectedDelays.findIndex(
      (delay) => delay.pathIncludes === undefined || path.includes(delay.pathIncludes),
    );
    if (index === -1) {
      return;
    }
    const [delay] = injectedDelays.splice(index, 1);
    if (delay !== undefined && delay.ms > 0) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, delay.ms);
      });
    }
  }

  function nextInjectedFailure(path: string): InjectedFailure | undefined {
    const index = injectedFailures.findIndex(
      (failure) => failure.pathIncludes === undefined || path.includes(failure.pathIncludes),
    );
    if (index === -1) {
      return undefined;
    }
    const failure = injectedFailures[index];
    if (failure === undefined) {
      return undefined;
    }
    failure.times -= 1;
    if (failure.times <= 0) {
      injectedFailures.splice(index, 1);
    }
    return failure;
  }

  const platform: FakePlatform = {
    url,
    tokens: { buyer: buyerToken, supplier: supplierToken },
    state,
    close: closeServer,
    seedCase,
    issueToken(role) {
      const token = `test-double-${role}-token-${state.tokens.size + 1}`;
      state.tokens.set(token, { role });
      return token;
    },
    getOffers() {
      return [...state.offers.values()].map((record) => record.offer);
    },
    getOrders() {
      return [...state.orders.values()];
    },
    getEvents(participantOrToken) {
      const participantId =
        state.participantsByToken.get(participantOrToken) ??
        (state.participants.has(participantOrToken) ? participantOrToken : undefined);
      if (participantId === undefined) {
        return [];
      }
      return [...(state.events.get(participantId) ?? [])];
    },
    forcePaymentFailure(value = true) {
      paymentOutcome = value ? "failed" : "succeeded";
    },
    setPaymentOutcome(outcome) {
      paymentOutcome = outcome;
    },
    setDiscoveryFailure(message) {
      discoveryFailure = message;
    },
    setRevisionLimit(limit) {
      if (!Number.isInteger(limit) || limit < 1) {
        throw new Error("revisionLimit must be a positive integer");
      }
      revisionLimit = limit;
    },
    failNextRequest(status, code = "INJECTED_FAILURE", times = 1, pathIncludes) {
      injectedFailures.push({
        status,
        code,
        times,
        ...(pathIncludes === undefined ? {} : { pathIncludes }),
      });
    },
    delayNextRequest(ms, pathIncludes) {
      injectedDelays.push({
        ms,
        ...(pathIncludes === undefined ? {} : { pathIncludes }),
      });
    },
  };

  return platform;

  function authenticate(request: IncomingMessage): AuthContext {
    const header = request.headers.authorization;
    if (typeof header !== "string" || !header.startsWith("Bearer ")) {
      throw new ApiError(401, "UNAUTHORIZED", "missing participant token");
    }
    const token = header.slice("Bearer ".length).trim();
    const record = token === "" ? undefined : state.tokens.get(token);
    if (record === undefined) {
      throw new ApiError(401, "UNAUTHORIZED", "unknown participant token");
    }
    return { token, record };
  }
}

/** Default buyer registration used by `seedCase`. */
export function defaultBuyerRegistration(domain = "buyer.example"): RegistrationInput {
  return {
    company: { name: "Buyer Demo GmbH", officialDomain: domain },
    role: "buyer",
    mandate: {
      maximumOrderTotal: { amountMinor: 500_000, currency: "EUR" },
      maximumRunTotal: { amountMinor: 1_000_000, currency: "EUR" },
      allowedCategories: ["industrial-parts"],
      destination: "Berlin, DE",
      expiresAt: futureIso(365),
      sandboxOnly: true,
    },
    demo: true,
  };
}

/** Default supplier registration used by `seedCase`. */
export function defaultSupplierRegistration(domain = DEFAULT_SUPPLIER_DOMAIN): RegistrationInput {
  return {
    company: { name: "Supplier Demo GmbH", officialDomain: domain },
    role: "supplier",
    mandate: {
      minimumDeliveredTotal: { amountMinor: 100_000, currency: "EUR" },
      availableQuantity: 50,
      unit: "unit",
      earliestDeliveryAt: futureIso(1),
      expiresAt: futureIso(365),
      sandboxOnly: true,
    },
    demo: true,
  };
}

function defaultCandidateSpecs(supplierDomain: string): FakeCandidateSpec[] {
  return [
    {
      companyName: "Supplier Demo GmbH",
      domain: supplierDomain,
      eligible: "yes",
      explanation: "Seeded candidate with a connected supplier participant",
      rank: 1,
    },
    {
      companyName: "Unconnected Metals Ltd",
      domain: "unconnected.example",
      eligible: "conditional",
      explanation: "Seeded candidate without a connected representative",
      rank: 2,
    },
  ];
}

function buildSeedOfferInput(
  request: SourcingRequest,
  supplierId: ParticipantId,
  buyerId: ParticipantId,
): Omit<Offer, "id"> {
  const deliveredMinor = Math.min(request.maximumDeliveredTotal.amountMinor, 150_000);
  return {
    requestId: request.id,
    buyerId,
    supplierId,
    quantity: request.quantity,
    unit: request.unit,
    destination: request.destination,
    deliveredTotal: {
      amountMinor: deliveredMinor,
      currency: request.maximumDeliveredTotal.currency,
    },
    taxMinor: 0,
    deliveryMinor: 0,
    deliveryAt: futureIso(30),
    expiresAt: futureIso(7),
    confirmedRequirementKeys: request.requirements
      .filter((requirement) => requirement.mandatory)
      .map((requirement) => requirement.key),
    termsOrigin: "demo-supplier-declaration",
    demo: true,
  };
}

function resolveRoute(method: string, segments: readonly string[]): FakeRoute {
  const resource = segments[1];
  const first = segments[2];
  const second = segments[3];

  if (segments.length === 2 && resource === "participants") {
    requireMethod(method, "POST");
    return { kind: "registerParticipant" };
  }
  if (segments.length === 2 && resource === "requests") {
    requireMethod(method, "POST");
    return { kind: "createRequest" };
  }
  if (segments.length === 2 && resource === "events") {
    requireMethod(method, "GET");
    return { kind: "listEvents" };
  }
  if (segments.length === 3 && resource === "discoveries" && first !== undefined) {
    requireMethod(method, "GET");
    return { kind: "getDiscovery", discoveryId: decodeId(first) };
  }
  if (segments.length === 3 && resource === "orders" && first !== undefined) {
    requireMethod(method, "GET");
    return { kind: "getOrder", orderId: decodeId(first) };
  }
  if (segments.length === 3 && resource === "offers" && first !== undefined) {
    requireMethod(method, "GET");
    return { kind: "getOffer", offerId: decodeId(first) };
  }
  if (segments.length === 3 && resource === "requests" && first !== undefined) {
    requireMethod(method, "GET");
    return { kind: "getRequest", requestId: decodeId(first) };
  }
  if (segments.length === 4 && resource === "requests" && first !== undefined) {
    if (second === "discover") {
      requireMethod(method, "POST");
      return { kind: "startDiscovery", requestId: decodeId(first) };
    }
    if (second === "quote-requests") {
      requireMethod(method, "POST");
      return { kind: "requestQuote", requestId: decodeId(first) };
    }
    if (second === "offers") {
      requireMethod(method, "POST");
      return { kind: "submitOffer", requestId: decodeId(first) };
    }
  }
  if (
    segments.length === 4 &&
    resource === "offers" &&
    first !== undefined &&
    second === "acceptances"
  ) {
    requireMethod(method, "POST");
    return { kind: "acceptOffer", offerId: decodeId(first) };
  }
  if (
    segments.length === 4 &&
    resource === "orders" &&
    first !== undefined &&
    second === "settle"
  ) {
    requireMethod(method, "POST");
    return { kind: "settleOrder", orderId: decodeId(first) };
  }
  throw new ApiError(404, "NOT_FOUND", "unknown route");
}

function requireMethod(actual: string, expected: "GET" | "POST"): void {
  if (actual !== expected) {
    throw new ApiError(405, "METHOD_NOT_ALLOWED", `this route accepts ${expected}`);
  }
}

function decodeId(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new ApiError(400, "INVALID_REQUEST", "malformed resource id");
  }
}

function readIdempotencyKey(request: IncomingMessage): string {
  const header = request.headers["idempotency-key"];
  if (typeof header !== "string" || header.trim() === "") {
    throw new ApiError(400, "MISSING_IDEMPOTENCY_KEY", "mutations require an Idempotency-Key header");
  }
  return header.trim();
}

function parseJsonBody(bodyText: string): unknown {
  if (bodyText.trim() === "") {
    return {};
  }
  try {
    return JSON.parse(bodyText) as unknown;
  } catch {
    throw new ApiError(400, "INVALID_JSON", "request body is not valid JSON");
  }
}

function parseRegistration(value: unknown, expectedRole: "buyer" | "supplier"): RegistrationInput {
  const body = requireObject(value, "registration");
  const role = requireString(body.role, "role");
  if (role !== "buyer" && role !== "supplier") {
    throw new ApiError(400, "INVALID_REQUEST", "role must be buyer or supplier");
  }
  if (role !== expectedRole) {
    throw new ApiError(403, "FORBIDDEN", "this token is scoped to a different role");
  }
  if (body.demo !== true) {
    throw new ApiError(400, "INVALID_REQUEST", "demo must be true");
  }
  const company = parseCompany(body.company);
  if (role === "buyer") {
    return { company, role: "buyer", mandate: parseBuyerMandate(body.mandate), demo: true };
  }
  return { company, role: "supplier", mandate: parseSupplierMandate(body.mandate), demo: true };
}

function parseCompany(value: unknown): RegistrationInput["company"] {
  const company = requireObject(value, "company");
  const name = requireString(company.name, "company.name");
  const officialDomain = requireString(company.officialDomain, "company.officialDomain");
  if (company.publicOrganizationId === undefined) {
    return { name, officialDomain };
  }
  return {
    name,
    officialDomain,
    publicOrganizationId: requireString(company.publicOrganizationId, "company.publicOrganizationId"),
  };
}

function parseBuyerMandate(value: unknown): Extract<RegistrationInput, { role: "buyer" }>["mandate"] {
  const mandate = requireObject(value, "mandate");
  if (mandate.sandboxOnly !== true) {
    throw new ApiError(400, "INVALID_REQUEST", "mandate.sandboxOnly must be true");
  }
  if (!Array.isArray(mandate.allowedCategories)) {
    throw new ApiError(400, "INVALID_REQUEST", "mandate.allowedCategories must be an array");
  }
  return {
    maximumOrderTotal: parseMoney(mandate.maximumOrderTotal, "mandate.maximumOrderTotal"),
    maximumRunTotal: parseMoney(mandate.maximumRunTotal, "mandate.maximumRunTotal"),
    allowedCategories: mandate.allowedCategories.map((entry, index) =>
      requireString(entry, `mandate.allowedCategories[${index}]`),
    ),
    destination: requireString(mandate.destination, "mandate.destination"),
    expiresAt: requireIso(mandate.expiresAt, "mandate.expiresAt"),
    sandboxOnly: true,
  };
}

function parseSupplierMandate(value: unknown): Extract<RegistrationInput, { role: "supplier" }>["mandate"] {
  const mandate = requireObject(value, "mandate");
  if (mandate.sandboxOnly !== true) {
    throw new ApiError(400, "INVALID_REQUEST", "mandate.sandboxOnly must be true");
  }
  return {
    minimumDeliveredTotal: parseMoney(mandate.minimumDeliveredTotal, "mandate.minimumDeliveredTotal"),
    availableQuantity: requirePositiveInteger(mandate.availableQuantity, "mandate.availableQuantity"),
    unit: requireString(mandate.unit, "mandate.unit"),
    earliestDeliveryAt: requireIso(mandate.earliestDeliveryAt, "mandate.earliestDeliveryAt"),
    expiresAt: requireIso(mandate.expiresAt, "mandate.expiresAt"),
    sandboxOnly: true,
  };
}

type RequestInput = Omit<SourcingRequest, "id" | "buyerId">;

function parseRequestInput(value: unknown): RequestInput {
  const body = requireObject(value, "request");
  if (body.demo === false) {
    throw new ApiError(400, "INVALID_REQUEST", "demo must be true");
  }
  return {
    category: requireString(body.category, "category"),
    description: requireString(body.description, "description"),
    quantity: requirePositiveInteger(body.quantity, "quantity"),
    unit: requireString(body.unit, "unit"),
    destination: requireString(body.destination, "destination"),
    maximumDeliveredTotal: parseMoney(body.maximumDeliveredTotal, "maximumDeliveredTotal"),
    deliverBy: requireIso(body.deliverBy, "deliverBy"),
    requirements: parseRequirements(body.requirements),
    demo: true,
  };
}

function parseRequirements(value: unknown): Requirement[] {
  if (!Array.isArray(value)) {
    throw new ApiError(400, "INVALID_REQUEST", "requirements must be an array");
  }
  return value.map((entry, index) => {
    const requirement = requireObject(entry, `requirements[${index}]`);
    if (typeof requirement.mandatory !== "boolean") {
      throw new ApiError(400, "INVALID_REQUEST", `requirements[${index}].mandatory must be a boolean`);
    }
    return {
      key: requireString(requirement.key, `requirements[${index}].key`),
      description: requireString(requirement.description, `requirements[${index}].description`),
      mandatory: requirement.mandatory,
    };
  });
}

function parseOfferInput(value: unknown): Omit<Offer, "id"> {
  const body = requireObject(value, "offer");
  if (body.demo === false) {
    throw new ApiError(400, "INVALID_REQUEST", "demo must be true");
  }
  if (body.termsOrigin !== "demo-supplier-declaration") {
    throw new ApiError(400, "INVALID_REQUEST", "termsOrigin must be demo-supplier-declaration");
  }
  if (!Array.isArray(body.confirmedRequirementKeys)) {
    throw new ApiError(400, "INVALID_REQUEST", "confirmedRequirementKeys must be an array");
  }
  const parsed: Omit<Offer, "id"> = {
    requestId: requireString(body.requestId, "requestId"),
    buyerId: requireString(body.buyerId, "buyerId"),
    supplierId: requireString(body.supplierId, "supplierId"),
    quantity: requirePositiveInteger(body.quantity, "quantity"),
    unit: requireString(body.unit, "unit"),
    destination: requireString(body.destination, "destination"),
    deliveredTotal: parseMoney(body.deliveredTotal, "deliveredTotal"),
    taxMinor: requireNonNegativeInteger(body.taxMinor, "taxMinor"),
    deliveryMinor: requireNonNegativeInteger(body.deliveryMinor, "deliveryMinor"),
    deliveryAt: requireIso(body.deliveryAt, "deliveryAt"),
    expiresAt: requireIso(body.expiresAt, "expiresAt"),
    confirmedRequirementKeys: body.confirmedRequirementKeys.map((entry, index) =>
      requireString(entry, `confirmedRequirementKeys[${index}]`),
    ),
    termsOrigin: "demo-supplier-declaration",
    demo: true,
  };
  if (body.previousOfferId !== undefined) {
    return { ...parsed, previousOfferId: requireString(body.previousOfferId, "previousOfferId") };
  }
  return parsed;
}

function validateOfferAgainstRequest(request: SourcingRequest, offer: Omit<Offer, "id">): void {
  if (
    offer.quantity !== request.quantity ||
    offer.unit !== request.unit ||
    offer.destination !== request.destination
  ) {
    throw new ApiError(422, "INVALID_OFFER", "offer quantity, unit and destination must match the request");
  }
  if (offer.deliveredTotal.currency !== request.maximumDeliveredTotal.currency) {
    throw new ApiError(422, "INVALID_OFFER", "offer currency must match the request");
  }
  if (offer.taxMinor + offer.deliveryMinor > offer.deliveredTotal.amountMinor) {
    throw new ApiError(422, "INVALID_OFFER", "tax and delivery are included in deliveredTotal");
  }
  const knownKeys = new Set(request.requirements.map((requirement) => requirement.key));
  for (const key of offer.confirmedRequirementKeys) {
    if (!knownKeys.has(key)) {
      throw new ApiError(422, "INVALID_OFFER", `unknown requirement key: ${key}`);
    }
  }
}

function parseMoney(value: unknown, field: string): Money {
  const money = requireObject(value, field);
  const amountMinor = requireNonNegativeInteger(money.amountMinor, `${field}.amountMinor`);
  const currency = requireString(money.currency, `${field}.currency`);
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new ApiError(400, "INVALID_REQUEST", `${field}.currency must be an ISO-4217 code`);
  }
  return { amountMinor, currency };
}

function requireObject(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ApiError(400, "INVALID_REQUEST", `${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ApiError(400, "INVALID_REQUEST", `${field} must be a non-empty string`);
  }
  return value;
}

function requireIso(value: unknown, field: string): string {
  const text = requireString(value, field);
  if (Number.isNaN(Date.parse(text))) {
    throw new ApiError(400, "INVALID_REQUEST", `${field} must be an ISO date-time`);
  }
  return text;
}

function requirePositiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new ApiError(400, "INVALID_REQUEST", `${field} must be a positive integer`);
  }
  return value;
}

function requireNonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new ApiError(400, "INVALID_REQUEST", `${field} must be a non-negative integer`);
  }
  return value;
}

function assertRole(participant: FakeParticipantRecord, role: "buyer" | "supplier"): void {
  if (participant.role !== role) {
    throw new ApiError(403, "FORBIDDEN", `this route requires a ${role} participant`);
  }
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

function futureIso(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

function idempotencyCacheKey(token: string, key: string): string {
  return `${token}\u0000${key}`;
}

function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk as Buffer);
    size += buffer.byteLength;
    if (size > MAX_BODY_BYTES) {
      throw new ApiError(413, "PAYLOAD_TOO_LARGE", "request body is too large");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function send(response: ServerResponse, status: number, payload: unknown): void {
  if (response.writableEnded || response.destroyed) {
    return;
  }
  const body = JSON.stringify(payload ?? null);
  try {
    response.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "content-length": String(Buffer.byteLength(body)),
      "x-test-double": "true",
    });
    response.end(body);
  } catch {
    // The client may have timed out and closed the socket. Nothing to do in a test double.
  }
}

function sendFailure(response: ServerResponse, error: unknown): void {
  if (response.writableEnded || response.destroyed) {
    return;
  }
  if (error instanceof ApiError) {
    const payload: Record<string, unknown> = { error: error.code };
    if (error.message !== "" && error.message !== error.code) {
      payload.message = error.message;
    }
    if (error.extra !== undefined) {
      Object.assign(payload, error.extra);
    }
    send(response, error.status, payload);
    return;
  }
  send(response, 500, { error: "INTERNAL_ERROR" });
}

class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly extra?: Record<string, unknown>;

  constructor(status: number, code: string, message?: string, extra?: Record<string, unknown>) {
    super(message ?? code);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    if (extra !== undefined) {
      this.extra = extra;
    }
  }
}
