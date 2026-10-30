/**
 * Local development entrypoint for the in-memory test double.
 *
 * The double itself always binds an ephemeral port, so this entrypoint listens
 * on the configurable public port and forwards to it unchanged. Nothing here is
 * a production backend; every response keeps the double's `x-test-double`
 * header.
 */
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createFakePlatform } from "./fake-platform.js";

const DEFAULT_PORT = 8788;
const BANNER = "TEST DOUBLE — not a production backend";

function readPort(raw: string | undefined): number {
  const value = raw === undefined || raw.trim() === "" ? String(DEFAULT_PORT) : raw.trim();
  if (!/^\d+$/.test(value)) {
    throw new Error("TEST_DOUBLE_PORT must be an integer between 0 and 65535");
  }
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new Error("TEST_DOUBLE_PORT must be an integer between 0 and 65535");
  }
  return port;
}

async function main(): Promise<void> {
  const port = readPort(process.env.TEST_DOUBLE_PORT);
  const platform = await createFakePlatform();
  const target = new URL(platform.url);

  const proxy = createServer((request: IncomingMessage, response: ServerResponse) => {
    const upstream = httpRequest(
      {
        hostname: target.hostname,
        port: target.port,
        method: request.method,
        path: request.url ?? "/",
        headers: { ...request.headers, host: target.host },
      },
      (upstreamResponse) => {
        response.writeHead(
          upstreamResponse.statusCode ?? 502,
          upstreamResponse.headers,
        );
        upstreamResponse.pipe(response);
      },
    );
    upstream.on("error", (error: Error) => {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      const body = JSON.stringify({
        error: "TEST_DOUBLE_PROXY_ERROR",
        message: error.message.slice(0, 200),
      });
      response.writeHead(502, {
        "content-type": "application/json; charset=utf-8",
        "content-length": String(Buffer.byteLength(body)),
        "x-test-double": "true",
      });
      response.end(body);
    });
    request.pipe(upstream);
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    const onError = (error: Error): void => {
      rejectListen(error);
    };
    proxy.once("error", onError);
    proxy.listen(port, "127.0.0.1", () => {
      proxy.off("error", onError);
      resolveListen();
    });
  });

  const address = proxy.address();
  const actualPort =
    address !== null && typeof address === "object" ? address.port : port;

  console.log(BANNER);
  console.log(`URL: http://127.0.0.1:${actualPort}`);
  console.log(`buyer token: ${platform.tokens.buyer}`);
  console.log(`supplier token: ${platform.tokens.supplier}`);

  let stopping = false;
  const stop = (): void => {
    if (stopping) {
      return;
    }
    stopping = true;
    proxy.close(() => undefined);
    proxy.closeAllConnections();
    void platform.close().then(
      () => {
        process.exitCode = 0;
      },
      () => {
        process.exitCode = 1;
      },
    );
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

function isMainModule(): boolean {
  const invoked = process.argv[1];
  return (
    invoked !== undefined &&
    resolve(invoked) === fileURLToPath(import.meta.url)
  );
}

if (isMainModule()) {
  void main().catch((error: unknown) => {
    console.error(
      error instanceof Error ? error.message : "dev platform failed to start",
    );
    process.exitCode = 1;
  });
}
