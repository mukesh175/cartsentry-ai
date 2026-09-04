# Billing

## Plans

| | Free | Starter | Growth | Pro |
|---|---|---|---|---|
| Price / month | $0 | $9 | $29 | $79 |
| Active rules | 3 | 10 | 25 | 100 |
| Simulations / month | 10 | Unlimited* | Unlimited* | Unlimited* |
| AI rule generations / month | — | — | 200 | 1,000 |
| History retention | 7 days | 30 days | 90 days | 365 days |
| Storefront warnings | — | Yes | Yes | Yes |
| Rule version history | — | Yes | Yes | Yes |
| AI Rule Creator | — | — | Yes | Yes |
| Advanced conflict detection | — | — | Yes | Yes |
| Advanced analytics | — | — | Yes | Yes |
| CSV export | — | — | — | Yes |

\* Subject to fair use.

**Every rule type is available on every plan, including Free.** Paying raises
limits and adds tooling — it never unlocks a capability Shopify itself provides
for free. Enforcement works identically on all four plans.

## How charging works

CartSentry uses Shopify's `appSubscriptionCreate` mutation, so charges appear on
the merchant's regular Shopify invoice. There is no external payment processor
and the app never handles card details.

Flow:

1. Merchant picks a plan. The app shows a **preview** of the impact first
   (rule-count implications, capabilities lost on a downgrade).
2. On confirmation, `appSubscriptionCreate` returns a `confirmationUrl`.
3. The app navigates the **top-level** window there — Shopify's approval screen
   cannot render inside the embedded iframe.
4. The merchant approves the charge in Shopify.
5. They return to `/app/billing`, which calls `syncSubscription` to read the
   authoritative state back from Shopify and record it.

The local `Subscription` row is never the source of truth for what the merchant
is paying. Shopify is. `syncSubscription` runs on every load of the billing
page, so a subscription cancelled in the Shopify admin is noticed without
waiting for a webhook.

Charges are created with `test: true` outside production, so development stores
are never really billed.

## Downgrades: rules are never deleted

This is the single most important behaviour in this document.

When a merchant downgrades or cancels:

- **No rule is deleted.**
- **No rule is deactivated.** Rules that were live stay live and keep enforcing.
- The app shows: *"You currently have 18 active rules. Your new plan supports 10."*
- They cannot **activate more** rules until they are back under the limit.
- They are offered three ways forward: review rules, disable some, or upgrade.

Deleting or silently disabling a merchant's configuration to fit a smaller plan
would destroy work they own. The plan governs what they can add, not what they
have already built.

Capabilities do turn off. A merchant dropping from Growth to Starter loses the
AI Rule Creator, but every rule the AI previously drafted keeps working and
stays fully editable in the manual builder.

## Entitlement enforcement

Enforced server-side in `app/lib/billing/entitlements.server.ts`:

- `assertEntitled(ctx, capability)` — feature gates
- `assertCanActivateRule(ctx)` — active-rule limit
- `assertCanSimulate(ctx)` — monthly simulation quota
- `assertCanUseAI(ctx)` — AI capability plus monthly quota

The UI hides unavailable features, but that is presentation. A request reaching
the server without the entitlement is rejected with a `PLAN_LIMIT` error that
names the plan required.

Quotas reset on the first day of each calendar month (UTC).

## Uninstall

`app/uninstalled` marks the subscription cancelled, since Shopify ends it the
moment the app is removed. Rules are retained in case of reinstall; permanent
deletion happens only on `shop/redact`.

## Testing billing

Use a Shopify development store. Charges are automatically created as test
charges outside production, so they can be approved and cancelled freely
without money moving.

Suggested passes:

1. Free → Starter: approve, confirm the plan and limits update.
2. Starter → Growth: confirm the AI Rule Creator appears in the nav.
3. Create 12 active rules on Growth, then downgrade to Starter (limit 10):
   confirm all 12 still exist and still enforce, that the over-limit banner
   appears, and that activating a 13th is refused.
4. Cancel: confirm the plan returns to Free and, again, that no rule was lost.
5. Decline the charge on Shopify's screen: confirm the app stays on the old plan.
