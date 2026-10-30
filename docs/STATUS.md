# Shared project state

Owner: platform integrator. Other workstreams update their own status files and propose shared-status changes in PR text.

## Current capabilities

- Working label: Agent Marketplace. Final product name is undecided.
- Public repository: https://github.com/yauhenifutryn/agent-marketplace
- TypeScript scaffold, Web Fetch handler, typed draft boundaries, team brief, agent instructions, and CI configuration exist.
- Implemented HTTP behavior: scaffold health, agent setup description, and draft OpenAPI output. Business routes return 501.
- No deployed service, verified bot integration, authentication, live connector, ranking, order lifecycle, Stripe setup, or in-chat completion reporting yet.
- Initial agent, sourcing, and integration tests are TODO tasks. Green scaffold CI does not establish those features.

## Verification at scaffold publication

- Local `npm run check`: typecheck passed; 5 scaffold tests passed, 8 acceptance TODOs, no failures.
- Individual agent, sourcing, and integration commands run successfully but contain only TODO acceptance tasks. They do not verify those features yet.
- Fresh-context scaffold review completed after resolving the public-status path. Initial [GitHub CI run](https://github.com/yauhenifutryn/agent-marketplace/actions/runs/41041768931) succeeded for the platform, agent, sourcing, and integration check groups. This verifies scaffold compilation/tests, including explicit TODOs; no hosted marketplace run exists yet.

## Next integration step

1. Assign GitHub handles to the three human owners and grant collaborators write access.
2. Platform owner implements scoped registration/request storage and coordinates contract validation.
3. Agent owner proves two actual clients can authenticate/call tools and that the supplier loop stays active.
4. Jenya + Codex implement live source retrieval and inspect two plausible buyer/supplier cases.
5. Integrate these first pieces before extending negotiation and payment.

## Clarified responsibilities and result reporting

- Teammate 1 builds the hosted backend, accounts, order rules, Stripe sandbox, demo documents, and authoritative status/events.
- Teammate 2 connects the actual bots, keeps the supplier listener running, enables autonomous offer exchange, and makes both bots report the result in their existing chats. This includes implementation and verification, not just checking that a URL opens.
- Jenya + Codex implement live-data pulling, extraction, and matching; Jenya personally selects and inspects a primary real-data scenario plus a backup, coordinates integration, and leads end-to-end rehearsal.
- Prepared cases do not preload or force supplier matches. Sources must be retrieved during the run, and incompatible limits must produce refusal.
- Email and a separate notification service are outside the MVP. Bot result reporting is required; failure messages matter as much as success messages.
- Workstream owners test and submit small PRs throughout the build. Platform owner controls shared wiring/contracts/status; Jenya leads overall acceptance.

## Unconfirmed

- Exact Grokbot/Instinct client products, versions, and supported integration interfaces.
- Primary/backup real company cases and fresh accessibility of their sources.
- Organizer acceptance of simulated agreement with sandbox settlement.
- Host's method of demonstrating a backend-only entry from the submission URL.
- Human owners' GitHub handles and the actual code-freeze deadline.

## Where to look

`TEAM_BRIEF.md`: full target and acceptance criteria. `docs/INTERFACES.md` and `src/contracts.ts`: boundaries. `docs/workstreams/`: each owner's current evidence and next step. Pull current Git state before relying on this status.

Local `.agent/` files are tool-managed private execution context. They are ignored and must not be published as shared team documentation.
