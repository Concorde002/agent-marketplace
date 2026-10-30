# Bot sandbox: test the real bots before the backend exists

Owner: teammate 2. This proves that real bot clients can register, negotiate, settle and report
through the agent workstream's code. It runs against the local **test double**: canned discovery
candidates and a simulated sandbox payment. It is not live sourcing, not the hosted platform, and
not Stripe.

## Start it

```sh
npm ci --ignore-scripts
npm run build
node dist/tests/agents/support/sandbox.js
```

Requires `cloudflared` (`brew install cloudflared`) for the public HTTPS URL. With
`SANDBOX_TUNNEL=off` it serves only `http://127.0.0.1:8790`, which is enough for local MCP clients.

It prints:

- the MCP URL,
- a buyer token and a supplier token,
- a probe link for checking what a bot can do,
- the path of `BOT-KIT.md`, which has copy-paste instructions for each bot.

Keep it running. The console shows every tool call and every chat message, never a token.

Each start creates new tokens and, with a quick tunnel, a new URL. To keep the bots configured
across restarts, set `SANDBOX_BUYER_TOKEN` and `SANDBOX_SUPPLIER_TOKEN`. The URL still changes;
use a named Cloudflare tunnel if that matters.

## What runs inside

| Piece | Code | Role |
| --- | --- | --- |
| Test double backend | `tests/agents/support/fake-platform.ts` | Stands in for teammate 1's API |
| Runtime host | `src/agents/host.ts` | Runs the deterministic buyer runtime per purchase and the always-on supplier listener, both keyed by bearer token |
| MCP endpoint | `src/mcp/*` | `start_purchase`, `purchase_status`, `supplier_status`, plus the low-level tools |
| Sheet bridge (optional) | `src/agents/bridge.ts`, `src/agents/sheets.ts` | Lets Instinct act through a Google Sheet |

The supplier's software is always on. Its human, and its bot, can stay idle. The bot only relays
completion messages, which always start with `agreed and sandbox-paid`, `no match` or
`payment failed`.

## Settings (environment, all optional)

| Variable | Default | Meaning |
| --- | --- | --- |
| `SANDBOX_PORT` | 8790 | Local port |
| `SANDBOX_TUNNEL` | on | `off` disables cloudflared |
| `SANDBOX_STATE_DIR` | temp dir | Where state and `BOT-KIT.md` go |
| `SANDBOX_BUYER_TOKEN`, `SANDBOX_SUPPLIER_TOKEN` | random | Reuse tokens across restarts |
| `BUYER_COMPANY_NAME`, `BUYER_COMPANY_DOMAIN` | demo values | Buyer identity |
| `SUPPLIER_COMPANY_NAME`, `SUPPLIER_COMPANY_DOMAIN` | demo values | Supplier identity |
| `BUYER_GRANT_MAX` | 10000 | Operator ceiling per purchase (major units) |
| `SUPPLIER_MIN_TOTAL` | 4400 | Supplier's private floor (major units) |
| `SUPPLIER_QUANTITY`, `SUPPLIER_LEAD_DAYS` | 60, 5 | Capacity and earliest delivery |
| `NEGOTIATION_DEADLINE_MS` | 120000 | How long the buyer waits before `no match` |
| `PAYMENT_WAIT_MS` | 60000 | How long a pending payment is awaited |
| `INSTINCT_SHEET_ID`, `GOOGLE_SERVICE_ACCOUNT_FILE`, `INSTINCT_ROLE` | unset | Enable the Instinct sheet bridge |

## Expected results

| Test | Buyer chat | Supplier chat |
| --- | --- | --- |
| Budget above the floor (e.g. 5060 EUR) | `agreed and sandbox-paid — order …; total 4598.00 EUR; document …; payment …` | the same line |
| Budget below the floor (e.g. 3080 EUR) | `no match — deadline_exceeded…`, after the deadline | `no match — buyer_budget_below_minimum`, at once |

Negotiation trace for the first test:
1. The supplier asks 4840.00.
2. The buyer opens 10% lower, at 4356.00.
3. The supplier meets halfway, at 4598.00.
4. The buyer accepts, and pays in sandbox.

## Known limits

- The buyer learns of a supplier refusal only at its deadline. The contract has no decline event;
  this is requested from the platform owner.
- Candidate-to-supplier mapping is injected by the host (`MVP_LIMIT`). The contract has no resolve
  call yet.
- Instinct only sees new results when it next reads the sheet. Disclose this as polling.
- Grok Bot quick-tunnel URLs change on every restart.
