import type { IncomingMessage, ServerResponse } from "node:http";
import { redactSecrets } from "./payments/stripe.js";

// MVP_LIMIT: 1 MiB covers Stripe events and API payloads; larger bodies are refused before parsing.
export const MAX_BODY_BYTES = 1024 * 1024;

class BodyTooLarge extends Error {}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const declared = Number(req.headers["content-length"] ?? 0);
  if (declared > MAX_BODY_BYTES) throw new BodyTooLarge();
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new BodyTooLarge();
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * Adapts a Web Fetch handler to node:http. The body is passed through byte-for-byte:
 * Stripe's webhook signature covers the exact raw payload.
 */
export function toNodeListener(handler: (request: Request) => Promise<Response>, log: (message: string) => void = console.error) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    let response: Response;
    try {
      const body = req.method === "GET" || req.method === "HEAD" ? undefined : await readBody(req);
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) {
        if (Array.isArray(value)) value.forEach((v) => headers.append(name, v));
        else if (value !== undefined) headers.set(name, value);
      }
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      const method = req.method ?? "GET";
      response = await handler(new Request(url, body === undefined ? { method, headers } : { method, headers, body: new Uint8Array(body) }));
    } catch (error) {
      if (error instanceof BodyTooLarge) {
        response = Response.json({ error: "PAYLOAD_TOO_LARGE" }, { status: 413 });
      } else {
        // A 5xx makes Stripe retry later; the event is only recorded after it was applied.
        log(`request failed: ${redactSecrets(error instanceof Error ? error.message : String(error))}`);
        response = Response.json({ error: "INTERNAL" }, { status: 500 });
      }
    }
    res.statusCode = response.status;
    response.headers.forEach((value, name) => res.setHeader(name, value));
    res.end(Buffer.from(await response.arrayBuffer()));
  };
}
