# Observer log stream

A read-only WebSocket that streams one human-readable log for **every endpoint call** the backend handles, so an observer page can show what the agents are doing as it happens. Owner: platform. Code: [observer.ts](../src/platform/observer.ts), [observer-socket.ts](../src/platform/observer-socket.ts).

Logs are an **execution trace**, not authoritative state. A page must still read order and payment status from the backend before showing a result as agreed or paid.

## Connecting

```
GET /observer/ws   (WebSocket upgrade, same host and port as the API)
```

The token goes in the subprotocol list, because browsers cannot set headers on a WebSocket and URLs end up in request logs:

```js
const ws = new WebSocket("wss://<host>/observer/ws", ["marketplace-observer.v1", `bearer.${observerToken}`]);
ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.type === "log") show(message);
};
```

| Server setting | Who may connect |
| --- | --- |
| `OBSERVER_TOKEN` set | Clients presenting exactly that token. Anything else gets `401` before the upgrade. |
| `OBSERVER_TOKEN` unset | Only direct loopback connections (local rehearsal). Behind Cloud Run this admits nobody, because every connection arrives through a proxy. |

`OBSERVER_TOKEN` is a read-only operator secret. Keep it in the host's secret manager. Never give it to a bot: the stream shows both sides' offers and refusals, which a negotiating agent must not see. Never reuse a bot or operator token as the observer token.

Other refusals before the upgrade: `404` for any other path, `503` when 50 clients are already connected.

The stream is one-way. Anything a client sends is ignored, and a frame over 1 KiB closes the connection with code `1009`. The server pings every 30 seconds and drops clients that stop answering.

## Message kinds

Every message is one JSON object with a `type` and a version `v` (currently `1`).

### `hello`

Sent once, immediately after connecting.

| Field | Type | Meaning |
| --- | --- | --- |
| `type` | `"hello"` | |
| `v` | `1` | |
| `serverTime` | ISO 8601 | The server's clock when you connected. |
| `instanceId` | string | Random id of the server process. A new value after reconnecting means a different or restarted instance. |
| `backlog` | `log[]` | Up to the last 200 logs from this instance, oldest first, each with its **original** timestamp. These are earlier calls, not new activity: label them as history. |
| `note` | string | A reminder of the two caveats above. |

### `log`

One per endpoint call, sent when the call finishes.

| Field | Type | Meaning |
| --- | --- | --- |
| `type` | `"log"` | |
| `v` | `1` | |
| `id` | UUID | Unique id of this log. |
| `seq` | integer | Increases by one per log on this instance. A gap means you missed messages. |
| `at` | ISO 8601 | When the call finished. |
| `requestId` | UUID | Correlation id of this call. |
| `parentRequestId` | UUID, optional | Present when an MCP tool call caused this call: the `requestId` of that `/mcp` log. |
| `source` | `"http"` \| `"mcp"` \| `"stripe"` \| `"system"` | `http`: a direct API call. `mcp`: a call made by an MCP tool on a bot's behalf. `stripe`: a Stripe webhook. `system`: health, docs and unknown routes. |
| `level` | `"debug"` \| `"info"` \| `"warn"` \| `"error"` | `debug`: reads and polls (a supplier bot polls events every few seconds, so filter these by default). `info`: actions that change state. `warn`: refused (4xx). `error`: failed (5xx). |
| `operation` | string | What was called. See the table below. |
| `method` | string | HTTP method. |
| `route` | string | Route pattern with placeholders, e.g. `/v1/requests/{requestId}/offers`. Unknown paths show as `(unknown)` or `/v1/…`, never verbatim. |
| `status` | integer | HTTP status returned. |
| `outcome` | `"ok"` \| `"refused"` \| `"error"` | `ok` below 400, `refused` for 4xx, `error` for 5xx. |
| `code` | string, optional | The error code for refused or failed calls, e.g. `POLICY_REFUSAL`, `REQUEST_CLOSED`, `INVALID_CREDENTIAL`. |
| `durationMs` | integer | How long the call took. |
| `actor` | object, optional | The authenticated caller: `{ participantId, role }`, with `role` either `"buyer"` or `"supplier"`. Absent for public routes, Stripe, and failed authentication. |
| `subject` | object, optional | Ids the call concerns. Any of `requestId`, `offerId`, `orderId`, `discoveryId`, `counterpartyId`, and `tool` (the MCP tool name). |
| `message` | string | One plain-English sentence, e.g. `Supplier alpha made an offer on request 7f…: 10 box for €150.00, delivery 2026-11-20 (offer 3c…).` |

Example:

```json
{
  "type": "log", "v": 1, "id": "6c1…", "seq": 42, "at": "2026-10-30T15:20:11.402Z",
  "requestId": "a91…", "parentRequestId": "5d0…", "source": "mcp", "level": "info",
  "operation": "accept_offer", "method": "POST", "route": "/v1/offers/{offerId}/acceptances",
  "status": 200, "outcome": "ok", "durationMs": 37,
  "actor": { "participantId": "buyer-demo", "role": "buyer" },
  "subject": { "offerId": "3c2…", "orderId": "e48…" },
  "message": "Buyer buyer-demo accepted offer 3c2…. Both sides agreed: order e48… for €150.00."
}
```

### `dropped`

Sent before the next `log` when your client fell behind (over 1 MiB unsent) and messages were skipped.

| Field | Type | Meaning |
| --- | --- | --- |
| `type` | `"dropped"` | |
| `v` | `1` | |
| `at` | ISO 8601 | When sending resumed. |
| `count` | integer | How many logs you missed. Re-read authoritative state rather than guessing what happened. |

## Operations

| `operation` | Endpoint | Level |
| --- | --- | --- |
| `get_my_participant` | `GET /v1/me` | debug |
| `register_participant` | `POST /v1/participants` | info |
| `list_events` | `GET /v1/events` | debug |
| `search_buyer_notices` | `POST /v1/sources/buyer-notices/search` | debug |
| `create_request` | `POST /v1/requests` | info |
| `get_request` | `GET /v1/requests/{requestId}` | debug |
| `start_discovery` | `POST /v1/requests/{requestId}/discover` | info |
| `get_discovery` | `GET /v1/discoveries/{discoveryId}` | debug |
| `get_discovery_evidence` | `GET /v1/discoveries/{discoveryId}/evidence` | debug |
| `read_discovery_source` | `GET /v1/discoveries/{discoveryId}/sources/{sourceId}` | debug |
| `submit_discovery_assessment` | `POST /v1/discoveries/{discoveryId}/assessments` | info |
| `resolve_discovery_participants` | `POST /v1/discoveries/{discoveryId}/resolve` | info |
| `request_quote` | `POST /v1/requests/{requestId}/quote-requests` | info |
| `submit_offer` | `POST /v1/requests/{requestId}/offers` | info |
| `get_offer` | `GET /v1/offers/{offerId}` | debug |
| `accept_offer` | `POST /v1/offers/{offerId}/acceptances` | info |
| `settle_order` | `POST /v1/orders/{orderId}/settle` | info |
| `get_order` | `GET /v1/orders/{orderId}` | debug |
| `mcp` | `POST /mcp` (the tool name is in `subject.tool`) | info |
| `stripe_webhook` | `POST /webhooks/stripe` | info |
| `observer_list_runs` | `GET /v1/observer/runs` (the observer page) | debug |
| `observer_get_run` | `GET /v1/observer/runs/{runId}` (the observer page) | debug |
| `observer_preflight` | `OPTIONS /v1/observer/…` (CORS preflight) | debug |
| `health`, `agent_instructions`, `openapi` | `GET /health`, `/agent.txt` or `/llms.txt`, `/openapi.json` | debug |
| `unknown_route` | anything else | warn |

A bot using MCP produces two logs per tool call: the inner operation (`source: "mcp"`), then the `mcp` call itself, linked by `parentRequestId`. Show the inner one, and use the outer one to prove which tool the client called.

Refused and failed calls of every operation read `<who> tried to <operation> and was refused: <code>.` (or `and failed:` for 5xx).

## What is never in a log

Messages are built from an explicit allowlist of fields per operation, never by copying request or response bodies.

- **Never included:** private mandate limits (buyer ceilings, supplier floor, capacity, earliest delivery), a request's budget (`maximumDeliveredTotal`), registration mandates, bearer or observer tokens, headers, idempotency keys, Stripe keys, webhook secrets, customer and payment method ids.
- **Included:** participant ids and roles, request quantities, units, categories, destinations and deadlines, offer terms (quantity, delivered total, delivery date), order totals, payment status and the sandbox receipt id (`pi_…`), public search queries and counts, error codes.

A refused offer's code is visible, but a log never says which private limit refused it.

## Limits

- **Per instance.** Each server instance only streams the calls it handled itself (`MVP_LIMIT`). For the demo, run Cloud Run with `--max-instances=1`. The upgrade path is Postgres `LISTEN/NOTIFY` between instances.
- **Not stored.** The 200-log backlog lives in memory and is lost on restart or scale-down. Nothing here replaces the database.
- **Reconnect.** Cloud Run closes long-lived connections at the service's request timeout (default 5 minutes, at most 60). Reconnect with backoff, and use `seq` and `instanceId` to spot gaps.
