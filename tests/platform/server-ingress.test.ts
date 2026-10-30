import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { connect } from "node:net";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { toNodeListener } from "../../src/server-adapter.js";

// Ingress behaviour over real sockets: upload deadline, disconnect before dispatch, cancellation signal.

async function listen(handler: (request: Request) => Promise<Response>, options: { uploadTimeoutMs?: number } = {}, log: (m: string) => void = () => {}) {
  const server = createServer(toNodeListener(handler, log, options));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: (server.address() as AddressInfo).port };
}
const close = (server: Server) => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Sends headers and part of a declared body, then waits. Resolves with the raw response or "no-response". */
function partialUpload(port: number, declared: number, sent: number, waitMs: number): Promise<string> {
  return new Promise((resolve) => {
    const socket = connect(port, "127.0.0.1");
    let data = "";
    socket.on("data", (chunk) => { data += chunk.toString(); });
    socket.on("close", () => resolve(data || "no-response"));
    socket.on("error", () => resolve(data || "no-response"));
    socket.write(`POST /v1/requests HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: ${declared}\r\n\r\n${"x".repeat(sent)}`);
    setTimeout(() => { socket.destroy(); }, waitMs);
  });
}

test("a stalled upload gets 408 within the deadline and never reaches the handler", async () => {
  let called = false;
  const { server, port } = await listen(async () => { called = true; return Response.json({}); }, { uploadTimeoutMs: 200 });
  try {
    const started = Date.now();
    const response = await partialUpload(port, 100, 10, 2000);
    assert.match(response, /^HTTP\/1\.1 408/);
    assert.match(response, /UPLOAD_TIMEOUT/);
    assert.ok(Date.now() - started < 1500, "the deadline, not the client, ended the upload");
    assert.equal(called, false);
  } finally { await close(server); }
});

test("a client that disconnects mid-upload is never dispatched and is not logged as a server failure", async () => {
  let called = false;
  const logs: string[] = [];
  const { server, port } = await listen(async () => { called = true; return Response.json({}); }, { uploadTimeoutMs: 5000 }, (m) => logs.push(m));
  try {
    await partialUpload(port, 100, 10, 100);
    await sleep(200);
    assert.equal(called, false);
    assert.deepEqual(logs.filter((m) => /request failed/.test(m)), []);
  } finally { await close(server); }
});

test("a client that disconnects while its request is handled aborts request.signal", async () => {
  let resolveAborted!: (value: boolean) => void;
  const aborted = new Promise<boolean>((resolve) => { resolveAborted = resolve; });
  const { server, port } = await listen(async (request) => {
    request.signal.addEventListener("abort", () => resolveAborted(true));
    await sleep(1500);
    resolveAborted(request.signal.aborted);
    return Response.json({ late: true });
  });
  try {
    const socket = connect(port, "127.0.0.1");
    socket.write("POST /mcp HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}");
    await sleep(150);
    socket.destroy();
    assert.equal(await aborted, true);
  } finally { await close(server); }
});

test("a complete request still passes through byte-for-byte with the signal not aborted", async () => {
  const { server, port } = await listen(async (request) => Response.json({ body: await request.text(), aborted: request.signal.aborted }), { uploadTimeoutMs: 200 });
  try {
    const body = JSON.stringify({ note: "Zamówienie – krzesła" }, null, 2);
    const response = await fetch(`http://127.0.0.1:${port}/x`, { method: "POST", headers: { "content-type": "application/json" }, body });
    assert.deepEqual(await response.json(), { body, aborted: false });
  } finally { await close(server); }
});
