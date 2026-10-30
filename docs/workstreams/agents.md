# Agent workstream

Human owner: teammate 2. Agent runtime: OpenCode workers, orchestrated and reviewed by Hermes.
Agent must read root `AGENTS.md` first.

## Owns

`src/agents/`, `src/mcp/`, demo scripts, and `tests/agents/`. This owner makes the existing buyer and
supplier bots use the platform and report results in their normal conversations.

## What this means in plain language

1. Prove the actual Grokbot/Instinct clients can connect, authenticate separately, and call the
   platform's tools. It is implementation work as well as a compatibility test.
2. Make each bot register its demo company and permitted terms using the backend built by teammate 1.
3. Keep the supplier bot active so it receives a quote request and automatically responds.
   "Listener" means a running event-checking loop, not a supplier-listing page.
4. Make the bots exchange offers/counteroffers and accept or refuse without their humans stepping in.
   Backend rules still enforce each mandate.
5. After the platform reports the actual result, make each bot tell its own human in the existing
   chat: agreed and sandbox-paid, no match, refused, expired, or payment failed. Include the demo
   order/invoice reference where applicable.

Email, a separate notification service, and a notification UI are outside the MVP. Do not write
another live-data connector or implement Stripe here.

## Current state (2026-10-30)

Implemented on branch `feat/agent-connectors` (PR pending):

- `config.ts` — environment-only identity, mandate and limits. Every missing/invalid variable is
  reported by name; values are never echoed. `sandboxOnly` is always true and a bot cannot raise a
  ceiling at runtime.
- `client.ts` — typed client for registration, requests, discovery, quote requests, offers,
  acceptances, settlement, order reads, events, and the two scoped reads. Bearer auth, deterministic
  `Idempotency-Key`, bounded timeout, retry only on 408/429/5xx with the same key.
- `store.ts` — atomic file-backed cursor, seen-event set and report ledger, plus a memory variant.
- `policy.ts` — deterministic buyer/supplier limit checks and offer arithmetic in integer minor
  units. Buyer counters only price failures; any non-price mismatch refuses instead of burning a
  revision.
- `negotiation.ts` / `buyer.ts` — buyer registers, creates the request, polls discovery, requests a
  quote from the top connected ranked candidate (up to five fallbacks), negotiates within three
  revisions or five minutes, settles, reads the order and reports.
- `listener.ts` — supplier event loop with backoff, persisted cursor, event dedupe, quote/offer
  handling, a settlement attempt with a graceful 403 fallback, and continued polling through payment.
- `reporter.ts` — exactly three literals (`agreed and sandbox-paid`, `no match`, `payment failed`)
  from authoritative status, deduplicated by order and event, with a pending queue for offline bots.
- `cli/` — `buyer`, `supplier`, `demo` entrypoints; `tests/agents/support/dev-platform.ts` starts the
  disposable test double for local runs.
- `src/mcp/gateway.ts`, `tools.ts`, `backend.ts` — zero-dependency Streamable HTTP MCP server with 14
  tools, strict schemas, token-scoped identity, sanitized errors, and `supplier_listener_tick` /
  `report_pending` for scheduled bot turns. Delivered as its own PR.

Checks observed locally:

```
npm run typecheck
npm run test:agents     # 100+ agent tests, 0 failures
npm run check           # full repository suite green
```

A real `@modelcontextprotocol/sdk` 1.28.0 client completed `initialize`, `tools/list` (14 tools) and
`tools/call` against the gateway over HTTP, including token propagation and a completion report.

## Gaps

- No live Grok Bot account was available, so the vendor-documented custom-MCP path is documented and
  protocol-tested, not account-tested. Someone must repeat it and record the transcript.
- Instinct has no public developer API and no documented custom MCP or credential storage. The
  named-client integration is **not achieved**; the disclosed fallback is the terminal harness with
  two independent tool-calling agents.
- The platform must expose `GET /v1/requests/{id}` and `GET /v1/offers/{id}` (scoped), and mount
  `createMcpHandler(createMcpBackend(...))` at `POST /mcp`. Events must carry request/offer/order ids
  in `resourceId` as documented in `docs/agent-setup.md`.
- Two open contract questions were raised on the PR and block hosted wiring: (a) whether submitting
  an offer counts as its author's acceptance or both parties must call `acceptOffer`; (b) how the
  buyer resolves a ranked candidate to a connected `supplierId`, since ranking must not know about
  membership. Until (b) is answered the runtime takes an injected candidate→participant map.
- Payment-status timing depends on the platform's `payment_updated` event; a stuck `pending` order is
  reported as failed only after the reporting window, never as paid.
- No refusal endpoint exists in the contract, so a supplier refusal is recorded locally and expressed
  as non-acceptance; the buyer reports `no match` on expiry or revision exhaustion.

## Next task

1. Platform owner: merge the scoped read routes and mount the MCP handler; confirm event resource ids.
2. Teammate 2: attach a real Grok Bot to the hosted `/mcp`, start the supplier routine, and record
   the two-chat transcript (buyer instruction → offers → paid → both messages).
3. Jenya: rehearse the changed-constraint refusal from the host computer using the same harness.

## Verification

`npm run test:agents` and `npm run check`. The agent tests use a disposable platform test double and
mocked payment outcomes; they are not a hosted run and not proof of a live Stripe payment. Record
hosted and client evidence separately in the PR that produces it.

## Dependencies and context upkeep

Consume the platform API rather than creating another marketplace backend. Coordinate event payloads,
read routes and MCP mounting with the platform owner. Keep the supplier listener active through final
payment status. Update this file with implemented behaviour, exact test outcomes, blockers and the
next step in each PR. No real company outreach; no email service.
