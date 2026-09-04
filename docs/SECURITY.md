# Security

## Threat model

CartSentry is a multi-tenant Shopify app. The threats that matter most, in
order:

1. **Cross-tenant data access** — one merchant reading or modifying another's rules.
2. **Forged webhooks** — an attacker deleting a shop's data by posting to a webhook URL.
3. **Prompt injection** — merchant text steering the AI into producing something harmful.
4. **Credential exposure** — access tokens or API keys reaching a browser or a log.
5. **Storefront tampering** — a shopper trying to defeat a purchase rule.

## Multi-tenancy

Every merchant-facing loader and action starts with `requireTenant(request)`,
which authenticates through Shopify and resolves the `Shop` row. All data access
then goes through the returned `TenantContext`.

- `ctx.scope` is `{ shopId }` and is spread into every query.
- In constructed `where` clauses, `shopId` is placed **last**, so a caller-supplied
  filter field cannot override the security boundary.
- `ctx.requireRule(id)` scopes by `shopId` and throws `NOT_FOUND`, not
  `FORBIDDEN`, for another shop's rule — the response does not confirm it exists.
- Webhook handlers, which have no session, resolve their shop by verified domain
  and build the same context.

This is a wrapper rather than a convention because a forgotten `where: { shopId }`
is a data leak, and conventions get forgotten.

## Authentication

- OAuth is handled entirely by `@shopify/shopify-app-react-router`.
- Sessions are stored in PostgreSQL via `PrismaSessionStorage`.
- **Access tokens never leave the server.** No loader returns one, and the
  logger redacts `accessToken` and `refreshToken` at any depth.
- Offline tokens are used for webhook-initiated Admin API calls.
- Expiring offline access tokens are enabled (`future.expiringOfflineAccessTokens`).

## Webhook verification

Every webhook route calls `authenticate.webhook(request)` first, which verifies
the HMAC. An unsigned or tampered request never reaches handler logic.

Handlers are:

- **Idempotent** — a repeat delivery is a no-op, not an error.
- **Retry-safe** — processing failures are logged and acknowledged rather than
  returning a non-2xx that makes Shopify retry a broken operation forever.
- **Tenant-scoped** — the shop comes from the verified payload, never a query
  parameter.

`shop/redact` is the only path that permanently deletes merchant data.
`app/uninstalled` deliberately does not, so a reinstall restores the merchant's
configuration.

## Input validation

Everything crossing a trust boundary is parsed with zod before use:

| Input | Schema |
|---|---|
| Rule create / update | `RuleInputSchema` |
| Rule definitions | `RuleDefinitionSchema` (`.strict()` — unknown keys rejected) |
| Simulator scenarios | `ScenarioSchema` |
| AI output | `AIRuleResponseSchema` |
| Settings | `SettingsSchema` |
| Environment | `EnvSchema`, parsed once at boot |

Shopify global IDs are regex-validated (`^gid://shopify/[A-Za-z]+/\d+$`), so a
`javascript:` URL or arbitrary string cannot be stored as a resource reference.

## AI safety

The AI can only ever produce data, never behaviour.

- **Two permitted output shapes**: a rule, or a clarification request. No free-text field.
- **Schema-validated**: output failing `AIRuleResponseSchema` is discarded and
  the merchant is told to rephrase or build the rule manually.
- **No code path executes model output.** Nothing is `eval`'d, no shell is
  invoked, no query is constructed from it.
- **Merchant text is delimited and labelled as data** inside
  `<merchant_request>` tags; closing tags in the input are stripped so the
  delimiter cannot be escaped.
- **The system prompt names the attack** and instructs the model to treat
  instruction-like text as a nonsensical rule description.

The defence that actually matters is the schema, not the prompt. Even a fully
successful injection cannot emit an unknown condition kind, a non-Shopify gid,
an unsupported customer tag, or an action outside `WARN`/`BLOCK` — the tests in
`app/lib/ai/__tests__/rule-creator.test.ts` assert exactly this.

## Rate limiting

- AI requests: per-shop hourly cap (`AI_MAX_REQUESTS_PER_HOUR`, default 60),
  enforced by counting recorded requests, plus a monthly plan quota.
- Simulations: monthly plan quota, enforced server-side.
- Provider calls carry an `AbortController` timeout (`AI_TIMEOUT_MS`).

## Entitlements

Plan gating is enforced **on the server**, in `entitlements.server.ts`, before
any gated work happens. The UI reads the same table to hide unavailable
features, but a hidden button is a courtesy — a request that reaches the server
without the entitlement is rejected with `PLAN_LIMIT`.

## Logging

`app/lib/logger.server.ts` enforces redaction at the logger, not at call sites,
so a future `logger.info({ session })` cannot leak a token.

Redacted: `accessToken`, `refreshToken`, `apiKey`, every provider key,
`SHOPIFY_API_SECRET`, `SESSION_SECRET`, `authorization`, `cookie`, and wildcard
variants.

Never logged: customer personal data, full request bodies, AI system prompts,
or provider responses beyond a status classification.

Every log line carries a request id, which is what a merchant quotes to support.

## Storefront

- The app proxy verifies Shopify's signature before answering.
- The response is a **minimal projection**: no rule ids, internal names,
  priorities, or full definitions — only what is needed to display a warning.
- Rules whose conditions cannot be checked client-side are omitted rather than
  approximated.
- The renderer uses `textContent` exclusively; merchant copy is never treated as
  markup, so a rule message cannot become stored XSS.
- Enforcement is entirely server-side, so tampering with the script, its cache,
  or the DOM gains a shopper nothing at checkout.

## Secrets

- All secrets come from environment variables; none are committed.
- `.env` is gitignored (`.env.example` is explicitly un-ignored so the template
  is committed).
- The app fails fast at boot on invalid configuration rather than starting in a
  half-configured state.
- `DEMO_MODE` is ignored in production, with a warning logged, so a stray
  variable can never serve fabricated data to a live merchant.

## Data minimisation

CartSentry stores rules, simulations, activity, usage counts, and the shop's own
identity (domain, name, currency, timezone).

It does **not** store customer names, email addresses, addresses, or order
contents. The validation function reads cart data on Shopify's servers and never
transmits it to us. This is why the `customers/data_request` and
`customers/redact` webhooks are honest no-ops.

## Known residual risks

- **Merchant-authored rule messages** are shown to shoppers. They are rendered
  as text everywhere, but a merchant can still write a misleading message. This
  is inherent to the product.
- **App proxy responses are cacheable for 5 minutes**, so a warning can lag a
  rule change by that much. Enforcement does not lag.
- **A compromised merchant admin account** can create rules that block sales.
  This is equivalent to any other admin capability and is mitigated by the
  activity log, which records who changed what and when.
