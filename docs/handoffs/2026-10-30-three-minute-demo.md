# Three-minute live demo and observer dashboard handoff

Status: implementation brief only. Jenya requested a presentation surface for a separate developer; no dashboard is implemented by this document. This narrowly extends the earlier backend-only presentation plan. It does not add customer registration, a trading UI or human approvals to the transaction path.

## Challenge priorities checked against the deck

Local reference: `Build the Arsenal — SalesPatriot Europe Challenge (Copy).pdf`, physical PDF pages 5, 8 and 9, displayed slide numbers 05/12, 08/12 and 11/12. Keep the source PDF outside Git.

Required: a live app on the host's computer, no slides/video; real public European data; both market sides; at least one autonomously closed deal. Submit repository, app link and each teammate's contribution. Use public permitted data, respect providers and code freeze. Judging: usefulness 30, creativity 30, use of data 20, demo quality 20. The three-minute slot is Jenya's presentation constraint, not a timing guarantee stated by this deck.

A live discovery timeline improves demo quality but does not replace the required closed deal. A completed prior rehearsal can be opened live with its original run/time and receipts, clearly identified as an earlier run; it must never appear as the newly started run. Whether that presentation and simulated agreement/Stripe sandbox satisfy the organizer's definition remains unconfirmed. Obtain organizer confirmation; if no successful autonomous run exists, describe the entry as incomplete.

## Developer ownership and smallest useful build

Use current main in your own branch/worktree after the reviewed integration merges. Read AGENTS.md, docs/INTERFACES.md, docs/workstreams/platform.md, docs/workstreams/agents.md and docs/architecture/0001-lean-procurement-directory.md. You are not alone; coordinate backend-owned routes/contracts with the platform developer. Do not replace the source adapters, transaction engine or bots.

Build one responsive observer page reachable from the submitted app link. A plain, readable layout using the existing server is sufficient; choose dependencies only when they save real implementation work. Do not build a separate customer product or a second database. Prefer native fetch and bounded polling initially; add streaming only if the existing backend already supports it.

Show:

1. Run ID, actual client identities/versions and connection evidence, current phase, elapsed time and last successful refresh. Distinguish observed client connection from a configured display name.
2. Two side-by-side buyer/supplier lanes. Each shows latest verified action, tool name, start/end timestamps, result/error and next awaited step. This is an execution trace, never fabricated chain-of-thought or animated dummy progress.
3. Public source evidence: provider, query/CPV, actual retrieval timestamp, source links, response hash in details, returned/omitted counts and source failures. Explain that award history is not current stock/capability proof.
4. Candidate comparison and reason, frozen ranking, then connected representative lookup as a separate phase. Missing/ambiguous identity stays unresolved. Do not display account membership as a ranking input.
5. Received simulated offer terms, exact revision, each acceptance, order ID, sandbox payment status and verified receipt reference. Keep requested, agreed, payment pending, paid, refused and failed visibly different.
6. A labeled selector for current run and a previously completed rehearsal. Never silently swap runs or replay saved events as current live work. Start/retry commercial actions from the bots or authorized operator workflow, not read-only dashboard buttons.

At desktop/projector width, prioritize the run header, two lanes and outcome above the fold. Evidence details can expand. At phone width stack lanes, wrap URLs/IDs, retain readable text and touch targets. Use three or four type sizes and minimal motion. Do not put a terminal-sized JSON dump on stage.

## Data contract and backend coordination

Existing participant-scoped reads are `/v1/me`, `/v1/events?after=...`, `/v1/requests/{id}`, `/v1/offers/{id}`, `/v1/discoveries/{id}` and `/v1/orders/{id}`. Discovery evidence is read through the existing scoped evidence/source routes and MCP equivalents. Verify names against live OpenAPI/tools before coding. These routes authenticate participants; they do not constitute a ready-made cross-participant observer API.

The backend owner should supply a minimal read-only projection for one authorized demo run. Proposed view fields: run ID, phase, started/updated timestamps, redacted per-agent action records, public source receipts, frozen candidate results, visible offer revision/acceptance state, order/payment state and errors. This is a proposed observer contract, not an existing endpoint. Keep private policy floors/ceilings, credentials, payment method IDs, webhook secrets and raw headers out of responses, browser storage and logs. Public source facts and agreed offer terms can be shown under an operator-approved presentation scope.

Existing participant events mostly cover quote/offer/order/payment lifecycle; they do not record every retrieval/tool step. Add server-observed trace instrumentation where missing, with correlation IDs and bounded payloads. Backend events/state establish the result; tool-call traces establish that the named client did the work. Do not infer successful client reasoning merely from a database row or fixture event.

Keep participant credentials server-side in the approved runtime. Never expose both bots' write tokens to the browser or reuse an operator secret as a dashboard token. The operator must grant a narrow read-only session for the selected run; coordinate its authentication rather than inventing an unauthenticated global activity endpoint. Until that exists, use a clearly labeled local observer during rehearsal, not a public credential-bearing client.

## Three-minute presentation plan

- 0:00–0:15: state the buyer's concrete need and why manual discovery is slow; start a fresh run through the actual buyer client.
- 0:15–1:00: show real retrieval and candidate comparison progressing in the observer page, with one source receipt. Show the supplier lane only when its client actually receives/answers an event.
- 1:00–1:40: show the current quote/agreement state. If the fresh run is still working, say so and open a separately labeled completed rehearsal receipt, if one exists. Do not call the current run complete.
- 1:40–2:15: demonstrate the closed agreement and actual sandbox payment result from an authoritative run. Explain that commercial representation/terms and settlement are simulated.
- 2:15–2:45: change a budget/deadline through the client and show a real refusal or its actual pending state. A completed separately labeled refusal rehearsal can be inspected if timing requires it.
- 2:45–3:00: explain the useful result, source provenance and one honest remaining limitation.

Measure retrieval, assessment, resolution, quote, agreement and payment independently during rehearsal. The three-minute clock controls the presentation, not a forced success timeout. Stop/pause presentation polling without cancelling an agreed payment or inventing a terminal outcome.

## Acceptance for the dashboard developer

- Refresh preserves the selected run and reads authoritative state; repeated polls neither create commercial effects nor duplicate events.
- Empty, slow, disconnected, expired-session and source-error states are explicit; no perpetual fake progress or cached-success fallback.
- A saved completed rehearsal has its original timestamp/run ID and a visible prior-run label.
- No connected supplier yields an external lead, not a fake quote. Low budget/deadline refusal creates no new order or payment attempt.
- Show actual named-client runs separately from protocol fixtures. Payment success comes from the provider-confirmed backend result.
- Verify the host-computer app link, desktop/mobile layouts and a complete three-minute rehearsal. Record measured timing and evidence limitations.

## Optional Jev experiment, after the core path works

Recommendation: keep Jev out of the critical path for the first demo unless a bounded benchmark shows a real improvement. It is a typed decision model, not a crawler, source database, embedding index or replacement for the buyer/supplier LLM. The existing architecture gives semantic interpretation to the clients; adding a hosted model would be an explicit optional architecture change with backend/agent owners, not a silent adapter dependency.

Most useful small experiment: after TED/BZP retrieval, score a bounded shortlist for relevance to the buyer need. Ask separate questions about product/category relevance and whether the provided record supports a specific requirement. Return supported/contradicted/insufficient evidence with record/source IDs; preserve original citations and never promote historical awards into proof of current stock, certification or delivery. Confidence is model output, not a truth guarantee. Account lookup still follows frozen comparison.

Secondary experiment: choose among a small shortlist of real official CPV code/label options. Jev can select from supplied options; it does not inherently contain an authoritative current CPV dictionary. Deterministic vocabulary lookup validates the selected code. Reusing the buyer notice's category is simpler for the first rehearsal.

Future implementer: feature flag off by default, pinned model, server-held operator-provisioned key, bounded input/candidate count, explicit timeout and cost ceiling, cancel propagation, and no hidden repeated retries. On Jev failure retain honest baseline/unknown results. Measure relevance against a small independent labeled fixture set and compare latency/cost with client-only interpretation before enabling. No API call or credential access is authorized by this handoff alone.

Primary references inspected 30 October 2026: [Jev introduction](https://docs.typesafe.ai/introduction), [re-ranking cookbook](https://docs.typesafe.ai/cookbooks/rerank_typesafe), [hierarchical classification](https://docs.typesafe.ai/cookbooks/hierarchical_classification), [models and pricing](https://docs.typesafe.ai/models), [coding-agent distinction](https://docs.typesafe.ai/introduction/coding-agents). Vendor examples are not performance evidence for this procurement application.
