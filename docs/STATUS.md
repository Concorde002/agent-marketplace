# Shared project state

Updated 30 October 2026 for the observer stream (#19) and observer dashboard (#18) integration. This describes source code, not a claim of deployed readiness.

## Implemented in code

- Persistent participant-scoped HTTP and 18-tool MCP workflow backed by Postgres, hashed operator-provisioned credentials and bounded mandates.
- Live public TED buyer retrieval and optional Tavily source reads, discovery-bound client assessments, immutable evidence/ranking, post-ranking domain-based connected-account lookup.
- Simulated quote/offer exchange, exact-revision acceptances, one order and existing Stripe sandbox settlement/webhook library. Hosted provider confirmation remains unverified.
- Bounded anonymous TED award-supplier and Polish BZP buyer directory adapters with provenance, ambiguous-identity handling and fixtures. These newer modules are not mounted in HTTP/MCP; directory-compatible identity resolution is still pending.
- Shared live agent instructions at `/agent.txt`, `/llms.txt` and live MCP initialization; conservative text when platform wiring is absent.
- Existing bot runtimes/protocol fixtures and separate-client setup documentation. Their presence does not establish actual Grok/Instinct account compatibility.
- Observer: a read-only page in `dashboard/` (static, deployed to Cloudflare Pages), its API `GET /v1/observer/runs[/{id}]` authenticated by operator-issued, hashed, expiring observer keys scoped to one demo buyer, bounded server traces per authenticated operation, and the `GET /observer/ws` stream of one human-readable log per endpoint call. Neither the API nor the stream exposes mandates, budgets, credentials or payment methods. Not hosted: the page shows only its connect screen until the steps in task 4 are done.

## Evidence and limits

The source-adapter revision passed typecheck and 316 fixture tests, with 4 explicit TODOs and no failures/cancellations. Four PR CI groups passed. The final main-compatible instruction revision passed typecheck and 318 tests, with 4 explicit TODOs and no failures/cancellations. Fresh scoped source/integration/instruction reviews returned ship; the documented ingress and hosted acceptance limitations remain. Fresh anonymous adapter reads returned current buyer notices and historical supplier leads; source receipts are in the supplier-data notes. An independent scoped adapter review found no blocker.

Local PGlite/mocked-provider tests do not prove hosted migrations, real concurrent Postgres behavior, two actual bot sessions, or provider-confirmed sandbox settlement. Do not advertise `marketplaceReady: true` from these checks. There is no automatic startup migration or in-memory production fallback.

## Remaining owner tasks

1. Backend/source developer: mount the structured directory path through authenticated tools, coordinate source-native buyer provenance and exact compatible identifiers without fabricated domains, persist evidence and freeze comparison before account lookup. Review ingress deadline/cancellation and remaining deployment configuration.
2. Bot developer: verify actual products/versions and two scoped connections; keep supplier execution active, submit source-bound assessments, read authoritative outcomes and report accurately in each client chat. No email or real-company outreach.
3. Dashboard developer: the read-only page is implemented ([observer workstream](workstreams/observer.md)). Verify it against the hosted service once task 4 is done, then rehearse the three minutes with both bot clients. Request to the source owner: record the query's `cpvCodes` in the evidence bundle when the structured directory is mounted.
4. Operator: verify deployed commit/trigger, apply reviewed migrations explicitly (including `20261030170000_observer.sql`), securely provision scoped accounts/mandates and confirm Stripe sandbox/webhook readiness. For the observer, set `OBSERVER_ALLOWED_ORIGINS=https://agentmarketplace.pages.dev` and `OBSERVER_TOKEN` (stream), deploy with `--max-instances=1`, and issue a key with `npm run observer:operator`. No credentials in Git or prompts.
5. Jenya/team: qualify primary/backup scenarios and complete success/refusal rehearsals. The challenge deck requires an autonomous closed deal; a discovery-only visualization does not meet that requirement. Organizer acceptance of sandbox settlement and prior-run receipts remains unconfirmed.

Jev is assessed as an optional relevance/CPV-choice experiment only, not integrated or required. No model call, key access or billing operation was performed by that assessment. See [ADR 0001](architecture/0001-lean-procurement-directory.md), [source evidence](supplier-data-sources.md) and [owner handoffs](handoffs/2026-10-30-integration-owners.md).
