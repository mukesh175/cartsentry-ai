# App Store listing

## Naming

- **App name**: CartSentry AI
- **Title**: CartSentry AI — Smart Purchase Rules
- **Tagline**: Prevent invalid purchases before checkout.

## Short description

Create purchase rules without code. Test them on a sample cart, catch rules that
contradict each other, warn customers early, and enforce it all with Shopify's
own checkout validation.

## Long description

**Stop invalid orders before they become support tickets.**

Every store has rules that live in someone's head. Maximum five per customer.
Wholesale accounts spend at least $500. This product needs that one. Right now
those rules are enforced by hoping, or by cancelling orders afterwards.

CartSentry turns them into real rules your store actually enforces.

**Build a rule without writing code**

Pick a condition, set a threshold, write the message your customer sees. Or
describe it in plain English and let CartSentry draft it for you — you review
every detail before anything goes live.

**Know what will happen before it happens**

The simulator is the part merchants tell us they cannot work without. Build a
test cart, run it, and see exactly what a customer would experience — which rule
fired, what it expected, what the cart actually had, and what to change. It runs
the same engine that runs at checkout, so it is a genuine prediction rather than
a guess.

**Catch rules that fight each other**

If one rule requires a minimum of 5 and another caps it at 3, no customer can
ever buy that product. CartSentry finds contradictions like that automatically,
explains why in plain language, and will not let you activate a rule with an
unresolved critical conflict.

**Tell customers early, not at checkout**

Being blocked at checkout is frustrating. CartSentry can show a warning in the
cart instead, so shoppers can fix the problem while they still want to.

**Enforced by Shopify, not by JavaScript**

Rules are enforced by a Cart and Checkout Validation Function running on
Shopify's own servers. A shopper cannot get around it by editing the page or
using Shop Pay, PayPal, Apple Pay or Google Pay.

Available on **every Shopify plan**. You do not need Shopify Plus.

## Features

- Visual rule builder — no code
- AI Rule Creator: describe a rule in plain English (Growth and above)
- Rule simulator with a step-by-step customer journey and failure explanations
- Conflict detection with proof, severity and suggested fixes
- Storefront warnings in the cart and on product pages (Starter and above)
- Server-side enforcement via Shopify Functions, on all plans
- Rule templates for the ten most common cases
- Rule version history and one-click rollback
- Full activity log: who changed what, when
- Purchase Rules Health score with a complete, auditable breakdown

## Rule types

- Maximum / minimum product quantity
- Maximum / minimum cart quantity
- Maximum / minimum order value
- Products that cannot be bought together
- Products that require another product
- Collection minimum / maximum quantity
- Customer tag rules (wholesale, B2B, VIP, trade, distributor, retail, staff)
- First-time versus returning customer
- Delivery country and cart currency

## Use cases

**Wholesale and B2B** — minimum order values for tagged accounts, without a
separate wholesale storefront.

**Product launches** — cap units per order so one buyer cannot take the stock.

**Limited editions** — cap how many items from a collection one order can hold.

**Products with requirements** — an item that must ship with its installation
service, or a part that needs its adapter.

**High-value stores** — cap order size so unusually large orders route through
your sales team.

**Agencies** — configure and test purchase rules for client stores without
custom development.

## FAQ

**Do I need Shopify Plus?**
No. CartSentry uses Cart and Checkout Validation Functions, which Shopify makes
available on every plan.

**Will customers see my message?**
Yes, exactly as you write it, in the cart and at checkout.

**Can a customer get around a rule?**
No. Enforcement runs on Shopify's servers, not in the browser, and it applies to
express checkouts too.

**What happens if the app has a problem?**
Purchases are allowed. We deliberately fail open — a bug in our app must never
stop your store from selling.

**Does the AI change my store on its own?**
No. It drafts a rule. You review it, test it, and activate it yourself. Nothing
is ever activated automatically.

**Can I use my own customer tags?**
CartSentry supports a fixed set: wholesale, b2b, vip, trade, distributor,
retail, staff. This is a Shopify Functions constraint, not a paywall — the tag
list is fixed when the app's function is deployed. Contact us if you need
another one.

**What happens if I downgrade?**
Nothing is deleted. Every rule stays exactly as configured and the live ones keep
working. You just cannot activate more until you are under the new limit.

**Do you store my customers' data?**
No. No names, emails, addresses, or order contents. The validation function reads
cart data on Shopify's servers and never sends it to us.

## Pricing

| Plan | Price | Highlights |
|---|---|---|
| Free | $0 | 3 active rules, 10 simulations/month, templates, basic conflict detection |
| Starter | $9/mo | 10 active rules, unlimited simulations, storefront warnings, version history |
| Growth | $29/mo | 25 active rules, AI Rule Creator, advanced simulator and conflict detection, advanced analytics |
| Pro | $79/mo | 100 active rules, full history, CSV export, priority support |

## Screenshot plan

1. **Dashboard** — health score expanded to show the point-by-point breakdown.
2. **Rule builder** — a maximum-quantity rule with the live WHEN/THEN preview.
3. **Simulator** — a FAILED result with the customer-journey timeline and the
   "Why?" table showing expected versus actual.
4. **Conflict Center** — a critical conflict with its plain-English explanation
   and suggested fix.
5. **AI Rule Creator** — a plain-English request and its structured
   interpretation, with the assumptions panel visible.
6. **Storefront** — a cart page showing the early warning to a customer.

Every screenshot must use a real development store. No mock-ups, no invented
metrics.

## Demo video script (60 seconds)

- **0–8s** — A cart with 6 units. Checkout is blocked with a clear message.
  "This is what CartSentry does. Here is how long it took to set up."
- **8–22s** — Rule builder: pick the product, set the limit to 5, write the
  message. The preview updates live.
- **22–38s** — Simulator: 6 units, FAILED, and the explanation — expected at
  most 5, cart has 6, one more than the limit.
- **38–48s** — Conflict Center: a second rule that contradicts the first, caught
  before activation with an explanation of why.
- **48–56s** — Activate, with the confirmation dialog making the impact explicit.
- **56–60s** — "Works on every Shopify plan. No Plus required, no code."

## Keywords

Used naturally in the copy above, not stuffed:

purchase rules, cart validation, checkout validation, minimum order,
maximum quantity, quantity limits, cart rules, product restrictions,
purchase limits, wholesale rules, B2B Shopify, product compatibility,
order limits, cart validation app

## Support

- Email: support@cartsentry.app
- In-app Help covers how rules work, how enforcement works, plan requirements,
  testing, conflicts, billing and privacy.
- Documentation: `docs/` in the repository.

## Claims we do not make

For reviewer clarity, CartSentry's marketing never says any of the following,
because none of them would be true:

- "Bypass Shopify Plus"
- "Unlock Plus checkout features"
- "Edit Shopify checkout on any plan"
- Any figure for checkout conversion, revenue saved, or shoppers blocked —
  Shopify Functions do not report per-shopper events to apps, so any such number
  would be invented.
