# Client-agent-assessed sourcing integration

These are tested internal TypeScript modules, not implemented HTTP/MCP routes. Platform owns authentication, job storage and shared contracts; agent tools call that boundary. Coordinate wiring in [issue #5](https://github.com/MaksMakarskyi/agent-marketplace/issues/5).

## Two-phase flow

1. Platform authenticates a buyer, loads its authoritative `SourcingRequest`, allocates a unique discovery ID and binds the selected TED publication number to the actual buyer need. Do not substitute an unrelated category notice.
2. Construct `AgentAssessedSourcingService` for that job with an `ApiEvidenceCollector`, `discoveryId`, `buyerNoticeNumber` and a platform-owned `persistEvidence` callback. Optional `supplierQuery` must describe requirements, not select a prepared supplier or account.
3. `discover(actor, request)` retrieves the selected active TED competition notice, searches public supplier leads and extracts at most five source documents through the fixed APIs. It persists the backend-only `DiscoveryEvidenceBundle` before returning `running`, with no ranked candidates yet. Collection failure returns `failed`; persistence failure throws rather than announcing a usable job. No backend model runs.
4. Platform loads the stored bundle by discovery ID for each authorized read. `evidenceForAgent(actor, request, bundle)` exposes buyer notice text, requirements, source metadata, unknowns and source failures. `readEvidenceSource(..., sourceId, { offset, limit })` returns bounded untrusted text pages, at most 8,000 characters each.
5. The client's own agent reads that evidence and submits an `AgentAssessment`: the exact discovery ID and buyer publication number, candidate company proposals, identity source IDs and quotations, and per-requirement `match`, `mismatch` or `unknown` claims. A supported non-unknown claim needs a backend-issued source ID and verbatim quotation. Source IDs are scoped as `<discoveryId>:source-<n>`.
6. `finalizeAgentAssessment(actor, request, storedBundle, submittedAssessment)` validates ownership, run/request binding, freshness, literal identity/domain and quotation support, then uses `EvidenceRanker`. It returns a complete ranked result; it does not persist it, resolve participants, request quotes or settle anything.
7. Platform atomically records one immutable finalized result. Only then may it resolve public company identities to connected participants. Unmapped companies remain external leads. Received demo offers can separately be compared with `OfferRanker`; platform retains all transaction authority.

## Trust and state requirements

- Actor context and request come from authenticated platform state. **Never accept a bundle, actor, source body, retrieval timestamp/hash or policy override from an assessment/tool payload.** Bundle fingerprints detect accidental record mutation; they are not signatures or authentication tokens.
- Persist evidence across requests and server instances. Allocate a new unique discovery ID per run. Platform must serialize/fence finalization, reject stale or repeated state transitions and implement appropriate retry/idempotency behavior. Calling a pure finalizer does not implement these guarantees.
- Requests, actors, bundles and proposals are snapshotted before asynchronous validation. A proposal from a prior discovery is rejected even when the source text repeats. Changed request terms invalidate the stored fingerprint. Collection and subsequent assessment each have a five-minute bound.
- The client agent owns semantic interpretation. Literal company-name/domain and quotation checks do not verify legal identity, company representation, certificate validity or the meaning of arbitrary prose. An evidence result of `eligible: "yes"` is not transaction permission or certification.
- Simple ISO/EN/DIN standard references require literal support, with editions retained for matches. Client-declared old-edition mismatches retain their quoted support. Unsupported amendment notation stays unknown. Complex equivalence, alternatives and certificate subject binding need explicit further handling, not optimistic inference.
- Search snippets are leads, not qualified facts. Missing price, stock and delivery stay unknown until a received supplier declaration supplies simulated commercial terms. No account directory is passed into collection or ranking.
- Tavily extraction reports API completion time, extracted-text hash and provider-response provenance, with `originRetrievedAt: null`. Do not describe these as guaranteed original-site freshness or an original HTML hash. No parked direct-fetch implementation is used.
- Source instructions cannot change configuration or invoke a tool. Agent owners must maintain that separation in the actual client prompts/tool runtime as well; fixture tests do not establish named-client prompt-injection resistance.

## Evidence and remaining acceptance

Local fixtures cover API collection, paginated source reads, client proposals, deterministic ranking and received-offer budget/deadline refusal, plus tenant isolation, stale runs, cross-run replay, forged/cross-company quotes, metadata overrides, mutation races, standard amendments/editions and failed persistence.

This does not establish hosted route availability, real Grokbot/Instinct compatibility, persistent finalization, agreement creation, provider-confirmed payment or reporting in both chats. Those require platform/agent wiring and a separate authorized full rehearsal, including an incompatible case that creates no agreement/payment.
