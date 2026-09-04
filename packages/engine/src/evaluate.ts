/**
 * The rule evaluator.
 *
 * This exact module runs in two places:
 *   - the simulator, in the admin, against a merchant-authored scenario
 *   - the Cart & Checkout Validation Function, on Shopify's servers, against a
 *     real cart
 *
 * Sharing it is the whole point: the simulator is not a re-implementation, so
 * "the simulator said PASS" and "checkout allowed it" cannot drift apart.
 *
 * Keep this file free of Node, Prisma and zod imports — the Function runtime
 * has none of them.
 */

import type { Condition, RuleDefinition, Operator } from "./rule-schema";
import type { EvaluationCart } from "./cart";
import {
  quantityInCollection,
  quantityOfProduct,
  totalQuantity,
} from "./cart";

/** A rule as the evaluator needs it — the DB row and the Function config both narrow to this. */
export interface EvaluableRule {
  id: string;
  name: string;
  priority: number;
  message: string;
  definition: RuleDefinition;
}

/**
 * Outcome of a single condition.
 *
 * `undeterminable` is a first-class result, not a failure: during early cart
 * interaction Shopify has no delivery address, so a shipping-country condition
 * genuinely has no answer yet. Treating that as `false` would silently block
 * carts that are actually fine.
 */
export type ConditionOutcome = "true" | "false" | "undeterminable";

export interface ConditionTrace {
  condition: Condition;
  outcome: ConditionOutcome;
  /** What the cart actually had, formatted for display. */
  actual: string;
  /** What the condition asked for, formatted for display. */
  expected: string;
}

export interface RuleTrace {
  rule: EvaluableRule;
  /** "triggered" means the conditions matched and the action applies. */
  triggered: boolean;
  /** True when at least one condition could not be resolved at this stage. */
  deferred: boolean;
  action: "WARN" | "BLOCK" | "NONE";
  conditions: ConditionTrace[];
}

export interface EvaluationResult {
  /** Every rule considered, in evaluation order (priority desc, then name). */
  traces: RuleTrace[];
  /** Messages from triggered BLOCK rules, highest priority first. */
  blocks: { ruleId: string; ruleName: string; message: string }[];
  /** Messages from triggered WARN rules. */
  warnings: { ruleId: string; ruleName: string; message: string }[];
  /** Convenience roll-up. */
  outcome: "PASS" | "WARNING" | "BLOCKED";
}

// ---------------------------------------------------------------------------
// Operators
// ---------------------------------------------------------------------------

function compareNumbers(actual: number, operator: Operator, expected: number): boolean {
  switch (operator) {
    case "eq":
      return actual === expected;
    case "neq":
      return actual !== expected;
    case "gt":
      return actual > expected;
    case "gte":
      return actual >= expected;
    case "lt":
      return actual < expected;
    case "lte":
      return actual <= expected;
    default:
      // Set operators are never routed here; treat as non-matching rather than
      // throwing, so one malformed rule cannot take down a whole evaluation.
      return false;
  }
}

/**
 * Money comparison in integer cents. Floating-point subtotals otherwise make
 * `subtotal >= 500` fail on a cart that is exactly 500.00.
 */
function compareMoney(actual: number, operator: Operator, expected: number): boolean {
  return compareNumbers(Math.round(actual * 100), operator, Math.round(expected * 100));
}

// ---------------------------------------------------------------------------
// Condition evaluation
// ---------------------------------------------------------------------------

function evaluateCondition(condition: Condition, cart: EvaluationCart): ConditionTrace {
  const trace = (
    outcome: ConditionOutcome,
    actual: string,
    expected: string,
  ): ConditionTrace => ({ condition, outcome, actual, expected });

  const bool = (matched: boolean, actual: string, expected: string): ConditionTrace =>
    trace(matched ? "true" : "false", actual, expected);

  switch (condition.kind) {
    case "product_quantity": {
      if (condition.product.missing) {
        return trace("undeterminable", "product no longer exists", `${condition.value}`);
      }
      const actual = quantityOfProduct(cart, condition.product.gid, condition.variant?.gid);
      return bool(
        compareNumbers(actual, condition.operator, condition.value),
        `${actual}`,
        `${condition.value}`,
      );
    }

    case "cart_quantity": {
      const actual = totalQuantity(cart);
      return bool(
        compareNumbers(actual, condition.operator, condition.value),
        `${actual}`,
        `${condition.value}`,
      );
    }

    case "cart_subtotal": {
      const actual = cart.subtotal;
      return bool(
        compareMoney(actual, condition.operator, condition.value),
        `${actual.toFixed(2)} ${cart.currencyCode}`,
        `${condition.value.toFixed(2)} ${condition.currencyCode}`,
      );
    }

    case "collection_quantity": {
      if (condition.collection.missing) {
        return trace("undeterminable", "collection no longer exists", `${condition.value}`);
      }
      const actual = quantityInCollection(cart, condition.collection.gid);
      return bool(
        compareNumbers(actual, condition.operator, condition.value),
        `${actual}`,
        `${condition.value}`,
      );
    }

    case "product_present": {
      if (condition.product.missing) {
        return trace("undeterminable", "product no longer exists", "in cart");
      }
      const inCart = quantityOfProduct(cart, condition.product.gid) > 0;
      return bool(
        inCart === condition.present,
        inCart ? "in cart" : "not in cart",
        condition.present ? "in cart" : "not in cart",
      );
    }

    case "collection_present": {
      if (condition.collection.missing) {
        return trace("undeterminable", "collection no longer exists", "in cart");
      }
      const inCart = quantityInCollection(cart, condition.collection.gid) > 0;
      return bool(
        inCart === condition.present,
        inCart ? "in cart" : "not in cart",
        condition.present ? "in cart" : "not in cart",
      );
    }

    case "customer_tag": {
      const needle = condition.value.toLowerCase();
      const has = cart.buyer.tags.includes(needle);
      const matched = condition.operator === "contains" ? has : !has;
      return bool(
        matched,
        cart.buyer.signedIn
          ? cart.buyer.tags.length
            ? cart.buyer.tags.join(", ")
            : "no tags"
          : "guest (no tags)",
        `${condition.operator === "contains" ? "has" : "does not have"} tag "${condition.value}"`,
      );
    }

    case "customer_signed_in":
      return bool(
        cart.buyer.signedIn === condition.value,
        cart.buyer.signedIn ? "signed in" : "guest",
        condition.value ? "signed in" : "guest",
      );

    case "customer_order_count": {
      const actual = cart.buyer.numberOfOrders;
      return bool(
        compareNumbers(actual, condition.operator, condition.value),
        `${actual} previous orders`,
        `${condition.value}`,
      );
    }

    case "shipping_country": {
      if (cart.shippingCountry === null) {
        return trace(
          "undeterminable",
          "no delivery address yet",
          condition.value.join(", "),
        );
      }
      const listed = condition.value.includes(cart.shippingCountry);
      return bool(
        condition.operator === "in" ? listed : !listed,
        cart.shippingCountry,
        `${condition.operator === "in" ? "one of" : "not one of"} ${condition.value.join(", ")}`,
      );
    }

    case "currency": {
      const listed = condition.value.includes(cart.currencyCode);
      return bool(
        condition.operator === "in" ? listed : !listed,
        cart.currencyCode,
        `${condition.operator === "in" ? "one of" : "not one of"} ${condition.value.join(", ")}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Rule evaluation
// ---------------------------------------------------------------------------

/**
 * Combine condition outcomes under three-valued logic (true / false /
 * undeterminable), so a rule only fires when it demonstrably matches.
 *
 * AND: any false => false. Otherwise any undeterminable => undeterminable.
 * OR:  any true  => true.  Otherwise any undeterminable => undeterminable.
 */
function combine(
  outcomes: ConditionOutcome[],
  logic: "AND" | "OR",
): ConditionOutcome {
  if (logic === "AND") {
    if (outcomes.some((o) => o === "false")) return "false";
    if (outcomes.some((o) => o === "undeterminable")) return "undeterminable";
    return "true";
  }
  if (outcomes.some((o) => o === "true")) return "true";
  if (outcomes.some((o) => o === "undeterminable")) return "undeterminable";
  return "false";
}

function negateOutcome(outcome: ConditionOutcome): ConditionOutcome {
  if (outcome === "true") return "false";
  if (outcome === "false") return "true";
  return "undeterminable";
}

export function evaluateRule(rule: EvaluableRule, cart: EvaluationCart): RuleTrace {
  const conditions = rule.definition.conditions.map((c) => evaluateCondition(c, cart));

  let outcome = combine(
    conditions.map((c) => c.outcome),
    rule.definition.logic,
  );
  if (rule.definition.negate) outcome = negateOutcome(outcome);

  const triggered = outcome === "true";
  return {
    rule,
    triggered,
    deferred: outcome === "undeterminable",
    action: triggered ? rule.definition.action.type : "NONE",
    conditions,
  };
}

/** Priority descending, then name, so evaluation order is stable and explainable. */
function byPriority(a: EvaluableRule, b: EvaluableRule): number {
  if (b.priority !== a.priority) return b.priority - a.priority;
  return a.name.localeCompare(b.name);
}

export function evaluate(rules: EvaluableRule[], cart: EvaluationCart): EvaluationResult {
  const traces = [...rules].sort(byPriority).map((rule) => evaluateRule(rule, cart));

  const blocks = traces
    .filter((t) => t.action === "BLOCK")
    .map((t) => ({ ruleId: t.rule.id, ruleName: t.rule.name, message: t.rule.message }));

  const warnings = traces
    .filter((t) => t.action === "WARN")
    .map((t) => ({ ruleId: t.rule.id, ruleName: t.rule.name, message: t.rule.message }));

  const outcome: EvaluationResult["outcome"] = blocks.length
    ? "BLOCKED"
    : warnings.length
      ? "WARNING"
      : "PASS";

  return { traces, blocks, warnings, outcome };
}
