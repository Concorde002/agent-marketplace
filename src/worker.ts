/**
 * Cloudflare Workers entry point: the same API as src/server.ts, without the /observer/ws stream.
 * Configuration (wrangler secrets / vars, see docs/cloudflare-deploy.md):
 *   HYPERDRIVE              binding to the Postgres database (preferred; Hyperdrive handles TLS and pooling)
 *   DB_CONNECTION           direct Postgres URL, used only when no HYPERDRIVE binding exists
 *   DB_SSL=disable          only for a database on localhost (local `wrangler dev` rehearsal)
 *   STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, OBSERVER_ALLOWED_ORIGINS, DEMO_ONBOARDING,
 *   DEPLOYMENT_ENVIRONMENT, PUBLIC_DEMO_OBSERVER  same meaning as in src/server.ts
 */
import pg from "pg";
import { handleRequest, type Dependencies } from "./index.js";
import { readStripeConfig } from "./payments/config.js";
import { PostgresPaymentStore } from "./payments/postgres-store.js";
import { SettlementService } from "./payments/settlement.js";
import { StripeClient, StripeSandboxProvider } from "./payments/stripe.js";
import { postgresDatabase } from "./platform/database.js";
import { Marketplace } from "./platform/marketplace.js";
import { createPlatformHttp } from "./platform/http.js";
import { ObserverBus } from "./platform/observer.js";

export interface WorkerEnv {
  HYPERDRIVE?: { connectionString: string };
  [key: string]: unknown;
}
interface ExecutionContext { waitUntil(promise: Promise<unknown>): void }

// Per-isolate log buffer for the observer page; the database stays authoritative.
const observer = new ObserverBus();

function strings(env: WorkerEnv): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) if (typeof value === "string") out[key] = value;
  return out;
}

function origins(value: string | undefined): string[] {
  return (value ?? "").split(",").map((origin) => origin.trim()).filter((origin) => /^https:\/\/[^/]+$/.test(origin));
}

/** Workers cannot share sockets between requests, so each request gets its own small pool. */
function dependencies(env: WorkerEnv): { deps: Dependencies; pool?: pg.Pool } {
  const vars = strings(env);
  const connectionString = env.HYPERDRIVE?.connectionString ?? vars.DB_CONNECTION;
  if (!connectionString) return { deps: { observer } };
  const pool = new pg.Pool({
    connectionString, max: 5, connectionTimeoutMillis: 10_000,
    // Hyperdrive terminates TLS to the database itself; a direct URL must use TLS (except a local rehearsal database).
    ssl: env.HYPERDRIVE ? false : !(vars.DB_SSL === "disable" && /^(localhost|127\.0\.0\.1)$/.test(new URL(connectionString).hostname)),
  });
  const paymentStore = new PostgresPaymentStore(pool);
  let settlement: SettlementService | undefined;
  let stripeClient: StripeClient | undefined;
  let webhookSecret: string | undefined;
  if (vars.STRIPE_SECRET_KEY || vars.STRIPE_WEBHOOK_SECRET) {
    const stripe = readStripeConfig(vars, { requireWebhookSecret: !!vars.STRIPE_WEBHOOK_SECRET });
    stripeClient = new StripeClient(stripe);
    settlement = new SettlementService(paymentStore, new StripeSandboxProvider(stripeClient));
    webhookSecret = stripe.webhookSecret;
  }
  const market = new Marketplace(postgresDatabase(pool), { paymentStore, ...(settlement ? { settlement } : {}) });
  const deps: Dependencies = { observer, platform: createPlatformHttp(postgresDatabase(pool), market, {
    paymentConfigured: !!settlement && !!webhookSecret,
    observer,
    publicDemoObserver: { enabled: vars.PUBLIC_DEMO_OBSERVER !== "false" },
    ...(vars.DEMO_ONBOARDING === "off" ? {} : { onboarding: { stripe: stripeClient } }),
    observerApi: { allowedOrigins: origins(vars.OBSERVER_ALLOWED_ORIGINS), environment: vars.DEPLOYMENT_ENVIRONMENT ?? "cloudflare" },
  }) };
  if (settlement && webhookSecret) deps.stripeWebhook = { settlement, secret: webhookSecret };
  return { deps, pool };
}

export default {
  async fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
    const { deps, pool } = dependencies(env);
    try {
      return await handleRequest(request, deps);
    } finally {
      if (pool) ctx.waitUntil(pool.end().catch(() => undefined));
    }
  },
};
