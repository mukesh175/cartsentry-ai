# Shopify App Store review checklist

Status against Shopify's review criteria. Items marked **Needs store testing**
are implemented but not yet verified on a live development store — see
TESTING.md for the exact steps.

## Installation and authentication

| Item | Status | Where |
|---|---|---|
| OAuth via official library | Implemented | `app/shopify.server.ts` |
| Embedded app with App Bridge | Implemented | `app/routes/app.tsx` |
| Session storage | Implemented | `PrismaSessionStorage` |
| Access tokens never sent to the browser | Implemented | No loader returns one; logger redacts |
| Reinstall restores configuration | Implemented | Uninstall marks, does not delete |
| Requests minimum scopes | Implemented | 4 scopes; `read_customers` deliberately not requested |
| Installs without errors | **Needs store testing** | |

## Billing

| Item | Status | Where |
|---|---|---|
| Uses Shopify Billing API | Implemented | `appSubscriptionCreate` |
| Merchant approves each charge | Implemented | Confirmation URL flow |
| Test charges outside production | Implemented | `test: !isProduction` |
| Plan state read back from Shopify | Implemented | `syncSubscription` |
| Downgrade does not destroy data | Implemented | Documented in BILLING.md |
| Entitlements enforced server-side | Implemented | `entitlements.server.ts` |
| Upgrade / downgrade / cancel flows | **Needs store testing** | |

## Webhooks and privacy

| Item | Status | Where |
|---|---|---|
| `customers/data_request` | Implemented | `webhooks.compliance.tsx` |
| `customers/redact` | Implemented | Same |
| `shop/redact` | Implemented | Same — the only permanent deletion path |
| `app/uninstalled` | Implemented | `webhooks.app.uninstalled.tsx` |
| HMAC verified before processing | Implemented | `authenticate.webhook` first line |
| Idempotent and retry-safe | Implemented | Repeat delivery is a no-op |
| Privacy policy | **To supply at submission** | |

## Functionality

| Item | Status |
|---|---|
| No placeholder or non-functional buttons | Implemented — features are hidden, not shown broken |
| No fabricated data anywhere in the UI | Implemented — analytics state what they cannot measure |
| Empty, loading, error and success states on every page | Implemented |
| Friendly error messages, technical detail logged server-side | Implemented |
| Health check endpoint | Implemented — `/healthz` |
| Function deploys and enforces | **Needs store testing** |
| Theme extension renders | **Needs store testing** |

## Performance

| Item | Status |
|---|---|
| Storefront script is dependency-free and small | Implemented — plain JS, no framework |
| Storefront config cached per session | Implemented |
| No admin or database code on the storefront | Implemented |
| Database indexed on every query path | Implemented |
| Rule lists paginated | Implemented |
| Function configuration size-capped | Implemented — 60 KB with a merchant warning |

## Design and accessibility

| Item | Status |
|---|---|
| Polaris web components throughout | Implemented |
| App nav follows Shopify conventions | Implemented |
| Status never conveyed by colour alone | Implemented — every badge carries a word |
| All form controls labelled | Implemented |
| Live regions for async storefront content | Implemented — `role="status"` |
| Responsive layouts | Implemented — auto-fit grids |

## Prohibited techniques — explicit confirmation

CartSentry does **none** of the following. Each is verifiable in the source.

- No Shopify Plus bypass of any kind
- No `checkout.liquid` modification
- No injection into protected checkout surfaces
- No undocumented or private APIs
- No admin scraping or browser automation
- No circumvention of plan restrictions
- No misleading capability claims in listing copy
- No execution of AI-generated code — the AI can only emit schema-validated data
- No storage of customer personal data

## Listing accuracy

| Claim | Verified by |
|---|---|
| "Works on every Shopify plan" | Validation functions are available on all plans — SHOPIFY_CAPABILITIES.md |
| "Enforced server-side" | The function runs on Shopify's infrastructure |
| "Customers cannot bypass it" | Enforcement is not client-side; applies to express checkouts |
| "Nothing is activated automatically" | New and AI-drafted rules are always DRAFT; activation is a separate gated action |
| "Downgrading never deletes rules" | BILLING.md, and the downgrade preview in the UI |
| No conversion or revenue claims | Analytics page states the measurement limitation |

## Outstanding before submission

1. Run the full store test pass (TESTING.md) on a development store.
2. Deploy the function with `shopify app deploy` and confirm enforcement end to end.
3. Capture the six listing screenshots on a real store.
4. Supply a privacy policy URL and a support email.
5. Confirm the app proxy subpath does not collide on the test store.
