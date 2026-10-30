import assert from "node:assert/strict";
import { test } from "node:test";
import { handleRequest } from "../../src/index.js";

test("health distinguishes a reachable scaffold from a ready marketplace", async () => {
  const response = await handleRequest(new Request("https://example.test/health"));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    status: "scaffold",
    demo: true,
    marketplaceReady: false,
  });
});

test("integration instructions disclose missing business operations", async () => {
  const response = await handleRequest(new Request("https://example.test/agent.txt"));
  assert.equal(response.status, 200);
  assert.match(await response.text(), /not implemented/i);
});

test("OpenAPI distinguishes available endpoints from planned operations", async () => {
  const response = await handleRequest(new Request("https://example.test/openapi.json"));
  assert.equal(response.status, 200);
  const api = await response.json() as {
    paths: Record<string, Record<string, { "x-implemented": boolean }>>;
  };
  assert.equal(api.paths["/health"]?.get?.["x-implemented"], true);
  assert.equal(api.paths["/v1/participants"]?.post?.["x-implemented"], false);
});

test("transaction endpoints cannot pretend to accept or pay an order", async () => {
  for (const path of ["/v1/participants", "/v1/offers/offer-1/acceptances", "/v1/orders/order-1/settle", "/webhooks/stripe"]) {
    const response = await handleRequest(new Request(`https://example.test${path}`, { method: "POST" }));
    assert.equal(response.status, 501);
    assert.equal((await response.json() as { error: string }).error, "NOT_IMPLEMENTED");
  }
});

test("unknown routes and mutations of read-only routes are rejected", async () => {
  assert.equal((await handleRequest(new Request("https://example.test/unknown"))).status, 404);
  assert.equal((await handleRequest(new Request("https://example.test/health", { method: "POST" }))).status, 405);
});
