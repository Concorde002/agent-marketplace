# Live sourcing and acceptance workstream

Human owner: Jenya, using Codex. Agent must read root `AGENTS.md` first.

Implementation can be handed to Jenya's Azure coding assistant. Read the [focused handover and copy-paste kickoff prompt](../handoffs/live-sourcing.md) for the first deliverable, PR sequence, and merge boundaries. The workstream owner remains Jenya regardless of the coding assistant used.

## Owns

`src/sourcing/`, `src/matching/`, `tests/sourcing/`, `tests/integration/`, case research, and live demo acceptance.

## What Jenya does personally

1. With Codex, choose the real public-data sources and define the buyer's sourcing requirements. Codex writes the live retrieval, extraction, and supplier-comparison code in this workstream.
2. Research one primary demo scenario and one backup. Each case is a real public buyer requirement plus a real supplier with documented relevant capabilities, source links, and explicitly simulated commercial terms. These are prepared scenarios, not imported candidate records or hard-coded matches.
3. Inspect the source evidence and rehearse whether the live search actually finds and qualifies the represented supplier. If it does not, choose a better case rather than forcing the ranking.
4. Coordinate the three owners' integration and lead the complete demo rehearsal, including a changed budget/deadline that should cause refusal.

Jenya is the human owner and acceptance lead; Codex implements and tests code within this workstream. This is not just manually collecting company names. It includes the live API connection, data processing, and ranking. The public catalog is not a registered supplier: teammate 2 connects the participant's bot; teammate 1 handles accounts and orders.

## What "matching" means

Turn the buyer's requirements and freshly fetched supplier evidence into a reasoned comparison. Keep missing price/stock unknown. After a connected supplier submits a demo quote, compare its price, quantity, and delivery terms against the request. Backend owner enforces acceptance and spending limits; sourcing owner does not implement a second deal engine.

## Integration responsibility

Every owner opens small tested PRs and another teammate reviews them. Merge usable increments throughout the build. Jenya coordinates and verifies the overall result; the platform owner handles shared wiring and updates `docs/STATUS.md`. Do not wait for three large finished branches and leave Jenya to reconcile them at the end.

## Current state

- First feature branch implements `src/sourcing/ted.ts`: a dependency-injected native Web Fetch client for the fixed public TED Search API. It validates search/envelope/notice shapes; preserves multilingual buyer requirements, publication references and separate tender/participation deadlines; attaches fresh API-source timestamps and SHA-256 hashes.
- Retrieval is bounded by time, response bytes and paging. No redirects, outbound credentials, automatic retries, response-selected URL traversal or cached fallback. Invalid records produce explicit source errors; whole-source failures throw typed errors without reflecting upstream content.
- The follow-up branch adds `src/matching/evidence.ts`: deterministic evidence ranking against request-bound, expiring current-run source snapshots and extracted public identities. Registration metadata is ignored/stripped; missing mandatory evidence stays conditional; sourced mandatory mismatches remain rejected. No account directory is an input.
- These are local modules, **not** `SourcingService.discover`, hosted API wiring, supplier discovery/extraction, offer comparison or end-to-end readiness. Shared main remains the scaffold until the integrator merges the PRs.
- Primary and backup leads have inspected official sources, but neither is qualified/approved. Per Jenya's instruction, prepared identities and detailed observations remain private evaluator material, excluded from public docs and agent context. [Public case-selection rules](../demo-cases.md) contain no seeded identities. Stock, price, delivery commitments and real-company representation remain unknown.

## Verification

- Red-green: initial compiled stub produced 13 failing retrieval tests; implementing the client made those tests pass. Adding request-to-participate deadlines first produced two failures, then the separate fields were implemented.
- Ranking red-green: 12 initial tests failed against its compiled stub. Additional request/clock/identity cases produced three failures before fixes; an overlong collection-window case failed before its bound was added. Ranking now has 20 substantive local fixture tests.
- Automated, local synthetic fixtures: `npm run test:sourcing`: 35 passed, 2 remaining source/offer TODOs; `npm run check`: typecheck passed, 40 tests passed, 7 remaining TODOs; `npm run test:e2e`: 0 implemented tests, 2 TODOs. Zero failures. `git diff --check` passed. No tests access production databases or live providers. The pure registration-independence TODO was replaced by a real metadata-toggle/input-order test.
- Fresh-context read-only source-boundary review found no blocking issue. Its optional unexpected-location/body-cancellation coverage was added and passes. A human teammate still needs to review the PR before merge.
- Ranker review and recheck found no remaining code-level blocker for the bounded in-process comparator. Identity, request and freshness findings were addressed; optional public-ID/conflicting-name/exact-expiry tests were added and pass. The trusted collector and semantic verification remain explicit integration blockers, not established features.
- Retrieval PR #3 GitHub CI passed all four workstream jobs. The agent/e2e TODOs in that revision still do not prove bots or a closed deal.
- Live, local Node 22 client: `2026-10-30T11:06:13.835Z`, category search under `ACTIVE` with latest versions returned a competition notice published that day, zero source errors. It exposed a request-to-participate deadline while tender fields were missing. Exact identifiers, quotations and hashes are retained privately so prepared cases do not leak to research agents. [Generic repeatable command and interpretation](../demo-runbook.md).
- Separate live official-page inspections and their individual timestamps/hashes are in private evaluator notes. No live supplier matching, hosted service, named-client compatibility or sandbox/payment evidence exists. In-process registration independence is tested; an integrated directory-isolation test is still needed when that boundary exists.

## Interfaces and coordination

- No changes to platform-owned contracts, package/configuration, HTTP routes or shared status. The module reuses shared `Evidence` and source-error shapes. `TedSearchResult` is a low-level source result, not a second offer/order model.
- Platform owner: coordinate discovery ID allocation, audit/result storage and partial-source-failure handling before `SourcingService.discover` wiring. The current draft does not specify these implementation details; this PR does not invent a scheduler/database.
- Ranker prerequisite: `EvidenceRun` is trusted in-process backend collector output, not a bot-controlled attestation or new RPC schema. The collector must bind hashes to actual fresh bodies, derive identities from public sources, and assess semantic outcomes. Quotation containment alone does not prove semantics, legal identity or a certificate. No public route currently accepts this context. Never use registered participants to supply its public identity list.
- Runtime clock checks bind the context to one request, limit collection to five minutes and expire it five minutes after completion. This clears usable source/candidate state between runs without deleting authoritative audit/order history. External certificate registries need verified subject-identity binding before their claims can count; they are not silently whitelisted.
- Agent owner: sourcing remains behind the platform API. No bot adapter, hosting or Stripe work is included.
- Supplier search configuration is not provisioned. No credential files were read and no dependencies were added.

## Next task and blockers

Implement one permitted supplier-search route plus DNS-aware safe official-page retrieval, then the trusted collection/semantic-extraction boundary and a genuine case comparison. The current TED-only boundary must not be reused for arbitrary supplier URLs. Supplier-search and extraction-model provider/configuration, body/identity binding and human case approval remain open. Then add offer comparison and integrated cold-start rehearsals. The bot uses its own model for dialogue; any backend semantic extractor needs separate configured server-side tokens. Neither exists implicitly through a caller's Grok subscription.

Public demand/buyer identity, supplier capabilities and standards evidence should be visible in tool results and existing bot chats, not a new frontend. Supplier-led opportunity discovery requires a coordinated platform read boundary. Simulated API-client testing must remain distinct from real Grok/Instinct acceptance. Full demo acceptance still depends on the other two owners' implementations.

Publication: [retrieval PR #3](https://github.com/yauhenifutryn/agent-marketplace/pull/3). The separate evidence-ranking PR is pending and will be stacked on #3, not merged into main by this assistant. Project-local permissions permit owned feature-branch publication while retaining main-push, merge, deployment and secret-access restrictions. A human teammate must review before merge. No merge or deployment is authorized or performed.
