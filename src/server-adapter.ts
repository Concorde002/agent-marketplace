import type { IncomingMessage, ServerResponse } from "node:http";
import { redactSecrets } from "./payments/stripe.js";

// MVP_LIMIT: 1 MiB covers Stripe events and API payloads; larger bodies are refused before parsing.
export const MAX_BODY_BYTES = 1024 * 1024;
/** Whole-upload deadline. Matches the JSON handler's own 5 s budget, which only starts after buffering. */
export const UPLOAD_TIMEOUT_MS = 5000;

class BodyTooLarge extends Error {}
class UploadTimeout extends Error {}
/** The client went away before its request was complete; there is no one to answer. */
class ClientGone extends Error {}

function readBody(req: IncomingMessage, timeoutMs: number): Promise<Buffer> {
  const declared = Number(req.headers["content-length"] ?? 0);
  if (declared > MAX_BODY_BYTES) return Promise.reject(new BodyTooLarge());
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const finish = (error?: Error) => {
      clearTimeout(timer);
      req.off("data", onData).off("end", onEnd).off("error", onGone).off("close", onClose);
      if (error) { req.pause(); reject(error); } else resolve(Buffer.concat(chunks));
    };
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) finish(new BodyTooLarge());
      else chunks.push(chunk);
    };
    const onEnd = () => finish();
    const onGone = () => finish(new ClientGone());
    const onClose = () => { if (!req.complete) finish(new ClientGone()); };
    const timer = setTimeout(() => finish(new UploadTimeout()), timeoutMs);
    req.on("data", onData).on("end", onEnd).on("error", onGone).on("close", onClose);
  });
}

/**
 * Adapts a Web Fetch handler to node:http. The body is passed through byte-for-byte:
 * Stripe's webhook signature covers the exact raw payload. `request.signal` aborts when the
 * client disconnects before the response is sent, so long-running work can stop early;
 * committed database work is unaffected and stays idempotent for the client's retry.
 */
export function toNodeListener(
  handler: (request: Request) => Promise<Response>,
  log: (message: string) => void = console.error,
  options: { uploadTimeoutMs?: number } = {},
) {
  const uploadTimeoutMs = options.uploadTimeoutMs ?? UPLOAD_TIMEOUT_MS;
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const disconnected = new AbortController();
    res.on("close", () => { if (!res.writableFinished) disconnected.abort(); });
    let response: Response;
    try {
      const body = req.method === "GET" || req.method === "HEAD" ? undefined : await readBody(req, uploadTimeoutMs);
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) {
        if (Array.isArray(value)) value.forEach((v) => headers.append(name, v));
        else if (value !== undefined) headers.set(name, value);
      }
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      const method = req.method ?? "GET";
      const signal = disconnected.signal;
      response = await handler(new Request(url, body === undefined ? { method, headers, signal } : { method, headers, signal, body: new Uint8Array(body) }));
    } catch (error) {
      if (error instanceof ClientGone) return;
      if (error instanceof BodyTooLarge) {
        response = Response.json({ error: "PAYLOAD_TOO_LARGE" }, { status: 413 });
      } else if (error instanceof UploadTimeout) {
        // The rest of the body is never read, so the connection cannot be reused.
        res.setHeader("connection", "close");
        response = Response.json({ error: "UPLOAD_TIMEOUT" }, { status: 408 });
      } else {
        // A 5xx makes Stripe retry later; the event is only recorded after it was applied.
        log(`request failed: ${redactSecrets(error instanceof Error ? error.message : String(error))}`);
        response = Response.json({ error: "INTERNAL" }, { status: 500 });
      }
    }
    if (res.destroyed) return;
    res.statusCode = response.status;
    response.headers.forEach((value, name) => res.setHeader(name, value));
    res.end(Buffer.from(await response.arrayBuffer()));
  };
}
