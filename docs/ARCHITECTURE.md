# Architecture

## The central idea

One rule engine, two runtimes.

`packages/engine` holds the entire rule model: the schema, the evaluator, the
explanation generator, the conflict detector and the configuration compiler. It
is imported by **both** the admin app and the Shopify Function.

That is not a tidiness preference. It is what makes the simulator trustworthy.
If the simulator had its own copy of the logic, "the simulator said PASS" and
"checkout allowed it" would be two claims that drift apart over time. Sharing
the module makes them the same claim.

Constraint that keeps this possible: nothing in `packages/engine` imports Node,
Prisma, or React. `rule-schema.ts` is the only module that pulls in zod.

**The Function must import from the specific engine modules, never the package
barrel.** `index.ts` re-exports rule-schema's zod schemas as runtime values,
which esbuild cannot tree-shake, so a barrel import puts ~100kb of zod into the
Function — measured at 134kb total, 74% of it zod. Importing
`@cartsentry/engine/evaluate` and `@cartsentry/engine/compile` instead brings the
bundle to 9.8kb (5.2kb minified) with zod entirely absent, because those modules
reference rule-schema with `import type` only. The package exposes subpath
exports for exactly this reason.

## Flow

```
Merchant describes a rule
   │  (rule builder, template, or AI Rule Creator)
   ▼
RuleInputSchema validates it                    packages/engine/rule-schema.ts
   ▼
Stored as a DRAFT in PostgreSQL                 app/lib/rules/rules.server.ts
   ▼
Simulator evaluates it against a test cart      app/lib/simulator/  →  engine/evaluate.ts
   ▼
Conflict detector proves it is satisfiable      engine/conflicts.ts
   ▼
Merchant activates (gated: valid, no critical conflict, within plan)
   ▼
compile() → one compact JSON document           engine/compile.ts
   ▼
validationCreate / validationUpdate             app/lib/shopify/validation.server.ts
   ▼
Shopify stores it as a metafield on the Validation
   ▼
Function reads it on every cart change          extensions/purchase-rules-validation
   └─ evaluates with the SAME engine → validation errors at cart and checkout
```

## Layout

```
packages/engine/          Shared rule engine. No Node, Prisma or React.
  rule-schema.ts          Canonical rule model + zod validation
  cart.ts                 Normalised cart the evaluator reads
  evaluate.ts             Three-valued evaluator (true / false / undeterminable)
  explain.ts              Human-readable explanations
  conflicts.ts            Provable-contradiction detection
  compile.ts              Rules → Function configuration, and back

app/
  domain/                 (moved into packages/engine)
  lib/
    config.server.ts      Validated environment. Fails fast on misconfiguration.
    logger.server.ts      Structured logs with enforced redaction
    errors.server.ts      AppError → merchant-facing message
    tenancy.server.ts     requireTenant(): the multi-tenancy boundary
    activity.server.ts    Audit trail + usage metrics
    i18n.ts               Translation lookup layer
    rules/                CRUD, templates
    simulator/            Scenario → timeline + explanations
    conflicts/            Persistence and merchant decisions
    billing/              Plans, entitlements, Shopify subscriptions
    analytics/            Only what can actually be measured
    dashboard/            Health score
    ai/                   Provider adapters + rule creator
    shopify/              validation publishing, resource resolution
  routes/                 React Router flat routes
  components/             Polaris web-component UI

extensions/
  purchase-rules-validation/   Cart & Checkout Validation Function
  cartsentry-warnings/         Theme app extension (storefront warnings)

prisma/                   PostgreSQL schema, migration, seed
```

## Key design decisions

### Three-valued evaluation

Conditions return `true`, `false`, or **`undeterminable`**. The third value
exists because Shopify genuinely does not know some things yet — during early
cart interaction there is no delivery address, so a country condition has no
answer.

Treating that as `false` would silently block carts that are fine. Instead, an
AND group with any unresolved condition (and no outright failure) is
undeterminable and the rule does not fire. A rule only ever fires when it
demonstrably matches.

The same mechanism handles a deleted product: the condition becomes
undeterminable rather than accidentally matching everything.

### The compiled configuration is a separate format

Stored rules carry admin-only data — descriptions, cached titles, warning
styling — that the Function has no use for, and metafield space is finite. So
`compile()` produces a short-keyed projection, and `expand()` reverses it.

This also decouples the merchant-facing schema from the wire format: the rule
model can evolve without a Function redeploy.

### Publishing never breaks working enforcement

`publishRules` records a `PENDING` configuration row, then calls Shopify. On
failure it marks that row `FAILED`, leaves the previous `PUBLISHED` row and the
live Shopify configuration untouched, notifies the merchant, and throws a
`FUNCTION_PUBLISH` error whose message says the previous rules are still live.

Publishing is idempotent: if the compiled checksum matches the last published
one, nothing is sent.

### Conflicts must be provable

A false "CRITICAL" costs more merchant trust than a missed "MEDIUM". So every
detector either demonstrates an impossibility or downgrades its own confidence:

- `confirmed` — provably unsatisfiable, or provably redundant
- `potential` — same scope, outcomes disagree, but a cart could avoid both
- `overlap` — can co-fire; worth a look

Numeric contradictions are proved by intersecting *permitted* intervals (the
complement of what a BLOCK rule triggers on) and showing the result is empty.
Rules whose scopes are provably disjoint — mutually exclusive customer tags,
non-overlapping countries — are never reported as conflicting.

### Multi-tenancy is a wrapper, not a convention

Every merchant-facing loader and action begins with `requireTenant(request)`,
which authenticates with Shopify and returns a `TenantContext` carrying
`scope: { shopId }`. Queries spread that scope, and `shopId` is placed **last**
in constructed `where` clauses so caller-supplied input cannot override it.

`ctx.requireRule(id)` returns `NOT_FOUND` — never `FORBIDDEN` — for a rule
belonging to another shop, so the response does not reveal that it exists.

### Errors: two audiences

`AppError` carries a code. `toAppError` logs the technical detail with a request
id; `toPayload()` returns only a plain merchant-facing sentence. Raw messages
from Shopify, Prisma, or an AI provider are never rendered to a merchant.

`Response` objects thrown by React Router and Shopify are re-thrown untouched,
because those are control flow (redirects, auth bounces), not errors.

### AI is constrained by schema, not by prompt

The model may return exactly two shapes: a rule, or a clarification request.
There is no free-text escape hatch. Whatever it produces is parsed against
`AIRuleResponseSchema`, and anything else is discarded.

This is why prompt injection is a non-event here: a successful injection still
cannot emit a condition kind that does not exist, a non-Shopify gid, an
unsupported customer tag, or an action type outside WARN/BLOCK. Merchant text is
delimited in `<merchant_request>` tags and labelled as data.

No code is generated, returned, or evaluated. Ever.

### Storefront code is deliberately primitive

`cartsentry-warnings.js` is plain ES5-style JavaScript with no dependencies,
because it runs on every shopper's cart page. It fetches a minimal projection of
the warning rules through a signed app proxy, caches it in `sessionStorage`, and
renders with `textContent` — never `innerHTML`.

It shows warnings only. A shopper who blocks it, clears storage, or edits the
DOM gains nothing, because enforcement is server-side.

## Accessibility

- Status is never colour-only: every badge carries a word.
- Filter selection is expressed in the accessible label, not just the variant.
- Simulator results use `role="status"` regions on the storefront side.
- All form controls are labelled; visually-hidden labels use Polaris's
  `labelAccessibilityVisibility="exclusive"` rather than being omitted.

## Internationalisation

`app/lib/i18n.ts` is a lookup layer. UI strings go through `t()` rather than
being inlined, so adding a locale is a data change. English is the only bundled
dictionary; `PLANNED_LOCALES` records the intended set.

## Extension points

The architecture anticipates, without building:

- **Advanced analytics** — `UsageMetric` and `RuleDailyStat` already exist.
- **AI optimisation** — `AIRequest` records prompts, outcomes and latency.
- **Agency / multi-store** — every table is already keyed by `shopId`; a parent
  organisation is an added table, not a migration of existing data.
