import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import type { ObserverBus, ObserverLog } from "./observer.js";

export const OBSERVER_PATH = "/observer/ws";
/** Browsers cannot set headers on a WebSocket; the token travels as a second subprotocol, never in the URL. */
export const OBSERVER_PROTOCOL = "marketplace-observer.v1";
const TOKEN_PREFIX = "bearer.";

export interface ObserverSocketOptions {
  /** Read-only observer token. Without one, only loopback connections are accepted (local rehearsal). */
  token?: string | undefined;
  maxClients?: number;
  /** Skip messages for a client whose unsent buffer exceeds this, then tell it how many it missed. */
  maxBufferedBytes?: number;
  heartbeatMs?: number;
}

/** Sent once on connect. */
export interface ObserverHello {
  type: "hello";
  v: 1;
  serverTime: string;
  instanceId: string;
  /** Earlier logs from this server instance, oldest first, each with its original timestamp. */
  backlog: ObserverLog[];
  note: string;
}

/** Sent before the next log when a slow client had messages skipped. */
export interface ObserverDropped { type: "dropped"; v: 1; at: string; count: number }

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const digest = (value: string) => createHash("sha256").update(value, "utf8").digest();

function reject(socket: Duplex, status: 401 | 403 | 404 | 503, reason: string) {
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

function offeredToken(req: IncomingMessage): string | undefined {
  const offered = (req.headers["sec-websocket-protocol"] ?? "").split(",").map((p) => p.trim());
  return offered.find((p) => p.startsWith(TOKEN_PREFIX))?.slice(TOKEN_PREFIX.length);
}

function authorised(req: IncomingMessage, token: string | undefined): boolean {
  if (!token) {
    // Behind Cloud Run every connection arrives through a proxy, so this never admits remote clients.
    return LOOPBACK.has(req.socket.remoteAddress ?? "") && req.headers["x-forwarded-for"] === undefined;
  }
  const presented = offeredToken(req);
  return presented !== undefined && timingSafeEqual(digest(presented), digest(token));
}

/** Streams every observer log to authorised WebSocket clients on `GET /observer/ws`. Clients cannot send commands. */
export function attachObserverSocket(server: Server, bus: ObserverBus, options: ObserverSocketOptions = {}) {
  const maxClients = options.maxClients ?? 50;
  const maxBuffered = options.maxBufferedBytes ?? 1024 * 1024;
  const instanceId = crypto.randomUUID();
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 1024,
    // Echo only the public protocol name; never the token.
    handleProtocols: (protocols) => (protocols.has(OBSERVER_PROTOCOL) ? OBSERVER_PROTOCOL : false),
  });
  const alive = new WeakSet<WebSocket>();

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    if (path !== OBSERVER_PATH) return reject(socket, 404, "Not Found");
    if (!authorised(req, options.token)) return reject(socket, 401, "Unauthorized");
    if (wss.clients.size >= maxClients) return reject(socket, 503, "Service Unavailable");
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws));
  });

  wss.on("connection", (ws: WebSocket) => {
    alive.add(ws);
    let dropped = 0;
    const hello: ObserverHello = {
      type: "hello", v: 1, serverTime: new Date().toISOString(), instanceId, backlog: bus.recent(),
      note: "Backlog entries are earlier calls on this instance, not new activity. Logs are an execution trace, not authoritative order state.",
    };
    ws.send(JSON.stringify(hello));
    const unsubscribe = bus.subscribe((log) => {
      if (ws.readyState !== ws.OPEN) return;
      if (ws.bufferedAmount > maxBuffered) { dropped++; return; }
      if (dropped) {
        const notice: ObserverDropped = { type: "dropped", v: 1, at: new Date().toISOString(), count: dropped };
        ws.send(JSON.stringify(notice));
        dropped = 0;
      }
      ws.send(JSON.stringify(log));
    });
    ws.on("pong", () => alive.add(ws));
    // Read-only stream: anything a client sends is ignored. Oversized frames close it (maxPayload).
    ws.on("message", () => {});
    ws.on("close", unsubscribe);
    ws.on("error", unsubscribe);
  });

  // Keeps idle connections open through proxies and removes clients that stopped answering.
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!alive.has(ws)) { ws.terminate(); continue; }
      alive.delete(ws);
      ws.ping();
    }
  }, options.heartbeatMs ?? 30_000);
  heartbeat.unref();

  return {
    get clients() { return wss.clients.size; },
    close: () => new Promise<void>((resolve) => {
      clearInterval(heartbeat);
      for (const ws of wss.clients) ws.close(1001, "server shutting down");
      wss.close(() => resolve());
    }),
  };
}
