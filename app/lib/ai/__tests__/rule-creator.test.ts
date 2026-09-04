/**
 * AI output-validation tests.
 *
 * These exercise the security boundary rather than the model: whatever a
 * provider returns, only output matching `AIRuleResponseSchema` can become a
 * rule. That property is what makes prompt injection a non-event — a
 * successful injection still cannot smuggle through anything the schema
 * rejects.
 */

import { describe, expect, it } from "vitest";

import { AIRuleResponseSchema } from "../rule-creator.server";

const validRule = {
  kind: "rule",
  name: "Maximum 5 units",
  description: "Limits quantity per order.",
  message: "You can purchase a maximum of 5 units of this product.",
  priority: 50,
  definition: {
    schemaVersion: 1,
    logic: "AND",
    negate: false,
    conditions: [
      {
        kind: "product_quantity",
        product: { gid: "gid://shopify/Product/0", title: "Premium T-Shirt", missing: false },
        operator: "gt",
        value: 5,
      },
    ],
    action: { type: "BLOCK" },
  },
  assumptions: ["Assumed the limit applies per order."],
  confidence: "high",
};

describe("AI response schema", () => {
  it("accepts a well-formed rule", () => {
    const parsed = AIRuleResponseSchema.safeParse(validRule);
    expect(parsed.success).toBe(true);
  });

  it("accepts a clarification request", () => {
    const parsed = AIRuleResponseSchema.safeParse({
      kind: "clarification",
      question: "Do you mean 5 units per order, or 5 per customer across all orders?",
      options: ["5 per order", "5 per customer over time"],
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects a clarification with only one option", () => {
    const parsed = AIRuleResponseSchema.safeParse({
      kind: "clarification",
      question: "Which did you mean?",
      options: ["only one"],
    });
    expect(parsed.success).toBe(false);
  });

  describe("rejects anything that is not a rule or a clarification", () => {
    it("rejects an unknown response kind", () => {
      expect(AIRuleResponseSchema.safeParse({ kind: "shell", cmd: "rm -rf /" }).success).toBe(
        false,
      );
    });

    it("rejects a response with no kind at all", () => {
      expect(AIRuleResponseSchema.safeParse({ name: "x", definition: {} }).success).toBe(false);
    });

    it("rejects free text", () => {
      expect(AIRuleResponseSchema.safeParse("here is your rule!").success).toBe(false);
    });
  });

  describe("injection attempts cannot widen the output", () => {
    it("rejects an extra executable field on the definition", () => {
      const hostile = {
        ...validRule,
        definition: { ...validRule.definition, exec: "process.exit(1)" },
      };
      expect(AIRuleResponseSchema.safeParse(hostile).success).toBe(false);
    });

    it("rejects an invented condition kind", () => {
      const hostile = {
        ...validRule,
        definition: {
          ...validRule.definition,
          conditions: [{ kind: "eval", value: "fetch('http://evil')" }],
        },
      };
      expect(AIRuleResponseSchema.safeParse(hostile).success).toBe(false);
    });

    it("rejects a non-Shopify gid such as a javascript: URL", () => {
      const hostile = {
        ...validRule,
        definition: {
          ...validRule.definition,
          conditions: [
            {
              kind: "product_present",
              product: { gid: "javascript:alert(1)", title: "x", missing: false },
              present: true,
            },
          ],
        },
      };
      expect(AIRuleResponseSchema.safeParse(hostile).success).toBe(false);
    });

    it("rejects an unsupported customer tag", () => {
      const hostile = {
        ...validRule,
        definition: {
          ...validRule.definition,
          conditions: [
            { kind: "customer_tag", operator: "contains", value: "arbitrary-attacker-tag" },
          ],
        },
      };
      expect(AIRuleResponseSchema.safeParse(hostile).success).toBe(false);
    });

    it("rejects an action type outside WARN and BLOCK", () => {
      const hostile = {
        ...validRule,
        definition: { ...validRule.definition, action: { type: "DELETE_ALL_PRODUCTS" } },
      };
      expect(AIRuleResponseSchema.safeParse(hostile).success).toBe(false);
    });
  });

  describe("field limits", () => {
    it("rejects a customer message over Shopify's practical length", () => {
      const parsed = AIRuleResponseSchema.safeParse({
        ...validRule,
        message: "x".repeat(256),
      });
      expect(parsed.success).toBe(false);
    });

    it("rejects a rule with no conditions", () => {
      const parsed = AIRuleResponseSchema.safeParse({
        ...validRule,
        definition: { ...validRule.definition, conditions: [] },
      });
      expect(parsed.success).toBe(false);
    });

    it("rejects more than 10 conditions", () => {
      const one = validRule.definition.conditions[0];
      const parsed = AIRuleResponseSchema.safeParse({
        ...validRule,
        definition: { ...validRule.definition, conditions: Array(11).fill(one) },
      });
      expect(parsed.success).toBe(false);
    });

    it("rejects a priority outside 0-100", () => {
      expect(AIRuleResponseSchema.safeParse({ ...validRule, priority: 9999 }).success).toBe(false);
    });

    it("requires a confidence value", () => {
      const withoutConfidence: Record<string, unknown> = { ...validRule };
      delete withoutConfidence.confidence;
      expect(AIRuleResponseSchema.safeParse(withoutConfidence).success).toBe(false);
    });
  });
});
