import type { EvaluableRule } from "../evaluate";
import type { EvaluationCart, EvaluationLine } from "../cart";
import { computeSubtotal } from "../cart";
import { RuleDefinitionSchema, type RuleDefinition } from "../rule-schema";

export const PRODUCT_A = "gid://shopify/Product/1001";
export const PRODUCT_B = "gid://shopify/Product/1002";
export const COLLECTION_X = "gid://shopify/Collection/2001";

export function ref(gid: string, title = "Test resource", missing = false) {
  return { gid, title, missing };
}

export function line(overrides: Partial<EvaluationLine> = {}): EvaluationLine {
  return {
    productGid: PRODUCT_A,
    variantGid: "gid://shopify/ProductVariant/9001",
    title: "Test product",
    quantity: 1,
    unitPrice: 10,
    collectionGids: [],
    ...overrides,
  };
}

export function cart(
  lines: EvaluationLine[],
  overrides: Partial<Omit<EvaluationCart, "lines" | "subtotal">> = {},
): EvaluationCart {
  return {
    lines,
    subtotal: computeSubtotal(lines),
    currencyCode: "USD",
    buyer: { signedIn: false, tags: [], numberOfOrders: 0 },
    shippingCountry: null,
    stage: "CHECKOUT_INTERACTION",
    ...overrides,
  };
}

let counter = 0;

export function rule(
  definition: RuleDefinition | unknown,
  overrides: Partial<EvaluableRule> = {},
): EvaluableRule {
  counter += 1;
  return {
    id: `rule-${counter}`,
    name: `Rule ${counter}`,
    priority: 50,
    message: "Blocked by test rule.",
    definition: RuleDefinitionSchema.parse(definition),
    ...overrides,
  };
}
