# Live sourcing and acceptance workstream

Human owner: Jenya, using Codex. Agent must read root `AGENTS.md` first.

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

No live connector, supplier ranking, or selected real company case has been implemented. Tests are explicit TODOs. No live company inventory, price, or delivery availability has been established.

## Next task

Prove live TED retrieval and supplier evidence fetching, then implement `SourcingService` and `MatchingService` against the shared types. Research one primary and one backup case. Keep evidence ranking independent of demo account registration. Confirm current official source text rather than treating a search snippet as supplier proof.

## Verification

Run `npm run test:sourcing`, `npm run test:e2e`, and `npm run check`. Use disposable fixtures for automation. Record the separate live-source rehearsal, URLs, timestamps, comparison rationale, and unknowns. Do not expose private demo mandates or participant contact details in public docs.

## Dependencies and context upkeep

Platform owner supplies persistence/job orchestration; agent owner supplies two independently running clients. End-to-end completion requires their real implementations plus sandbox-provider evidence. Update this file with exact evidence, integration needs, and the next task in every PR.
