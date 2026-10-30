# Agent workstream

Human owner: teammate 2, GitHub handle unassigned. Agent must read root `AGENTS.md` first.

## Owns

`src/agents/`, `src/mcp/`, demo scripts, and `tests/agents/`. This owner makes the existing buyer and supplier bots use the platform and report results in their normal conversations.

## What this means in plain language

1. Prove the actual Grokbot/Instinct clients can connect, authenticate separately, and call the platform's tools. It is implementation work as well as a compatibility test.
2. Make each bot register its demo company and permitted terms using the backend built by teammate 1.
3. Keep the supplier bot active so it receives a quote request and automatically responds. "Listener" means a running event-checking loop, not a supplier-listing page.
4. Make the bots exchange offers/counteroffers and accept or refuse without their humans stepping in. Backend rules still enforce each mandate.
5. After the platform reports the actual result, make each bot tell its own human in the existing chat: agreed and sandbox-paid, no match, refused, expired, or payment failed. Include the demo order/invoice reference where applicable.

Email, a separate notification service, and a notification UI are outside the MVP. Do not write another live-data connector or implement Stripe here.

## Current state

No bot integration or in-chat result reporting exists. Tests are explicit TODOs. Named-client compatibility is unconfirmed. A platform URL does not itself wake an agent or provide authentication.

## Next task

Verify the actual two client products and prove each can call an HTTP/MCP tool with its own scoped credential. Build an active supplier listener and request the scoped request/offer read routes it needs from platform owner. No need to wait for Stripe or live sourcing to prove tool connectivity; use clearly labeled disposable fixtures locally.

## Verification

Run `npm run test:agents` and `npm run check`. TODO tests are not a completed integration. Add real client-boundary behavior tests and record a manual two-session connectivity result separately from local fixtures.

## Dependencies and context upkeep

Consume the platform API rather than creating another marketplace backend. Coordinate event payloads/read routes, persist event cursors, and deduplicate chat reports. Keep the supplier listener active through final payment/failure status. Update this file with implemented behavior, exact test outcomes, blockers, and next step in each PR. No real company outreach.
