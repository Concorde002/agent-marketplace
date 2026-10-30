# Shared project state

Updated 30 October 2026 for the reviewed integration merge. This describes source code, not a claim of deployed readiness.

## Implemented in code

- Persistent participant-scoped HTTP and 18-tool MCP workflow backed by Postgres, hashed operator-provisioned credentials and bounded mandates.
- Live public TED buyer retrieval and optional Tavily source reads, discovery-bound client assessments, immutable evidence/ranking, post-ranking domain-based connected-account lookup.
- Simulated quote/offer exchange, exact-revision acceptances, one order and existing Stripe sandbox settlement/webhook library. Hosted provider confirmation remains unverified.
- Bounded anonymous TED award-supplier and Polish BZP buyer directory adapters with provenance, ambiguous-identity handling and fixtures. These newer modules are not mounted in HTTP/MCP; directory-compatible identity resolution is still pending.
- Shared live agent instructions at `/agent.txt`, `/llms.txt` and live MCP initialization; conservative text when platform wiring is absent.
- Existing bot runtimes/protocol fixtures and separate-client setup documentation. Their presence does not establish actual Grok/Instinct account compatibility.

## Evidence and limits

The source-adapter revision passed typecheck and 316 fixture tests, with 4 explicit TODOs and no failures/cancellations. Four PR CI groups passed. Later instruction changes must record their own fresh result in the sourcing workstream. Fresh anonymous adapter reads returned current buyer notices and historical supplier leads; source receipts are in the supplier-data notes. An independent scoped adapter review found no blocker.

Local PGlite/mocked-provider tests do not prove hosted migrations, real concurrent Postgres behavior, two actual bot sessions, or provider-confirmed sandbox settlement. Do not advertise `marketplaceReady: true` from these checks. There is no automatic startup migration or in-memory production fallback.

## Remaining owner tasks

1. Backend/source developer: mount the structured directory path through authenticated tools, coordinate source-native buyer provenance and exact compatible identifiers without fabricated domains, persist evidence and freeze comparison before account lookup. Review ingress deadline/cancellation and remaining deployment configuration.
2. Bot developer: verify actual products/versions and two scoped connections; keep supplier execution active, submit source-bound assessments, read authoritative outcomes and report accurately in each client chat. No email or real-company outreach.
3. Dashboard developer: follow [the three-minute observer handoff](handoffs/2026-10-30-three-minute-demo.md). Build a read-only selected-run view, not a customer trading UI. The dashboard is not implemented yet.
4. Operator: verify deployed commit/trigger, apply reviewed migrations explicitly, securely provision scoped accounts/mandates and confirm Stripe sandbox/webhook readiness. No credentials in Git or prompts.
5. Jenya/team: qualify primary/backup scenarios and complete success/refusal rehearsals. The challenge deck requires an autonomous closed deal; a discovery-only visualization does not meet that requirement. Organizer acceptance of sandbox settlement and prior-run receipts remains unconfirmed.

Jev is assessed as an optional relevance/CPV-choice experiment only, not integrated or required. No model call, key access or billing operation was performed by that assessment. See [ADR 0001](architecture/0001-lean-procurement-directory.md), [source evidence](supplier-data-sources.md) and [owner handoffs](handoffs/2026-10-30-integration-owners.md).
