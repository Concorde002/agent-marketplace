# Agent workstream

Human owner: teammate 2, GitHub handle unassigned. Agent must read root `AGENTS.md` first.

## Owns

`src/agents/`, `src/mcp/`, `src/notifications/`, demo scripts, and `tests/agents/`.

## Current state

No bot integration or notification provider exists. Tests are explicit TODOs. Named-client compatibility is unconfirmed. A platform URL does not itself wake an agent or provide authentication.

## Next task

Verify the actual two client products and prove each can call an HTTP/MCP tool with its own scoped credential. Build an active supplier listener and request the scoped request/offer read routes it needs from platform owner. No need to wait for Stripe or live sourcing to prove tool connectivity; use clearly labeled disposable fixtures locally.

## Verification

Run `npm run test:agents` and `npm run check`. TODO tests are not a completed integration. Add real client-boundary behavior tests and record a manual two-session connectivity result separately from local fixtures.

## Dependencies and context upkeep

Consume the platform API rather than creating another marketplace backend. Coordinate event payloads/read routes and notification retry ownership. Update this file with implemented behavior, exact test outcomes, blockers, and next step in each PR. No real company email recipients.
