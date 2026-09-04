/**
 * CartSentry AI — canonical rule definition schema.
 *
 * This is the single source of truth for what a purchase rule is. Everything
 * else derives from it:
 *
 *   - the visual rule builder writes it
 *   - the AI Rule Creator must produce output that parses against it
 *   - the simulator evaluates it
 *   - the conflict detector reasons over it
 *   - the Function compiler turns it into the metafield configuration that the
 *     Cart & Checkout Validation Function reads at runtime
 *
 * Deliberately *not* shaped like Shopify's Function input. Adapting to Shopify
 * happens in `app/domain/compile.ts` so that a Shopify API change never forces
 * a migration of stored merchant rules.
 *
 * This module is dependency-free and runs unchanged inside the Shopify Function
 * (which has no Node runtime), so keep it free of Node/Prisma imports.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/** Comparison operators. Only operators the engine can actually evaluate. */
export const COMPARISON_OPERATORS = [
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
] as const;

/** Set/collection operators. */
export const SET_OPERATORS = [
  "in",
  "not_in",
  "contains",
  "not_contains",
] as const;

export const OperatorSchema = z.enum([
  ...COMPARISON_OPERATORS,
  ...SET_OPERATORS,
]);
export type Operator = z.infer<typeof OperatorSchema>;

/** Human-readable operator labels, used by the explanation engine and the UI. */
export const OPERATOR_LABELS: Record<Operator, string> = {
  eq: "is equal to",
  neq: "is not equal to",
  gt: "is greater than",
  gte: "is at least",
  lt: "is less than",
  lte: "is at most",
  in: "is one of",
  not_in: "is not one of",
  contains: "contains",
  not_contains: "does not contain",
};


/**
 * Customer tags a rule may reference.
 *
 * Not an arbitrary string. The Function input query asks Shopify
 * `customer.hasTags(tags: [...])` with a literal list, and a Function input
 * query is static per deploy — there is no way to inject a shop-specific tag
 * at runtime. So the vocabulary is fixed here, the query asks for exactly
 * these, and the rule builder offers them as a picker rather than a text box.
 *
 * Extending the list means editing this constant AND the matching `hasTags`
 * argument in
 * extensions/purchase-rules-validation/src/cart_validations_generate_run.graphql,
 * then redeploying. `customerTagsMatch` guards that they stay in step.
 */
export const SUPPORTED_CUSTOMER_TAGS = [
  "wholesale",
  "b2b",
  "vip",
  "trade",
  "distributor",
  "retail",
  "staff",
] as const;

export type SupportedCustomerTag = (typeof SUPPORTED_CUSTOMER_TAGS)[number];
/** A Shopify global ID plus the human-facing label we cached when it was picked. */
export const ResourceRefSchema = z.object({
  /** e.g. gid://shopify/Product/12345 */
  gid: z.string().regex(/^gid:\/\/shopify\/[A-Za-z]+\/\d+$/, "Invalid Shopify global ID"),
  /** Display title captured at selection time. Refreshed opportunistically. */
  title: z.string().max(255).default(""),
  /** Set to true when the resource can no longer be resolved in the shop. */
  missing: z.boolean().default(false),
});
export type ResourceRef = z.infer<typeof ResourceRefSchema>;

// ---------------------------------------------------------------------------
// Conditions
// ---------------------------------------------------------------------------

/**
 * Every condition kind the engine supports. Each maps to data the Cart &
 * Checkout Validation Function input can actually provide — nothing here is
 * inferred or fabricated.
 */
export const ConditionSchema = z.discriminatedUnion("kind", [
  /** Quantity of a specific product (summed across its variants) in the cart. */
  z.object({
    kind: z.literal("product_quantity"),
    product: ResourceRefSchema,
    /** Optional narrowing to a single variant. */
    variant: ResourceRefSchema.optional(),
    operator: z.enum(COMPARISON_OPERATORS),
    value: z.number().int().min(0).max(1_000_000),
  }),

  /** Total number of units in the cart. */
  z.object({
    kind: z.literal("cart_quantity"),
    operator: z.enum(COMPARISON_OPERATORS),
    value: z.number().int().min(0).max(1_000_000),
  }),

  /**
   * Cart subtotal. Currency is the cart's presentment currency; the merchant
   * states the amount in shop currency and we compare against the cart subtotal
   * as provided by Shopify without any conversion of our own.
   */
  z.object({
    kind: z.literal("cart_subtotal"),
    operator: z.enum(COMPARISON_OPERATORS),
    value: z.number().min(0).max(100_000_000),
    currencyCode: z.string().length(3),
  }),

  /** Total quantity of items belonging to a collection. */
  z.object({
    kind: z.literal("collection_quantity"),
    collection: ResourceRefSchema,
    operator: z.enum(COMPARISON_OPERATORS),
    value: z.number().int().min(0).max(1_000_000),
  }),

  /** Whether a given product is present in the cart at all. */
  z.object({
    kind: z.literal("product_present"),
    product: ResourceRefSchema,
    /** true => "is in the cart", false => "is not in the cart" */
    present: z.boolean(),
  }),

  /** Whether any product from a collection is present in the cart. */
  z.object({
    kind: z.literal("collection_present"),
    collection: ResourceRefSchema,
    present: z.boolean(),
  }),

  /**
   * Customer tag. Available from the Function input via
   * `cart.buyerIdentity.customer.hasTags`. Guests have no tags, so a
   * `contains` check is false for guests by definition.
   */
  z.object({
    kind: z.literal("customer_tag"),
    operator: z.enum(["contains", "not_contains"]),
    value: z.enum(SUPPORTED_CUSTOMER_TAGS),
  }),

  /**
   * Whether the buyer is a signed-in customer.
   * Derived from the presence of `cart.buyerIdentity.customer`.
   */
  z.object({
    kind: z.literal("customer_signed_in"),
    value: z.boolean(),
  }),

  /**
   * First-time vs returning buyer, from `customer.numberOfOrders`.
   * Guests are treated as having 0 orders.
   */
  z.object({
    kind: z.literal("customer_order_count"),
    operator: z.enum(COMPARISON_OPERATORS),
    value: z.number().int().min(0).max(1_000_000),
  }),

  /**
   * Shipping destination country, from the cart delivery address.
   * Unknown until a delivery address exists, so rules using this condition are
   * evaluated as "not yet determinable" during early cart interaction.
   */
  z.object({
    kind: z.literal("shipping_country"),
    operator: z.enum(["in", "not_in"]),
    /** ISO 3166-1 alpha-2 codes. */
    value: z.array(z.string().length(2)).min(1).max(250),
  }),

  /** Cart presentment currency, from `localization.country.currency`. */
  z.object({
    kind: z.literal("currency"),
    operator: z.enum(["in", "not_in"]),
    value: z.array(z.string().length(3)).min(1).max(200),
  }),
]);

export type Condition = z.infer<typeof ConditionSchema>;
export type ConditionKind = Condition["kind"];

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/**
 * WARN shows a storefront message via the theme app extension but does not stop
 * the purchase. BLOCK additionally emits a validation error from the Shopify
 * Function, which prevents checkout.
 */
export const ActionSchema = z.object({
  type: z.enum(["WARN", "BLOCK"]),
});
export type Action = z.infer<typeof ActionSchema>;

// ---------------------------------------------------------------------------
// Rule definition
// ---------------------------------------------------------------------------

/**
 * A rule fires when its condition group matches.
 *
 * `logic` combines the top-level conditions. `negate` wraps the whole group in
 * a NOT. Nested groups are intentionally not supported: they make conflict
 * analysis undecidable in practice and merchants consistently misread them.
 * Anything needing nesting can be expressed as two rules.
 */
export const RuleDefinitionSchema = z
  .object({
    /** Schema version, so stored rules can be migrated safely. */
    schemaVersion: z.literal(1).default(1),
    logic: z.enum(["AND", "OR"]).default("AND"),
    negate: z.boolean().default(false),
    conditions: z.array(ConditionSchema).min(1).max(10),
    action: ActionSchema,
  })
  .strict();

export type RuleDefinition = z.infer<typeof RuleDefinitionSchema>;

// ---------------------------------------------------------------------------
// Storefront warning configuration
// ---------------------------------------------------------------------------

export const WarningConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    title: z.string().max(120).default(""),
    /** Falls back to the rule's customer message when empty. */
    message: z.string().max(500).default(""),
    severity: z.enum(["info", "warning", "critical"]).default("warning"),
    showOnProduct: z.boolean().default(true),
    showInCart: z.boolean().default(true),
    icon: z.enum(["none", "alert", "info", "lock"]).default("alert"),
  })
  .strict();

export type WarningConfig = z.infer<typeof WarningConfigSchema>;

export const DEFAULT_WARNING_CONFIG: WarningConfig = WarningConfigSchema.parse({});

// ---------------------------------------------------------------------------
// Whole-rule payload (what the CRUD API accepts)
// ---------------------------------------------------------------------------

export const RULE_TYPES = [
  "PRODUCT_QUANTITY",
  "CART_QUANTITY",
  "CART_VALUE",
  "PRODUCT_COMBINATION",
  "REQUIRED_PRODUCT",
  "COLLECTION_QUANTITY",
  "CUSTOMER",
  "MARKET",
  "COMPOSITE",
] as const;
export type RuleTypeName = (typeof RULE_TYPES)[number];

export const RuleInputSchema = z.object({
  name: z.string().min(1, "Give the rule a name").max(120),
  description: z.string().max(500).optional(),
  /**
   * Customer-facing text. Shopify surfaces this verbatim in the cart and at
   * checkout, so it must be plain text — no markup is rendered.
   */
  message: z
    .string()
    .min(1, "Enter the message customers will see")
    .max(255, "Shopify truncates long validation messages; keep it under 255 characters"),
  priority: z.number().int().min(0).max(100).default(50),
  definition: RuleDefinitionSchema,
  warningConfig: WarningConfigSchema.default(DEFAULT_WARNING_CONFIG),
});

export type RuleInput = z.infer<typeof RuleInputSchema>;

// ---------------------------------------------------------------------------
// Derived helpers
// ---------------------------------------------------------------------------

/**
 * Classify a rule for filtering and reporting. Purely descriptive — the engine
 * never branches on it, so a misclassification cannot change enforcement.
 */
export function deriveRuleType(definition: RuleDefinition): RuleTypeName {
  const kinds = new Set(definition.conditions.map((c) => c.kind));

  const hasPresence = kinds.has("product_present") || kinds.has("collection_present");
  const hasCustomer =
    kinds.has("customer_tag") ||
    kinds.has("customer_signed_in") ||
    kinds.has("customer_order_count");
  const hasMarket = kinds.has("shipping_country") || kinds.has("currency");

  // A pair of presence conditions is the signature of the combination and
  // requirement rules. Compare on the conditions themselves, not on the set of
  // kinds — two `product_present` conditions are one *kind* but two conditions.
  if (definition.conditions.length === 2 && hasPresence && !hasCustomer && !hasMarket) {
    const presenceFlags = definition.conditions
      .filter((c) => c.kind === "product_present" || c.kind === "collection_present")
      .map((c) => (c as { present: boolean }).present);
    if (presenceFlags.length === 2) {
      // both present => "cannot be bought together"; mixed => "A requires B".
      return presenceFlags.every(Boolean) ? "PRODUCT_COMBINATION" : "REQUIRED_PRODUCT";
    }
  }

  if (definition.conditions.length > 1 || kinds.size > 1) {
    return "COMPOSITE";
  }

  const only = definition.conditions[0]!.kind;
  switch (only) {
    case "product_quantity":
      return "PRODUCT_QUANTITY";
    case "cart_quantity":
      return "CART_QUANTITY";
    case "cart_subtotal":
      return "CART_VALUE";
    case "collection_quantity":
      return "COLLECTION_QUANTITY";
    case "product_present":
    case "collection_present":
      return "PRODUCT_COMBINATION";
    case "customer_tag":
    case "customer_signed_in":
    case "customer_order_count":
      return "CUSTOMER";
    case "shipping_country":
    case "currency":
      return "MARKET";
  }
}

/** Every Shopify resource a rule depends on, for existence checks and webhooks. */
export function referencedResources(definition: RuleDefinition): ResourceRef[] {
  const refs: ResourceRef[] = [];
  for (const condition of definition.conditions) {
    if ("product" in condition && condition.product) refs.push(condition.product);
    if ("variant" in condition && condition.variant) refs.push(condition.variant);
    if ("collection" in condition && condition.collection) refs.push(condition.collection);
  }
  return refs;
}
