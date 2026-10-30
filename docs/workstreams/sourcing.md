# Live sourcing and acceptance workstream

Human owner: Jenya, using Codex. Agent must read root `AGENTS.md` first.

## Owns

`src/sourcing/`, `src/matching/`, `tests/sourcing/`, `tests/integration/`, case research, and live demo acceptance.

## Current state

No live connector, supplier ranking, or selected real company case has been implemented. Tests are explicit TODOs. No live company inventory, price, or delivery availability has been established.

## Next task

Prove live TED retrieval and supplier evidence fetching, then implement `SourcingService` and `MatchingService` against the shared types. Research one primary and one backup case. Keep evidence ranking independent of demo account registration. Confirm current official source text rather than treating a search snippet as supplier proof.

## Verification

Run `npm run test:sourcing`, `npm run test:e2e`, and `npm run check`. Use disposable fixtures for automation. Record the separate live-source rehearsal, URLs, timestamps, comparison rationale, and unknowns. Do not expose private demo mandates or teammate emails in public docs.

## Dependencies and context upkeep

Platform owner supplies persistence/job orchestration; agent owner supplies two independently running clients. End-to-end completion requires their real implementations plus sandbox-provider evidence. Update this file with exact evidence, integration needs, and the next task in every PR.
