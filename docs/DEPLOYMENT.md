# Deployment

Target: **Vercel** for the app, **Neon** for PostgreSQL.

## 1. Database (Neon)

1. Create a Neon project and a database named `cartsentry`.
2. Copy the **pooled** connection string. Vercel runs serverless functions, so
   the pooled endpoint (`-pooler` in the host) is required — a direct connection
   will exhaust Postgres connections under load.
3. `DATABASE_URL` — the pooled string — is all you strictly need. Migrations
   apply successfully over the pooler (verified against Neon).

   Optionally also set `DIRECT_URL` to the unpooled string. Neon recommends a
   direct connection for schema changes because migrations take advisory locks
   and the pooler can drop long-running sessions. It is a robustness measure for
   large migrations, not a requirement.

To use a separate migration connection, add to `prisma/schema.prisma`:

```prisma
datasource db {
  provider  = "postgresql"
  url       = env("DATABASE_URL")
  directUrl = env("DIRECT_URL")
}
```

## 2. Shopify Partner app

1. Create an app in the Partner Dashboard.
2. `shopify app config link` — writes `client_id` and `application_url` into
   `shopify.app.toml`.
3. Set the app URL to your Vercel production domain.
4. Allowed redirect URLs:
   - `https://<your-domain>/auth/callback`
   - `https://<your-domain>/auth/shopify/callback`
   - `https://<your-domain>/api/auth/callback`
5. Confirm the app proxy is configured: prefix `apps`, subpath `cartsentry`,
   URL `https://<your-domain>/proxy`.

## 3. Vercel environment variables

Set for **Production** and **Preview**:

| Variable | Notes |
|---|---|
| `SHOPIFY_API_KEY` | Partner Dashboard |
| `SHOPIFY_API_SECRET` | Partner Dashboard. Secret. |
| `SHOPIFY_APP_URL` | `https://<your-domain>` |
| `SHOPIFY_APP_HANDLE` | `cartsentry-ai` |
| `SCOPES` | `read_products,write_products,read_validations,write_validations` |
| `DATABASE_URL` | Neon **pooled** string |
| `DIRECT_URL` | Neon **direct** string. Optional — see step 1. |
| `NODE_ENV` | `production` |
| `LOG_LEVEL` | `info` |
| `AI_PROVIDER` | `gemini`, `anthropic`, `groq`, or `none` |
| `AI_API_KEY` / `GEMINI_API_KEY` / `GROQ_API_KEY` / `ANTHROPIC_API_KEY` | Provider key |
| `AI_MODEL` | e.g. `gemini-2.5-flash` |
| `AI_FALLBACK_PROVIDER` | Optional, e.g. `groq` |
| `AI_FALLBACK_MODEL` | Optional, e.g. `llama-3.3-70b-versatile` |

Do **not** set `DEMO_MODE=true` in production. The app ignores it there and logs
a warning, but it should not be set at all.

## 4. Deploy the app

```bash
vercel --prod
```

`vercel.json` runs `prisma generate && prisma migrate deploy && react-router build`,
so migrations are applied as part of the build.

The Vercel preset in `react-router.config.ts` is applied only when the `VERCEL`
environment variable is present, so local development and CI stay on the plain
Node target.

## 5. Deploy the extensions

The Shopify Function and theme app extension deploy through the Shopify CLI, not
Vercel:

```bash
shopify app deploy --allow-updates
```

Requires Shopify CLI 4.x or later. CLI 3.84.1 fails with a misleading
"At least one specification file is required" error — see TROUBLESHOOTING.md.

This builds `extensions/purchase-rules-validation` to WebAssembly and uploads it
along with the theme extension and `shopify.app.toml`.

**The function must be deployed before a merchant activates a rule.**
`validationCreate` references it by handle (`purchase-rules-validation`); if it
is not deployed, publishing fails and the merchant sees a clear error while
their previous rules keep working.

## 6. Verify

```bash
curl https://<your-domain>/healthz
```

Expect `{"status":"ok","checks":{"app":"ok","database":"ok"}}`. A 503 with
`"database":"fail"` means `DATABASE_URL` is wrong or Neon is unreachable.

Then, on a development store:

1. Install the app and complete OAuth.
2. Create a rule, run a simulation, activate it.
3. Check Settings → the configuration should show as `PUBLISHED`.
4. In the store, add more than the allowed quantity and try to check out.

## Local development

```bash
npm install
cp .env.example .env          # fill in DATABASE_URL at minimum
npm run db:deploy             # apply migrations
npm run db:seed               # optional development data
shopify app dev               # tunnels, injects Shopify credentials, hot reloads
```

`shopify app dev` supplies `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET` and
`SHOPIFY_APP_URL` automatically; you only need `DATABASE_URL` and any AI keys in
`.env`.

## Commands

| Command | Purpose |
|---|---|
| `npm run dev` | `shopify app dev` |
| `npm run build` | Production build |
| `npm start` | Serve the build |
| `npm test` | Run the test suite |
| `npm run typecheck` | Typegen + `tsc --noEmit` |
| `npm run lint` | ESLint |
| `npm run db:migrate` | Create a migration in development |
| `npm run db:deploy` | Apply migrations |
| `npm run db:seed` | Seed development data |
| `npm run db:studio` | Prisma Studio |
| `shopify app deploy --allow-updates` | Deploy function + theme extension + config |

## Monitoring

- `/healthz` for uptime checks. It reports liveness and a real database
  round-trip, and deliberately exposes no configuration or version detail.
- Logs are structured JSON on stdout, which Vercel's log drain ingests directly.
  Every line carries a request id and shop id, with secrets redacted at the
  logger.
- The integration point for an error tracker (Sentry or similar) is
  `toAppError` in `app/lib/errors.server.ts` — every unhandled error passes
  through it exactly once.

## Rollback

- **App**: promote the previous Vercel deployment.
- **Migrations**: Prisma Migrate does not auto-revert. Write a forward migration
  that undoes the change. Every migration so far is additive.
- **Rules**: Settings → Advanced lists published configurations with a
  *Roll back to this* action. Only configurations that previously published
  successfully can be restored, so a broken configuration can never be
  reinstated.
