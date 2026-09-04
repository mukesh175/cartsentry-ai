/**
 * Tests the Shopify Function's run export against realistically-shaped input.
 *
 * This does not exercise the compiled WebAssembly module — building that needs
 * the Shopify CLI toolchain — but it does cover the part that carries the risk:
 * the adapter from Shopify's input shape to the engine's cart, and the
 * fail-open behaviour. See docs/TROUBLESHOOTING.md for how to run the real
 * function locally against a store.
 */

// The Function is plain JS with JSDoc types, by design; allowJs resolves it.
import { cartValidationsGenerateRun } from "../../../../extensions/purchase-rules-validation/src/index.js";

import { describe, expect, it } from "vitest";
import { compile, type CompilableRule } from "../compile";
import { RuleDefinitionSchema } from "../rule-schema";

const PRODUCT_A = "gid://shopify/Product/1001";
const VARIANT_A1 = "gid://shopify/ProductVariant/9001";
const COLLECTION_X = "gid://shopify/Collection/2001";

function compiledMetafield(
  rules: CompilableRule[],
  collections: Record<string, string[]> = {},
) {
  return compile(rules, collections).json;
}

function maxFiveRule(): CompilableRule {
  return {
    id: "rule-max-5",
    name: "Maximum 5 per order",
    status: "ACTIVE",
    priority: 50,
    message: "You can purchase a maximum of 5 units of this product.",
    definition: RuleDefinitionSchema.parse({
      conditions: [
        {
          kind: "product_quantity",
          product: { gid: PRODUCT_A, title: "Premium T-Shirt", missing: false },
          operator: "gt",
          value: 5,
        },
      ],
      action: { type: "BLOCK" },
    }),
  };
}

/** Input shaped the way the documented `cart.validations.generate.run` payload is. */
function functionInput(options: {
  metafieldValue?: string | null;
  quantity?: number;
  unitPrice?: string;
  subtotal?: string;
  tags?: { tag: string; hasTag: boolean }[];
  customer?: boolean;
  countryCode?: string | null;
  step?: string;
  merchandiseTypename?: string;
}) {
  const {
    metafieldValue = null,
    quantity = 1,
    unitPrice = "10.00",
    subtotal = "10.00",
    tags = [],
    customer = false,
    countryCode = null,
    step = "CHECKOUT_INTERACTION",
    merchandiseTypename = "ProductVariant",
  } = options;

  return {
    buyerJourney: { step },
    validation: { metafield: metafieldValue === null ? null : { value: metafieldValue } },
    cart: {
      cost: { subtotalAmount: { amount: subtotal, currencyCode: "USD" } },
      buyerIdentity: {
        customer: customer
          ? { id: "gid://shopify/Customer/1", numberOfOrders: 3, hasTags: tags }
          : null,
      },
      deliveryGroups: countryCode ? [{ deliveryAddress: { countryCode } }] : [],
      lines: [
        {
          quantity,
          cost: { amountPerQuantity: { amount: unitPrice } },
          merchandise: {
            __typename: merchandiseTypename,
            id: VARIANT_A1,
            title: "Medium / Black",
            product: { id: PRODUCT_A, title: "Premium T-Shirt" },
          },
        },
      ],
    },
    localization: { country: { isoCode: "US" } },
  };
}

describe("cartValidationsGenerateRun", () => {
  it("returns no operations when the cart is within the limit", () => {
    const result = cartValidationsGenerateRun(
      functionInput({ metafieldValue: compiledMetafield([maxFiveRule()]), quantity: 5 }),
    );
    expect(result.operations).toEqual([]);
  });

  it("emits the merchant's message when the limit is exceeded", () => {
    const result = cartValidationsGenerateRun(
      functionInput({ metafieldValue: compiledMetafield([maxFiveRule()]), quantity: 6 }),
    );
    expect(result.operations).toHaveLength(1);
    expect(result.operations[0].validationAdd.errors).toEqual([
      {
        message: "You can purchase a maximum of 5 units of this product.",
        target: "$.cart",
      },
    ]);
  });

  it("orders multiple errors by rule priority", () => {
    const low: CompilableRule = { ...maxFiveRule(), id: "low", name: "Low", priority: 10 };
    const high: CompilableRule = {
      ...maxFiveRule(),
      id: "high",
      name: "High",
      priority: 90,
      message: "High priority message.",
    };
    const result = cartValidationsGenerateRun(
      functionInput({ metafieldValue: compiledMetafield([low, high]), quantity: 6 }),
    );
    expect(result.operations[0].validationAdd.errors[0].message).toBe("High priority message.");
  });

  describe("fail-open behaviour", () => {
    it("allows checkout when no configuration metafield exists", () => {
      expect(cartValidationsGenerateRun(functionInput({})).operations).toEqual([]);
    });

    it("allows checkout when the configuration is malformed JSON", () => {
      expect(
        cartValidationsGenerateRun(functionInput({ metafieldValue: "{not json" })).operations,
      ).toEqual([]);
    });

    it("allows checkout when the configuration is a newer format version", () => {
      expect(
        cartValidationsGenerateRun(
          functionInput({ metafieldValue: JSON.stringify({ v: 99, rules: [] }) }),
        ).operations,
      ).toEqual([]);
    });

    it("allows checkout when the input is entirely missing", () => {
      expect(cartValidationsGenerateRun(undefined).operations).toEqual([]);
      expect(cartValidationsGenerateRun({}).operations).toEqual([]);
    });

    it("allows checkout when a line has no merchandise", () => {
      const input = functionInput({ metafieldValue: compiledMetafield([maxFiveRule()]) });
      input.cart.lines = [{ quantity: 9 } as never];
      expect(cartValidationsGenerateRun(input).operations).toEqual([]);
    });
  });

  it("ignores non-ProductVariant merchandise such as gift cards", () => {
    const result = cartValidationsGenerateRun(
      functionInput({
        metafieldValue: compiledMetafield([maxFiveRule()]),
        quantity: 6,
        merchandiseTypename: "CustomProduct",
      }),
    );
    expect(result.operations).toEqual([]);
  });

  describe("customer tags", () => {
    const wholesale: CompilableRule = {
      id: "wholesale-min",
      name: "Wholesale minimum",
      status: "ACTIVE",
      priority: 50,
      message: "Wholesale orders require a minimum order value of $500.",
      definition: RuleDefinitionSchema.parse({
        logic: "AND",
        conditions: [
          { kind: "customer_tag", operator: "contains", value: "wholesale" },
          { kind: "cart_subtotal", operator: "lt", value: 500, currencyCode: "USD" },
        ],
        action: { type: "BLOCK" },
      }),
    };

    it("blocks a tagged wholesale customer under the minimum", () => {
      const result = cartValidationsGenerateRun(
        functionInput({
          metafieldValue: compiledMetafield([wholesale]),
          customer: true,
          tags: [{ tag: "wholesale", hasTag: true }],
          subtotal: "300.00",
        }),
      );
      expect(result.operations[0].validationAdd.errors[0].message).toContain("$500");
    });

    it("allows the same customer once the minimum is met", () => {
      const result = cartValidationsGenerateRun(
        functionInput({
          metafieldValue: compiledMetafield([wholesale]),
          customer: true,
          tags: [{ tag: "wholesale", hasTag: true }],
          subtotal: "600.00",
        }),
      );
      expect(result.operations).toEqual([]);
    });

    it("does not apply the rule to an untagged customer", () => {
      const result = cartValidationsGenerateRun(
        functionInput({
          metafieldValue: compiledMetafield([wholesale]),
          customer: true,
          tags: [{ tag: "wholesale", hasTag: false }],
          subtotal: "300.00",
        }),
      );
      expect(result.operations).toEqual([]);
    });

    it("does not apply the rule to a guest", () => {
      const result = cartValidationsGenerateRun(
        functionInput({ metafieldValue: compiledMetafield([wholesale]), subtotal: "300.00" }),
      );
      expect(result.operations).toEqual([]);
    });
  });

  describe("collection rules using compile-time membership", () => {
    const collectionRule: CompilableRule = {
      id: "limited",
      name: "Limited edition cap",
      status: "ACTIVE",
      priority: 50,
      message: "You can order at most 2 limited edition items.",
      definition: RuleDefinitionSchema.parse({
        conditions: [
          {
            kind: "collection_quantity",
            collection: { gid: COLLECTION_X, title: "Limited Edition", missing: false },
            operator: "gt",
            value: 2,
          },
        ],
        action: { type: "BLOCK" },
      }),
    };

    it("blocks when the product is a member of the compiled collection", () => {
      const result = cartValidationsGenerateRun(
        functionInput({
          metafieldValue: compiledMetafield([collectionRule], { [COLLECTION_X]: [PRODUCT_A] }),
          quantity: 3,
        }),
      );
      expect(result.operations).toHaveLength(1);
    });

    it("does not block when the product is not a member", () => {
      const result = cartValidationsGenerateRun(
        functionInput({
          metafieldValue: compiledMetafield([collectionRule], {
            [COLLECTION_X]: ["gid://shopify/Product/999"],
          }),
          quantity: 3,
        }),
      );
      expect(result.operations).toEqual([]);
    });
  });

  describe("delivery country", () => {
    const countryRule: CompilableRule = {
      id: "no-ca",
      name: "No shipping to CA",
      status: "ACTIVE",
      priority: 50,
      message: "We cannot ship these items to your country.",
      definition: RuleDefinitionSchema.parse({
        conditions: [{ kind: "shipping_country", operator: "in", value: ["CA"] }],
        action: { type: "BLOCK" },
      }),
    };

    it("does not block before a delivery address is known", () => {
      const result = cartValidationsGenerateRun(
        functionInput({
          metafieldValue: compiledMetafield([countryRule]),
          countryCode: null,
          step: "CART_INTERACTION",
        }),
      );
      expect(result.operations).toEqual([]);
    });

    it("blocks once the address resolves to a listed country", () => {
      const result = cartValidationsGenerateRun(
        functionInput({ metafieldValue: compiledMetafield([countryRule]), countryCode: "CA" }),
      );
      expect(result.operations).toHaveLength(1);
    });
  });

  it("does not emit errors for WARN rules, which never block checkout", () => {
    const warnRule: CompilableRule = {
      ...maxFiveRule(),
      id: "warn",
      definition: RuleDefinitionSchema.parse({
        conditions: [
          {
            kind: "product_quantity",
            product: { gid: PRODUCT_A, title: "Premium T-Shirt", missing: false },
            operator: "gt",
            value: 5,
          },
        ],
        action: { type: "WARN" },
      }),
    };
    const result = cartValidationsGenerateRun(
      functionInput({ metafieldValue: compiledMetafield([warnRule]), quantity: 6 }),
    );
    expect(result.operations).toEqual([]);
  });
});
