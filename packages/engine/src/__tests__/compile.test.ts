import { describe, expect, it } from "vitest";

import {
  MAX_CONFIG_BYTES,
  compile,
  exceedsSizeLimit,
  expand,
  safeParseConfig,
  type CompilableRule,
} from "../compile";
import { evaluate } from "../evaluate";
import { RuleDefinitionSchema } from "../rule-schema";
import { COLLECTION_X, PRODUCT_A, cart, line, ref } from "./helpers";

let n = 0;
function rule(overrides: Partial<CompilableRule> = {}): CompilableRule {
  n += 1;
  return {
    id: `rule-${n}`,
    name: `Rule ${n}`,
    status: "ACTIVE",
    priority: 50,
    message: "Blocked.",
    definition: RuleDefinitionSchema.parse({
      conditions: [
        { kind: "product_quantity", product: ref(PRODUCT_A, "Widget"), operator: "gt", value: 5 },
      ],
      action: { type: "BLOCK" },
    }),
    ...overrides,
  };
}

describe("compile", () => {
  it("includes only ACTIVE rules", () => {
    const result = compile([
      rule({ status: "ACTIVE" }),
      rule({ status: "DRAFT" }),
      rule({ status: "DISABLED" }),
      rule({ status: "ARCHIVED" }),
      rule({ status: "NEEDS_ATTENTION" }),
    ]);
    expect(result.config.rules).toHaveLength(1);
  });

  it("orders rules by priority, highest first", () => {
    const result = compile([
      rule({ name: "Low", priority: 10 }),
      rule({ name: "High", priority: 90 }),
      rule({ name: "Mid", priority: 50 }),
    ]);
    expect(result.config.rules.map((r) => r.n)).toEqual(["High", "Mid", "Low"]);
  });

  it("skips rules referencing a deleted product and explains why", () => {
    const broken = rule({
      name: "Broken rule",
      definition: RuleDefinitionSchema.parse({
        conditions: [
          {
            kind: "product_quantity",
            product: ref(PRODUCT_A, "Deleted widget", true),
            operator: "gt",
            value: 5,
          },
        ],
        action: { type: "BLOCK" },
      }),
    });

    const result = compile([broken, rule({ name: "Healthy" })]);
    expect(result.config.rules.map((r) => r.n)).toEqual(["Healthy"]);
    expect(result.warnings.join(" ")).toContain("Broken rule");
    expect(result.warnings.join(" ")).toContain("no longer exist");
  });

  describe("checksums", () => {
    it("is stable for identical input", () => {
      const rules = [rule({ id: "a", name: "A" })];
      expect(compile(rules).checksum).toBe(compile(rules).checksum);
    });

    it("changes when a message changes", () => {
      const before = compile([rule({ id: "a", name: "A", message: "One" })]);
      const after = compile([rule({ id: "a", name: "A", message: "Two" })]);
      expect(before.checksum).not.toBe(after.checksum);
    });

    it("changes when a threshold changes", () => {
      const makeRule = (value: number) =>
        rule({
          id: "a",
          name: "A",
          definition: RuleDefinitionSchema.parse({
            conditions: [
              { kind: "product_quantity", product: ref(PRODUCT_A), operator: "gt", value },
            ],
            action: { type: "BLOCK" },
          }),
        });
      expect(compile([makeRule(5)]).checksum).not.toBe(compile([makeRule(6)]).checksum);
    });
  });

  describe("collection membership", () => {
    const collectionRule = rule({
      definition: RuleDefinitionSchema.parse({
        conditions: [
          {
            kind: "collection_quantity",
            collection: ref(COLLECTION_X, "Limited"),
            operator: "gt",
            value: 2,
          },
        ],
        action: { type: "BLOCK" },
      }),
    });

    it("ships membership for referenced collections", () => {
      const result = compile([collectionRule], { [COLLECTION_X]: [PRODUCT_A] });
      expect(result.config.c[COLLECTION_X]).toEqual([PRODUCT_A]);
    });

    it("omits membership for collections no rule references", () => {
      const result = compile([rule()], { "gid://shopify/Collection/999": [PRODUCT_A] });
      expect(Object.keys(result.config.c)).toHaveLength(0);
    });

    it("warns when membership could not be resolved", () => {
      const result = compile([collectionRule], {});
      expect(result.warnings.join(" ")).toContain("could not be resolved");
    });
  });

  describe("size limits", () => {
    it("reports a small configuration as within the limit", () => {
      const result = compile([rule()]);
      expect(result.byteSize).toBeLessThan(MAX_CONFIG_BYTES);
      expect(exceedsSizeLimit(result)).toBe(false);
    });

    it("flags a configuration that exceeds the limit", () => {
      const many = Array.from({ length: 400 }, (_, i) =>
        rule({ id: `r${i}`, name: `Rule ${i}`, message: "x".repeat(250) }),
      );
      const result = compile(many);
      expect(exceedsSizeLimit(result)).toBe(true);
      expect(result.warnings.join(" ")).toContain("over the");
    });
  });
});

describe("compile / expand round trip", () => {
  it("preserves evaluation behaviour exactly", () => {
    const rules = [rule({ name: "Max 5" })];
    const testCart = cart([line({ quantity: 6 })]);

    const direct = evaluate(
      rules.map((r) => ({
        id: r.id,
        name: r.name,
        priority: r.priority,
        message: r.message,
        definition: r.definition,
      })),
      testCart,
    );

    const roundTripped = evaluate(expand(compile(rules).config), testCart);

    expect(roundTripped.outcome).toBe(direct.outcome);
    expect(roundTripped.blocks).toEqual(direct.blocks);
  });
});

describe("safeParseConfig", () => {
  it("parses a valid configuration", () => {
    const json = compile([rule()]).json;
    expect(safeParseConfig(json).rules).toHaveLength(1);
  });

  it("returns an empty rule set for null or empty input", () => {
    expect(safeParseConfig(null).rules).toEqual([]);
    expect(safeParseConfig("").rules).toEqual([]);
    expect(safeParseConfig(undefined).rules).toEqual([]);
  });

  it("returns an empty rule set for malformed JSON rather than throwing", () => {
    expect(() => safeParseConfig("{oh no")).not.toThrow();
    expect(safeParseConfig("{oh no").rules).toEqual([]);
  });

  it("refuses a configuration from a newer format version", () => {
    expect(safeParseConfig(JSON.stringify({ v: 2, rules: [{}] })).rules).toEqual([]);
  });

  it("defaults missing collection membership to an empty map", () => {
    const parsed = safeParseConfig(JSON.stringify({ v: 1, rules: [] }));
    expect(parsed.c).toEqual({});
  });
});
