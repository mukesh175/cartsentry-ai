import { describe, expect, it } from "vitest";

import { detectConflicts, hasCriticalConflict, type ConflictInput } from "../conflicts";
import { RuleDefinitionSchema } from "../rule-schema";
import { PRODUCT_A, PRODUCT_B, ref } from "./helpers";

let n = 0;
function r(definition: unknown, overrides: Partial<ConflictInput> = {}): ConflictInput {
  n += 1;
  return {
    id: `r${n}`,
    name: `Rule ${n}`,
    status: "ACTIVE",
    priority: 50,
    definition: RuleDefinitionSchema.parse(definition),
    ...overrides,
  };
}

const productQty = (operator: string, value: number) => ({
  conditions: [
    { kind: "product_quantity", product: ref(PRODUCT_A, "Widget"), operator, value },
  ],
  action: { type: "BLOCK" },
});

describe("impossible numeric range", () => {
  it("flags minimum 5 against maximum 3 as a confirmed CRITICAL", () => {
    // "block if fewer than 5" permits >=5; "block if more than 3" permits <=3.
    const min5 = r(productQty("lt", 5), { name: "Minimum 5" });
    const max3 = r(productQty("gt", 3), { name: "Maximum 3" });

    const conflicts = detectConflicts([min5, max3]);
    const impossible = conflicts.filter((c) => c.type === "IMPOSSIBLE_RANGE");

    expect(impossible).toHaveLength(1);
    expect(impossible[0]!.severity).toBe("CRITICAL");
    expect(impossible[0]!.confidence).toBe("confirmed");
    expect(impossible[0]!.explanation).toContain("No value satisfies both");
  });

  it("does not flag minimum 3 against maximum 5, which overlap", () => {
    const min3 = r(productQty("lt", 3));
    const max5 = r(productQty("gt", 5));
    expect(detectConflicts([min3, max5]).filter((c) => c.type === "IMPOSSIBLE_RANGE")).toHaveLength(
      0,
    );
  });

  it("flags a cart-value minimum above its maximum", () => {
    const min1000 = r({
      conditions: [{ kind: "cart_subtotal", operator: "lt", value: 1000, currencyCode: "USD" }],
      action: { type: "BLOCK" },
    });
    const max500 = r({
      conditions: [{ kind: "cart_subtotal", operator: "gt", value: 500, currencyCode: "USD" }],
      action: { type: "BLOCK" },
    });
    const found = detectConflicts([min1000, max500]).filter(
      (c) => c.type === "IMPOSSIBLE_RANGE",
    );
    expect(found).toHaveLength(1);
    expect(found[0]!.severity).toBe("CRITICAL");
  });

  it("does not compare different products", () => {
    const a = r(productQty("lt", 5));
    const b = r({
      conditions: [
        { kind: "product_quantity", product: ref(PRODUCT_B, "Other"), operator: "gt", value: 3 },
      ],
      action: { type: "BLOCK" },
    });
    expect(detectConflicts([a, b])).toHaveLength(0);
  });

  it("does not compare different currencies", () => {
    const usd = r({
      conditions: [{ kind: "cart_subtotal", operator: "lt", value: 1000, currencyCode: "USD" }],
      action: { type: "BLOCK" },
    });
    const eur = r({
      conditions: [{ kind: "cart_subtotal", operator: "gt", value: 500, currencyCode: "EUR" }],
      action: { type: "BLOCK" },
    });
    expect(detectConflicts([usd, eur])).toHaveLength(0);
  });

  it("does not flag rules scoped to mutually exclusive customer tags", () => {
    const wholesaleMin = r({
      logic: "AND",
      conditions: [
        { kind: "customer_tag", operator: "contains", value: "wholesale" },
        { kind: "cart_subtotal", operator: "lt", value: 1000, currencyCode: "USD" },
      ],
      action: { type: "BLOCK" },
    });
    const retailMax = r({
      logic: "AND",
      conditions: [
        { kind: "customer_tag", operator: "not_contains", value: "wholesale" },
        { kind: "cart_subtotal", operator: "gt", value: 500, currencyCode: "USD" },
      ],
      action: { type: "BLOCK" },
    });
    expect(detectConflicts([wholesaleMin, retailMax]).filter((c) => c.severity === "CRITICAL"))
      .toHaveLength(0);
  });

  it("does not flag rules scoped to non-overlapping countries", () => {
    const ca = r({
      logic: "AND",
      conditions: [
        { kind: "shipping_country", operator: "in", value: ["CA"] },
        { kind: "cart_quantity", operator: "lt", value: 10 },
      ],
      action: { type: "BLOCK" },
    });
    const us = r({
      logic: "AND",
      conditions: [
        { kind: "shipping_country", operator: "in", value: ["US"] },
        { kind: "cart_quantity", operator: "gt", value: 2 },
      ],
      action: { type: "BLOCK" },
    });
    expect(detectConflicts([ca, us]).filter((c) => c.severity === "CRITICAL")).toHaveLength(0);
  });

  it("ignores WARN rules, which restrict nothing", () => {
    const warnMin = r({
      conditions: [
        { kind: "product_quantity", product: ref(PRODUCT_A), operator: "lt", value: 5 },
      ],
      action: { type: "WARN" },
    });
    const blockMax = r(productQty("gt", 3));
    expect(
      detectConflicts([warnMin, blockMax]).filter((c) => c.type === "IMPOSSIBLE_RANGE"),
    ).toHaveLength(0);
  });
});

describe("requirement vs incompatibility", () => {
  const requiresB = r(
    {
      logic: "AND",
      conditions: [
        { kind: "product_present", product: ref(PRODUCT_A, "Camera"), present: true },
        { kind: "product_present", product: ref(PRODUCT_B, "Lens"), present: false },
      ],
      action: { type: "BLOCK" },
    },
    { name: "Camera requires Lens" },
  );

  const forbidsB = r(
    {
      logic: "AND",
      conditions: [
        { kind: "product_present", product: ref(PRODUCT_A, "Camera"), present: true },
        { kind: "product_present", product: ref(PRODUCT_B, "Lens"), present: true },
      ],
      action: { type: "BLOCK" },
    },
    { name: "Camera cannot ship with Lens" },
  );

  it("flags the pair as a confirmed CRITICAL", () => {
    const found = detectConflicts([requiresB, forbidsB]).filter(
      (c) => c.type === "REQUIREMENT_CONTRADICTION",
    );
    expect(found).toHaveLength(1);
    expect(found[0]!.severity).toBe("CRITICAL");
    expect(found[0]!.confidence).toBe("confirmed");
    expect(found[0]!.scenario?.description).toContain("blocked");
  });

  it("gates activation of either rule", () => {
    const conflicts = detectConflicts([requiresB, forbidsB]);
    expect(hasCriticalConflict(conflicts, requiresB.id)).toBe(true);
    expect(hasCriticalConflict(conflicts, forbidsB.id)).toBe(true);
  });

  it("does not flag a requirement rule on its own", () => {
    expect(detectConflicts([requiresB])).toHaveLength(0);
  });
});

describe("redundancy", () => {
  it("flags the looser of two same-direction maximums as LOW", () => {
    const max10 = r(productQty("gt", 10), { name: "Maximum 10" });
    const max5 = r(productQty("gt", 5), { name: "Maximum 5" });

    const found = detectConflicts([max10, max5]).filter((c) => c.type === "REDUNDANT_RULE");
    expect(found).toHaveLength(1);
    expect(found[0]!.severity).toBe("LOW");
    // The looser rule (max 10) is the one reported as redundant.
    expect(found[0]!.ruleId).toBe(max10.id);
    expect(found[0]!.relatedRuleId).toBe(max5.id);
  });

  it("does not call a minimum and a maximum redundant", () => {
    const min3 = r(productQty("lt", 3));
    const max10 = r(productQty("gt", 10));
    expect(detectConflicts([min3, max10]).filter((c) => c.type === "REDUNDANT_RULE")).toHaveLength(
      0,
    );
  });

  it("does not flag identical limits as redundant", () => {
    const a = r(productQty("gt", 5));
    const b = r(productQty("gt", 5));
    expect(detectConflicts([a, b]).filter((c) => c.type === "REDUNDANT_RULE")).toHaveLength(0);
  });
});

describe("scan behaviour", () => {
  it("produces stable fingerprints regardless of rule order", () => {
    const a = r(productQty("lt", 5));
    const b = r(productQty("gt", 3));
    const forward = detectConflicts([a, b]).map((c) => c.fingerprint);
    const reverse = detectConflicts([b, a]).map((c) => c.fingerprint);
    expect(forward).toEqual(reverse);
  });

  it("includes DRAFT rules so problems surface before activation", () => {
    const draftMin = r(productQty("lt", 5), { status: "DRAFT" });
    const activeMax = r(productQty("gt", 3));
    expect(detectConflicts([draftMin, activeMax]).length).toBeGreaterThan(0);
  });

  it("ignores ARCHIVED and DISABLED rules", () => {
    const archived = r(productQty("lt", 5), { status: "ARCHIVED" });
    const disabled = r(productQty("gt", 3), { status: "DISABLED" });
    const active = r(productQty("gt", 3));
    expect(detectConflicts([archived, disabled, active])).toHaveLength(0);
  });

  it("returns nothing for a single rule", () => {
    expect(detectConflicts([r(productQty("gt", 5))])).toHaveLength(0);
  });

  it("returns nothing for an empty rule set", () => {
    expect(detectConflicts([])).toHaveLength(0);
  });

  it("sorts CRITICAL findings ahead of LOW ones", () => {
    const min5 = r(productQty("lt", 5));
    const max3 = r(productQty("gt", 3));
    const max10 = r(productQty("gt", 10));
    const severities = detectConflicts([max10, min5, max3]).map((c) => c.severity);
    expect(severities[0]).toBe("CRITICAL");
    expect(severities[severities.length - 1]).toBe("LOW");
  });
});

describe("no false positives on unrelated rules", () => {
  it("does not flag rules about different subjects", () => {
    const productRule = r(productQty("gt", 5));
    const customerRule = r({
      conditions: [{ kind: "customer_signed_in", value: false }],
      action: { type: "BLOCK" },
    });
    const collectionRule = r({
      conditions: [
        {
          kind: "collection_quantity",
          collection: ref("gid://shopify/Collection/1", "Sale"),
          operator: "gt",
          value: 2,
        },
      ],
      action: { type: "BLOCK" },
    });
    expect(detectConflicts([productRule, customerRule, collectionRule])).toHaveLength(0);
  });
});
