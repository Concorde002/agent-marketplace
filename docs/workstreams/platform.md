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

Scaffold implements status/docs endpoints and `POST /webhooks/stripe`. All `/v1/` trading endpoints, including `/v1/orders/{id}/settle`, still return 501. Typed boundaries are drafts; authentication and runtime validation do not exist. No service is hosted.

`src/server.ts` is a Node HTTP entry point (`node dist/src/server.js`) for Cloud Run or local use; `src/server-adapter.ts` passes request bodies through byte-for-byte, caps them at 1 MiB, and turns handler failures into 500 so Stripe retries. Without `STRIPE_WEBHOOK_SECRET` the server runs the scaffold only and the webhook route stays 501.

Stripe sandbox settlement in `src/payments/` (design: [payments-design.md](../payments-design.md)):

- `StripeSandboxProvider`: one confirmed off-session card PaymentIntent per order, idempotency key `order:{id}:v1`, maps success, processing, `authentication_required` (→ `requires_action`), and declines. Plain `fetch`, no SDK.
- `readStripeConfig`: refuses live keys (`sk_live_`/`rk_live_`) and keys or errors leaking into output.
- `verifyStripeSignature` and `SettlementService.handleWebhook`: raw-body HMAC-SHA256 check with 300-second tolerance and secret rotation, event deduplication, PaymentIntent/amount/currency matching, terminal states never regress.
- `SettlementService.settle`: buyer-only, amount taken from the accepted offer, per-order and expiry mandate checks, atomic run-total check, one attempt per order, emits one `payment_updated` event per status change.
- `PostgresPaymentStore`: the `PaymentStore` over the Supabase schema, through `marketplace.claim_payment_attempt()` and `marketplace.emit_participant_events()`; converts `bigint` amounts to numbers.
- `npm run payments:operator`: operator-only CLI that creates a demo Customer, saves a test card through a SetupIntent (`visa`, `decline`, or `auth-required` scenario), and runs a smoke charge.

Missing: the settle route (needs authentication and order creation), a deployment, and a webhook endpoint registered with Stripe for the hosted URL. Saved-card records from the operator CLI are inserted into `payment_credentials` by hand. `MVP_LIMIT`: no supplier payout or Connect account; the test payment lands in the platform sandbox account only.

## Next task

Implement scoped participant registration and request creation with runtime validation and disposable storage tests. Coordinate request/offer read APIs with agent owner. Keep auth context server-derived and mandate limits bounded by operator grants. Then integrate sourcing and negotiation incrementally.

Payments next: wire `POST /v1/orders/{id}/settle` once authentication and orders exist; after deployment, register `https://<host>/webhooks/stripe` in the Stripe sandbox for `payment_intent.succeeded`, `.payment_failed`, `.requires_action`, and `.processing`, and store its signing secret in the host's secret manager.

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

Not verified: a hosted endpoint registered with Stripe, a Cloud Run deployment, and settlement through stored orders and the HTTP settle route.

## Dependencies and context upkeep

Provide working authenticated tools for agent owner and an authorized request/job context for sourcing owner. Update this file in each PR, and `docs/STATUS.md` after integrated merges. Changes to shared files are coordinated here, not independently made by all three agents.
