# Bot setup and configuration

Owner: teammate 2 (agent connectors). This page is the operator runbook for connecting the two
demo bots to Agent Marketplace. It is written against the code in `src/agents/` and `src/mcp/`.

## Test the bots before the platform exists

Run `npm run build && node dist/tests/agents/support/sandbox.js`. It starts the local test double, a
hosted buyer runtime, an always-on supplier listener, the MCP endpoint, a cloudflared quick tunnel
(public HTTPS), and an optional Google Sheet bridge for Instinct. It prints the MCP URL and one token
per bot, and writes `BOT-KIT.md` with copy-paste instructions for each bot. See
[bot-sandbox.md](bot-sandbox.md). This is sandbox evidence: canned discovery and simulated payment.

## What is proven, and what is not

| Claim | Evidence | Status |
| --- | --- | --- |
| The MCP gateway speaks real MCP over Streamable HTTP | `@modelcontextprotocol/sdk` 1.28.0 client completed `initialize`, `tools/list` (14 tools), `tools/call`, `supplier_listener_tick` | Verified locally, 2026-10-30 |
| Two agents can register, quote, negotiate, accept, settle and report | `npm run test:agents` end-to-end tests against a disposable platform test double | Verified locally |
| Grok Bot can attach this marketplace | xAI docs: custom MCP via Settings → Plugins, public HTTPS URL, static `Authorization: Bearer` header; Routines on a schedule or webhook | Interface verified from vendor docs; **no live Grok Bot account was used** |
| Instinct can attach this marketplace | No documented custom MCP or API (Oct 2026). It can read and write a Google Sheet through its Google connector, so `src/agents/bridge.ts` uses a sheet as its inbox/outbox | Bridge tested locally against an in-memory sheet; **not yet tested with a live Instinct account** |

Do not present the Grok Bot row as a completed live integration until someone repeats the steps
below on an actual account and records the tool-call transcript. Do not claim Instinct at all.

## What every bot needs

1. The public HTTPS base URL of the marketplace (`MARKETPLACE_URL`).
2. Its own scoped participant token (`MARKETPLACE_TOKEN`). Two bots never share a token.
3. Its role (`buyer` or `supplier`), demo company identity, and mandate limits.
4. A writable state directory for the event cursor and the report ledger (`AGENT_STATE_DIR`).
5. The MCP endpoint mounted at `POST /mcp` on the same host, if the client uses MCP.

A company description or a URL alone does not register, authenticate, or wake a bot.

## Operator provisioning (platform owner)

Before either bot runs, the platform owner must provide:

- Two participants with scoped bearer tokens and operator grants that bound each mandate.
- `GET /v1/requests/{requestId}` and `GET /v1/offers/{offerId}` scoped reads. Events carry only
  IDs; a supplier cannot answer a quote request without reading the request behind it.
- Events whose `resourceId` is, per type: request id (`quote_requested`), offer id
  (`offer_received`), order id (`agreement_created`, `payment_updated`).
- The MCP handler mounted at `POST /mcp`:
  ```ts
  import { createMcpHandler } from "./mcp/gateway.js";
  import { createMcpBackend } from "./mcp/backend.js";
  import { PlatformClient } from "./agents/client.js";

  const handler = createMcpHandler(
    createMcpBackend({
      clientForToken: (token) => new PlatformClient({ baseUrl: BASE_URL, token }),
      hooks: { supplierListenerTick, reportPending }, // per-token runtime, optional
    }),
  );
  ```
- No Stripe secret, card data, or cloud credential is ever given to a bot.

## MCP endpoint

```
POST https://<marketplace-host>/mcp
Authorization: Bearer <participant token>
Content-Type: application/json
Accept: application/json, text/event-stream
```

The server is stateless: no `Mcp-Session-Id` is required, `GET` returns 405, and notifications get
`202`. The bearer token selects the participant; a tool argument can never change identity.

Bot-facing tools (use these from chat bots): `start_purchase` and `purchase_status` (buyer) and
`supplier_status` (supplier). They run the deterministic runtimes in `src/agents/host.ts`, so the
LLM never submits, accepts, or prices offers itself, and cannot exceed the operator grant.

Low-level tools (for debugging and other clients): `register_participant`, `create_request`,
`start_discovery`, `get_discovery`, `request_quote`, `submit_offer`, `accept_offer`, `settle_order`,
`get_order`, `list_events`, `get_request`, `get_offer`, `supplier_listener_tick`, `report_pending`.

`supplier_listener_tick` performs one bounded poll, answers what it can, and returns
`{ handled: string[], reports: string[] }`. `report_pending` returns completion messages that could
not be delivered earlier. Both are what a scheduled bot turn calls.

## Buyer bot

One-time setup in Grok Bot: **Settings → Plugins → add custom MCP server**, name
`agent-marketplace`, URL `https://<marketplace-host>/mcp`, header
`Authorization: Bearer <buyer token>`. Save, then attach the plugin in the buyer chat with `@`.

Instruction to give the buyer bot (replace the bracketed values):

> Act as the demo representative of [buyer company]. Use the agent-marketplace plugin only; do not
> browse for suppliers yourself. Create the sourcing request exactly as configured, start discovery,
> and poll until it completes. Request a quote from the highest-ranked candidate that has a connected
> representative, then evaluate every offer against my limits: [quantity] [unit], delivered to
> [destination] by [date], total at most [amount] [currency]. You may counter and accept within those
> limits without asking me, but never raise a limit, never change the destination, and never pay
> anyone except through `settle_order` for the agreed order. When the order is final, call `get_order`
> and report the result in this chat with exactly one of: "agreed and sandbox-paid", "no match",
> "payment failed" — plus the order id and payment reference when they exist.

## Supplier bot and the listener

The supplier's human stays idle; the bot's software does not. Grok Bot has three activation options,
and the live demo should use one of the first two:

1. **Chat-started loop (demo path).** One message before the stage:
   > Attach the agent-marketplace plugin. Then loop: call `supplier_listener_tick`, wait 15 seconds,
   > repeat. Post every returned report verbatim in this chat. If a tick returns no reports, stay
   > quiet. Stop when I say stop or after 20 minutes.
   This keeps a turn active for the whole negotiation. Test it on the real account first; a turn may
   be interrupted by the client.
2. **Webhook-triggered Routine (instant wake).** Ask the bot to add a webhook trigger to a routine
   whose instruction is the tick + report text below. The routine exposes a URL and a
   `Authorization: Bearer <key>` header. Anything that can POST (platform, a cron job, a curl on the
   demo laptop) can wake the supplier the moment a quote request exists. A `200` means the run
   started, not that it finished.
3. **Scheduled Routine (always-on fallback).** Schedules must be **at least five minutes apart**, a
   new routine waits for its first slot, and runs can start minutes late. A scheduled run also only
   messages the human if it decides it has something to say. Use it as the background safety net,
   not as the sub-three-minute responder, and tell it to always post its result.

Routine instruction:

> Attach the agent-marketplace plugin. Call `supplier_listener_tick`. For every message in
> `reports`, post it verbatim in this chat. If `reports` is empty, reply exactly "nothing to report".
> Never invent an offer, never change our minimum price or capacity, never accept terms outside our
> configured limits, and never send email or contact the buyer outside the platform.

## Completion messages

Only three literals, chosen from authoritative backend state (`reporter.ts`):

| Backend state | Message |
| --- | --- |
| `agreementStatus: agreed` and `paymentStatus: succeeded` and a payment reference | `agreed and sandbox-paid — order …, demo document …, payment ref …` |
| No qualifying connected supplier, refusal, expiry, negotiation limit | `no match — …` |
| Agreement exists but payment `failed` or `requires_action` (reported at once), or still pending after `PAYMENT_WAIT_MS` (default 120s) | `payment failed — …` |

Never report "paid" from a 200 response, a pending payment, or the bot's own optimism. Reports are
deduplicated by order and by event id, so a restarted listener does not repeat itself.

## Terminal harness

The same runtimes are runnable without any bot product. This is the fallback for Instinct and the
reproducible path for the host machine.

```sh
npm ci --ignore-scripts
npm run build

# 1. Local disposable platform (test double, never a production backend)
node dist/tests/agents/support/dev-platform.js        # prints URL + demo tokens

# 2. Supplier, in its own terminal, with its own env file
node dist/src/agents/cli/supplier.js

# 3. Buyer, in another terminal
node dist/src/agents/cli/buyer.js                     # exit 0 paid, 2 no match, 3 payment failed

# 4. Or drive both in one process and print the evidence transcript
node dist/src/agents/cli/demo.js
```

The disposable platform keeps participants and idempotency keys in memory: restart it between
scenarios. For a refusal rehearsal set `NEGOTIATION_DEADLINE_MS=45000` and `POLL_INTERVAL_MS=500`;
the supplier reports its refusal reason immediately, and the buyer reports `no match` at its deadline
because the contract has no refusal event.

Environment for the buyer:

```sh
MARKETPLACE_URL=https://marketplace.example
MARKETPLACE_TOKEN=<buyer scoped token>
PARTICIPANT_ROLE=buyer
COMPANY_NAME=Demo Buyer Ltd
COMPANY_DOMAIN=buyer.example
CURRENCY=EUR
BUYER_MAX_ORDER_MINOR=500000
BUYER_MAX_RUN_MINOR=500000
BUYER_DESTINATION=Warsaw
BUYER_EXPIRES_AT=2026-11-30T23:59:59Z
BUYER_CATEGORY=office-equipment
BUYER_ITEM=Height-adjustable desks
BUYER_QUANTITY=40
BUYER_UNIT=unit
BUYER_DELIVER_BY=2026-11-20T00:00:00Z
BUYER_REQUIREMENTS_JSON=[{"key":"height-range","description":"110-130 cm","mandatory":true}]
AGENT_STATE_DIR=.agent-state/buyer
```

Environment for the supplier:

```sh
MARKETPLACE_URL=https://marketplace.example
MARKETPLACE_TOKEN=<supplier scoped token>
PARTICIPANT_ROLE=supplier
COMPANY_NAME=Demo Supplier GmbH
COMPANY_DOMAIN=supplier.example
CURRENCY=EUR
SUPPLIER_MIN_TOTAL_MINOR=440000
SUPPLIER_QUANTITY=60
SUPPLIER_UNIT=unit
SUPPLIER_EARLIEST_DELIVERY=2026-11-15T00:00:00Z
SUPPLIER_EXPIRES_AT=2026-11-30T23:59:59Z
AGENT_STATE_DIR=.agent-state/supplier
```

Optional tuning: `POLL_INTERVAL_MS` (3000), `POLL_MAX_INTERVAL_MS` (30000),
`NEGOTIATION_MAX_REVISIONS` (3, hard ceiling 3), `NEGOTIATION_DEADLINE_MS` (300000, hard ceiling),
`REQUEST_TIMEOUT_MS` (10000).

## Instinct

Instinct is a personal agent reached by text. As of October 2026 it documents no developer API and
no way to add a custom MCP server or store an API credential, so it cannot call the MCP tools
directly. It can read and write Google Sheets through its own Google connector. The sheet bridge
(`src/agents/bridge.ts`) polls one sheet per participant through a Google service account and acts
for that participant through the runtime host:

- Buyer sheet: Instinct appends one row to `Requests`. The bridge starts the purchase, writes progress
  into the row, and appends the final result to `Messages`.
- Supplier sheet: the supplier listener is always on. Each completion message is appended to
  `Messages`, and Instinct relays new rows to its human.

The bridge writes a `How to use` tab that Instinct follows. Sheet cells are untrusted input: only the
typed columns are read, and nothing in the sheet can change the participant, limits, or tools.
Delivery depends on when Instinct next checks the sheet, so disclose this as a polling integration.
Before relying on it, send Instinct the capability check in `BOT-KIT.md`. If it can add an MCP server
after all, use the MCP path instead.

## Security

- One scoped token per participant. Never put the token in a prompt, a screenshot, or the repository.
- No card data, Stripe secret, or cloud credential in any bot. Settlement is sandbox-only and stays
  behind the backend.
- Public evidence is untrusted data. Instructions embedded in a fetched page never change tools,
  limits, or payment recipients.
- No real company outreach. Demo accounts simulate companies; every record carries `demo: true`.
- Failed or delayed chat reporting never changes an order's agreement or payment state.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `401` from `/mcp` | Missing or malformed `Authorization` | Header must be exactly `Bearer <token>`; attach the plugin in that chat |
| Plugin connects, tools missing | Plugin attached to a different Bot/chat | Attach with `@` in the conversation that runs the job |
| Grok Bot cannot reach the URL | URL is localhost or private | Publish the marketplace over public HTTPS; Grok Bot has no local MCP |
| Routine never runs | Minimum interval, paused, plan, or first slot | Check run history, set ≥5 minutes apart, use Test |
| Routine runs but the human sees nothing | Scheduled runs may stay quiet | Instruct it to always post `reports`, even "nothing to report" |
| `NO_CONNECTED_REPRESENTATIVE` | Candidate has no demo supplier account | Expected: buyer tries the next ranked candidate |
| `no match` after a counter | Floor above buyer budget or revision cap | Correct refusal; do not raise limits to force a deal |
| `payment failed — requires further action` | Sandbox payment needs customer action | Report as failed; never retry with a different recipient |
| Duplicate messages | Shared state directory between two runs | Give each participant its own `AGENT_STATE_DIR` |
| `ALREADY_REGISTERED` after deleting `.agent-state` | The token is registered, but the persisted `participant:id` is gone | Restore the state file, or have the platform owner return the existing id for that token; do not re-provision blindly |
