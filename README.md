# CartSentry AI — Smart Purchase Rules

> Prevent invalid purchases before checkout.

A Shopify app that lets merchants build purchase rules without code, test them
against a sample cart, catch rules that contradict each other, warn customers
early, and enforce them with Shopify's own Cart and Checkout Validation
Functions.

**Works on every Shopify plan.** Validation functions are not a Plus-only
feature, so nothing here bypasses or works around a plan restriction.

## The idea

```
CREATE → TEST → DETECT → WARN → ENFORCE → MONITOR
```

Most purchase-rule apps stop at "create". CartSentry's differentiator is
everything between creating a rule and it going live:

- **Simulator** — build a test cart and see exactly what a customer would
  experience, using the *same engine* that runs at checkout. Not an
  approximation.
- **Conflict detector** — proves when two rules cannot both be satisfied, and
  refuses to let you activate into that state.
- **Early warning** — tell shoppers in the cart, not at checkout.
- **AI Rule Creator** — describe a rule in English; review it before it exists.

## Stack

| | |
|---|---|
| Framework | React Router 7 (Shopify's current recommended template) |
| UI | Polaris web components + App Bridge |
| Database | PostgreSQL via Prisma |
| Enforcement | Shopify Function, `cart.validations.generate.run`, API 2026-07 |
| Storefront | Theme app extension + app proxy |
| Hosting | Vercel + Neon |
| Tests | Vitest |

## Architecture in one paragraph

`packages/engine` holds the whole rule model — schema, evaluator, explanations,
conflict detection, and the configuration compiler — and is imported by **both**
the admin app and the Shopify Function. That is what makes the simulator
trustworthy: it is not a re-implementation of the checkout logic, it is the same
module. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Quick start

```bash
npm install
cp .env.example .env        # set DATABASE_URL at minimum
npm run db:deploy           # apply migrations
npm run db:seed             # optional development data
shopify app dev
```

`shopify app dev` supplies the Shopify credentials and tunnel automatically.

Deploy the function and theme extension separately:

```bash
shopify app deploy
```

## Commands

| Command | Purpose |
|---|---|
| `npm run dev` | `shopify app dev` |
| `npm test` | Run the test suite |
| `npm run typecheck` | Typegen + `tsc --noEmit` |
| `npm run lint` | ESLint |
| `npm run build` | Production build |
| `npm run db:migrate` | Create a migration |
| `npm run db:deploy` | Apply migrations |
| `npm run db:seed` | Seed development data |

## Layout

```
packages/engine/    Shared rule engine — no Node, Prisma or React
app/lib/            Server services: tenancy, rules, billing, AI, conflicts…
app/routes/         Admin pages, webhooks, app proxy, health check
app/components/     Rule builder and shared UI
extensions/
  purchase-rules-validation/   Cart & Checkout Validation Function
  cartsentry-warnings/         Theme app extension
prisma/             Schema, migration, seed
docs/               Full documentation
```

## Status

| | |
|---|---|
| Automated tests | 118 passing |
| Typecheck | Clean |
| Production build | Passing |
| Store end-to-end testing | **Not yet run** — needs a Partner account and dev store |

The Shopify Function's compiled WebAssembly has not been built or run on a real
store in this environment. Its run export is unit-tested against documented
input shapes, but that is not the same as verified enforcement. See
[docs/TESTING.md](docs/TESTING.md) for the full store test plan.

## Documentation

| Document | Contents |
|---|---|
| [SHOPIFY_CAPABILITIES.md](docs/SHOPIFY_CAPABILITIES.md) | Platform audit: what Shopify supports, on which plans |
| [LIMITATIONS.md](docs/LIMITATIONS.md) | What the app cannot do, and why |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | Design decisions and their reasoning |
| [SECURITY.md](docs/SECURITY.md) | Threat model, tenancy, AI safety |
| [BILLING.md](docs/BILLING.md) | Plans, entitlements, downgrade behaviour |
| [DEPLOYMENT.md](docs/DEPLOYMENT.md) | Vercel + Neon deployment |
| [TESTING.md](docs/TESTING.md) | Coverage and the store test plan |
| [TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | Diagnosis by symptom |
| [APP_STORE_LISTING.md](docs/APP_STORE_LISTING.md) | Listing copy and assets |
| [SHOPIFY_REVIEW_CHECKLIST.md](docs/SHOPIFY_REVIEW_CHECKLIST.md) | Review readiness |

## What this app deliberately does not do

- Bypass Shopify Plus, or claim to
- Modify `checkout.liquid` or any Plus-gated surface
- Use undocumented APIs, scrape the admin, or automate a browser
- Execute AI-generated code — the AI can only emit schema-validated data
- Store customer personal data
- Report checkout conversion or revenue figures, which Shopify Functions make
  impossible to measure honestly
- Delete a merchant's rules on downgrade
