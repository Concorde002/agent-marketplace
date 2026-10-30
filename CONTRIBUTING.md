# Working together

Use one repository and short-lived feature branches, not three separate applications. Review `AGENTS.md` before coding.

## First working session

Assign the three human owners. Platform owner controls shared contracts, migrations, API wiring, and dependency/configuration files. Agree changes to `src/contracts.ts` before parallel clients depend on them. Keep the first working interface small.

```sh
git fetch origin
git switch -c feat/your-small-task origin/main
npm ci --ignore-scripts
```

One checkout/worktree per writing agent. Other people's changes are not disposable fixtures.

## PRs

Create a PR for one usable increment. Run the owner's test group and `npm run check`. When implementation changes a shared boundary, include the corresponding contract/OpenAPI/interface-doc change through its owner. Do not guess the other owner's code.

Update your own `docs/workstreams/*.md` in that PR. The integrator owns the shared handoff and updates it after merges. Public docs must contain no credentials, private mandates, or participant contact details.

Ask another teammate to review, fix proven findings, then merge within the team's authorization. Pull the merged main into each workspace before the next task. Module checks run independently in CI; integration checks run as well. A passing CI job with TODO tests does not mean that workstream is complete.

## Integration order

1. Platform: participant identity and request creation. Agents: connect and authenticate two clients. Sourcing: prove live retrieval independently.
2. Connect real sourcing to the platform through `SourcingService` and `MatchingService`.
3. Connect the agents to requests/events/offers; prove negotiation and refusal with simulated terms.
4. Add Stripe sandbox settlement and demo documents, then accurate team-only notifications.
5. Run a real hosted rehearsal with separate clients and current public evidence. Repeat with incompatible limits.

The independent workstreams can run in parallel, but the final product must be integrated incrementally. No amount of isolated testing guarantees that a final merge works.

## Shared context upkeep

- Owner updates workstream status in every behavior-changing PR.
- Integrator updates `docs/STATUS.md` after merging a change that affects current capabilities or next steps.
- Interface owner updates `src/contracts.ts`, `src/openapi.ts`, and `docs/INTERFACES.md` together when an API boundary changes.
- Team changes the full brief only when the agreed scope or architecture changes.
- At the next session, agents fetch current Git state and read those documents again.

This is deliberate documentation, not automatic memory synchronization. Push status updates promptly so others can actually retrieve them.
