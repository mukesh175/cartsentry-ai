# Troubleshooting

## The app will not start

**`Invalid environment configuration`** — the app validates its environment at
boot and refuses to start half-configured. The error names the missing or
malformed variables. Check `.env` against `.env.example`.

**`Can't reach database server`** — `DATABASE_URL` is wrong or Postgres is
unreachable. On Neon, confirm you are using the **pooled** connection string for
runtime and the **direct** one for migrations.

**Prisma client is out of date** — run `npx prisma generate`. The build does
this automatically; a fresh clone does not.

## Rules are not being enforced

Work down this list in order:

1. **Is the rule Active?** Draft, Disabled and Needs-attention rules are never
   published.
2. **Did the last publish succeed?** Settings → Advanced lists every
   configuration version. A `FAILED` row newer than the latest `PUBLISHED` one
   means your recent changes are not live — the previous rules still are.
   Use *Republish rules to Shopify*.
3. **Is the function deployed?** `validationCreate` references the function by
   handle. If `shopify app deploy` has never run, publishing fails. Deploy, then
   republish.
4. **Is the order path covered?** Validation functions do not apply to the
   Create Order API, admin order editing, POS, pre-orders, or subscriptions.
5. **Does the rule actually match?** Run the scenario in the Simulator. It uses
   the same engine as checkout, so if it says the rule does not apply, it does
   not apply.

## A rule says "Needs attention"

It references a product, variant or collection that no longer exists in the
store. The rule is excluded from the published configuration, so it is enforcing
nothing.

Fix it by opening the rule and selecting a replacement resource, or by disabling
it. CartSentry never edits or deletes the rule for you.

Settings → *Re-check rule references* re-runs the check across all rules.

## Storefront warnings are not appearing

1. **Is the app block added?** Theme editor → cart template → add the CartSentry
   warnings block. Warnings do not render without it. Enforcement is unaffected.
2. **Is the rule's warning enabled?** Warnings are off by default and require
   Starter or above.
3. **Can the warning be evaluated client-side?** Only product quantity, cart
   quantity, cart subtotal and product presence are checkable from `cart.js`.
   Rules using customer tags, order history, country, currency or collections
   are deliberately skipped rather than guessed — they are still enforced at
   checkout.
4. **Stale cache?** The configuration is cached in `sessionStorage` for five
   minutes. Open a new tab or wait it out.
5. **App proxy reachable?** Load `https://<shop>/apps/cartsentry/warnings`
   directly. It should return JSON. A 404 means the proxy subpath is not
   configured or collides with another app.

## Collection rules seem out of date

Collection membership is resolved when rules are published, not at checkout —
see LIMITATIONS.md for why. A product added to a collection takes effect on the
next publish.

Settings → *Republish rules to Shopify* forces it. A `collections/update`
webhook also triggers it automatically.

Collections are truncated at 250 products. For very large collections, use a
product-based rule.

## Publishing fails

**"We could not publish your rules to Shopify"** — your previous rules are still
live and enforcing. Nothing has been lost. Settings → Advanced shows the failed
version and its error.

Common causes:

- The function has not been deployed (`shopify app deploy`).
- The `write_validations` scope is missing — reinstall the app to re-grant.
- The store already has 25 validation functions from other apps.
- The configuration exceeds 60 KB, which the error will say explicitly.

## The AI Rule Creator is unavailable

- **"Not available right now"** — no provider is configured. Set `AI_PROVIDER`
  and the matching key. The manual builder does everything the AI does.
- **"We could not turn that description into a rule"** — the model returned
  something that failed schema validation. Rephrase more concretely, or build it
  manually. This is the safety mechanism working, not a bug.
- **Rate limited** — an hourly per-shop cap plus a monthly plan quota. Both are
  shown on the page.
- **The rule references the wrong product** — expected. The AI does not know
  your product IDs and inserts a placeholder; open the draft and pick the real
  product. The app tells you this before you save.

## A conflict looks wrong

CartSentry only marks something CRITICAL when it can prove no cart satisfies
both rules. If you believe a critical finding is wrong:

- Check the two rules really do share a scope. Rules gated on mutually exclusive
  customer tags or non-overlapping countries are not reported as conflicting.
- Read the explanation — it states the permitted range of each rule.

Dismissing a conflict never changes your rules. It only hides the warning.

## Billing problems

**Charge approved but the plan did not change** — reload `/app/billing`, which
re-reads the subscription from Shopify. Shopify is the source of truth, not our
database.

**Over the rule limit after a downgrade** — expected and safe. Every rule is
kept and the live ones keep enforcing. You cannot activate more until you are
back under the limit.

**Charges on a development store** — those are test charges. No money moves.

## Diagnosing from logs

Every log line carries a `requestId` and `shopId`. Merchants see the same
request id in support-facing errors, so:

```
grep '"requestId":"<id>"' <log output>
```

gives the full server-side story for one merchant action. Secrets are redacted
at the logger, so logs are safe to share internally.

## Health check

```bash
curl https://<your-domain>/healthz
```

`{"status":"ok",...}` — app and database both fine.
`503` with `"database":"fail"` — Postgres unreachable; check `DATABASE_URL`.
