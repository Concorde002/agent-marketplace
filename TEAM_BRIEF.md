# Agent Marketplace Backend Marketplace Implementation Plan

> For agentic workers: implement this plan task by task using the executing-plans skill. Three human teammates own the workstreams below, using their own coding agents. Do not create additional chats, delegate work, push, merge, deploy, provision accounts, or send messages merely because this document describes those future steps. Preserve the human team's chosen execution method and obtain the applicable authorization for external actions.

**Goal:** Two independently instructed agents use live European public evidence to discover a suitable counterparty, negotiate a simulated commercial agreement, complete a Stripe sandbox payment, and notify both demo participants without a human approving individual steps.

**Architecture:** A public HTTPS backend exposes authenticated JSON tools. Buyer and supplier bots run independently and call those tools; the backend owns company identities, evidence, requests, offers, policy enforcement, agreements, and payment state. Public data discovery is separate from whether a company has a connected demo representative.

**Proposed stack:** TypeScript on Cloudflare Workers with D1, an HTTP API and OpenAPI description, a thin MCP adapter only where the selected clients support it, TED for public procurement data, one web-search provider for supplier discovery, Stripe sandbox, and one transactional email provider. Use the team's existing host instead if its working setup saves time. Choose one host, not several.

**Spec:** Jenya's agreed requirements, reproduced in this document, and the local SalesPatriot challenge deck. The source PDF is not uploaded to this public repo. The repository now contains a TypeScript scaffold; implementation status is recorded in `docs/STATUS.md` and `docs/workstreams/`.

## 1. What we are building

An agent asks Agent Marketplace to source something. Agent Marketplace fetches public evidence, compares candidates, and identifies who can respond through the platform. Connected buyer and supplier agents exchange structured offers, agree within limits set beforehand, and complete the sandbox order.

People interact through their existing bots. There is no marketplace frontend, dashboard, approval button, or shopping cart. The stage shows the two bot conversations, source links, and the resulting order and sandbox payment references. JSON and plain-text event output provide execution evidence.

The product's value is shared transaction infrastructure beyond public search: counterparties can respond, revise terms, accept the same agreement, and receive consistent order status.

## 2. Honest demo boundaries

- Public buyer requirements and supplier capabilities are retrieved during each live run, with URLs and retrieval timestamps. No preloaded supplier catalog or replay presented as live retrieval.
- Two demo accounts role-play real companies. Every company registration, order, invoice document, and notification carries `demo: true`. Account registration does not verify representation of that real organization.
- Budgets, available quantities, minimum prices, delivery commitments, and permission to trade are declared simulation inputs unless a source actually supports them.
- Do not infer current inventory or price from a supplier website, or today's capability from a past award alone.
- No real procurement submission, binding company commitment, payment, seller payout, shipment, or tax invoice is represented as having occurred.
- A successful sandbox payment means the demo order is agreed and test-paid. It does not mean goods were delivered or a supplier earned profit.
- Human setup is allowed before the run. From the initial buyer instruction onward, agents must proceed or refuse without approval prompts.

Two questions go to an organizer early: does this simulated agreement count as the required autonomous deal, and can the host demonstrate through bot clients or a terminal using the submitted service URL? The deck explicitly requires a live demo on the host's computer from an app link. Backend-only operation does not automatically settle that presentation requirement.

## 3. The stage sequence

### Before the stage

Jenya researches two plausible buyer/supplier cases: one primary and one backup. Each has accessible public evidence and several plausible candidate suppliers. Research guides case selection, not the ranking code. Do not force a supplier by identity or insert its ID into the buyer prompt.

Provision two scoped demo participant credentials through an operator setup step. That step fixes maximum permissions and spending limits before either bot runs; registration cannot expand them. Each bot can register its participant's company context at the service URL. Issue no payment-provider or cloud credentials to bots. Supply demo email addresses belonging to the team.

Example buyer instruction, with exact goods and numbers chosen after inspecting a real case:

"Act as the demo representative of buyer ABC. Find a supplier for [specific requirement], quantity [Q], delivered to Warsaw by [date], within [budget and currency]. Use live public evidence. You may negotiate and accept within those limits, then complete sandbox payment."

Example supplier instruction:

"Act as the demo representative of supplier XYZ. Use our official public capabilities as evidence. Respond to compatible requests. In this simulation our capacity is [Q], minimum acceptable total is [amount], and earliest delivery is [date]. Negotiate within those limits and notify me when an order is agreed and test-paid."

The supplier bot must already have an active listener or poll loop. Its human can sit idle; its software cannot be switched off.

### During the stage

1. Buyer bot registers its demo company and mandate, then creates a sourcing request.
2. Agent Marketplace calls the live procurement source and supplier search. It retrieves evidence from the selected official supplier pages. Search results alone are not treated as verified capabilities.
3. The buyer receives a small comparison, ideally three to five independently discovered candidates, with evidence, unknowns, and a ranking explanation.
4. Only after evidence ranking, Agent Marketplace resolves whether each candidate has a connected demo representative. This availability flag must not influence public-evidence ranking.
5. The buyer agent requests a quote from a qualifying connected candidate. If none qualifies, the run stops with an explanation.
6. The supplier bot sees the request, submits terms, and negotiates. Both bots operate with separate credentials, prompts, private limits, and execution contexts.
7. Both accept the exact same offer revision. Agent Marketplace validates both policies and creates one agreement.
8. Agent Marketplace initiates Stripe sandbox payment. Verified provider status drives the order's payment status.
9. Agent Marketplace creates a clearly labeled demo invoice/order document and notifies both demo participants. Their bots read the final status and report it in their chats.
10. A judge changes the budget, quantity, or deadline. Rerun live sourcing; the system must renegotiate or refuse when appropriate.

Target a first end-to-end run within three minutes, including live retrieval. This is an acceptance target, not a measured performance claim. Allow up to five minutes before reporting a bounded failure. Measure each phase during rehearsal.

## 4. How matching works without cheating

Two different outputs are required:

1. **Evidence shortlist:** plausible suppliers based on the current public evidence, regardless of platform membership.
2. **Offer comparison:** actual received demo offers that satisfy quantity, total cost, destination, deadline, and mandatory specification.

For the evidence shortlist, use a fixed, documented rule: first remove candidates with a proven mandatory mismatch, then rank by the number of sourced matching requirements, then source completeness. A missing fact remains unknown and requires clarification; it is not invented. Use a stable identity-based tie break unrelated to account membership. Keep mandatory-unknown candidates explicitly conditional.

For offers, require all mandatory fields to be confirmed by the offer and within each party's mandate. Rank qualifying offers by total delivered cost in one shared currency, then delivery date. Leave tax and delivery charges explicit in the simulated offer so totals are comparable. Do not add currency conversion in the MVP.

An LLM can extract evidence and propose terms. Deterministic code checks limits, offer revisions, and acceptance. Extracted evidence must include a supporting quotation and URL and be treated as untrusted input.

If an unregistered company appears stronger, show that result as an external lead. Do not manufacture its quote. Say "best qualifying received offer" when only the connected demo supplier responds. Do not claim a global market optimum.

Preparing a case where the represented supplier is plausible is legitimate. Guaranteeing that it wins regardless of evidence is not. If rehearsal shows it is not a good match, change the case openly rather than adding an identity exception.

## 5. Live data implementation

- **TED adapter:** search and retrieve current procurement notices using the public Search API. Separate active requests from historical awards; award records may provide supplier leads, not current availability.
- **Supplier search adapter:** choose one provider for finding official company/product pages. Tavily is a proposed option, not a required dependency. TED is not a complete live supplier catalog.
- **Evidence fetcher:** fetch the chosen public pages during the run. Limit initial searches and fetches, use bounded concurrency and timeouts, respect source terms, and avoid broad crawling.
- **Extraction:** normalize company identity, official domain, product or service capabilities, locations, supported mandatory attributes, source URL, supporting text, retrieval time, and unknown fields.
- **Identity resolution:** use canonical domain and a public organization identifier when available, rather than a fuzzy name alone. Demo aliases can map identities to accounts, but do not affect ranking. Conflicting identities require clarification.
- **Audit:** store what was retrieved for that run and its content hash. This is a record of fresh retrieval, not an imported catalog. Search indexes may lag; only claim current retrieval, not guaranteed current inventory.
- **Failure:** mark source failures and missing documents explicitly. Do not silently use prior-run records to claim a fresh result.

Select sources whose relevant text is accessible within the available runtime. If an essential document is an inaccessible PDF, scanned image, or blocked portal, select a different legitimate case before the demo. Do not build a general scraping or OCR platform for this entry.

## 6. Minimal contract all three owners agree first

The HTTP API is canonical; MCP tools call the same domain functions and do not implement separate business rules. Draft TypeScript signatures are in `src/contracts.ts`; cross-workstream behavior is described in `docs/INTERFACES.md`. The current scaffold has only status/docs endpoints. The routes below describe the target, not implemented behavior.

| Operation | HTTP endpoint | Result |
| --- | --- | --- |
| Describe integration | `GET /agent.txt`, `GET /openapi.json` | Setup instructions and machine-readable schema |
| Register demo identity and policy | `POST /v1/participants` | Participant ID scoped to provisioned credential |
| Create request | `POST /v1/requests` | Request ID |
| Fetch and rank live evidence | `POST /v1/requests/:id/discover` | Discovery run ID |
| Read sourcing result | `GET /v1/discoveries/:id` | Status, candidates, evidence, errors |
| Read own pending events | `GET /v1/events?after=:cursor` | Authorized events and next cursor |
| Request a quote | `POST /v1/requests/:id/quote-requests` | Quote request routed to selected participant |
| Make an offer or counteroffer | `POST /v1/requests/:id/offers` | Immutable offer revision ID |
| Accept exact revision | `POST /v1/offers/:id/acceptances` | Acceptance and agreement status |
| Start sandbox settlement | `POST /v1/orders/:id/settle` | Sandbox payment status/reference |
| Read own order and demo document | `GET /v1/orders/:id` | Terms, payment state, document, notification state |
| Receive provider payment events | `POST /webhooks/stripe` | Signature-verified, deduplicated update |

Requests contain item specification, quantity and unit, destination, currency, maximum total delivered cost, and delivery deadline. Offers contain the same commercial fields, an expiry, both participant IDs, and an immutable revision ID. Money uses integer minor units. Dates use ISO 8601 with explicit timezone. Evidence values and simulated terms have separate fields.

The supplier's private floor never appears in buyer responses. Each side can only act for its own participant. Before agreement, a counteroffer invalidates stale acceptance paths. The second valid acceptance atomically creates one order for the current offer revision, after which terms are immutable and further offers are rejected. Requests can close once, and capacity cannot be allocated twice.

Use idempotency keys on mutations. Payment and notification jobs use a persistent outbox so retries do not repeat their business effect. There are separate agreement, payment, and notification statuses: a failed email does not undo payment, and an agent's message does not mark a payment successful.

Long work returns an ID and is polled in bounded steps. Do not depend on one long serverless HTTP request or in-memory state to complete the transaction.

## 7. Three owners, three substantial outcomes

### Owner A: platform, orders, and Stripe

**Owns:** initial repository scaffold, shared contracts, hosted HTTP service, persistence, authentication, policy enforcement, order lifecycle, sandbox payment, and demo invoice/order document.

**Proposed files:** `src/contracts.ts`, `src/index.ts`, `src/openapi.ts`, `src/platform/*`, `src/payments/*`, `migrations/*`, `tests/platform/`. Owner A alone edits shared `package.json`, lockfile, deployment configuration, and contracts during parallel work; others request surgical changes.

- [ ] Scaffold one TypeScript project with `npm run typecheck`, `npm test`, and `npm run test:e2e`; supply an OpenAPI contract and sanitized local setup instructions.
- [ ] Write failing tests for tenant isolation, policy limits, stale acceptance, duplicate order creation, capacity conflicts, and payment retries.
- [ ] Implement the authenticated API and persistent agreement state with atomic acceptance and allocation.
- [ ] Configure sandbox-only payment support using server-held credentials and test payment methods. Create or reuse exactly one provider payment per order. Verify webhook signatures and deduplicate events.
- [ ] Generate a plain-text/JSON demo invoice with stable document ID, participants, line items, currency, total, `demo: true`, and an explicit no-real-payment statement. This is not a legally valid tax invoice.
- [ ] Run `npm run test:platform` and `npm run typecheck`; read failures and repair owned changes.
- [ ] Prepare deployment commands and required provider configuration. Deploy only with the applicable authorization and verify the actual hosted endpoints afterward.

**Done:** API requests from two scoped clients produce one correctly validated order and one verified sandbox payment, with no UI or secret exposed to an agent.

### Owner B: bot connectivity, independent execution, and notifications

**Owns:** client adapters, conditional MCP wrapper, buyer/supplier instructions, active supplier listener, safe notification routing, and the host-computer demo harness.

**Proposed files:** `src/agents/*`, `src/mcp/*`, `src/notifications/*`, `scripts/run-demo.ts`, `tests/agents/`, `docs/agent-setup.md`.

- [ ] First verify the actual Grokbot and Instinct products and versions: how each authenticates, calls custom HTTP/MCP tools, runs without per-call approval, and receives asynchronous events. Names alone do not establish compatibility.
- [ ] Connect two distinct participant credentials. Implement only the supported interface; prefer HTTP if it works immediately, add MCP if needed by a chosen client.
- [ ] Write failing tests that separate buyer and supplier identity, redact private limits, and prevent an untrusted source from changing tools, policies, or payment recipients.
- [ ] Implement a supplier listener that polls its authorized event cursor every few seconds with backoff, and a buyer runner that advances the sourcing/negotiation flow. Persist cursors and deduplicate responses.
- [ ] Bound negotiation to three offer revisions or five minutes, whichever comes first. Stop on incompatible policies rather than loop forever.
- [ ] Implement email notifications to the team's allowlisted demo addresses through one provider. Use order/event IDs for deduplication and include source links, agreed terms, demo document, and sandbox status. External company email addresses must never be used.
- [ ] Make both bots report final status in their own chats where the verified client API supports it. If proactive chat delivery is unavailable, use the active bot's poll loop and disclose that behavior.
- [ ] Run `npm run test:agents` and demonstrate buyer and supplier running in genuinely separate sessions.
- [ ] Prepare a portable terminal harness for the host computer. If a named client cannot connect, use two independently configured tool-calling agents against the same API and explicitly report that the named-client integration was not achieved.

**Done:** the supplier human remains idle while its running agent receives a request, negotiates, and both demo humans receive accurate completion messages. The host can reproduce this without the developers' private machine state.

### Owner C: Jenya with Codex, live sourcing, matching, and acceptance

**Owns:** case research, real-data connectors, evidence normalization, supplier comparison, live-run proof, and acceptance testing. This is a substantial implementation workstream, not just finding two company names.

**Proposed files:** `src/sourcing/*`, `src/matching/*`, `tests/sourcing/`, `tests/integration/`, `docs/demo-cases.md`, `docs/demo-runbook.md`.

- [ ] Find one primary and one backup case with accessible public demand and multiple plausible suppliers. Avoid product names guessed from the voice transcript; select exact goods from inspected sources.
- [ ] Record source URLs and the demo assumptions separately in the private/local case runbook. Keep account aliases out of candidate-ranking inputs.
- [ ] Write failing tests for unsupported claims, missing mandatory evidence, expired notices, ambiguous identities, irrelevant suppliers, and platform-membership bias.
- [ ] Implement TED search, supplier discovery, current-run source fetches, evidence extraction, identity normalization, and deterministic ranking.
- [ ] Implement quote comparison using confirmed complete commercial terms. A public lead with no quote never becomes a fabricated competing offer.
- [ ] Run `npm run test:sourcing`, then rehearse live retrieval for both cases. A case is accepted only if the results actually support the proposed match.
- [ ] Run the integrated acceptance cases below and capture the final source timestamps, order ID, payment reference, and notification status. Perform the hosted run only against the authorized demo service and sandbox providers.

**Done:** live retrieval independently finds credible candidates, membership changes do not change evidence ranking, and a changed constraint can defeat the prepared supplier. The full run has inspectable evidence rather than a scripted success message.

## 8. Integration sequence and GitHub workflow

These are relative work blocks; adjust to the actual code-freeze time. Do not assume that the spoken estimate established the deadline.

| Block | Shared milestone |
| --- | --- |
| First 30 minutes | Agree exact contract, ownership, host, case criteria, demo interpretation, and the two clients to test. |
| Next 60-90 minutes | A supplies the minimal authenticated API; B proves both client connections and supplier polling; C proves live procurement retrieval plus official supplier evidence. |
| Middle build block | Parallel work on order/payment state, agent negotiation/notifications, and evidence/ranking. Integrate each working vertical piece promptly. |
| Last 90 minutes before freeze | Stop adding features. Run success and refusal cases, inspect security/payment behavior, fix proven faults, and rehearse from the host's execution surface. |

Fail early: do not spend hours on Stripe if the clients cannot call tools, or on a matching algorithm if the chosen sources are inaccessible.

The shared public repository is https://github.com/yauhenifutryn/agent-marketplace. A first scaffold and draft contracts are provided; assign human GitHub handles before parallel implementation. This document does not authorize initializing Git in any umbrella directory. Use three branches such as `platform-payments`, `agent-connectors`, and `live-sourcing`, with PRs into a shared main branch. Push and merge require the team's authorization.

Contracts and shared configuration have one writer, Owner A. Every PR states its behavior, tests, and limitations. A teammate who did not implement a non-trivial change reviews the scoped diff and invariant; security, concurrent acceptance, and payment changes receive particular attention. Fix proven findings and recheck the fixes. Do not commit credentials or personal execution state. Jenya authorized publishing this team brief and repository-owned agent instructions. Shared status is updated through reviewed PRs; no personal transcripts, private participant data, or credentials belong in the public repository.

### Shared documentation rule

Every implementation PR must update its owner's `docs/workstreams/*.md`: what works, exact checks and results, remaining gaps, changed interfaces, dependencies, and next step. The platform integrator alone updates `docs/STATUS.md` after merges. All agents read the handoff, interfaces, current Git state, and their workstream status before starting. Fetch/pull makes published context available; uncommitted work is not automatically shared. Root `AGENTS.md` and `CONTRIBUTING.md` define this workflow.

## 9. Autonomous does not mean unlimited permission

For the demo, never provide real cards. Bots receive scoped Agent Marketplace credentials; Stripe test credentials and test payment methods stay behind the backend. Public pages and bot text cannot select arbitrary payment recipients or raise limits.

Each buyer mandate fixes maximum order and run-total spending, currency, allowed category, destination, expiry, and sandbox-only operation. Supplier mandates fix scope, capacity, delivery limits, and price floor. All mandates are bounded by the operator-provisioned grant; the bot cannot raise that ceiling through registration, policy updates, or a tool call. Bots may agree within these limits without a new human approval. A limit failure ends the attempt; it does not invite the model to override the rule.

In production, use verified business representation, merchant/payment onboarding, and a supported saved-payment authorization flow. No raw card details or unrestricted Stripe secret should be handed to an LLM. Some payment methods can require additional customer authentication; such transactions must pause or fail instead of bypassing it. Seller payouts and marketplace money movement would need a deliberate Connect/payment design. They are outside this MVP.

## 10. Required checks and acceptance evidence

Automated behavior tests use disposable local data and mocked external responses, with no live financial credentials. Live proof is a separate, explicitly authorized demo/sandbox rehearsal. The project scaffold must make the commands below real before claiming them as verification.

| Test | Required observation | Owner |
| --- | --- | --- |
| Live sourcing | Current-run network retrieval produces cited requirements and more than one plausible candidate; failures remain visible. | C |
| Membership independence | Toggle or reorder account registration for identical evidence; shortlist scores and order remain unchanged. | C |
| Honest unknowns | Absent stock or price stays unknown until a demo supplier offer confirms it. | C |
| Happy path | Separate agents agree on one revision; one order is sandbox-paid; both receive accurate notifications. | All |
| Budget/deadline refusal | Incompatible limits produce no agreement and no payment. | A, B |
| Tenant isolation | Buyer credential cannot submit supplier acceptance, view its private floor, or read another tenant's events. | A, B |
| Stale/replayed/concurrent calls | Old revision, duplicate acceptance, or simultaneous attempts cannot create duplicate orders or oversell capacity. | A |
| Payment replay/failure | Retry and duplicate webhook do not double-pay or double-notify; a decline never produces a paid message. | A, B |
| Notification failure | Order/payment remain correct; failed email retries without sending repeated business notifications. | B |
| Malicious source | Instructions embedded in retrieved text cannot alter spending limits, invoke settlement, leak credentials, or fetch private network endpoints. | A, B, C |
| Host reproduction | Host computer can access the service and run/show both agent sessions using the agreed demo setup. | B |

Verification commands after integration: `npm run typecheck`, `npm test`, then `npm run test:e2e` for the disposable local integrated scenario. Inspect fresh output in full. Independently verify one hosted order against its sandbox provider status; a bot saying "done" is not proof.

Use HTTP(S)-only, public-destination fetches with private-address and redirect checks, document-size limits, timeouts, and credentials stripped from outbound fetches. Keep email recipients and payment account mapping controlled by the backend. Never log secrets.

## 11. Scope ceiling and fallback behavior

MVP: two demo accounts, one live procurement connector, one supplier-search route, one currency, one selected supplier per order, three offer revisions maximum, one Stripe sandbox flow, demo invoice/order document, team-only email notifications, and two separate agent sessions.

Defer multi-supplier consortiums, split orders, real-money payouts, formal tax invoicing, universal agent compatibility, self-service company verification, broad crawling, vector databases, and a frontend. Deliberate implementation shortcuts must carry a greppable `MVP_LIMIT` comment stating the ceiling and upgrade path.

If sources fail, return a sourcing failure. If no connected supplier qualifies, return leads but do not close a deal. If payment fails, preserve the agreement with a failed payment state. If a bot client is unsupported, disclose the replacement client. If email is unavailable, show notification failure rather than pretending delivery. Do not substitute a recording, imported catalog, or cached replay for the live run.

## 12. Source references inspected for this plan

- Local challenge deck: live host-computer demo, real public European data, autonomous deal, submission link, and team contributions. The deck does not define whether sandbox settlement satisfies a closed deal.
- [TED Search API](https://docs.ted.europa.eu/api/latest/search.html): published-notice search and retrieval without authentication.
- [Cloudflare Workers](https://developers.cloudflare.com/workers/) and [D1](https://developers.cloudflare.com/d1/): proposed hosted service and persistent SQL storage.
- [MCP architecture](https://modelcontextprotocol.io/docs/learn/architecture): client/server tool integration; not a guarantee that a particular bot supports it or wakes autonomously.
- [Tavily Search](https://docs.tavily.com/documentation/api-reference/endpoint/search): optional supplier-site discovery provider. Direct source fetches supply the current-run evidence.
- [Stripe testing](https://docs.stripe.com/testing): sandbox payments do not move funds; use test payment details.
- [Stripe Payment Intents](https://docs.stripe.com/payments/payment-intents) and [webhooks](https://docs.stripe.com/webhooks): payment state and server-side event handling. For this headless sandbox choose the smallest supported server-side flow; do not add a Checkout UI or billing product without need.

## 13. Definition of done

Two independently running agents, connected to one public backend, retrieve live evidence, discover a qualifying demo counterparty without an identity exception, negotiate and accept identical permitted terms, create exactly one sandbox-paid order and demo document, and report accurate status to both participants. A changed incompatible requirement produces refusal. The host can observe it live, and the team can explain which facts are public evidence and which terms are simulated.

This document is a target plan. A status/docs HTTP scaffold and local test setup now exist. Authentication, live sourcing, trading, bot integrations, Stripe configuration, email delivery, real cases, and deployment remain unimplemented. Initial TODO tests are acceptance tasks, not passing evidence. See the shared handoff for current integrated status.
