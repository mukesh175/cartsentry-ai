# Limitations

Written plainly and on purpose. A merchant who reads this should never be
surprised later, and a Shopify reviewer should be able to check every claim the
app makes.

## What CartSentry does not do

### It does not bypass Shopify Plus

CartSentry does not, and will never:

- edit `checkout.liquid` or any Plus-gated checkout customisation
- unlock a Plus-only capability on a non-Plus plan
- inject code into protected checkout surfaces
- use undocumented or private Shopify APIs
- scrape the Shopify admin or automate a browser to work around a restriction

It does not need to. Cart and Checkout Validation Functions — the mechanism it
uses — are available on **every** Shopify plan. That is the whole product
thesis: it is not a Plus workaround, it is the supported path.

### It does not report checkout conversion

The validation function runs on Shopify's servers and does not send per-shopper
events back to the app. CartSentry therefore **cannot** know how many customers
hit a rule, how many carts it blocked, or what revenue that represents.

Rather than estimate those numbers, the Analytics page reports only what the app
observes directly (rules created, activated, simulated, published; conflicts
found) and states this limitation on the page itself.

### It does not enforce per-customer limits across orders

A validation function sees one cart. It cannot see a customer's order history
beyond `numberOfOrders`. So "at most 5 units per customer, ever" is not
enforceable — only "at most 5 units per order".

The AI Rule Creator is instructed to ask for clarification when a request is
ambiguous between the two, rather than quietly building the wrong rule.

## Constraints inherited from the platform

### Customer tags are a fixed vocabulary

Supported: `wholesale`, `b2b`, `vip`, `trade`, `distributor`, `retail`, `staff`.

A function's input query asks Shopify for specific tags **by name**, and that
query is static per deploy — it cannot be parameterised per shop. So the app
cannot support arbitrary merchant-defined tags at runtime.

The rule builder therefore offers a picker rather than a free-text field, so a
merchant never types a tag that silently never matches. Extending the list means
editing `SUPPORTED_CUSTOMER_TAGS` in `packages/engine/src/rule-schema.ts` **and**
the matching `hasTags` argument in the function's input query, then redeploying.

### Collection membership updates on publish, not instantly

`Product.inAnyCollection(ids:)` also needs literal IDs in the static query, so
collection membership is resolved through the Admin API when rules are published
and shipped inside the configuration.

Consequences:

- A product added to a collection takes effect on the **next publish**.
  Settings → *Republish rules to Shopify* forces this immediately, and a
  `collections/update` webhook triggers it automatically.
- Collections are **truncated at 250 products**. For very large collections, a
  product-based rule is more reliable.
- Large collections consume configuration space against the 60 KB budget.

### Configuration size limit

All active rules compile into one metafield document, capped at 60 KB. In
practice that is several hundred rules, well beyond any plan's active-rule
limit. If it is ever exceeded, publishing is refused with a clear message rather
than failing silently at Shopify.

### Storefront warnings need a theme block, and are advisory

Warnings render through a theme app extension the merchant must add to their
cart template. If they never add it, **rules are still fully enforced** — they
just take effect at checkout instead of earlier.

The storefront script evaluates only conditions it can check from `cart.js`:
product quantity, cart quantity, cart subtotal, and product presence. Rules
using customer tags, order history, country, currency or collections are
skipped there rather than guessed at. The server always evaluates them all.

### Not applicable to some order paths

Shopify documents validation functions as not applying to the Create Order API,
admin order editing, POS, pre-orders / Try Before You Buy, or subscription
contracts.

## Behaviour under failure

| Situation | What happens | Why |
|---|---|---|
| The validation function throws | Purchase is allowed | `blockOnFailure: false`. Blocking every checkout store-wide is far worse than one rule not applying. |
| Configuration is unreadable | No rules apply | `safeParseConfig` fails open for the same reason. |
| Publishing to Shopify fails | The previous working configuration stays live | A failed publish never replaces working enforcement. The merchant is notified. |
| A rule's product is deleted | The rule is flagged *Needs attention* and excluded from the next publish | A rule that cannot be evaluated must not silently become always-true or always-false. It is never auto-edited or auto-deleted. |
| The AI provider is unavailable | The manual rule builder still does everything | AI is a convenience, never a dependency. |
| A merchant downgrades below their rule count | Every rule is kept, live ones keep working | Merchant configuration is theirs. They simply cannot activate more until back under the limit. |

## Plan gating in CartSentry itself

These are our commercial choices, not platform constraints:

| Capability | Lowest plan |
|---|---|
| Rule builder, all rule types, enforcement | Free |
| Simulator | Free (10/month), unlimited from Starter |
| Storefront warnings | Starter |
| Rule version history | Starter |
| AI Rule Creator | Growth |
| Advanced conflict detection | Growth |
| 90-day and custom analytics | Growth |
| CSV export | Pro |

Every **rule type** is available on every plan. Paying never unlocks a
capability Shopify offers for free — it raises limits and adds tooling.
