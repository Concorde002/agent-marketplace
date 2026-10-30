# Platform workstream

Human owner: teammate 1, GitHub handle unassigned. Agent must read root `AGENTS.md` first.

## Owns

API, authentication, grants, storage/migrations, agreement/payment lifecycle, Stripe sandbox, demo documents, shared contracts/configuration, and the integrated handoff.

## What this means in plain language

1. Put one backend on the internet and publish its tool/API description.
2. Give each bot its own identity and permission limits, then store demo company registrations, requests, and offers.
3. Enforce exact-term agreement, spending limits, ownership, and duplicate-order protection.
4. Execute Stripe sandbox payments and read verified payment status. Create the labeled demo order/invoice document.
5. Expose authorized request/offer/order reads and events so teammate 2's bots can act and report results in their own chats.

This owner implements hosting and Stripe; Jenya does not need to duplicate them. Supplier search/ranking belongs to Jenya + Codex. Actual bot setup, listening, negotiation execution, and in-chat wording belong to teammate 2. No email provider is required.

## Current state

Scaffold implements status/docs endpoints only. Trading endpoints, including `/v1/orders/{id}/settle` and `/webhooks/stripe`, still return 501. Typed boundaries are drafts; authentication and runtime validation do not exist. No service is hosted.

Stripe sandbox settlement exists as a library in `src/payments/`, not yet wired to HTTP routes (design: [payments-design.md](../payments-design.md)):

- `StripeSandboxProvider`: one confirmed off-session card PaymentIntent per order, idempotency key `order:{id}:v1`, maps success, processing, `authentication_required` (→ `requires_action`), and declines. Plain `fetch`, no SDK.
- `readStripeConfig`: refuses live keys (`sk_live_`/`rk_live_`) and keys or errors leaking into output.
- `verifyStripeSignature` and `SettlementService.handleWebhook`: raw-body HMAC-SHA256 check with 300-second tolerance and secret rotation, event deduplication, PaymentIntent/amount/currency matching, terminal states never regress.
- `SettlementService.settle`: buyer-only, amount taken from the accepted offer, per-order and expiry mandate checks, atomic run-total check, one attempt per order, emits one `payment_updated` event per status change.
- `npm run payments:operator`: operator-only CLI that creates a demo Customer, saves a test card through a SetupIntent (`visa`, `decline`, or `auth-required` scenario), and runs a smoke charge.

Missing: a D1 `PaymentStore` implementation and migrations (tests use an in-memory test double), the settle and webhook routes, authentication, and any run against a real Stripe sandbox. `MVP_LIMIT`: no supplier payout or Connect account; the test payment lands in the platform sandbox account only.

## Next task

Implement scoped participant registration and request creation with runtime validation and disposable storage tests. Coordinate request/offer read APIs with agent owner. Keep auth context server-derived and mandate limits bounded by operator grants. Then integrate sourcing and negotiation incrementally.

Payments next: rehearse the operator CLI against a team Stripe sandbox (needs the keys below), then implement the D1 `PaymentStore` (`claimAttempt` as one guarded INSERT with UNIQUE(order_id)) and wire the settle and webhook routes once orders and authentication exist.

### Stripe sandbox configuration

Put sandbox keys in `.dev.vars` (gitignored) as `STRIPE_SECRET_KEY=sk_test_…` and, once a webhook endpoint exists, `STRIPE_WEBHOOK_SECRET=whsec_…`. Never commit them, paste them into a bot prompt, or share them in chat. Then:

```sh
npm run payments:operator -- setup-buyer --participant <buyer-participant-id> --name "<demo buyer>" --card visa
npm run payments:operator -- smoke-charge --customer <cus_…> --payment-method <pm_…> --amount 1000 --currency EUR
```

The printed credential record belongs in server-side storage, not in Git.

## Verification

Run `npm run test:platform` and `npm run check`.

Observed locally on branch `feature/stripe` (2026-10-30): `npm run check` typecheck passed; 36 tests, 28 pass, 0 fail, 8 pre-existing TODOs from other workstreams. `tests/platform/payments.test.ts` adds 23 tests against a recorded `fetch` and in-memory test doubles. Each of 14 guards (in-flight resume, terminal finality, buyer ownership, order ceiling, mandate expiry, webhook amount/PaymentIntent matching, deduplication, signature check and tolerance, `off_session`, SCA mapping, live-key refusal, secret redaction) was removed one at a time and a test failed each time. CLI error paths (missing key, live key, bad arguments) checked offline.

Not verified: no request has reached Stripe. The sandbox card behaviors of the `decline` and `auth-required` scenarios are expected from Stripe's testing docs but unobserved. Local tests are not evidence of a live integration.

## Dependencies and context upkeep

Provide working authenticated tools for agent owner and an authorized request/job context for sourcing owner. Update this file in each PR, and `docs/STATUS.md` after integrated merges. Changes to shared files are coordinated here, not independently made by all three agents.
