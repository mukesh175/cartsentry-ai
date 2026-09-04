/**
 * Rule templates.
 *
 * A template is a partially-filled rule: everything except the merchant's own
 * products, thresholds and wording. Choosing one opens the normal rule builder
 * pre-filled, so there is no separate "template mode" to maintain.
 *
 * `requiresProduct` / `requiresCollection` tell the builder which resource
 * pickers to open first.
 */

import type { RuleInput } from "@cartsentry/engine";

export interface RuleTemplate {
  id: string;
  title: string;
  summary: string;
  /** Which merchant problem this maps to, used by onboarding. */
  problem: string;
  requiresProduct: number;
  requiresCollection: number;
  /** A draft with placeholder resources the builder will replace. */
  build: () => Omit<RuleInput, "warningConfig"> & { warningConfig?: RuleInput["warningConfig"] };
}

/** Placeholder the builder swaps out once the merchant picks a real resource. */
const PLACEHOLDER_PRODUCT = {
  gid: "gid://shopify/Product/0",
  title: "Choose a product",
  missing: false,
};
const PLACEHOLDER_PRODUCT_B = {
  gid: "gid://shopify/Product/1",
  title: "Choose a second product",
  missing: false,
};
const PLACEHOLDER_COLLECTION = {
  gid: "gid://shopify/Collection/0",
  title: "Choose a collection",
  missing: false,
};

export const TEMPLATES: RuleTemplate[] = [
  {
    id: "max-product-quantity",
    title: "Maximum product quantity",
    summary: "Stop customers buying more than a set number of one product.",
    problem: "maximum-quantity",
    requiresProduct: 1,
    requiresCollection: 0,
    build: () => ({
      name: "Maximum product quantity",
      description: "Limits how many units of one product a customer can buy in a single order.",
      message: "You can purchase a maximum of 5 units of this product.",
      priority: 50,
      definition: {
        schemaVersion: 1,
        logic: "AND",
        negate: false,
        conditions: [
          {
            kind: "product_quantity",
            product: PLACEHOLDER_PRODUCT,
            operator: "gt",
            value: 5,
          },
        ],
        action: { type: "BLOCK" },
      },
    }),
  },

  {
    id: "min-product-quantity",
    title: "Minimum product quantity",
    summary: "Require a minimum number of units when a product is bought.",
    problem: "minimum-quantity",
    requiresProduct: 1,
    requiresCollection: 0,
    build: () => ({
      name: "Minimum product quantity",
      description: "Requires a minimum order quantity for a product.",
      message: "This product must be ordered in quantities of 5 or more.",
      priority: 50,
      definition: {
        schemaVersion: 1,
        logic: "AND",
        negate: false,
        conditions: [
          { kind: "product_present", product: PLACEHOLDER_PRODUCT, present: true },
          {
            kind: "product_quantity",
            product: PLACEHOLDER_PRODUCT,
            operator: "lt",
            value: 5,
          },
        ],
        action: { type: "BLOCK" },
      },
    }),
  },

  {
    id: "min-order-value",
    title: "Minimum order value",
    summary: "Require the cart to reach a minimum subtotal before checkout.",
    problem: "minimum-order",
    requiresProduct: 0,
    requiresCollection: 0,
    build: () => ({
      name: "Minimum order value",
      description: "Requires a minimum cart subtotal.",
      message: "Orders must total at least $50 before checkout.",
      priority: 60,
      definition: {
        schemaVersion: 1,
        logic: "AND",
        negate: false,
        conditions: [
          { kind: "cart_subtotal", operator: "lt", value: 50, currencyCode: "USD" },
        ],
        action: { type: "BLOCK" },
      },
    }),
  },

  {
    id: "max-order-value",
    title: "Maximum order value",
    summary: "Cap how large a single order can be.",
    problem: "maximum-order",
    requiresProduct: 0,
    requiresCollection: 0,
    build: () => ({
      name: "Maximum order value",
      description: "Caps the cart subtotal for a single order.",
      message: "Orders above $5,000 need to be placed with our sales team.",
      priority: 60,
      definition: {
        schemaVersion: 1,
        logic: "AND",
        negate: false,
        conditions: [
          { kind: "cart_subtotal", operator: "gt", value: 5000, currencyCode: "USD" },
        ],
        action: { type: "BLOCK" },
      },
    }),
  },

  {
    id: "incompatible-products",
    title: "Products that cannot be bought together",
    summary: "Block a cart that contains two incompatible products.",
    problem: "product-combinations",
    requiresProduct: 2,
    requiresCollection: 0,
    build: () => ({
      name: "Incompatible products",
      description: "Blocks two products that cannot be purchased in the same order.",
      message: "These two items cannot be purchased together. Please order them separately.",
      priority: 70,
      definition: {
        schemaVersion: 1,
        logic: "AND",
        negate: false,
        conditions: [
          { kind: "product_present", product: PLACEHOLDER_PRODUCT, present: true },
          { kind: "product_present", product: PLACEHOLDER_PRODUCT_B, present: true },
        ],
        action: { type: "BLOCK" },
      },
    }),
  },

  {
    id: "required-product",
    title: "Required companion product",
    summary: "Require a second product whenever the first one is bought.",
    problem: "product-requirements",
    requiresProduct: 2,
    requiresCollection: 0,
    build: () => ({
      name: "Required companion product",
      description: "Requires a companion product to be in the cart.",
      message: "This item requires its companion product. Please add it to your cart.",
      priority: 70,
      definition: {
        schemaVersion: 1,
        logic: "AND",
        negate: false,
        conditions: [
          { kind: "product_present", product: PLACEHOLDER_PRODUCT, present: true },
          { kind: "product_present", product: PLACEHOLDER_PRODUCT_B, present: false },
        ],
        action: { type: "BLOCK" },
      },
    }),
  },

  {
    id: "wholesale-minimum",
    title: "Wholesale minimum order",
    summary: "Require tagged wholesale customers to meet a minimum order value.",
    problem: "wholesale",
    requiresProduct: 0,
    requiresCollection: 0,
    build: () => ({
      name: "Wholesale minimum order",
      description: "Applies a minimum order value to customers tagged as wholesale.",
      message: "Wholesale orders require a minimum order value of $500.",
      priority: 80,
      definition: {
        schemaVersion: 1,
        logic: "AND",
        negate: false,
        conditions: [
          { kind: "customer_tag", operator: "contains", value: "wholesale" },
          { kind: "cart_subtotal", operator: "lt", value: 500, currencyCode: "USD" },
        ],
        action: { type: "BLOCK" },
      },
    }),
  },

  {
    id: "collection-minimum",
    title: "Collection minimum quantity",
    summary: "Require a minimum number of items from a collection.",
    problem: "minimum-quantity",
    requiresProduct: 0,
    requiresCollection: 1,
    build: () => ({
      name: "Collection minimum quantity",
      description: "Requires a minimum number of items from a collection.",
      message: "Please add at least 3 items from this range to continue.",
      priority: 50,
      definition: {
        schemaVersion: 1,
        logic: "AND",
        negate: false,
        conditions: [
          { kind: "collection_present", collection: PLACEHOLDER_COLLECTION, present: true },
          {
            kind: "collection_quantity",
            collection: PLACEHOLDER_COLLECTION,
            operator: "lt",
            value: 3,
          },
        ],
        action: { type: "BLOCK" },
      },
    }),
  },

  {
    id: "collection-maximum",
    title: "Collection maximum quantity",
    summary: "Cap how many items from a collection one order can contain.",
    problem: "maximum-quantity",
    requiresProduct: 0,
    requiresCollection: 1,
    build: () => ({
      name: "Collection maximum quantity",
      description: "Caps the number of items from a collection in one order.",
      message: "You can order a maximum of 3 items from this range.",
      priority: 50,
      definition: {
        schemaVersion: 1,
        logic: "AND",
        negate: false,
        conditions: [
          {
            kind: "collection_quantity",
            collection: PLACEHOLDER_COLLECTION,
            operator: "gt",
            value: 3,
          },
        ],
        action: { type: "BLOCK" },
      },
    }),
  },

  {
    id: "launch-limit",
    title: "Limited launch quantity",
    summary: "Keep a launch fair by capping units per order for new customers.",
    problem: "product-launch",
    requiresProduct: 1,
    requiresCollection: 0,
    build: () => ({
      name: "Limited launch quantity",
      description: "Caps units per order during a product launch.",
      message: "During launch, customers can order a maximum of 2 units.",
      priority: 90,
      definition: {
        schemaVersion: 1,
        logic: "AND",
        negate: false,
        conditions: [
          {
            kind: "product_quantity",
            product: PLACEHOLDER_PRODUCT,
            operator: "gt",
            value: 2,
          },
        ],
        action: { type: "BLOCK" },
      },
    }),
  },
];

export function templateById(id: string): RuleTemplate | undefined {
  return TEMPLATES.find((t) => t.id === id);
}

/** Templates matched to the problem a merchant picked during onboarding. */
export function templatesForProblem(problem: string): RuleTemplate[] {
  const matches = TEMPLATES.filter((t) => t.problem === problem);
  return matches.length > 0 ? matches : TEMPLATES.slice(0, 3);
}
