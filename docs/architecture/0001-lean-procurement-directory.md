# ADR 0001: Structured procurement discovery for the first demo

Date: 2026-10-30. Decision: agreed with Jenya. Source adapters are implemented in this increment; hosted API/MCP integration is pending owner coordination.

## Decision and scope

Use two anonymous structured public APIs:

- **TED supplier leads:** reported contractors from historical `can-standard` procurement notices. An "award winner" is the published contractor, not our ranking winner.
- **Poland BZP buyer opportunities:** `ContractNotice` records containing the buying organization, procurement object, CPV and submission deadline.

This is a bounded view of published procurement records, not all suppliers or buyers in Europe. Poland-only buyer coverage is sufficient. No Tavily, Firecrawl, supplier website listing, crawler, extra database or hosted model is required for this first path. Existing richer source-page assessment remains separate and must not become a hidden prerequisite.

## Retrieval and interpretation

1. The client's own model translates the user's need into CPV and/or plain keywords plus publication dates.
2. `ProcurementDirectory.findSuppliers(query, { signal? })` or `findBuyers` performs one fresh API request. `DirectoryQuery` has `cpvCode?`, `keywords?`, required `publishedFrom`/`publishedTo` calendar dates and `limit?` (default 5, maximum 10).
3. TED uses structured CPV/date clauses and literal full-text keywords (`FT ~ "..."`), `scope: "ALL"`, latest versions and page 1. BZP uses `CpvCode`, `OrderObject`, publication bounds and `PageSize`. No geography filter is implemented in this increment. TED/BZP may interpret category filters differently; returned CPV is checked locally using the requested parent prefix.
4. The result preserves source-reported names, identifiers when unambiguous, country, notice-level CPV, notice URL/publication date, retrieval timestamp and the exact response-body SHA-256. It includes omissions/errors and bounded-coverage metadata.
5. Clients can interpret the records. The backend owns deterministic comparison, frozen ranking, authorization and commercial rules. Account membership must not enter public retrieval or ranking.
6. Only after comparison, the backend resolves a unique connected demo representative through compatible exact public identity. A source organization identifier is never a platform participant ID.

There are **no embeddings, vector index, separate RAG service or backend LLM**. Retrieved records augment the client context in the ordinary sense, but this is API retrieval, not a new semantic-search infrastructure. Reconsider embeddings only after measured failures of the structured filters, not speculatively.

## Honest evidence and identity

- CPV means Common Procurement Vocabulary: a procurement category, not a company identifier or capability certification. Parent categories conventionally end in zeros. The adapter strips an optional check digit; it does not validate the full CPV vocabulary/checksum.
- TED's parallel winner-name/identifier/country fields do not establish multi-winner relationships. Ambiguous records return names with identity fields unbound. Even single-winner identifiers are source-reported, not independently registry-verified. No invented company domains.
- Technical certifications, current stock, price, capacity, delivery and representation stay unknown. Directory CPV describes the notice, not proof that each winner supplied every lot/category.
- Demo accounts explicitly simulate companies. Operator setup must corroborate identifier scheme/country compatibility before account resolution. Missing, conflicting or ambiguous identity stays unresolved; do not fall back to fuzzy names or arbitrary public-ID equality.
- Timezone-free deadlines remain raw text with `deadlineStatus: "unknown"`. Past deadlines remain visible and cannot be called active opportunities. Publication does not establish that a notice is still open or unamended.
- Do not impose a new registry-verification service or website audit for the first demo. If a mandatory capability is not supported, report unknown/refuse or obtain an explicitly simulated declaration, never relabel history as proof.

## Transport and audit

Reuse `FixedJsonApi`: fixed HTTPS destinations, anonymous procurement calls, no redirects, URL traversal, automatic retries or cached fallback; 15-second directory timeout and 1 MiB default body ceiling. Configurable transport bounds retain the existing hard ceiling (30 seconds/2 MiB). Cancellation propagates through body reads. Invalid whole responses fail; malformed/irrelevant records and conflicting duplicates are explicit omissions. All source text remains untrusted data, never tool or policy instructions.

MVP_LIMIT: one page and at most 10 notices per call; up to 100 names per notice. No automatic pagination or bulk ingestion. BZP's full page means more may exist; this is not an exact total or freshness guarantee. Existing platform persistence should store authoritative run evidence, query and results, not introduce another supplier database. Per-call limits are not an aggregate rate limiter: platform owner must bound authenticated call rate/concurrency to provider ceilings before a shared rollout.

## Reuse decision

No new runtime dependency. Extend the existing native Fetch transport rather than install a procurement stack. [OP-TED eForms SDK](https://github.com/OP-TED/eForms-SDK) (CC BY 4.0) and [OCDS](https://github.com/open-contracting/standard) are schema/reference resources, not universal supplier API clients. [Kingfisher Collect](https://github.com/open-contracting/kingfisher-collect) adds a Python/Scrapy ingestion workflow unnecessary for two requests. [openapi-typescript](https://github.com/openapi-ts/openapi-typescript) (MIT) is optional dev-only generation if maintaining a wider OpenAPI surface later saves work. Nothing was installed or copied; generated types would not replace runtime validation.

## Owner handoff and acceptance

- Sourcing: adapters, normalization, provenance, fixture tests and live public-read proof in `src/sourcing/directory.ts` and `tests/sourcing/directory.test.ts`.
- Platform (#11): approve shared directory shapes, authenticated reads, persistence/query binding, minimal BZP request provenance, frozen comparison and exact compatible identity resolution. Current `CompanyIdentity.officialDomain` and TED-only `buyerNoticeNumber` do not directly fit this path. Do not force missing domains into those fields or silently reinterpret a BZP reference as TED.
- Agents (#13): expose small directory tools through the platform, client interpretation and explicit unknowns. Tool names remain proposals (`find_supplier_leads`, `find_buyer_opportunities`) until coordinated. Do not advertise unmounted adapters or make accounts determine search results.
- Jenya: choose primary/backup public-data scenarios after fresh retrieval, register demo representatives through operator setup, then run separate-client success and incompatible refusal. Prepared identities stay outside independent discovery context.

Local adapter tests/live public reads are not hosted integration, actual Grok/Instinct compatibility or sandbox payment proof. Existing richer discovery/ranking tests do not certify a new directory-mode comparator. Final acceptance still requires all three owners and provider-confirmed sandbox settlement with accurate results in both chats.

## Primary references

- [TED Search API](https://docs.ted.europa.eu/api/latest/search.html), [schema](https://api.ted.europa.eu/api-v3.yaml), [CPV](https://ted.europa.eu/en/simap/cpv).
- [BZP integration](https://ezamowienia.gov.pl/pl/integracja), [official documentation archive with OpenAPI 3.0.1](https://media.ezamowienia.gov.pl/pod/2022/08/Zalacznik-3-Instrukcja-integracji-z-API-BZP.zip).
- [Source evidence and limitations](../supplier-data-sources.md). Coordination: [#5](https://github.com/MaksMakarskyi/agent-marketplace/issues/5), [#11](https://github.com/MaksMakarskyi/agent-marketplace/issues/11), [#13](https://github.com/MaksMakarskyi/agent-marketplace/issues/13).

## Operator questions and acceptance boundary

The backend owner wires these adapters into authenticated platform routes and persists their results; the agent owner exposes those routes as client tools. Buyer and supplier accounts do not install independent copies of the adapters. This increment exports the implemented modules, not hosted tools.

Search has three distinct layers:

- **Directory retrieval:** CPV category, literal keywords and publication window select records. Supplying CPV and keywords uses both filters. Returned category codes are checked against the requested parent prefix. Results preserve provider order; this adapter does not assign a suitability score. Historical contract winners are leads, not qualified offers.
- **Existing richer evidence comparison:** `EvidenceRanker` checks request-bound source identities and quoted claims. Mandatory mismatches make a candidate ineligible; absent mandatory evidence leaves it conditional. Sorting uses mismatch exclusion, match count, documented outcome count and a stable identity tie-break. This domain-based comparator is not yet a compatible directory-mode comparator.
- **Received offers:** `OfferRanker` filters exact request/quantity/unit/destination/currency, budget, delivery, expiry and mandatory confirmations, then sorts by delivered total, delivery time and stable offer ID. Commercial terms come from explicitly simulated supplier declarations.

Account lookup is backend post-processing after a frozen ranking. The current `PlatformMarketplace.resolve` uses exact official domain, optional exact public organization ID and valid supplier grants/mandates. Only one match resolves; zero or multiple matches remain external. Structured directory records often lack domains and do not declare a verified identifier scheme. Platform must coordinate that identity boundary before wiring directory leads to quote requests. Do not invent domains, compare arbitrary cross-country identifiers or change public retrieval to favor registered accounts.

CPV codes currently receive format validation, not authoritative vocabulary or check-digit validation. For a selected-notice rehearsal, reuse its source-reported category. For general free-text requests, prefer a small pinned official code/label lookup with model-proposed candidates checked against it; the lookup needs no vector database. The official [TED vocabulary downloads](https://ted.europa.eu/en/simap/cpv) and [developer code list](https://docs.ted.europa.eu/eforms/latest/reference/code-lists/cpv.html) provide the reference. A dictionary is not installed in this increment; neither model recall nor a well-formed code establishes its meaning or suitability.

A **success rehearsal** means two separate actual clients retrieve fresh public evidence, compare before resolving accounts, exchange a simulated quote, accept the same offer, receive provider-confirmed Stripe sandbox payment status and report accurately in both conversations. An **incompatible rehearsal** changes a binding budget, deadline or mandatory requirement so no valid deal can close; assert that no order/payment is produced and both clients explain the refusal. Fixture tests and source API reads establish smaller components, not either full rehearsal.

Publication uses the approved feature branch and ordinary scoped Git operations. No global permission relaxation is needed or part of this change. Merge, deployment, account provisioning and sandbox transaction execution remain separate operator actions.
