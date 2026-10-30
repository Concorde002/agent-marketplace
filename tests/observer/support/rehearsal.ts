/**
 * Local observer rehearsal. Starts the disposable fixture platform (real handler, stubbed TED/Tavily
 * and payment provider), serves dashboard/ on a second origin, records one finished run, and then
 * starts a slower run so the page can be watched while it progresses.
 *
 *   npm run build && node dist/tests/observer/support/rehearsal.js
 *
 * Environment: OBSERVER_FIXTURE_PORT (API, default 8791), DASHBOARD_PORT (default 8792),
 * REHEARSAL_STEP_MS (pause between live steps, default 4000), REHEARSAL_LIVE=off to skip the live run.
 * OBSERVER_EXTRA_ORIGINS adds browser origins (e.g. the deployed Pages site) allowed to read the fixture API.
 * Everything it shows is labelled "local-fixture": it is not hosted or named-client evidence.
 */
import { readFile } from "node:fs/promises";
import http from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { announceMcpClient, createObserverPlatform, driveRun } from "./platform.js";

const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };

async function main(): Promise<void> {
  process.env.OBSERVER_FIXTURE_PORT ??= "8791";
  const dashboardPort = Number(process.env.DASHBOARD_PORT ?? 8792);
  const dashboardOrigin = `http://127.0.0.1:${dashboardPort}`;
  const extraOrigins = (process.env.OBSERVER_EXTRA_ORIGINS ?? "").split(",").map((o) => o.trim()).filter(Boolean);
  const platform = await createObserverPlatform({ allowedOrigins: [dashboardOrigin, `http://localhost:${dashboardPort}`, ...extraOrigins], providerDelayMs: 300 });

  const root = fileURLToPath(new URL("../../../../dashboard/", import.meta.url));
  const server = http.createServer(async (req, res) => {
    const path = normalize(decodeURIComponent((req.url ?? "/").split("?")[0]!)).replace(/^(\.\.[/\\])+/, "");
    const file = join(root, path === "/" ? "index.html" : path);
    if (!file.startsWith(root)) { res.writeHead(404).end(); return; }
    try {
      const body = await readFile(file);
      res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" }).end(body);
    } catch {
      res.writeHead(404).end("not found");
    }
  });
  await new Promise<void>((resolve) => server.listen(dashboardPort, "127.0.0.1", resolve));

  const link = `${dashboardOrigin}/#api=${encodeURIComponent(platform.url)}&key=${encodeURIComponent(platform.tokens.observer)}`;
  console.log(`Fixture API:   ${platform.url} (local-fixture, stubbed sources and payment)`);
  console.log(`Observer link: ${link}`);

  await announceMcpClient(platform, platform.tokens.buyer, "rehearsal-buyer-client", "0.0.0-fixture");
  await announceMcpClient(platform, platform.tokens.supplier, "rehearsal-supplier-client", "0.0.0-fixture");
  const finished = await driveRun(platform, { counter: true });
  console.log(`Finished run:  ${finished.requestId} (paid, fixture)`);
  // A supplier ask below its own floor: the platform refuses it, and no order or payment exists.
  await driveRun(platform, { askMinor: 500 }).catch(() => undefined);
  console.log("Refused run recorded (fixture)");
  if (process.env.REHEARSAL_LIVE !== "off") {
    const step = Number(process.env.REHEARSAL_STEP_MS ?? 4000);
    setTimeout(() => {
      console.log("Starting a slower run now…");
      void driveRun(platform, { counter: true, stepDelayMs: step, log: (line) => console.log(`  live: ${line}`) })
        .then((run) => console.log(`Live run finished: ${run.requestId}`))
        .catch((error: unknown) => console.error(`Live run failed: ${error instanceof Error ? error.message : "error"}`));
    }, Number(process.env.REHEARSAL_START_MS ?? 15000));
  }
  const stop = () => { server.close(); void platform.close().finally(() => process.exit(0)); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

void main();
