import assert from "node:assert/strict";
import { test } from "node:test";
import type { Database } from "../../src/platform/database.js";
import { ObserverBus, type ObserverLog } from "../../src/platform/observer.js";
import { announceMcpClient, createObserverPlatform } from "./support/observer-platform.js";

// The read-only observer API (#18) running alongside the /observer/ws stream (#19). Disposable PGlite only.
const limit = { timeout: 15_000 };
const isObserverWrite = (sql: string) => /marketplace\.(agent_traces|client_sightings)/.test(sql);

test("a stalled trace write cannot hold a bot's response", limit, async () => {
  // Tracing is best-effort bookkeeping; a stuck write must not delay or block the bot's actual answer.
  const platform = await createObserverPlatform({ wrapDb: (db): Database => ({
    query: (sql, params) => (isObserverWrite(sql) ? new Promise(() => {}) : db.query(sql, params)),
    transaction: (action) => db.transaction(action),
  }) });
  try {
    const started = Date.now();
    const response = await fetch(`${platform.url}/v1/offers/missing-offer`, {
      headers: { authorization: `Bearer ${platform.tokens.buyer}` }, signal: AbortSignal.timeout(3000),
    });
    assert.equal(response.status, 404);
    assert.ok(Date.now() - started < 1500, `answered after ${Date.now() - started} ms`);
  } finally { await platform.close(); }
});

test("polling does not rewrite the client sighting on every call", limit, async () => {
  let sightingWrites = 0;
  const platform = await createObserverPlatform({ wrapDb: (db): Database => ({
    query: (sql, params) => { if (/marketplace\.client_sightings/.test(sql)) sightingWrites++; return db.query(sql, params); },
    transaction: (action) => db.transaction(action),
  }) });
  try {
    for (let i = 0; i < 5; i++) {
      await fetch(`${platform.url}/v1/events?after=0`, { headers: { authorization: `Bearer ${platform.tokens.supplier}`, "user-agent": "fixture-bot/1.0" } });
    }
    assert.equal(sightingWrites, 1, "one write for an unchanged HTTP client within the refresh window");
    sightingWrites = 0;
    await announceMcpClient(platform, platform.tokens.buyer, "fixture-mcp-client", "2.0.0");
    for (let i = 0; i < 5; i++) {
      await fetch(`${platform.url}/mcp`, { method: "POST", headers: { authorization: `Bearer ${platform.tokens.buyer}`, "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: i + 10, method: "tools/list" }) });
    }
    assert.equal(sightingWrites, 1, "initialize records the client; follow-up MCP calls in the window add no writes");
    // A changed client is recorded immediately, not after the window.
    await announceMcpClient(platform, platform.tokens.buyer, "fixture-mcp-client", "2.1.0");
    assert.equal(sightingWrites, 2);
    const row = (await platform.db.query<{ client_version: string }>("select client_version from marketplace.client_sightings where participant_id='buyer' and channel='mcp'")).rows[0];
    assert.equal(row?.client_version, "2.1.0");
  } finally { await platform.close(); }
});

test("the observer page's own requests are named in the stream and never carry its key", limit, async () => {
  const bus = new ObserverBus();
  const logs: ObserverLog[] = [];
  bus.subscribe((l) => logs.push(l));
  const platform = await createObserverPlatform({ observer: bus });
  try {
    const runs = await fetch(`${platform.url}/v1/observer/runs`, { headers: { authorization: `Bearer ${platform.tokens.observer}` } });
    assert.equal(runs.status, 200);
    await fetch(`${platform.url}/v1/observer/runs/some-run`, { headers: { authorization: `Bearer ${platform.tokens.observer}` } });
    await fetch(`${platform.url}/v1/observer/runs`, { headers: { authorization: "Bearer obs_not-a-real-observer-key-0000" } });
    assert.deepEqual(logs.map((l) => [l.operation, l.status, l.level]), [
      ["observer_list_runs", 200, "debug"], ["observer_get_run", 404, "warn"], ["observer_list_runs", 401, "warn"]]);
    assert.equal(logs[0]?.message, "The observer page listed runs.");
    assert.equal(logs[1]?.subject?.requestId, "some-run");
    assert.equal(logs[2]?.message, "The observer page tried to list runs and was refused: INVALID_OBSERVER_SESSION.");
    const all = JSON.stringify(logs);
    assert.equal(all.includes(platform.tokens.observer), false);
    assert.equal(all.includes("obs_not-a-real"), false);
  } finally { await platform.close(); }
});
