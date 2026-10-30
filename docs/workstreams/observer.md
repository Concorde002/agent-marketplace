# Observer dashboard workstream

Owner: dashboard developer. Scope: one read-only observer page and its presentation/deployment, per
[the three-minute demo handoff](../handoffs/2026-10-30-three-minute-demo.md). Not a trading UI.

## Works now (local fixture)

- `dashboard/`: static page deployed to https://agentmarketplace.pages.dev (Cloudflare Pages). Run
  selector with current/earlier labels and a "new run" banner (no silent switch), header with phase,
  elapsed and last activity, buyer and supplier lanes from server traces, observed client vs
  configured name, sources with retrieval receipts, frozen comparison, representative lookup after
  ranking, offers/acceptances, order and payment. Desktop, projector and phone layouts; light and
  dark.
- Proposed backend piece (needs the backend developer's review): `src/platform/observer.ts`,
  observer routes in `src/platform/http.ts`, migration `20261030170000_observer.sql`, config in
  `src/server.ts`, operator key command `observer:operator`.
- `tests/observer/observer.test.ts` (10): paid run with both lanes and observed clients; no private
  limit, token or payment method in any response; session scoping (other buyer 404, participant
  token rejected, observer key rejected on participant routes, expiry, POST 405); polling writes
  nothing; failed and pending payments show no receipt; conditional candidate never quoted;
  refusal traced with no order; CORS only for configured origins; phase derivation; key command.
- `tests/observer/support/rehearsal.ts`: local rehearsal server (paid, refused, then a slow live run).

Checks (2026-10-30): `npm run check`: typecheck clean; 332 tests, 328 passed, 0 failed, 4
pre-existing TODO. Browser-checked locally at 1440×900 and 375×812 (no horizontal scroll), light
and dark, disconnected state, new-run banner, refused run. Evidence class: local fixture only.

## Missing / blocked

1. Backend developer: review and own the observer projection, auth and redaction; merge; operator
   applies the migration and sets `OBSERVER_ALLOWED_ORIGINS`. Until then the deployed page can only
   show its connect screen.
2. The deployed page has not been verified against the actual service (a public page cannot reach a
   local API). Needs the hosted observer API and an issued observer key.
3. CPV codes are not recorded by the live discovery pipeline; the page says so. Request: store the
   query CPV in the evidence bundle (`cpvCodes`) when the structured directory is mounted.
4. No hosted timing or three-minute rehearsal with both actual bot clients yet.
5. `docs/STATUS.md` still says the dashboard is not implemented; the integrator updates it after merge.

## Next step

Backend review of the observer API, hosted deployment, then a full rehearsal on the host computer
using [the runbook](../observer-runbook.md), recording run IDs and measured timing.
