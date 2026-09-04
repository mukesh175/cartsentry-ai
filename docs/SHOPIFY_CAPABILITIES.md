# Shopify platform capabilities

Audited against Shopify's official documentation before implementation. API version **2026-07**.

The purpose of this document is to record what Shopify actually supports, so that
nothing in CartSentry relies on a workaround, an undocumented endpoint, or a
capability the merchant's plan does not have.

## Summary of the decisive finding

**Cart and Checkout Validation Functions are available on every Shopify plan.**
They are not restricted to Shopify Plus. This is what makes CartSentry viable as
a product without touching anything Plus-gated: rules are enforced server-side,
on Shopify's own infrastructure, on all plans.

Shopify limits a store to **25 validation functions**. CartSentry compiles all of
a merchant's active rules into a **single** validation, so it consumes one slot
regardless of how many rules the merchant creates.

## Capability matrix

| Feature | Supported? | Plan requirement | API / extension | Limitation | Our implementation |
|---|---|---|---|---|---|
| Server-side purchase validation | Yes | All plans | Cart and Checkout Validation Function, target `cart.validations.generate.run` | 25 validations per store | One validation holding all rules — `extensions/purchase-rules-validation` |
| Register / update the validation | Yes | All plans | `validationCreate`, `validationUpdate` (scope `write_validations`) | — | `app/lib/shopify/validation.server.ts` |
| Function configuration storage | Yes | All plans | Metafield on the Validation, read via `validation { metafield }` | Metafield value is size-capped | Compiled to a compact JSON document, capped at 60 KB with a merchant-facing warning |
| Errors shown in cart | Yes | All plans | Validation function output, `target: "$.cart"` | — | Merchant's own message, verbatim |
| Errors shown at checkout | Yes | All plans | Same | Also applies to Shop Pay, PayPal, Google Pay, Apple Pay | Same |
| Errors in Storefront API carts | Yes | All plans | Cart object | — | Same |
| Product quantity / cart quantity / subtotal conditions | Yes | All plans | Function input `cart.lines`, `cart.cost` | — | Full support |
| Customer tags | Partial | All plans | `customer.hasTags(tags:)` | The tag list is **static per deploy** — a Function input query cannot be parameterised per shop | Fixed supported vocabulary; the rule builder offers a picker, not a text box |
| Customer order count | Yes | All plans | `customer.numberOfOrders` | Guests have none | Guests treated as 0 |
| Collection membership | Partial | All plans | `Product.inAnyCollection(ids:)` | Needs literal IDs in a static query | Resolved at publish time via the Admin API and shipped inside the configuration |
| Delivery country | Yes | All plans | `cart.deliveryGroups[0].deliveryAddress.countryCode` | Unknown until an address exists | Treated as *undeterminable*, never guessed |
| Storefront warnings (cart, product page) | Yes | All plans | Theme app extension + app proxy | Requires the merchant to add the app block | `extensions/cartsentry-warnings` |
| Checkout UI extensions | Not used | Some placements need Plus | Checkout UI extensions | Placement restrictions vary by plan | Deliberately not used — see LIMITATIONS.md |
| Editing checkout.liquid | **No** | Shopify Plus only | — | Plus-only by design | Never attempted |
| Billing | Yes | All plans | `appSubscriptionCreate`, `appSubscriptionCancel` | Merchant approves each charge | `app/lib/billing/billing.server.ts` |
| Resource pickers | Yes | All plans | App Bridge `resourcePicker` | — | Used instead of a custom product search |
| Mandatory privacy webhooks | Required | All plans | `customers/data_request`, `customers/redact`, `shop/redact` | HMAC verified | `app/routes/webhooks.compliance.tsx` |
| Embedded admin UI | Yes | All plans | App Bridge + Polaris web components | — | React Router 7 template |

## Where validation does *not* apply

Shopify documents these as outside the validation function's reach. CartSentry
does not claim to cover them, and the Help page says so:

- Create Order API
- Order editing in the Shopify admin
- Shopify POS
- Pre-orders and Try Before You Buy
- Subscription contracts

## Constraints that shaped the design

1. **Function input queries are static.** They are fixed at deploy time and
   cannot vary per shop. This is the single biggest constraint, and it is why
   customer tags are a fixed vocabulary and collection membership is resolved at
   publish time rather than at runtime.

2. **Functions do not call back into the app.** They run on Shopify's servers
   and report nothing per-shopper. This is why CartSentry's analytics report
   what the app can observe and explicitly do not report checkout conversion or
   how many shoppers hit a rule.

3. **A throwing function is dangerous.** `blockOnFailure` is set to `false` and
   the function catches everything, so a bug in CartSentry degrades to "the rule
   did not apply" rather than "the store cannot sell anything".

4. **Validation configuration is size-capped.** Rules compile to short keys, and
   the app refuses to publish over 60 KB rather than letting Shopify reject it.

## Sources

- [Cart and Checkout Validation Function API](https://shopify.dev/docs/api/functions/latest/cart-and-checkout-validation)
- [About cart and checkout validation](https://shopify.dev/docs/apps/build/checkout/cart-checkout-validation)
- [Create checkout validation](https://shopify.dev/docs/apps/build/checkout/cart-checkout-validation/create-checkout-validation)
- [validationCreate mutation](https://shopify.dev/docs/api/admin-graphql/latest/mutations/validationCreate)
- [Scaffold an app](https://shopify.dev/docs/apps/build/scaffold-app)
