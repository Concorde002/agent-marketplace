# Platform workstream

Human owner: Maksym (teammate 1). Agent must read root `AGENTS.md` first.

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

Branch `maksym/live-integration-review`, from `9698789` on `feat/live-marketplace-integration` (PR #12), issue #11. Locally implemented and tested: scoped token authentication and bounded registration, persistent discovery evidence and client assessment, frozen ranking, post-ranking account resolution, offers with both persisted acceptances, one order per request, and Stripe sandbox settlement through `POST /v1/orders/{id}/settle`. HTTP and `/mcp` share one implementation. `POST /webhooks/stripe` is proven hosted (below).

**Not hosted.** Cloud Run still serves the pre-PR #12 revision (`/health` reports `scaffold`, `/mcp` 404, `/v1/*` 501). The Supabase project does not yet have `20261030133000_live_marketplace_api.sql` and has no operator grants, participants, credentials, or saved cards. `marketplaceReady` stays `false`.

Stripe sandbox settlement in `src/payments/` ([payments-design.md](../payments-design.md)): one off-session PaymentIntent per order with an order-derived idempotency key; live keys refused; signed, deduplicated webhooks; buyer-only, amount from the accepted offer, mandate and atomic run-total checks. `MVP_LIMIT`: no supplier payout or Connect account.

## Review of PR #12 (issue #11)

Fixed, each with a test that failed on `9698789` and passes now:

1. **Supplier floor oracle.** A buyer counteroffer below the supplier's private floor (or before its earliest delivery date) was refused with `POLICY_REFUSAL`, and refused attempts are not stored, so a buyer could binary-search the floor. Buyer-authored revisions are now checked against request and buyer limits only; the supplier's acceptance still enforces every supplier limit, so no below-floor order can exist.
2. **Closed request reported as an outage.** An offer or acceptance after the request closed was stopped only by a database trigger and returned `503 PLATFORM_UNAVAILABLE`, which invites retries. It now returns `409 REQUEST_CLOSED`, checked under the request lock.
3. **Concurrent acceptance.** Simultaneous acceptances of one offer with different idempotency keys: one agreed and the rest got `409 STALE_OFFER` (7 of 8 on real Postgres). The existing-order check now repeats under the request lock, so all return the same agreed order.
4. **Legacy offer fields.** The CLI runtimes send `Omit<Offer, "id">`, including `buyerId`/`supplierId`, which the schema rejected (`400`). Both are now accepted only when equal to the server-derived parties, refused with `403 PARTICIPANT_MISMATCH` otherwise, and never used as authority. Other unknown fields stay refused.
5. **Ingress.** The Node adapter buffered uploads with no deadline before the handler's 5 s timer started, and never signalled disconnects. Uploads now have a 5 s whole-body deadline (`408 UPLOAD_TIMEOUT`); a client that disconnects mid-upload is not dispatched or logged as a failure; `request.signal` aborts when the client disconnects during handling.

Reviewed without change: token authentication (SHA-256 lookup, unexpired demo grant, role match); registration within grant under a row lock; tenant scoping of requests, offers, orders, discoveries, and events; idempotency (participant-scoped key, advisory lock, body fingerprint, stored response); lock order request → offer → mandates sorted by id, consistent with the payment claim; discovery evidence and ranking frozen by trigger; account resolution only after ranking, ambiguous identities left as leads.

Open, not fixed here: the invited supplier reads the request's `maximumDeliveredTotal`, the buyer's budget for that request. The contract includes it, but it lets a supplier quote at the ceiling. This is a product decision for the team.

## Next task

Operator steps for hosted acceptance (#11), in order. None run at server startup, and no credential or private limit goes into GitHub or an agent prompt.

1. Apply `20261030133000_live_marketplace_api.sql` to Supabase (SQL editor or `psql --single-transaction`).
2. Deploy this branch's commit to Cloud Run with the existing secrets, then confirm `/health` reports `demo-api` with `sourcingReady: true`.
3. Provision one buyer and one supplier: operator grants, participants, and one bearer token each; store only the SHA-256 token hash in `api_credentials`. Save the buyer's sandbox card with `npm run payments:operator -- setup-buyer` and insert its record into `payment_credentials`.
4. Run the hosted authenticated scenario: discovery, offer, both acceptances, settle, Stripe-confirmed payment, plus an over-budget refusal.

### Container image

`Dockerfile` builds on `node:22.23.4-bookworm-slim`, pinned by digest. The build stage runs `npm run check`, so an image only exists for passing code. The runtime stage holds production dependencies (`pg`), `dist/src`, and the Supabase CA at `/app/certs/prod-ca-2021.crt` (`DB_CA_FILE` defaults to it), runs as `node`, and listens on `$PORT`. `.dockerignore` keeps `.env*`, `.dev.vars*`, Git, and local tool state out of the build context. Cloud Run runs `linux/amd64`: build with `gcloud run deploy --source .` or `docker build --platform linux/amd64 .`; a plain build on Apple Silicon produces arm64.

`supabase/prod-ca-2021.crt` is Supabase's public root certificate (Supabase Root 2021 CA, SHA-256 `80:70:25:AD:…:E6:CA:FA`, expires 2031-04-26), not a secret.

### Server configuration

`PORT` (default 8080), `STRIPE_SECRET_KEY` (sandbox only), `STRIPE_WEBHOOK_SECRET` (enables the webhook route), `DB_CONNECTION` (login role in `marketplace_app`), `DB_CA_FILE` (Supabase CA, `prod-ca-2021.crt`). TLS to the database is always verified; `DB_SSL=disable` is accepted only for a database on localhost, and `sslmode` in `DB_CONNECTION` is refused because node-postgres would let it override the CA. Dependencies added: `pg` 8.23.1 (runtime), `@types/pg` 8.23.1 and `@electric-sql/pglite` 0.5.13 (tests). `tsconfig.json` sets `skipLibCheck` because PGlite's published types reference `@types/emscripten`, which it does not ship.

### Database (Supabase Postgres)

`supabase/migrations/20261030120000_initial_schema.sql` creates the whole schema in a private `marketplace` schema that the Supabase Data API does not expose. The backend connects directly as a login role in `marketplace_app`, created by hand after the migration and never committed. Database-enforced: one order per offer and request, both-party acceptance of the current immutable revision, supplier capacity, mandates within operator grants, one payment attempt per order, buyer run total under concurrency, terminal payment states, and gap-free event cursors per participant. API roles (`anon`, `authenticated`) have no access, and RLS is on for every table.

Checked locally (2026-10-30), disposable databases only:

- Applied with `psql --single-transaction` to Postgres 17.11 in Docker: 22 tables, RLS on all 22.
- 67 sequential checks pass on Postgres 17.11 and on PGlite (Postgres 18.6); each refusal is matched to its intended constraint or trigger.
- 19 concurrency checks pass on Postgres 17.11 with real simultaneous connections as the backend role: run-total claims, two orders on one request, two orders over capacity, two counteroffers on one revision, and event polling. In each case the second transaction is observed waiting on a lock and is then refused or ordered correctly. Negative controls with the locks removed reproduce the bugs: two claims commit 8,400 EUR against an 8,000 EUR limit, and a polling bot misses one of two events.

- Hosted Supabase project (Postgres 17.11, session pooler, TLS verified against the Supabase Root 2021 CA): migration applied through the SQL editor; 22 tables with RLS, all functions, triggers, and policies present; `anon`, `authenticated`, and `service_role` have no schema, table, or function access. The 66 rule checks pass there inside one transaction that is rolled back; a fresh connection afterwards found no rows and no lasting role change.

Not yet verified on Supabase: the concurrency checks, which must commit data. Connecting requires Supabase's CA certificate (Project Settings → Database → SSL Configuration); the backend must ship it and verify TLS. node-postgres returns `bigint` columns as strings; `PostgresPaymentStore` converts them, and a test feeds it string rows because PGlite returns numbers.

### Stripe sandbox configuration

Put sandbox keys in `.env.local` or `.dev.vars` (both gitignored) as `STRIPE_SECRET_KEY=sk_test_…` and, once a webhook endpoint exists, `STRIPE_WEBHOOK_SECRET=whsec_…`. Never commit them, paste them into a bot prompt, or share them in chat. Then:

```sh
npm run payments:operator -- setup-buyer --participant <buyer-participant-id> --name "<demo buyer>" --card visa
npm run payments:operator -- smoke-charge --customer <cus_…> --payment-method <pm_…> --amount 1000 --currency EUR
```

The printed credential record belongs in server-side storage, not in Git.

## Verification

Run `npm run test:platform` and `npm run check`.

Observed locally on branch `feature/stripe` (2026-10-30): `npm run check` typecheck passed; 38 tests, 30 pass, 0 fail, 8 pre-existing TODOs from other workstreams. `tests/platform/payments.test.ts` adds 25 tests against a recorded `fetch` and in-memory test doubles. Each of 14 guards (in-flight resume, terminal finality, buyer ownership, order ceiling, mandate expiry, webhook amount/PaymentIntent matching, deduplication, signature check and tolerance, `off_session`, SCA mapping, live-key refusal, secret redaction) was removed one at a time and a test failed each time. CLI error paths (missing key, live key, bad arguments) checked offline.

Sandbox evidence (2026-10-30, team Stripe sandbox, operator CLI): for each card scenario, setup succeeded and one €10.00 off-session charge was made, then the PaymentIntent was read back independently from the Stripe API. All reported `livemode: false`.

| Scenario | Provider result | Stripe's record |
| --- | --- | --- |
| `visa` | `succeeded` | `succeeded`, 1000 received |
| `decline` | `failed`, `generic_decline` | `requires_payment_method`, `generic_decline`, 0 received |
| `auth-required` | `requires_action` | `requires_payment_method`, `authentication_required`, 0 received |

The sandbox run found two defects that local tests had missed, both fixed with tests: current Stripe API versions reject `payment_method_types` (now `automatic_payment_methods` with redirects disabled), and an off-session authentication demand arrives as `requires_payment_method` with `authentication_required`, which the webhook mapping had misread as a decline.

Webhook handler, local rehearsal (2026-10-30): server on localhost against a disposable Postgres 17 in Docker, real events from the team Stripe sandbox forwarded by `stripe listen` (API version `2026-09-30.endive`). 11 checks passed. A charge whose result was deliberately never recorded (simulated crash) was moved from `creating` to `succeeded` by Stripe's own `payment_intent.succeeded` webhook, with the matching PaymentIntent id. A normally settled order's webhook was verified and recorded without changing its status. A forged signature returned 400 and was not recorded. Buyer and supplier each received one `payment_updated` event per order. Stripe reported HTTP 200 for both deliveries.

`tests/platform/payments-postgres.test.ts` adds 12 tests against PGlite with the real migration, as the backend role, including webhooks over a real HTTP server. Each of 9 guards (bigint conversion, raw-body passthrough, 500 on failure, declared and streamed size limits, route wiring, event recording, status compare-and-set, TLS-disable only for localhost, `sslmode` refusal) was removed one at a time and a test failed each time.

Container image, local (2026-10-30): built for arm64 and linux/amd64; inside both builds `npm run check` reported 50 tests, 42 pass, 0 fail, 8 TODO. The 351 MB runtime image contains only `dist/src`, `pg`, and the CA, runs as `node`, and has no `.env`/`.dev.vars`/`whsec` files or key-shaped strings. Scaffold mode: `/health` 200, webhook and settle 501, SIGTERM stops it in under a second. Webhook mode against a disposable Postgres: forged signature 400; signed event applied (pending to succeeded, one event per party); repeat reported as duplicate. `DB_SSL=disable` with a remote host stops startup. From inside the image, a read-only connection to the hosted Supabase project verified TLS with the bundled CA.

Hosted webhook (2026-10-30): Stripe sandbox endpoint registered for the Cloud Run URL with the four `payment_intent` events. One €10 sandbox charge's `payment_intent.succeeded` was reported delivered by Stripe and recorded in Supabase `marketplace.webhook_events` with the same event id.

PR #12 review, local (2026-10-30), at `9698789` then this branch:

- `npm run check` at `9698789`: 307 tests, 303 pass, 0 fail, 4 TODO. After fixes: 322 tests, 313 pass, 0 fail, 4 TODO, 5 skipped (the opt-in Postgres tests below). `npm run test:e2e`: 14 tests, 12 pass, 2 TODO, unchanged.
- `tests/platform/live-marketplace-review.test.ts` (6) and `server-ingress.test.ts` (4) run on PGlite and real sockets. Each of 7 fixes was removed one at a time and a test failed each time.
- `tests/platform/concurrency-postgres.test.ts` (5) needs real simultaneous connections. Opt-in with `MARKETPLACE_TEST_ADMIN_URL` pointing at a disposable Postgres; it creates and drops its own database. On Postgres 17.11: 8 simultaneous acceptances return one agreed order; two suppliers on one request give one order and `REQUEST_CLOSED`; two 4-unit orders against capacity 5 give one order and `POLICY_REFUSAL`; 6 identical idempotent requests create one; a counteroffer racing an acceptance has one winner. With the race fix removed, the first test fails. `npm run test:platform` with Postgres: 82 tests, 82 pass.
- Both migrations applied in order with `psql --single-transaction` to Postgres 17.11: 22 tables, RLS on all; new columns and both freeze triggers present; `anon` cannot execute the new functions; re-applying the additive migration fails rather than duplicating.

Not verified: anything on the hosted service beyond the webhook. The PR #12 revision is not deployed and its migration and participants are not provisioned (see Next task).

## Dependencies and context upkeep

Provide working authenticated tools for agent owner and an authorized request/job context for sourcing owner. Update this file in each PR, and `docs/STATUS.md` after integrated merges. Changes to shared files are coordinated here, not independently made by all three agents.
