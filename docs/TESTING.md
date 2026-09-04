# Testing

## Automated tests

```bash
npm test          # 118 tests
npm run typecheck # typegen + tsc --noEmit
npm run build     # production build
```

### What is covered

| Area | File | Tests |
|---|---|---|
| Rule evaluation | `packages/engine/src/__tests__/evaluate.test.ts` | 33 |
| Conflict detection | `packages/engine/src/__tests__/conflicts.test.ts` | 21 |
| Function run export | `packages/engine/src/__tests__/function-run.test.ts` | 18 |
| Configuration compiler | `packages/engine/src/__tests__/compile.test.ts` | 25 |
| AI output validation | `app/lib/ai/__tests__/rule-creator.test.ts` | 17 |
| Plans and entitlements | `app/lib/billing/__tests__/plans.test.ts` | 14 |

Notable cases, mapped to the requirements they cover:

- **Rule engine** — min/max quantity, min/max cart value, required product,
  incompatible product, collection min/max, customer conditions, AND, OR, NOT,
  multiple rules, priority ordering, invalid rules, missing and deleted
  resources.
- **Conflicts** — 5-minimum vs 3-maximum, $1000-minimum vs $500-maximum,
  requirement vs incompatibility, redundancy, and explicit **no-false-positive**
  cases for different products, currencies, customer tags, countries and
  scopes.
- **Function** — enforcement at the boundary (5 passes, 6 blocks), priority
  ordering of messages, wholesale minimum, collection membership, delivery
  country, and every fail-open path (no config, malformed JSON, unknown version,
  missing input, missing merchandise).
- **AI** — every injection shape is rejected by the schema: extra executable
  fields, invented condition kinds, `javascript:` gids, unsupported tags,
  invalid actions, oversized messages.
- **Money** — integer-cent comparison, so `3 × 166.67` correctly passes a
  `>= 500` rule rather than failing on float error.

### What is *not* covered by automated tests

Honestly stated, because these need a real store:

- OAuth and installation
- The compiled WebAssembly function running on Shopify's infrastructure
- Theme app extension rendering in a real theme
- Billing approval flows
- Webhook delivery
- Database-level tenant isolation (the code path is scoped, but the assertion
  needs a live database with two shops)

## Store test plan

Run these on a Shopify development store after `shopify app deploy`.

### 1. Installation

- [ ] Install completes without error
- [ ] OAuth grants the four requested scopes
- [ ] Dashboard shows the empty state for a new store
- [ ] Uninstall, then reinstall — previous rules are still present

### 2. Scenario A — maximum quantity (the core promise)

1. [ ] Create: "Customers cannot buy more than 5 units of Product A"
2. [ ] The WHEN/THEN preview reads correctly
3. [ ] Simulate with quantity 5 → **PASS**
4. [ ] Simulate with quantity 6 → **FAIL**, showing expected 5, actual 6, and
       "1 more than the limit"
5. [ ] Activate — the confirmation dialog warns about customer impact
6. [ ] Settings shows the configuration as PUBLISHED
7. [ ] In the storefront, add 5 → checkout proceeds
8. [ ] Add a 6th → checkout is blocked with the exact configured message
9. [ ] Try Shop Pay / express checkout → also blocked
10. [ ] The activity log records creation, activation and publish

### 3. Scenario B — wholesale minimum

1. [ ] Tag a test customer `wholesale`
2. [ ] Create: "Wholesale customers must spend at least $500"
3. [ ] Simulate wholesale + $300 → **BLOCKED**
4. [ ] Simulate wholesale + $600 → **PASS**
5. [ ] Simulate untagged + $300 → **PASS** (rule does not apply)
6. [ ] Conflict Center reports no conflict
7. [ ] Activate; verify in the storefront as the tagged customer

### 4. Scenario C — the deliberate contradiction

1. [ ] Create "Product A requires Product B"
2. [ ] Create "Product A cannot be purchased with Product B"
3. [ ] Conflict Center reports a **CRITICAL, confirmed** conflict
4. [ ] The explanation states why no cart satisfies both
5. [ ] Activating either rule is **refused** with the conflict as the reason
6. [ ] Disabling one clears the conflict and allows activation

### 5. Theme extension

- [ ] Add the CartSentry block to the cart template
- [ ] Enable a warning on an active rule
- [ ] Exceed the limit in the cart → the warning appears
- [ ] Reduce the quantity → the warning disappears
- [ ] Remove the block → enforcement still works at checkout

### 6. Billing

- [ ] Free → Starter: approve, limits update
- [ ] Starter → Growth: the AI Rule Creator appears in the nav
- [ ] Create 12 active rules on Growth, downgrade to Starter (limit 10)
- [ ] **All 12 rules still exist and still enforce**
- [ ] The over-limit banner appears; activating a 13th is refused
- [ ] Cancel → plan returns to Free, **no rule lost**
- [ ] Decline a charge → the app stays on the previous plan

### 7. Resource deletion

- [ ] Create and activate a rule on a product
- [ ] Delete that product in Shopify
- [ ] The rule becomes **Needs attention** with a clear reason
- [ ] It is excluded from the republished configuration
- [ ] Checkout is no longer blocked by it
- [ ] Selecting a replacement product restores it to Draft

### 8. Tenant isolation

With two development stores installed:

- [ ] Store A's rule ids return **404** when requested while authenticated as Store B
- [ ] Store B's rule list contains none of Store A's rules
- [ ] Store B's conflict scan considers only Store B's rules
- [ ] `shop/redact` for Store A leaves Store B's data untouched

### 9. Failure behaviour

- [ ] Stop the database → `/healthz` returns 503; the admin shows a friendly error, not a stack trace
- [ ] Remove the AI key → the AI page offers the manual builder instead of a broken button
- [ ] Force a publish failure → previous rules stay live and the merchant is notified

## Current results

```
Test Files  6 passed (6)
     Tests  118 passed (118)

tsc --noEmit    clean
react-router build  succeeds
```

All implemented automated tests pass. The store test plan above has **not** been
run — it requires a Shopify Partner account and a development store, which were
not available in this environment.
