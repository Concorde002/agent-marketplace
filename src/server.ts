/**
 * Node HTTP entry point (Cloud Run, or local). Configuration comes only from the environment:
 *   PORT                    listen port (default 8080, as Cloud Run sets it)
 *   STRIPE_SECRET_KEY       sandbox key; live keys are refused
 *   STRIPE_WEBHOOK_SECRET   enables POST /webhooks/stripe; without it the route returns 501
 *   DB_CONNECTION           Postgres URL for a login role in marketplace_app
 *   DB_CA_FILE              CA certificate for TLS verification (Supabase: prod-ca-2021.crt)
 *   DB_SSL=disable          only accepted for a database on localhost
 */
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import pg from "pg";
import { handleRequest, type Dependencies } from "./index.js";
import { readStripeConfig } from "./payments/config.js";
import { PostgresPaymentStore } from "./payments/postgres-store.js";
import { SettlementService } from "./payments/settlement.js";
import { StripeClient, StripeSandboxProvider } from "./payments/stripe.js";
import { toNodeListener } from "./server-adapter.js";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export function databaseSsl(env: NodeJS.ProcessEnv, connectionString: string): pg.ClientConfig["ssl"] {
  const host = new URL(connectionString).hostname;
  if (env.DB_SSL === "disable") {
    if (!LOCAL_HOSTS.has(host)) throw new Error("DB_SSL=disable is only allowed for a database on localhost");
    return false;
  }
  if (new URL(connectionString).searchParams.has("sslmode")) {
    // pg lets a URL sslmode override the CA settings below, which would silently weaken verification.
    throw new Error("remove sslmode from DB_CONNECTION; TLS is configured with DB_CA_FILE");
  }
  return env.DB_CA_FILE ? { ca: readFileSync(env.DB_CA_FILE, "utf8") } : true;
}

export function buildDependencies(env: NodeJS.ProcessEnv): { deps: Dependencies; pool?: pg.Pool; notes: string[] } {
  const notes: string[] = [];
  if (!env.STRIPE_WEBHOOK_SECRET) {
    notes.push("STRIPE_WEBHOOK_SECRET not set: /webhooks/stripe returns 501");
    return { deps: {}, notes };
  }
  const stripe = readStripeConfig(env, { requireWebhookSecret: true });
  const connectionString = env.DB_CONNECTION;
  if (!connectionString) throw new Error("DB_CONNECTION is required when STRIPE_WEBHOOK_SECRET is set");
  const pool = new pg.Pool({ connectionString, ssl: databaseSsl(env, connectionString), max: 5, connectionTimeoutMillis: 10_000 });
  const settlement = new SettlementService(new PostgresPaymentStore(pool), new StripeSandboxProvider(new StripeClient(stripe)));
  notes.push("POST /webhooks/stripe enabled");
  return { deps: { stripeWebhook: { settlement, secret: stripe.webhookSecret! } }, pool, notes };
}

const isEntryPoint = import.meta.url === new URL(process.argv[1] ?? "", "file://").href;
if (isEntryPoint) {
  const { deps, pool, notes } = buildDependencies(process.env);
  const port = Number(process.env.PORT ?? 8080);
  const server = createServer(toNodeListener((request) => handleRequest(request, deps)));
  server.listen(port, () => console.error(`listening on :${port}; ${notes.join("; ")}`));
  const shutdown = () => server.close(() => void pool?.end().finally(() => process.exit(0)));
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
