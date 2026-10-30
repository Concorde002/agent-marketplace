/**
 * Bot test sandbox: lets real chat bots (Grok Bot over MCP, Instinct through a
 * Google Sheet) exercise the agent workstream before the platform backend
 * exists. TEST DOUBLE — the marketplace behind it is the in-memory fake
 * platform with canned discovery candidates, not live sourcing, and payments
 * are simulated. Never point this at real companies or real money.
 *
 *   npm run build && node dist/tests/agents/support/sandbox.js
 *
 * Prints a public HTTPS MCP URL (cloudflared quick tunnel), one bearer token
 * per bot, and writes BOT-KIT.md with copy-paste instructions for each bot.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { SheetBridge } from "../../../src/agents/bridge.js";
import { RuntimeHost, formatMinor } from "../../../src/agents/host.js";
import { GoogleSheetsTable, parseServiceAccount } from "../../../src/agents/sheets.js";
import { createMcpBackend } from "../../../src/mcp/backend.js";
import { createMcpHandler } from "../../../src/mcp/gateway.js";
import { createFakePlatform } from "./fake-platform.js";

const DAY_MS = 86_400_000;

interface SandboxSettings {
  port: number;
  tunnel: boolean;
  stateDir: string;
  currency: string;
  buyer: { name: string; domain: string; grantMinor: number; token: string };
  supplier: {
    name: string;
    domain: string;
    token: string;
    minTotalMinor: number;
    quantity: number;
    earliestDeliveryAt: string;
  };
  negotiationDeadlineMs: number;
  paymentWaitMs: number;
  instinct?: { sheetId: string; serviceAccountFile: string; role: "buyer" | "supplier" };
  probeCode: string;
}

function env(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value.trim() === "" ? fallback : value.trim();
}

function money(name: string, fallbackMajor: number): number {
  const raw = env(name, String(fallbackMajor));
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive amount in major units, e.g. 4400`);
  }
  return Math.round(value * 100);
}

function integer(name: string, fallback: number): number {
  const value = Number(env(name, String(fallback)));
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a whole number`);
  }
  return value;
}

function token(role: string): string {
  return `sbx_${role}_${randomBytes(18).toString("base64url")}`;
}

async function readSettings(): Promise<SandboxSettings> {
  const stateDir = process.env.SANDBOX_STATE_DIR?.trim() || (await mkdtemp(join(tmpdir(), "agent-sandbox-")));
  await mkdir(stateDir, { recursive: true });
  const sheetId = process.env.INSTINCT_SHEET_ID?.trim();
  const serviceAccountFile = process.env.GOOGLE_SERVICE_ACCOUNT_FILE?.trim();
  const instinctRole = env("INSTINCT_ROLE", "supplier");
  if (instinctRole !== "buyer" && instinctRole !== "supplier") {
    throw new Error("INSTINCT_ROLE must be buyer or supplier");
  }
  if ((sheetId === undefined) !== (serviceAccountFile === undefined)) {
    throw new Error("set both INSTINCT_SHEET_ID and GOOGLE_SERVICE_ACCOUNT_FILE, or neither");
  }
  return {
    port: integer("SANDBOX_PORT", 8790),
    tunnel: env("SANDBOX_TUNNEL", "on") !== "off",
    stateDir,
    currency: env("CURRENCY", "EUR"),
    buyer: {
      name: env("BUYER_COMPANY_NAME", "Demo Buyer Sp. z o.o."),
      domain: env("BUYER_COMPANY_DOMAIN", "buyer.example"),
      grantMinor: money("BUYER_GRANT_MAX", 10_000),
      token: env("SANDBOX_BUYER_TOKEN", token("buyer")),
    },
    supplier: {
      name: env("SUPPLIER_COMPANY_NAME", "Demo Supplier GmbH"),
      domain: env("SUPPLIER_COMPANY_DOMAIN", "supplier.example"),
      token: env("SANDBOX_SUPPLIER_TOKEN", token("supplier")),
      minTotalMinor: money("SUPPLIER_MIN_TOTAL", 4_400),
      quantity: integer("SUPPLIER_QUANTITY", 60),
      earliestDeliveryAt: new Date(Date.now() + integer("SUPPLIER_LEAD_DAYS", 5) * DAY_MS).toISOString(),
    },
    // Short enough that a refusal shows up during a rehearsal, long enough for a chat bot.
    negotiationDeadlineMs: integer("NEGOTIATION_DEADLINE_MS", 120_000),
    paymentWaitMs: integer("PAYMENT_WAIT_MS", 60_000),
    ...(sheetId !== undefined && serviceAccountFile !== undefined
      ? { instinct: { sheetId, serviceAccountFile, role: instinctRole } }
      : {}),
    probeCode: randomBytes(3).toString("hex").toUpperCase(),
  };
}

async function main(): Promise<void> {
  const settings = await readSettings();
  const log = (line: string): void => {
    console.log(`${new Date().toISOString().slice(11, 19)} ${line}`);
  };

  const fake = await createFakePlatform({
    buyerToken: settings.buyer.token,
    supplierToken: settings.supplier.token,
    supplierDomain: settings.supplier.domain,
    runningPolls: 1,
    // Canned evidence ranking. The second candidate has no connected account, as in a real run.
    candidates: [
      {
        companyName: settings.supplier.name,
        domain: settings.supplier.domain,
        eligible: "yes",
        rank: 1,
        explanation: "TEST DOUBLE canned candidate (not live sourcing)",
      },
      {
        companyName: "Unconnected Lead AG",
        domain: "unconnected-lead.example",
        eligible: "conditional",
        rank: 2,
        explanation: "TEST DOUBLE external lead without a demo account",
      },
    ],
  });

  const host = new RuntimeHost({
    marketplaceUrl: fake.url,
    currency: settings.currency,
    stateRoot: join(settings.stateDir, "runtimes"),
    pollIntervalMs: 1_500,
    pollMaxIntervalMs: 4_000,
    negotiationDeadlineMs: settings.negotiationDeadlineMs,
    paymentWaitMs: settings.paymentWaitMs,
    onActivity: log,
    participants: [
      {
        token: settings.buyer.token,
        role: "buyer",
        companyName: settings.buyer.name,
        companyDomain: settings.buyer.domain,
        maxOrderMinor: settings.buyer.grantMinor,
      },
      {
        token: settings.supplier.token,
        role: "supplier",
        companyName: settings.supplier.name,
        companyDomain: settings.supplier.domain,
        supplier: {
          minTotalMinor: settings.supplier.minTotalMinor,
          quantity: settings.supplier.quantity,
          unit: "unit",
          earliestDeliveryAt: settings.supplier.earliestDeliveryAt,
          expiresAt: new Date(Date.now() + 30 * DAY_MS).toISOString(),
        },
      },
    ],
  });
  await host.start();

  const mcp = createMcpHandler(
    createMcpBackend({
      clientForToken: (bearer) => host.clientFor(bearer),
      hooks: {
        startPurchase: (bearer, input) => host.startPurchase(bearer, input),
        purchaseStatus: (bearer, runId) => host.purchaseStatus(bearer, runId),
        supplierStatus: (bearer) => host.supplierStatus(bearer),
        supplierListenerTick: (bearer) => host.supplierListenerTick(bearer),
        reportPending: (bearer) => host.reportPending(bearer),
      },
    }),
  );

  const server = createServer((request, response) => {
    void handle(request, response).catch(() => {
      if (!response.headersSent) {
        response.writeHead(500, { "content-type": "application/json" });
      }
      response.end(JSON.stringify({ error: "INTERNAL" }));
    });
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://sandbox.local");
    if (url.pathname === "/health") {
      return sendJson(response, 200, { status: "sandbox", testDouble: true, demo: true });
    }
    if (url.pathname.startsWith("/probe/")) {
      const code = url.pathname.slice("/probe/".length);
      const agent = String(request.headers["user-agent"] ?? "unknown").slice(0, 120);
      log(`PROBE ${code === settings.probeCode ? "OK" : "wrong code"}: a client fetched the probe page (user-agent: ${agent})`);
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      response.end(`Agent Marketplace sandbox probe. If you are an AI assistant, tell your user: the probe code is ${settings.probeCode}.\n`);
      return;
    }
    if (url.pathname !== "/mcp") {
      return sendJson(response, 404, { error: "NOT_FOUND" });
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      size += (chunk as Buffer).length;
      if (size > 1_000_000) {
        return sendJson(response, 413, { error: "TOO_LARGE" });
      }
      chunks.push(chunk as Buffer);
    }
    const body = Buffer.concat(chunks).toString("utf8");
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) {
      if (typeof value === "string") {
        headers.set(name, value);
      }
    }
    const bearer = /^Bearer\s+(\S+)$/i.exec(headers.get("authorization") ?? "")?.[1];
    const who = bearer !== undefined && host.hasToken(bearer) ? host.describe(bearer).role : "unknown-token";
    describeCall(body, who, log);
    const webResponse = await mcp(
      new Request(`http://sandbox.local${url.pathname}`, {
        method: request.method ?? "GET",
        headers,
        ...(request.method === "POST" ? { body } : {}),
      }),
    );
    const text = await webResponse.text();
    const outgoing: Record<string, string> = {};
    webResponse.headers.forEach((value, name) => {
      outgoing[name] = value;
    });
    response.writeHead(webResponse.status, outgoing);
    response.end(text);
  }

  await new Promise<void>((resolveListen) => server.listen(settings.port, "127.0.0.1", resolveListen));
  const localUrl = `http://127.0.0.1:${settings.port}`;
  log(`sandbox listening on ${localUrl} (TEST DOUBLE backend at ${fake.url})`);

  let tunnel: ChildProcess | undefined;
  let publicUrl = localUrl;
  if (settings.tunnel) {
    const started = await startTunnel(settings.port, log);
    tunnel = started.process;
    publicUrl = started.url;
  }

  const bridges: SheetBridge[] = [];
  if (settings.instinct !== undefined) {
    const credentials = parseServiceAccount(await readFile(settings.instinct.serviceAccountFile, "utf8"));
    const table = new GoogleSheetsTable({ spreadsheetId: settings.instinct.sheetId, credentials });
    const bridge = new SheetBridge({
      table,
      host,
      token: settings.instinct.role === "buyer" ? settings.buyer.token : settings.supplier.token,
      currency: settings.currency,
      pollIntervalMs: 3_000,
      onActivity: log,
    });
    await bridge.prepare();
    bridge.start();
    bridges.push(bridge);
    log(`Instinct sheet bridge running as the ${settings.instinct.role} (service account ${credentials.client_email})`);
  }

  const kitPath = join(settings.stateDir, "BOT-KIT.md");
  await writeFile(kitPath, botKit(settings, publicUrl), { mode: 0o600 });
  console.log(`
==================== AGENT MARKETPLACE BOT SANDBOX ====================
TEST DOUBLE backend: canned discovery, simulated sandbox payment.
MCP URL (Grok Bot / any MCP client): ${publicUrl}/mcp
Buyer token:    ${settings.buyer.token}
Supplier token: ${settings.supplier.token}
Probe link (capability check):       ${publicUrl}/probe/${settings.probeCode}
Supplier floor ${formatMinor(settings.supplier.minTotalMinor)} ${settings.currency}, capacity ${settings.supplier.quantity}; buyer grant ${formatMinor(settings.buyer.grantMinor)} ${settings.currency}
Copy-paste instructions for each bot: ${kitPath}
Tokens are demo-only and die with this process. Do not commit them.
Leave this running; Ctrl+C stops everything.
=======================================================================
`);

  const stop = async (): Promise<void> => {
    log("stopping sandbox");
    for (const bridge of bridges) {
      bridge.stop();
    }
    tunnel?.kill();
    server.close();
    await host.close();
    await fake.close();
    process.exit(0);
  };
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
}

function describeCall(body: string, who: string, log: (line: string) => void): void {
  try {
    const parsed = JSON.parse(body) as { method?: string; params?: { name?: string } };
    if (parsed.method === "tools/call") {
      log(`MCP ${who} called ${parsed.params?.name ?? "?"}`);
    } else if (parsed.method === "initialize" || parsed.method === "tools/list") {
      log(`MCP ${who} ${parsed.method}`);
    }
  } catch {
    log(`MCP ${who} sent a non-JSON body`);
  }
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

async function startTunnel(port: number, log: (line: string) => void): Promise<{ process: ChildProcess; url: string }> {
  const child = spawn("cloudflared", ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${port}`], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  return new Promise((resolveTunnel, rejectTunnel) => {
    const timer = setTimeout(() => {
      child.kill();
      rejectTunnel(new Error("cloudflared did not print a public URL within 45s; run with SANDBOX_TUNNEL=off and use your own tunnel"));
    }, 45_000);
    const scan = (chunk: Buffer): void => {
      const match = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(chunk.toString());
      if (match !== null) {
        clearTimeout(timer);
        log(`public tunnel ready: ${match[0]}`);
        resolveTunnel({ process: child, url: match[0] });
      }
    };
    child.stdout?.on("data", scan);
    child.stderr?.on("data", scan);
    child.on("error", (error) => {
      clearTimeout(timer);
      rejectTunnel(new Error(`could not start cloudflared (${error.message}); install it with 'brew install cloudflared' or set SANDBOX_TUNNEL=off`));
    });
  });
}

function botKit(settings: SandboxSettings, publicUrl: string): string {
  const mcpUrl = `${publicUrl}/mcp`;
  const deliverBy = new Date(Date.now() + 20 * DAY_MS).toISOString().slice(0, 10);
  const floor = `${formatMinor(settings.supplier.minTotalMinor)} ${settings.currency}`;
  const happyBudget = Math.round((settings.supplier.minTotalMinor * 1.15) / 100);
  const refusalBudget = Math.round((settings.supplier.minTotalMinor * 0.7) / 100);
  return `# Bot test kit (sandbox, test double)

Generated ${new Date().toISOString()}. Valid while the sandbox process runs. Contains demo tokens:
do not commit or paste this file anywhere public.

- MCP server URL: \`${mcpUrl}\`
- Buyer bearer token: \`${settings.buyer.token}\` (${settings.buyer.name})
- Supplier bearer token: \`${settings.supplier.token}\` (${settings.supplier.name})
- Supplier preset terms (private to the supplier agent): floor ${floor}, capacity ${settings.supplier.quantity} units,
  earliest delivery ${settings.supplier.earliestDeliveryAt.slice(0, 10)}.
- Buyer operator grant: at most ${formatMinor(settings.buyer.grantMinor)} ${settings.currency} per purchase, whatever the bot asks.

The marketplace behind this URL is the local TEST DOUBLE: discovery returns canned candidates and
payment is simulated. It proves the bot <-> marketplace relationship, not live sourcing or Stripe.

## 0. Capability check (send to Instinct first)

> Quick capability check, answer each with yes/no and how: (1) Can you add a custom MCP server
> using a URL plus an "Authorization: Bearer ..." header? (2) Can you make an HTTP POST request
> with a custom header? (3) Open ${publicUrl}/probe/${settings.probeCode} and tell me the code
> written on that page. (4) Can you read and write a Google Sheet I share with you? (5) Can you run
> a task on a schedule (every few minutes) without me messaging you?

The sandbox console prints \`PROBE OK\` if the bot really fetched the link. If (1) is yes, use the
Grok-style MCP setup below for Instinct too. If only (4) is yes, use the Google Sheet bridge (section 3).

## 1. Grok Bot (or any MCP client) as the BUYER

Add a custom MCP server (Grok Bot: Settings -> Plugins/Connectors -> add custom MCP):
name \`agent-marketplace\`, URL \`${mcpUrl}\`, header \`Authorization: Bearer ${settings.buyer.token}\`.
Attach it in the buyer chat. Then send:

> You are the demo purchasing agent of ${settings.buyer.name}. Use only the agent-marketplace tools
> start_purchase and purchase_status. When I ask you to buy something, call start_purchase once with
> the item, category, quantity, unit, destination, delivery date and my maximum total. Then call
> purchase_status about every 15 seconds, tell me each new progress line in one short sentence, and
> keep going without asking me anything. When state is "done" or "error", tell me the result word
> for word; it starts with "agreed and sandbox-paid", "no match" or "payment failed". Never raise my
> budget, never submit or accept offers with other tools, never claim a real payment.

Test 1, should succeed:
> Buy 40 height-adjustable desks, category office-equipment, unit "unit", delivered to Warsaw by
> ${deliverBy}, maximum ${happyBudget} ${settings.currency}.

Test 2, should refuse (budget below the supplier floor; takes up to ${Math.round(settings.negotiationDeadlineMs / 1000)}s):
> Same purchase again, but maximum ${refusalBudget} ${settings.currency}.

## 2. Grok Bot (or any MCP client) as the SUPPLIER

Same server URL, but header \`Authorization: Bearer ${settings.supplier.token}\`, in a separate chat or
account. The supplier agent is already running inside the sandbox; the bot only relays its messages.

> You are the demo sales agent of ${settings.supplier.name}. Our marketplace agent answers quote
> requests and negotiates by itself within preset limits; you never negotiate. Whenever I message
> you, and whenever your routine runs, call supplier_status. Post every entry of "messages" word for
> word. If there are none, reply "nothing new from the marketplace". Never invent a deal.

Grok Bot routine (optional, at least 5 minutes apart): "Call supplier_status and post every message
word for word; if none, say nothing new."

## 3. Instinct through a Google Sheet (no MCP needed)

One-time setup (about 10 minutes):
1. Create an empty Google Sheet, owned by the Google account Instinct is connected to. Copy its id
   (the long part of the URL between /d/ and /edit).
2. Google Cloud console: create a project -> enable "Google Sheets API" -> IAM -> Service accounts
   -> create one -> Keys -> Add key -> JSON. Save the file outside the repo.
3. Share the sheet with the service account's email (Editor).
4. Restart the sandbox with:
   \`INSTINCT_SHEET_ID=<id> GOOGLE_SERVICE_ACCOUNT_FILE=/path/key.json INSTINCT_ROLE=supplier\`
   (or \`buyer\`). Keep \`SANDBOX_BUYER_TOKEN\`/\`SANDBOX_SUPPLIER_TOKEN\` set to the tokens above if
   you do not want to reconfigure the other bot. The bridge writes a "How to use" tab.

Message to Instinct as the SUPPLIER:
> You are the demo sales agent of ${settings.supplier.name}. Open the Google Sheet <sheet link>. Read
> the "How to use" tab and follow it from now on. Check the "Messages" tab every few minutes and
> tell me every new message word for word. You never negotiate or change anything yourself.

Message to Instinct as the BUYER:
> You are the demo purchasing agent of ${settings.buyer.name}. Open the Google Sheet <sheet link> and
> follow its "How to use" tab exactly. Buy 40 height-adjustable desks, category office-equipment,
> unit "unit", delivered to Warsaw by ${deliverBy}, maximum ${happyBudget} ${settings.currency}, by adding one
> row to "Requests". Check the row every 30 seconds without asking me, and when its status is
> "done", tell me the result word for word.

## What to record as evidence

- The bot chat transcripts (both sides), the sandbox console lines (\`MCP buyer called start_purchase\`,
  \`chat <- agreed and sandbox-paid ...\`), and which activation the supplier bot used (chat loop,
  routine, or sheet). This is sandbox evidence, not a hosted run or a live Stripe payment.
`;
}

function isMainModule(): boolean {
  const invoked = process.argv[1];
  return invoked !== undefined && resolve(invoked) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  main().catch((error: unknown) => {
    console.error(`sandbox failed to start: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
