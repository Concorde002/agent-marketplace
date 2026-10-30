# Observer dashboard: setup and three-minute rehearsal

A read-only page that shows one demo buyer's runs: both agents' recorded actions, public sources,
the frozen comparison, representative lookup after ranking, offers and acceptances, the order and
the authoritative sandbox payment state. It starts, retries and pays for nothing.

- Page: `dashboard/` (static HTML/CSS/JS, no build). Deployed at https://agentmarketplace.pages.dev.
- API: `GET /v1/observer/runs` and `GET /v1/observer/runs/{runId}` on the existing backend
  (`src/platform/observer.ts`, migration `20261030170000_observer.sql`). **Proposed; the backend
  developer owns the projection, auth and redaction and must review it before it is deployed.**

## What the page reads, and what it never reads

| Shown | Source |
| --- | --- |
| Run ID, phase, start, last activity, elapsed | `sourcing_requests` plus the furthest authoritative record (discovery, resolution, quote, offer, order, payment attempt) |
| Buyer and supplier lanes | `agent_traces`: one row per authenticated API/MCP operation, recorded by the server after it completes (participant, tool name, channel, HTTP status, error code, ids, start/end). No bodies. Polling reads (`list_events`, `get_my_participant`) only refresh last-seen |
| Observed client | `client_sightings`: the name/version the client sent in MCP `initialize`, or its HTTP user agent. The configured company name is shown separately and labelled as configured |
| Sources | The immutable evidence bundle: TED notices with retrieval time and response hash, supplier query, retrieved pages with provider, retrieval time, content hash and size, and failures. CPV is shown as "not recorded" because the live pipeline does not store it yet |
| Comparison | The frozen ranking (rank, eligibility, reason, quoted claims), then representative lookup as a separate later step |
| Commercial state | Quote requests, every offer revision with author and acceptances, the order, demo document id, payment status. A receipt reference is shown only for a `succeeded` payment |

Never in a response, the page, browser storage or a trace: mandates and grants (ceilings,
floors, quantities), the request's private maximum total, participant or operator credentials,
Stripe customer/payment-method ids, webhook secrets and raw headers. `tests/observer` asserts this
with distinctive limit values and the tokens themselves.

## States the page keeps distinct

Collecting sources · awaiting the buyer agent's assessment · ranking frozen · representatives
looked up (or "external leads only" when no ranked company is eligible and connected) · awaiting
the supplier · negotiating · refused by the platform (latest quote/offer/acceptance returned
`POLICY_REFUSAL` or a related refusal, with no order) · agreed, payment not started · payment
pending / needs action · paid · payment failed · source collection failed. It also shows connecting,
slow API, disconnected (with the time of the last data shown), paused, expired or rejected key, no
runs, and a run not visible to this key.

A newer run never replaces the selected one: a banner offers it. Every run is labelled with its
own start time, and a finished run is marked "finished before this page opened" when that is true.

## Operator setup (hosted)

1. Backend developer reviews and merges the observer PR; the operator applies
   `supabase/migrations/20261030170000_observer.sql` as with the earlier migrations.
2. Set on the backend service:
   - `OBSERVER_ALLOWED_ORIGINS=https://agentmarketplace.pages.dev`
   - optionally `DEPLOYMENT_ENVIRONMENT=hosted` (the default)
3. Issue a read-only observer key for the demo buyer participant (8 hours, at most 7 days):

   ```sh
   npm run observer:operator -- issue --buyer <buyer participant id> --label "Demo rehearsal"
   ```

   It prints the key once and the SQL to run in the database SQL editor. Only the SHA-256 hash is
   stored. Revoke with `observer:operator -- revoke --session <id>`.
4. Give the presenter the link privately (not in Git, chat logs or slides):
   `https://agentmarketplace.pages.dev/#api=<https backend origin>&key=<observer key>`.
   The page removes the key from the address bar and keeps it only in memory. After a reload,
   open the link again.

## Deploying the page

```sh
npx wrangler@4.45.0 pages deploy dashboard --project-name agentmarketplace --branch main
```

`dashboard/_headers` sets a strict CSP (scripts from the same origin only, no inline script),
`no-referrer`, `nosniff`, no framing and `no-store`.

## Local rehearsal (fixture, not demo evidence)

```sh
npm run build && node dist/tests/observer/support/rehearsal.js
```

Real handler, Marketplace and settlement rules on PGlite with stubbed TED/Tavily and a stubbed
payment provider. It records a paid run and a refused run, then starts a slower run after
`REHEARSAL_START_MS`. The page labels all of it "Not hosted · local-fixture" and "paid (stubbed
provider)". A browser on the public Pages site cannot reach a local API, so use the local copy it
prints (`http://127.0.0.1:8792`).

## Three-minute presentation script

Open the observer link on the host computer before starting, at projector width.

| Time | Presenter | On screen |
| --- | --- | --- |
| 0:00–0:15 | State the buyer's need and why manual discovery is slow. Start a fresh run from the buyer's own client. | The "new run started" banner; click it. Header shows "Current run · not finished", run ID, elapsed counting from the real start. |
| 0:15–1:00 | Narrate retrieval and comparison as they arrive. Open one source receipt (provider, retrieval time, hash). | Buyer lane fills with `create_request`, `start_discovery`, `get_discovery_evidence`, `read_discovery_source`, `submit_discovery_assessment`. Supplier lane stays empty until the supplier's client acts. |
| 1:00–1:40 | Show ranking, then the separate representative lookup, then the quote. If the fresh run is still working, say so and switch the selector to the earlier finished rehearsal, which keeps its own run ID and time. | Ranking table, "Representative lookup, after ranking", "Awaiting supplier". |
| 1:40–2:15 | Show the closed agreement and the payment from an authoritative run: offer revisions, both acceptances, order ID, payment "Paid · Stripe sandbox" and its receipt reference. Say that representation, terms and settlement are simulated. | Outcome panel. |
| 2:15–2:45 | Change budget or deadline in the buyer's client; show the real refusal or its pending state. If time is short, open the separately labelled refused rehearsal. | "Refused by the platform", red Agreement step, the refused tool call in the lane, no order. |
| 2:45–3:00 | The useful result, source provenance, one honest limitation (for example: CPV not recorded; historical awards are not proof of current stock). | — |

Do not call the current run complete unless the header says so. Pausing the page does not pause
the agents or a payment.

### Measured timing so far

Only fixture timing exists. With no artificial delays a fixture run goes from `create_request` to
paid in about 1 s; the rehearsal's slow run took 33 s because of its configured 4 s step pauses.
Neither predicts hosted timing: real TED/Tavily reads, a client model's assessment and Stripe
confirmation are unmeasured until a hosted rehearsal with both bots.
