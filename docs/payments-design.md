# Stripe settlement design, draft

Status: the provider, webhook verification, settlement rules, and operator setup CLI exist in `src/payments/` with
local tests, and the provider plus CLI have run against a team Stripe sandbox. Persistence, the HTTP routes, and
live webhook delivery do not exist yet. See `docs/workstreams/platform.md`.
Owner: platform (`src/payments/`, per root `AGENTS.md`). Not yet reviewed by another teammate.

This document records the intended payment model, the invariants to test, and the explicit upgrade path.
It is a target design; `docs/workstreams/platform.md` records what is actually implemented.

## 1. Correcting the obvious model

The intuitive model is "collect the buyer's card, collect the supplier's Stripe API key, move money between
them." Both halves are wrong, and for this MVP neither artifact is needed.

### Buyer side: a tokenized mandate, not card details

The backend must never receive, store, or forward raw card or bank account numbers. That puts the service in
PCI scope and contradicts `TEAM_BRIEF.md` §9. The supported mechanism is:

1. A human completes a one-time setup, outside the agent run, creating a Stripe `Customer` and attaching a
   `PaymentMethod` through a `SetupIntent`. Strong customer authentication happens here, on-session, once.
2. The backend stores only the resulting opaque identifiers (`cus_…`, `pm_…`) against the participant.
3. At settlement the backend creates a PaymentIntent with `off_session: true` and `confirm: true`. The card is
   charged without the buyer present because authentication already happened at setup.

The agent never sees `cus_…`, `pm_…`, or any Stripe key. It references an order ID. The authorization it acts
under is the `BuyerMandate` in `src/contracts.ts`, not possession of a payment credential.

Bank-account rails (SEPA Direct Debit, ACH) are technically available but settle over days and carry their own
mandate requirements. They cannot produce an observable terminal payment state inside the run. Out of scope.

### Supplier side: never an API key

A supplier's secret key would grant this platform unrestricted authority over that supplier's entire Stripe
account — charges, refunds, payouts, customer data. No real supplier would issue one, and it is not how Stripe
models multi-party payments.

The supported mechanism is Stripe Connect. The supplier onboards once through hosted onboarding; the platform
stores the resulting account ID (`acct_…`). The platform then acts using **only its own secret key**, naming the
connected account by ID — `Stripe-Account` header for direct charges, or `transfer_data[destination]` /
`on_behalf_of` for destination charges. The platform never holds a connected account's credentials.

For a marketplace where the buyer transacts with the platform and a supplier fulfils, destination charges with
`application_fee_amount` are the conventional fit.

### What this MVP actually builds

`TEAM_BRIEF.md` §9 places seller payout and marketplace money movement outside the MVP, and §11 defers
real-money payouts. So the build target is deliberately smaller than either mechanism above:

- One platform-held Stripe sandbox account. One PaymentIntent per order. No connected account, no transfer,
  no payout, no application fee.
- The buyer's payment method is a server-held **test** PaymentMethod attached to a demo Customer during
  operator setup.
- The supplier sees the agreed and paid result through its own bot and the demo order document. It receives no money.

A successful sandbox payment therefore means: the demo order is agreed and test-paid. It does not mean goods
moved, a supplier was paid, or a supplier earned anything. Every shortcut here carries a greppable
`MVP_LIMIT` comment naming the ceiling and the Connect upgrade path.

## 2. Why this is still "no human in the loop"

Autonomy here does not mean no human ever consents. It means consent is moved earlier and bounded, so that
from the initial buyer instruction onward no step waits for approval.

The consent artifact is the operator-provisioned grant plus the mandate: maximum order total, maximum run
total, currency, allowed category, destination, expiry, sandbox-only. Deterministic backend code checks every
settlement against those ceilings. A bot cannot raise them through registration, a policy update, a tool call,
or text recovered from a source page.

This is the same shape as Stripe's own agentic card primitive, a Shared Payment Token: a scoped grant with
usage and expiry limits, approved once by a human, usable by an agent without exposing the credential. The
mandate design already in `src/contracts.ts` is the right abstraction; this work gives it a payment backend.

## 3. Interface boundary

A provider interface keeps Stripe out of the order lifecycle and makes the invariants testable without
network access.

```ts
// src/payments/provider.ts
export interface PaymentAttemptInput {
  orderId: OrderId;
  amount: Money;            // copied from the accepted offer, never from a request body
  customerRef: string;      // cus_…, read from server-side credential storage
  paymentMethodRef: string; // pm_…, read from server-side credential storage
  idempotencyKey: string;   // derived from orderId; not supplied by a caller
}

export type PaymentOutcome =
  | { status: "succeeded"; providerPaymentId: string }
  | { status: "pending"; providerPaymentId: string }
  | { status: "requires_action"; providerPaymentId: string }
  | { status: "failed"; providerPaymentId?: string; code: string };

export interface PaymentProvider {
  readonly sandboxOnly: true;
  createPayment(input: PaymentAttemptInput): Promise<PaymentOutcome>;
  getPayment(providerPaymentId: string): Promise<PaymentOutcome>;
}
```

`StripeSandboxProvider` implements this over the Stripe REST API. Tests use a local test double; per
`docs/INTERFACES.md` that double stays a test utility and never becomes a production fake provider.

### Contract changes required

`src/contracts.ts` does not yet express payment credentials or attempt metadata. Platform owner must add, in
one coordinated increment:

- `Order` fields for the payment failure code, so a declined payment is explainable to both bots.
- `PlatformService.settleOrder` should document that it is idempotent per order (it is, by design here).

The server-only credential and attempt types live in `src/payments/types.ts` because no other workstream may
see them. `Order.paymentStatus` already includes `requires_action`, and `withPayment()` projects an attempt onto
the shared `Order` without changing the contract.

## 4. Data model

Four tables in `migrations/`:

- `payment_credentials` — `participant_id` (unique), `stripe_customer_id`, `stripe_payment_method_id`,
  `sandbox_only`. Written only by the operator setup path. No agent-facing route writes or reads it back.
- `payment_attempts` — `order_id` **UNIQUE**, `payment_intent_id`, `status`, `amount_minor`, `currency`,
  `idempotency_key`, `last_error_code`, `created_at`, `updated_at`. The uniqueness constraint is the
  "exactly one provider payment per order" invariant; it is not left to application logic.
- `webhook_events` — `stripe_event_id` PRIMARY KEY, `type`, `received_at`, `processed_at`. Insert-first
  deduplication.
- Participant events — one `payment_updated` event per (order, status), visible to that order's buyer and
  supplier. Bots read these and report results in their own chats; there is no email or notification service.

## 5. Settlement flow

`POST /v1/orders/{orderId}/settle`, authenticated as the buyer participant of that order.

1. Derive `ActorContext` from the credential. Reject a client-supplied actor ID as authority.
2. Load the payment attempt. If one exists, return its state with no second PaymentIntent. An attempt stuck in
   `creating` (a crash before Stripe's answer was recorded) is resumed with the same idempotency key, but only
   after 30 seconds: Stripe rejects a parallel request that reuses a key still in flight.
3. Re-validate server-side: agreement exists, offer revision is immutable, `sandboxOnly` holds, and the amount
   equals the accepted offer's `deliveredTotal` exactly. The amount is read from stored order state, never
   from the request body.
4. Check the buyer mandate: amount ≤ `maximumOrderTotal`, and the run-total accumulator plus amount ≤
   `maximumRunTotal`. On breach, refuse with no PaymentIntent created and no order state change.
5. Insert the `payment_attempts` row. On unique conflict, read the existing row and return its state.
6. Create the PaymentIntent with `Idempotency-Key: order:{orderId}:v1` and `amount`, `currency`, `customer`,
   `payment_method`, `off_session=true`, `confirm=true`, `automatic_payment_methods[enabled]=true`,
   `automatic_payment_methods[allow_redirects]=never`, `metadata[order_id]`, `metadata[demo]=true`.
   (`payment_method_types` is rejected by current Stripe API versions.)
7. Map the outcome: success → `succeeded`; an `authentication_required` decline → `requires_action`; a
   `card_declined` → `failed`; still processing → `pending`.
8. Emit one `payment_updated` participant event for the new status.
9. Return the order. Never block the response on a webhook arriving.

A `requires_action` result ends the attempt. The run does not attempt to bypass authentication, and no
message claims payment. A declined payment preserves the agreement with a failed payment state.

## 6. Webhook flow

`POST /webhooks/stripe`, authenticated by Stripe signature, not by a participant credential.

1. Read the **raw** request body before any JSON parsing. The signature covers raw bytes.
2. Verify `Stripe-Signature`: parse `t` and `v1`, compute HMAC-SHA256 over `{t}.{rawBody}` with the webhook
   secret, compare in constant time, and reject a timestamp outside a 300-second tolerance. Invalid or absent
   signature returns 400 with no state change.
3. If the event ID was already processed, return 200 and do nothing further. The ID is recorded after
   processing, so a crash mid-way lets Stripe's retry finish; every transition is idempotent.
4. Handle `payment_intent.succeeded`, `payment_intent.payment_failed`, `payment_intent.requires_action`, and
   `payment_intent.processing`. Resolve the order through `metadata.order_id` **and** confirm the PaymentIntent
   ID matches the one stored for that order. An unrecognised PaymentIntent is recorded and ignored.
5. Confirm the event amount and currency match the stored attempt before applying it.
6. Apply the status transition monotonically: a late non-terminal event never overwrites a terminal one.
7. Emit one `payment_updated` participant event per status change.
8. Return 2xx for any accepted event, including unhandled types.

Verified provider status drives the order's payment status. An agent asserting success changes nothing.

## 7. Invariants, as red tests first

In `tests/platform/payments.test.ts`, before implementation:

1. Concurrent `settle` calls on one order produce exactly one PaymentIntent.
2. A retried `settle` returns the same state and creates no second charge.
3. A duplicated webhook (same event ID) applies once and emits one update.
4. An out-of-order webhook cannot move a terminal status backwards.
5. A tampered, absent, or time-expired signature is rejected with no state change.
6. The charged amount and currency equal the accepted offer's `deliveredTotal`; request-body amounts are ignored.
7. An amount above `maximumOrderTotal`, or a run total above `maximumRunTotal`, refuses before any provider call.
8. An `authentication_required` decline yields `requires_action`, leaves the agreement intact, and never emits a
   success update.
9. A decline yields `failed` with the agreement preserved.
10. A supplier credential cannot settle; neither party can read another tenant's order or payment state.
11. No response body, event payload, demo invoice, or log line contains `sk_`, `whsec_`, `cus_`, or `pm_`.
    The sandbox PaymentIntent ID is intentionally exposed as demo evidence.
12. Instructions embedded in retrieved source text cannot select a payment recipient, change an amount, raise a
    mandate, or invoke settlement.

Webhook signature tests generate signatures with the real scheme against a disposable secret, so verification
is proven without network access.

## 8. Configuration

Server-held only, as Worker secrets or `.dev.vars` — both already gitignored:

- `STRIPE_SECRET_KEY` — sandbox key.
- `STRIPE_WEBHOOK_SECRET`.

The provider asserts at construction that the secret key is a test key and refuses to start otherwise. No
payment credential is ever issued to a bot, placed in an agent prompt, or written to a log.

Operator setup is a separate CLI (`npm run payments:operator`), not an agent-callable route. It creates the demo
Customer and saves a test card through a SetupIntent, then prints the credential record for server-side storage.
Card scenarios: `visa` (`pm_card_visa`, off-session success), `decline` (`pm_card_chargeCustomerFail`, saves
but every charge declines), and `auth-required` (`pm_card_authenticationRequiredOnSetup`, deliberately attached
without setup so its off-session charge demands authentication). All three behaved as described in the sandbox.
Note that Stripe reports an off-session authentication demand as `requires_payment_method` with
`last_payment_error.code = authentication_required`; the mapping treats that as `requires_action`, not a decline.

## 9. Sequencing and dependencies

Payments sit late in the dependency chain. `TEAM_BRIEF.md` §8 warns against spending hours on Stripe before
the clients can call tools, and settlement cannot exist before orders do.

- **Phase 0, no dependencies.** Provider interface and types, webhook signature verification and
  deduplication, and the red tests above against a test double. Self-contained and startable now.
- **Phase 1, blocked.** The settle route needs authentication, persistence, and atomic acceptance from the
  platform workstream. Business routes currently return 501; `acceptOffer` does not yet create orders.
- **Phase 2, requires explicit authorization.** A Stripe sandbox account, webhook endpoint registration, and a
  live sandbox rehearsal verified against the provider's own records. A local test suite is not evidence of a
  working sandbox integration.

## 10. Upgrade path beyond the MVP

- **Supplier payout.** Stripe Connect with destination charges and `application_fee_amount`. Requires
  onboarding, capability checks, and a deliberate refund and dispute design, since destination charges debit
  the platform balance.
- **Agent-presented payment credentials.** Shared Payment Tokens under the Agentic Commerce Protocol: scoped
  grants, bounded by seller, amount, and time, issued from the Link Agent Wallet. This replaces the stored
  `cus_`/`pm_` pair with a token the buyer agent carries. Availability is currently US-centred; confirm
  regional support before relying on it.
- **Not a fit.** The Machine Payments Protocol targets agents paying per call for APIs and services over HTTP
  402. This project settles negotiated orders for goods, so MPP is the wrong primitive here.

## 11. Sources inspected

- [Stripe Connect charge types](https://docs.stripe.com/connect/charges) — confirms the platform uses only its
  own key and names connected accounts by ID.
- [Save a payment method for later use](https://docs.stripe.com/payments/save-and-reuse?payment-ui=elements) —
  SetupIntent, `off_session`, and the `authentication_required` decline path.
- [Stripe testing](https://docs.stripe.com/testing) — server-side test PaymentMethods and sandbox semantics.
- [Shared Payment Tokens](https://docs.stripe.com/agentic-commerce/concepts/shared-payment-tokens) and
  [machine payments](https://docs.stripe.com/payments/machine) — the agentic primitives and their intended scope.
