import { describe, expect, it } from "vitest";

import { evaluate, evaluateRule } from "../evaluate";
import { deriveRuleType, RuleDefinitionSchema } from "../rule-schema";
import {
  COLLECTION_X,
  PRODUCT_A,
  PRODUCT_B,
  cart,
  line,
  ref,
  rule,
} from "./helpers";

describe("product quantity rules", () => {
  const maxFive = rule({
    conditions: [
      {
        kind: "product_quantity",
        product: ref(PRODUCT_A, "Premium T-Shirt"),
        operator: "gt",
        value: 5,
      },
    ],
    action: { type: "BLOCK" },
  });

  it("passes at the limit", () => {
    const result = evaluate([maxFive], cart([line({ quantity: 5 })]));
    expect(result.outcome).toBe("PASS");
  });

  it("blocks one over the limit", () => {
    const result = evaluate([maxFive], cart([line({ quantity: 6 })]));
    expect(result.outcome).toBe("BLOCKED");
    expect(result.blocks).toHaveLength(1);
  });

  it("sums quantity across variants of the same product", () => {
    const result = evaluate(
      [maxFive],
      cart([
        line({ quantity: 3, variantGid: "gid://shopify/ProductVariant/1" }),
        line({ quantity: 3, variantGid: "gid://shopify/ProductVariant/2" }),
      ]),
    );
    expect(result.outcome).toBe("BLOCKED");
  });

  it("ignores other products", () => {
    const result = evaluate([maxFive], cart([line({ productGid: PRODUCT_B, quantity: 50 })]));
    expect(result.outcome).toBe("PASS");
  });

  it("narrows to a single variant when one is given", () => {
    const variantRule = rule({
      conditions: [
        {
          kind: "product_quantity",
          product: ref(PRODUCT_A),
          variant: ref("gid://shopify/ProductVariant/1"),
          operator: "gt",
          value: 2,
        },
      ],
      action: { type: "BLOCK" },
    });
    const result = evaluate(
      [variantRule],
      cart([
        line({ quantity: 2, variantGid: "gid://shopify/ProductVariant/1" }),
        line({ quantity: 9, variantGid: "gid://shopify/ProductVariant/2" }),
      ]),
    );
    expect(result.outcome).toBe("PASS");
  });
});

describe("cart value rules", () => {
  const minimum500 = rule({
    conditions: [
      { kind: "cart_subtotal", operator: "lt", value: 500, currencyCode: "USD" },
    ],
    action: { type: "BLOCK" },
  });

  it("blocks below the minimum", () => {
    const result = evaluate([minimum500], cart([line({ unitPrice: 300, quantity: 1 })]));
    expect(result.outcome).toBe("BLOCKED");
  });

  it("passes exactly at the minimum despite float arithmetic", () => {
    // 3 x 166.67 = 500.01 in cents, but 500.00000000000006 in float maths.
    const result = evaluate([minimum500], cart([line({ unitPrice: 166.67, quantity: 3 })]));
    expect(result.outcome).toBe("PASS");
  });

  it("passes above the minimum", () => {
    const result = evaluate([minimum500], cart([line({ unitPrice: 600, quantity: 1 })]));
    expect(result.outcome).toBe("PASS");
  });
});

describe("wholesale minimum order (customer tag AND cart value)", () => {
  const wholesale = rule({
    logic: "AND",
    conditions: [
      { kind: "customer_tag", operator: "contains", value: "wholesale" },
      { kind: "cart_subtotal", operator: "lt", value: 500, currencyCode: "USD" },
    ],
    action: { type: "BLOCK" },
  });

  const wholesaleBuyer = {
    buyer: { signedIn: true, tags: ["wholesale"], numberOfOrders: 4 },
  };

  it("blocks a wholesale customer under $500", () => {
    const result = evaluate([wholesale], cart([line({ unitPrice: 300 })], wholesaleBuyer));
    expect(result.outcome).toBe("BLOCKED");
  });

  it("passes a wholesale customer at $600", () => {
    const result = evaluate([wholesale], cart([line({ unitPrice: 600 })], wholesaleBuyer));
    expect(result.outcome).toBe("PASS");
  });

  it("does not apply to a retail customer under $500", () => {
    const result = evaluate([wholesale], cart([line({ unitPrice: 300 })]));
    expect(result.outcome).toBe("PASS");
  });

  it("matches customer tags case-insensitively", () => {
    const result = evaluate(
      [wholesale],
      cart([line({ unitPrice: 300 })], {
        buyer: { signedIn: true, tags: ["wholesale"], numberOfOrders: 1 },
      }),
    );
    expect(result.outcome).toBe("BLOCKED");
  });
});

describe("product combination rules", () => {
  it("blocks incompatible products bought together", () => {
    const incompatible = rule({
      logic: "AND",
      conditions: [
        { kind: "product_present", product: ref(PRODUCT_A, "Product A"), present: true },
        { kind: "product_present", product: ref(PRODUCT_B, "Product B"), present: true },
      ],
      action: { type: "BLOCK" },
    });
    const both = cart([line({ productGid: PRODUCT_A }), line({ productGid: PRODUCT_B })]);
    expect(evaluate([incompatible], both).outcome).toBe("BLOCKED");
    expect(evaluate([incompatible], cart([line({ productGid: PRODUCT_A })])).outcome).toBe(
      "PASS",
    );
  });

  it("blocks a required product that is missing", () => {
    const requires = rule({
      logic: "AND",
      conditions: [
        { kind: "product_present", product: ref(PRODUCT_A, "Product A"), present: true },
        { kind: "product_present", product: ref(PRODUCT_B, "Product B"), present: false },
      ],
      action: { type: "BLOCK" },
    });
    expect(evaluate([requires], cart([line({ productGid: PRODUCT_A })])).outcome).toBe(
      "BLOCKED",
    );
    expect(
      evaluate([requires], cart([line({ productGid: PRODUCT_A }), line({ productGid: PRODUCT_B })]))
        .outcome,
    ).toBe("PASS");
  });
});

describe("collection rules", () => {
  it("counts only lines in the collection", () => {
    const maxTwo = rule({
      conditions: [
        {
          kind: "collection_quantity",
          collection: ref(COLLECTION_X, "Limited Edition"),
          operator: "gt",
          value: 2,
        },
      ],
      action: { type: "BLOCK" },
    });
    const inCollection = cart([
      line({ quantity: 3, collectionGids: [COLLECTION_X] }),
      line({ quantity: 9, productGid: PRODUCT_B, collectionGids: [] }),
    ]);
    expect(evaluate([maxTwo], inCollection).outcome).toBe("BLOCKED");
  });
});

describe("three-valued logic for undeterminable conditions", () => {
  const countryRule = rule({
    conditions: [{ kind: "shipping_country", operator: "in", value: ["CA"] }],
    action: { type: "BLOCK" },
  });

  it("defers instead of firing when no delivery address is known", () => {
    const trace = evaluateRule(countryRule, cart([line()], { shippingCountry: null }));
    expect(trace.triggered).toBe(false);
    expect(trace.deferred).toBe(true);
  });

  it("fires once the address is known", () => {
    const trace = evaluateRule(countryRule, cart([line()], { shippingCountry: "CA" }));
    expect(trace.triggered).toBe(true);
    expect(trace.deferred).toBe(false);
  });

  it("AND short-circuits to false when another condition already fails", () => {
    const combined = rule({
      logic: "AND",
      conditions: [
        { kind: "shipping_country", operator: "in", value: ["CA"] },
        { kind: "cart_quantity", operator: "gt", value: 100 },
      ],
      action: { type: "BLOCK" },
    });
    const trace = evaluateRule(combined, cart([line({ quantity: 1 })]));
    expect(trace.deferred).toBe(false);
    expect(trace.triggered).toBe(false);
  });

  it("OR short-circuits to true when another condition already matches", () => {
    const combined = rule({
      logic: "OR",
      conditions: [
        { kind: "shipping_country", operator: "in", value: ["CA"] },
        { kind: "cart_quantity", operator: "gt", value: 0 },
      ],
      action: { type: "BLOCK" },
    });
    const trace = evaluateRule(combined, cart([line({ quantity: 1 })]));
    expect(trace.triggered).toBe(true);
  });

  it("treats a deleted product reference as undeterminable, never as a match", () => {
    const broken = rule({
      conditions: [
        {
          kind: "product_quantity",
          product: ref(PRODUCT_A, "Deleted product", true),
          operator: "gte",
          value: 0,
        },
      ],
      action: { type: "BLOCK" },
    });
    const trace = evaluateRule(broken, cart([line()]));
    expect(trace.triggered).toBe(false);
    expect(trace.deferred).toBe(true);
  });
});

describe("negation", () => {
  it("inverts the group outcome", () => {
    const notWholesale = rule({
      negate: true,
      conditions: [{ kind: "customer_tag", operator: "contains", value: "wholesale" }],
      action: { type: "BLOCK" },
    });
    expect(evaluate([notWholesale], cart([line()])).outcome).toBe("BLOCKED");
    expect(
      evaluate(
        [notWholesale],
        cart([line()], { buyer: { signedIn: true, tags: ["wholesale"], numberOfOrders: 1 } }),
      ).outcome,
    ).toBe("PASS");
  });
});

describe("multiple rules and priority", () => {
  it("orders blocks by priority, highest first", () => {
    const low = rule(
      {
        conditions: [{ kind: "cart_quantity", operator: "gte", value: 1 }],
        action: { type: "BLOCK" },
      },
      { name: "Low priority", priority: 10 },
    );
    const high = rule(
      {
        conditions: [{ kind: "cart_quantity", operator: "gte", value: 1 }],
        action: { type: "BLOCK" },
      },
      { name: "High priority", priority: 90 },
    );
    const result = evaluate([low, high], cart([line()]));
    expect(result.blocks.map((b) => b.ruleName)).toEqual(["High priority", "Low priority"]);
  });

  it("reports BLOCKED when a block and a warning both fire", () => {
    const warn = rule({
      conditions: [{ kind: "cart_quantity", operator: "gte", value: 1 }],
      action: { type: "WARN" },
    });
    const block = rule({
      conditions: [{ kind: "cart_quantity", operator: "gte", value: 1 }],
      action: { type: "BLOCK" },
    });
    const result = evaluate([warn, block], cart([line()]));
    expect(result.outcome).toBe("BLOCKED");
    expect(result.warnings).toHaveLength(1);
    expect(result.blocks).toHaveLength(1);
  });

  it("reports WARNING when only warnings fire", () => {
    const warn = rule({
      conditions: [{ kind: "cart_quantity", operator: "gte", value: 1 }],
      action: { type: "WARN" },
    });
    expect(evaluate([warn], cart([line()])).outcome).toBe("WARNING");
  });

  it("passes an empty rule set", () => {
    expect(evaluate([], cart([line()])).outcome).toBe("PASS");
  });
});

describe("schema validation", () => {
  it("rejects a rule with no conditions", () => {
    expect(() =>
      RuleDefinitionSchema.parse({ conditions: [], action: { type: "BLOCK" } }),
    ).toThrow();
  });

  it("rejects an unknown condition kind", () => {
    expect(() =>
      RuleDefinitionSchema.parse({
        conditions: [{ kind: "run_arbitrary_code", value: 1 }],
        action: { type: "BLOCK" },
      }),
    ).toThrow();
  });

  it("rejects unknown top-level keys", () => {
    expect(() =>
      RuleDefinitionSchema.parse({
        conditions: [{ kind: "cart_quantity", operator: "gt", value: 1 }],
        action: { type: "BLOCK" },
        exec: "rm -rf /",
      }),
    ).toThrow();
  });

  it("rejects a malformed Shopify global ID", () => {
    expect(() =>
      RuleDefinitionSchema.parse({
        conditions: [
          {
            kind: "product_present",
            product: { gid: "javascript:alert(1)", title: "x", missing: false },
            present: true,
          },
        ],
        action: { type: "BLOCK" },
      }),
    ).toThrow();
  });
});

describe("deriveRuleType", () => {
  const parse = (d: unknown) => RuleDefinitionSchema.parse(d);

  it("classifies a single product quantity condition", () => {
    expect(
      deriveRuleType(
        parse({
          conditions: [
            { kind: "product_quantity", product: ref(PRODUCT_A), operator: "gt", value: 5 },
          ],
          action: { type: "BLOCK" },
        }),
      ),
    ).toBe("PRODUCT_QUANTITY");
  });

  it("classifies two present:true products as a combination rule", () => {
    expect(
      deriveRuleType(
        parse({
          conditions: [
            { kind: "product_present", product: ref(PRODUCT_A), present: true },
            { kind: "product_present", product: ref(PRODUCT_B), present: true },
          ],
          action: { type: "BLOCK" },
        }),
      ),
    ).toBe("PRODUCT_COMBINATION");
  });

  it("classifies a present/absent pair as a required-product rule", () => {
    expect(
      deriveRuleType(
        parse({
          conditions: [
            { kind: "product_present", product: ref(PRODUCT_A), present: true },
            { kind: "product_present", product: ref(PRODUCT_B), present: false },
          ],
          action: { type: "BLOCK" },
        }),
      ),
    ).toBe("REQUIRED_PRODUCT");
  });

  it("falls back to COMPOSITE for mixed conditions", () => {
    expect(
      deriveRuleType(
        parse({
          conditions: [
            { kind: "customer_tag", operator: "contains", value: "wholesale" },
            { kind: "cart_subtotal", operator: "lt", value: 500, currencyCode: "USD" },
          ],
          action: { type: "BLOCK" },
        }),
      ),
    ).toBe("COMPOSITE");
  });
});
