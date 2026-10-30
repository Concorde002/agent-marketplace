# Agent Marketplace

Working label, not a final product name. Backend-only hackathon project for agent sourcing, negotiation, and sandbox settlement using live European public data.

**Current state: scaffold. No live sourcing, authentication, bot integration, trading, Stripe payment, bot completion reporting, or deployment is implemented.**

Start with the [full team brief](TEAM_BRIEF.md), then [agent instructions](AGENTS.md), [interfaces](docs/INTERFACES.md), and [shared status](docs/STATUS.md).

## Three owners

| Workstream | Owner | Code | Status |
| --- | --- | --- | --- |
| Platform, hosting, order lifecycle, Stripe | Teammate 1 | `src/platform/`, `src/payments/`, API, contracts, migrations | [Platform](docs/workstreams/platform.md) |
| Bot connections, supplier listener, in-chat results | Teammate 2 | `src/agents/`, `src/mcp/`, `scripts/` | [Agents](docs/workstreams/agents.md) |
| Live data, matching, case research, acceptance | Jenya + Codex | `src/sourcing/`, `src/matching/` | [Sourcing](docs/workstreams/sourcing.md) |

Names and GitHub handles for the two teammates are not assigned yet. Do not assume ownership from who last edited a file.

In plain language: teammate 1 builds the service and payments; teammate 2 makes the two bots actually use it; Jenya + Codex build the live search/comparison and prove the demo works. Jenya personally chooses and inspects one primary buyer/supplier scenario plus a backup, defines the demo limits, coordinates integration, and leads the final rehearsal. Codex implements the sourcing/matching code with Jenya. Each owner tests and reviews contributions; integration happens through small PRs throughout the build.

A "demo case" is a researched real buyer requirement and a plausible real supplier, with public source links and explicit simulated terms. It is not a preloaded catalog or a forced match. A "supplier listener" is the supplier bot remaining active to receive requests and answer them; it is not a supplier-listing frontend.

## Start locally

Use Node 22 and npm. No credentials are needed for scaffold tests.

```sh
git clone https://github.com/yauhenifutryn/agent-marketplace.git
cd agent-marketplace
npm ci --ignore-scripts
npm run check
```

`src/index.ts` exports a Web Fetch handler suitable as a future Workers entry point. There is no deployment configuration or local HTTP server yet. Tests exercise the handler directly without network access.

Implemented: `GET /health`, `GET /agent.txt`, and `GET /openapi.json`. Business routes return HTTP 501. The OpenAPI description marks them `x-implemented: false`; it is a draft, not a completed client contract.

Owner commands: `npm run test:platform`, `npm run test:agents`, `npm run test:sourcing`, and `npm run test:e2e`. Initial agent, sourcing, and end-to-end tests are explicit TODOs, not verified functionality. CI runs all four groups independently and type-checks the whole repository.

## Work in parallel

1. Read the shared context and claim one workstream with your human teammate.
2. Start a small feature branch from current `origin/main` in your own checkout/worktree.
3. Change owned files. Ask the platform owner for contract, schema, package, or API-wiring changes.
4. Test your module using disposable fixtures. Update its status document in the same PR.
5. Get a teammate's review and merge within your authorized scope. Pull the new main before the next change.
6. Run the full integrated demo before calling the product ready.

Do not wait for three giant branches to finish before integrating. [Contribution workflow](CONTRIBUTING.md).

## Intended bot setup

Once implemented and hosted, each bot needs a service URL, scoped participant credential, demo company identity, and limits. Then the buyer asks for sourcing and the supplier runs a listener. A public URL and a company description alone do not register, authenticate, or wake a bot. Grokbot and Instinct support must be proven with the actual clients.

Results appear in each bot's existing conversation: agreed and sandbox-paid, no suitable supplier, failed negotiation, or payment failure. The bot reads authoritative order/payment status and reports it; the platform does not need a separate email service or notification frontend. Email is outside the MVP.

Public evidence is live; company representation and commercial terms are simulated. No real cards, real company outreach, procurement submissions, or binding transactions are part of the demo. Organizer acceptance of sandbox settlement and the host's backend-only presentation remains unconfirmed.
