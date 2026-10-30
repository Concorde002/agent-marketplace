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
- The next branch adds API-direct `TavilySearch` / `TavilyExtract` clients with free keyless access, fixed outbound endpoints, bounded calls, explicit per-source failures and separate API-response/extracted-text provenance. Search snippets are leads; no supplier is inferred qualified. Direct website crawling is not the chosen production path.
- `src/matching/offers.ts` compares already-received demo offers: exact request/quantity/unit/destination, same currency and safe integer included totals, mandatory confirmations, future expiry and inclusive delivery window. Qualifying offers rank by delivered total, delivery time, then Unicode codepoint ID. Conflicting duplicate offer IDs fail closed; returned offers contain copied shared fields only.
- `src/sourcing/discovery.ts`, `assessment.ts` and `service.ts` now provide the internal two-phase bridge: exact selected buyer-notice collection, scoped source reads, client-agent assessment validation and deterministic evidence ranking. Platform supplies discovery IDs and authoritative persistence. Source IDs and assessments are discovery-bound; request/actor/proposal snapshots prevent validation races. See the [integration note](../sourcing-integration.md).
- These are local modules, **not** hosted route/tool wiring or end-to-end readiness. Main has separately merged platform payment work in PR #7; its unchanged sourcing contracts still need the coordination in #5. These sourcing increments are not yet merged.
- Primary and backup leads have inspected official sources, but neither is qualified/approved. Per Jenya's instruction, prepared identities and detailed observations remain private evaluator material, excluded from public docs and agent context. [Public case-selection rules](../demo-cases.md) contain no seeded identities. Stock, price, delivery commitments and real-company representation remain unknown.

## Verification

- Red-green: initial compiled stub produced 13 failing retrieval tests; implementing the client made those tests pass. Adding request-to-participate deadlines first produced two failures, then the separate fields were implemented.
- Ranking red-green: 12 initial tests failed against its compiled stub. Additional request/clock/identity cases produced three failures before fixes; an overlong collection-window case failed before its bound was added. Ranking now has 20 substantive local fixture tests.
- Automated, local synthetic fixtures for the bridge increment: `npm run test:sourcing`: 60 passed, 2 remaining sourcing TODOs; `npm run check`: typecheck passed, 77 tests passed, 7 remaining TODOs; `npm run test:e2e`: 12 passed, 2 order/payment TODOs. Zero failures. No tests access production databases or live providers. These counts describe this sourcing branch, not all still-unmerged teammate branches.
- Fresh-context read-only source-boundary review found no blocking issue. Its optional unexpected-location/body-cancellation coverage was added and passes. A human teammate still needs to review the PR before merge.
- Ranker review and recheck found no remaining code-level blocker for the bounded in-process comparator. Identity, request and freshness findings were addressed; optional public-ID/conflicting-name/exact-expiry tests were added and pass. The internal collector/assessment bridge now exists; platform wiring and actual client-agent semantic assessment still need integrated proof.
- Retrieval PR #3 GitHub CI passed all four workstream jobs. The agent/e2e TODOs in that revision still do not prove bots or a closed deal.
- API adapters red-green: 10 search/API-boundary tests and 6 extraction tests failed against compiled stubs, then passed. Review found no blocker; its optional per-result title/snippet bounds were added red-green. No credential, upstream failure body or provider instruction is reflected into trusted behavior.
- Offer comparison has eight substantive fixture tests. A 20,000-level malformed duplicate first reproduced a recursive-fingerprinting failure, then passed after fingerprinting was restricted to validated shallow offer copies. Fresh-context review found no remaining blocker. Its optional inclusive deadline and malformed expiry cases were added and pass. Comparison does not authorize ownership, current revision, acceptance, mandate limits, capacity or payment; platform still enforces those.
- Bridge red-green: six initial workflow tests failed against compiled stubs. Fresh review then reproduced cross-run replay, mutable-input races, amendment false positives and lost edition mismatches; regression tests and fixes passed, and a fresh reviewer rechecked the scoped result. The twelve integration tests exercise the source-to-ranking-to-received-offer boundary, not two autonomous bots or an order/payment engine. The resume checkpoint's four implementation/test files were independently byte-compared with its tested snapshot and preserved unchanged.
- Hosted read-only check on 2026-10-30: the supplied Cloud Run `/health` returned HTTP 200 with `marketplaceReady: false`; `/openapi.json` marks participant/request/discovery/offer/order/event routes unimplemented. Discovery and event GET probes returned HTTP 501. Reachable hosting does not establish marketplace readiness. No credentials or mutation/payment endpoints were used.
- Live keyless search at `2026-10-30T12:19:47.493Z` returned three leads; one API batch extraction at `12:19:48.414Z` returned three text records with separate API/extracted-text hashes and explicit `originRetrievedAt: null`. Some sources were directories/listicles, not qualified suppliers. See the runbook for provenance/limitations. No backend LLM or direct website fetch was involved.
- Live, local Node 22 client: `2026-10-30T11:06:13.835Z`, category search under `ACTIVE` with latest versions returned a competition notice published that day, zero source errors. It exposed a request-to-participate deadline while tender fields were missing. Exact identifiers, quotations and hashes are retained privately so prepared cases do not leak to research agents. [Generic repeatable command and interpretation](../demo-runbook.md).
- Separate live official-page inspections and their individual timestamps/hashes are in private evaluator notes. No live supplier matching, hosted service, named-client compatibility or sandbox/payment evidence exists. In-process registration independence is tested; an integrated directory-isolation test is still needed when that boundary exists.

## Interfaces and coordination

- No changes to platform-owned contracts, package/configuration, HTTP routes or shared status. The module reuses shared `Evidence` and source-error shapes. `TedSearchResult` is a low-level source result, not a second offer/order model.
- Platform owner: coordinate discovery ID allocation, audit/result storage and partial-source-failure handling before `SourcingService.discover` wiring. The current draft does not specify these implementation details; this PR does not invent a scheduler/database.
- Ranker prerequisite: `EvidenceRun` is trusted in-process backend collector output, not a bot-controlled attestation or new RPC schema. The collector must bind hashes to actual fresh bodies, derive identities from public sources, and assess semantic outcomes. Quotation containment alone does not prove semantics, legal identity or a certificate. No public route currently accepts this context. Never use registered participants to supply its public identity list.
- Runtime clock checks bind the context to one request, limit collection to five minutes and expire it five minutes after completion. This clears usable source/candidate state between runs without deleting authoritative audit/order history. External certificate registries need verified subject-identity binding before their claims can count; they are not silently whitelisted.
- Agent owner: sourcing remains behind the platform API. No bot adapter, hosting or Stripe work is included.
- Keyless search/extract API access is live and needs no account. Higher-quota bearer access is optional operator configuration. No credential files were read and no dependencies were added.
- Jenya clarified that the platform stays deterministic and client agents own semantic interpretation/model credits. Do not introduce a backend LLM provider. [Coordination issue #5](https://github.com/yauhenifutryn/agent-marketplace/issues/5) requests scoped source-bundle reads, agent assessment submission, selected buyer-source provenance and post-ranking participant resolution. Those shared changes belong to platform/agent owners.
- [Agent PR #1 finding](https://github.com/yauhenifutryn/agent-marketplace/pull/1#issuecomment-6522540433): public organization IDs cannot be used as participant IDs. An unmapped public company must remain an external lead.

## Next task and blockers

Platform/agent owners must wire the now-implemented internal bridge through authenticated source-read/assessment tools, immutable persistent jobs and one-time finalization, then resolve accounts after ranking. Offer comparison also needs authoritative platform wiring. Run integrated cold-start rehearsals only once that boundary works. No application-hosted LLM or custom crawler is planned. The client agent uses its own model for semantics and dialogue. Human case approval and genuine full bot-to-sandbox acceptance remain open. Provider extraction reports API retrieval, not guaranteed original-site freshness; keep that limit visible.

Public demand/buyer identity, supplier capabilities and standards evidence should be visible in tool results and existing bot chats, not a new frontend. Supplier-led opportunity discovery requires a coordinated platform read boundary. Simulated API-client testing must remain distinct from real Grok/Instinct acceptance. Full demo acceptance still depends on the other two owners' implementations.

TesterArmy e2e was researched from official docs as an optional independent-test layer, not installed or run. Its web/mobile engines are not a drop-in backend API harness; coordinate an API tool/executor/engine bridge with the appropriate owners. The inspected release needs Node 22.22.3+, while the observed runtime is 22.22.2. Fresh-discovery tests must disable action replay and exclude all private case material. Provider configuration and a working integrated backend remain prerequisites.

Publication: [retrieval PR #3](https://github.com/yauhenifutryn/agent-marketplace/pull/3), [evidence-ranking PR #4](https://github.com/yauhenifutryn/agent-marketplace/pull/4), stacked on #3. Project-local permissions permit owned feature-branch publication while retaining main-push, merge, deployment and secret-access restrictions. A human teammate must review before merge. No merge or deployment is authorized or performed.

The API-direct supplier research is [PR #6](https://github.com/yauhenifutryn/agent-marketplace/pull/6), stacked on #4. Isolated custom direct-fetch work was stopped on Jenya's direction and is not part of this branch or the chosen production path.

Received-offer comparison is [PR #9](https://github.com/MaksMakarskyi/agent-marketplace/pull/9), stacked on #6; it already exists and passed four CI jobs. The bridge is the next scoped PR stacked on #9. Repository ownership now resolves to `MaksMakarskyi/agent-marketplace`; earlier URLs redirect. No sourcing PR was merged and no deployment was performed by this workstream.
