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
Stripe customer/payment-method ids, webhook secrets and raw headers. `tests/platform/observer-projection.test.ts` asserts this
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

## Connecting the deployed dashboard to the hosted backend

The demo link is **https://agentmarketplace.pages.dev**. The backend serves only the observer API;
it does not serve a second copy of the page. Steps 1–5 belong to the backend developer and the
operator (issue #11); the dashboard developer does not run them.

| Step | Who | Done when |
| --- | --- | --- |
| 1. Approve the fork's workflows on PR #18 ("Approve and run workflows") | Repo maintainer | Four workstream checks green |
| 2. Review and merge PR #18 into `main` | Backend developer | Merge commit on `main` |
| 3. Apply `supabase/migrations/20261030170000_observer.sql` in the Supabase SQL editor, as for the earlier migrations | Operator | Check query below returns three names |
| 4. Deploy that `main` commit to the Cloud Run service with `OBSERVER_ALLOWED_ORIGINS=https://agentmarketplace.pages.dev` | Operator | The two `curl` checks below pass |
| 5. Issue a read-only observer key for the demo buyer participant and send the link privately | Operator | Presenter has the link; nothing posted to GitHub or chat |
| 6. Open the link on the host computer and run the verification list | Presenter + dashboard developer | Every item below ticked |

Step 3 check:

```sql
select to_regclass('marketplace.agent_traces'), to_regclass('marketplace.client_sightings'),
       to_regclass('marketplace.observer_sessions');
```

Step 4 deploy (service name and project as in issue #11; the image build runs `npm run check`):

```sh
gcloud run deploy <service> --source . --region europe-west1 \
  --update-env-vars OBSERVER_ALLOWED_ORIGINS=https://agentmarketplace.pages.dev
```

Step 4 checks:

```sh
curl -si -X OPTIONS https://<host>/v1/observer/runs \
  -H 'Origin: https://agentmarketplace.pages.dev' \
  -H 'Access-Control-Request-Method: GET' -H 'Access-Control-Request-Headers: authorization' | head -5
# expect 204 and access-control-allow-origin: https://agentmarketplace.pages.dev
curl -s https://<host>/v1/observer/runs
# expect {"error":"INVALID_OBSERVER_SESSION",...}. PLATFORM_UNAVAILABLE means the migration is missing.
```

Step 5 key (no database credential needed to generate it; 8 hours by default, at most 7 days):

```sh
npm run observer:operator -- issue --buyer <buyer participant id> --label "Demo rehearsal"
```

It prints the key once and an `insert` to run in the SQL editor; only the key's SHA-256 is stored.
Send the presenter this link through a private channel (password manager or direct message, never
GitHub, slides or a shared chat):

`https://agentmarketplace.pages.dev/#api=https%3A%2F%2F<host>&key=<observer key>`

The page removes the key from the address bar and keeps it only in memory; after a reload, open the
link again. Revoke with `npm run observer:operator -- revoke --session <id>` and run the printed SQL.

### Step 6: verification on the host computer

Record the results in `docs/workstreams/observer.md`. Do not tick an item from a fixture run.

- [ ] Header badge reads **Hosted platform**, not "Not hosted".
- [ ] A run started from the **buyer's actual bot** appears via the "new run started" banner.
- [ ] Buyer lane shows its tool calls with channel **MCP**, and the observed client is the name the
      bot reported in MCP `initialize`, not a fixture driver.
- [ ] Supplier lane fills only when the supplier's own client acts, with its own observed client.
- [ ] Sources show real retrieval times, links and hashes; failures appear as failures.
- [ ] Ranking appears before representative lookup; unresolved companies stay external leads.
- [ ] Offer revisions and both acceptances match what each bot reported in its chat.
- [ ] Order ID matches both bots' messages; payment shows **Paid · Stripe sandbox** with a `pi_…`
      reference, and the same PaymentIntent shows `succeeded` in the Stripe dashboard (test mode).
- [ ] The refusal case shows "Refused by the platform" (or its real pending state) and no order.
- [ ] Reloading with the link keeps the selected run; repeated polling adds no traces or events.
- [ ] Phone width stacks cleanly; projector width shows header, both lanes and outcome.
- [ ] Measured: retrieval, assessment, resolution, quote, agreement and payment times, with run IDs.

## Observing the TED/BZP directory workflow (pending)

The structured directory (`ProcurementDirectory`, ADR 0001) is not yet mounted as HTTP/MCP tools,
and company-identifier resolution is not yet exact. The page does not simulate it: today it shows
the live discovery bundle and says "CPV not recorded". To observe the directory path once the backend
and bot owners expose it, the observer needs, per run:

1. **Traces**: add each new directory route to `operationFor` in `src/platform/observer.ts`, with
   the request or discovery id it belongs to, so the buyer lane shows the call.
2. **Persisted retrieval receipts** linked to the run: provider (TED/BZP), CPV code and keywords,
   publication date bounds, retrieval timestamp, response SHA-256, returned and omitted counts, and
   source errors. Exposed as `discovery.collection.directory` and `cpvCodes`.
3. **Leads with provenance**: reported name, source identifier and scheme (only when unambiguous),
   country, notice-level CPV, notice URL and publication date.
4. **Identity resolution after ranking**: per ranked lead, `unique`, `ambiguous` or `missing`, with
   the matched identifier scheme and the connected demo account only for `unique`.

The page renders these from the projection only. Until they exist, it keeps showing "not recorded"
rather than inventing directory steps.

## Deploying the page

```sh
npx wrangler@4.45.0 pages deploy dashboard --project-name agentmarketplace --branch main
```

`dashboard/_headers` sets a strict CSP (scripts from the same origin only, no inline script),
`no-referrer`, `nosniff`, no framing and `no-store`.

## Local rehearsal (fixture, not demo evidence)

```sh
npm run build && node dist/tests/platform/support/observer-rehearsal.js
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
