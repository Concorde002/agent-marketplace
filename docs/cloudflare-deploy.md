# Cloudflare hosting

Everything runs on Cloudflare:

- **API Worker:** https://agent-marketplace-api.st-tomaszew.workers.dev (`/mcp`, `/v1/...`, `/health`). It runs `src/worker.ts`, the same API as Cloud Run without the `/observer/ws` stream.
- **Observer page:** https://agentmarketplace.pages.dev. It polls the Worker first and falls back to Cloud Run while the Worker has no database.

The `deploy-cloudflare` GitHub workflow deploys both on every push to main.

## One-time setup (repo Settings → Secrets and variables → Actions)

| Secret | Value |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Cloudflare token with *Workers Scripts: Edit*, *Cloudflare Pages: Edit*, *Hyperdrive: Edit* |
| `CLOUDFLARE_ACCOUNT_ID` | `e2ce022d0deb5f0a5b82c273956f6fb8` |
| `DB_CONNECTION` | The same Postgres URL Cloud Run uses (a `marketplace_app` login role), without `sslmode` |
| `STRIPE_SECRET_KEY` | Stripe **test** key (`sk_test_…`) |
| `STRIPE_WEBHOOK_SECRET` | Optional, `whsec_…` |

Then re-run the workflow (Actions → deploy-cloudflare → Run workflow). The workflow creates or updates the `agent-marketplace-db` Hyperdrive config, which handles TLS and pooling, and binds it to the Worker.

Check:

```bash
curl https://agent-marketplace-api.st-tomaszew.workers.dev/health
```

`"status":"demo-api"` means the database is connected. `"scaffold"` means `DB_CONNECTION` is not set yet.

Bots then connect to `https://agent-marketplace-api.st-tomaszew.workers.dev/mcp`.

## Local rehearsal

Put `DB_CONNECTION=postgres://…@localhost:…` and `DB_SSL=disable` in `.dev.vars` (gitignored), then run `npx wrangler dev`.
