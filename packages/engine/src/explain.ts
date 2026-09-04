/**
 * Turns rule structures and evaluation traces into sentences a merchant can read.
 *
 * Two audiences, deliberately separated:
 *   - merchant explanations describe the mechanism ("blocks the purchase when…")
 *   - customer messages are authored by the merchant and never generated here
 *
 * All output is plain text. Callers render it as text, never as HTML.
 */

import type { Condition, RuleDefinition } from "./rule-schema";
import { OPERATOR_LABELS } from "./rule-schema";
import type { ConditionTrace, RuleTrace } from "./evaluate";

function money(amount: number, currency: string): string {
  return `${amount.toFixed(2)} ${currency}`;
}

/** e.g. `the quantity of "Premium T-Shirt" is at least 5` */
export function explainCondition(condition: Condition): string {
  switch (condition.kind) {
    case "product_quantity": {
      const target = condition.variant?.title
        ? `"${condition.product.title}" (${condition.variant.title})`
        : `"${condition.product.title}"`;
      return `the quantity of ${target} in the cart ${OPERATOR_LABELS[condition.operator]} ${condition.value}`;
    }
    case "cart_quantity":
      return `the total number of items in the cart ${OPERATOR_LABELS[condition.operator]} ${condition.value}`;
    case "cart_subtotal":
      return `the cart subtotal ${OPERATOR_LABELS[condition.operator]} ${money(condition.value, condition.currencyCode)}`;
    case "collection_quantity":
      return `the number of items from "${condition.collection.title}" ${OPERATOR_LABELS[condition.operator]} ${condition.value}`;
    case "product_present":
      return condition.present
        ? `"${condition.product.title}" is in the cart`
        : `"${condition.product.title}" is not in the cart`;
    case "collection_present":
      return condition.present
        ? `an item from "${condition.collection.title}" is in the cart`
        : `no item from "${condition.collection.title}" is in the cart`;
    case "customer_tag":
      return condition.operator === "contains"
        ? `the customer has the tag "${condition.value}"`
        : `the customer does not have the tag "${condition.value}"`;
    case "customer_signed_in":
      return condition.value
        ? "the customer is signed in"
        : "the customer is shopping as a guest";
    case "customer_order_count":
      return `the customer's previous order count ${OPERATOR_LABELS[condition.operator]} ${condition.value}`;
    case "shipping_country":
      return condition.operator === "in"
        ? `the delivery country is one of ${condition.value.join(", ")}`
        : `the delivery country is not one of ${condition.value.join(", ")}`;
    case "currency":
      return condition.operator === "in"
        ? `the cart currency is one of ${condition.value.join(", ")}`
        : `the cart currency is not one of ${condition.value.join(", ")}`;
  }
}

/** A full sentence describing what the rule does, for the rule preview. */
export function explainRule(definition: RuleDefinition): string {
  const joiner = definition.logic === "AND" ? " and " : " or ";
  const clauses = definition.conditions.map(explainCondition).join(joiner);
  const when = definition.negate ? `it is not true that ${clauses}` : clauses;
  const verb =
    definition.action.type === "BLOCK"
      ? "blocks the purchase"
      : "shows a warning to the customer";
  return `This rule ${verb} when ${when}.`;
}

/** Short "WHEN … THEN …" form used by the rule preview card. */
export function rulePreviewLines(definition: RuleDefinition): {
  when: string[];
  logic: "AND" | "OR";
  negate: boolean;
  then: string;
} {
  return {
    when: definition.conditions.map(explainCondition),
    logic: definition.logic,
    negate: definition.negate,
    then: definition.action.type === "BLOCK" ? "Block purchase" : "Warn customer",
  };
}

// ---------------------------------------------------------------------------
// Simulation explanations
// ---------------------------------------------------------------------------

/** e.g. `Expected: at most 5. Actual: 6. The cart has 1 more than allowed.` */
export function explainConditionTrace(trace: ConditionTrace): string {
  const { condition, outcome, actual, expected } = trace;

  if (outcome === "undeterminable") {
    return `Could not be determined yet — ${actual}. This condition is only checked once the information is available.`;
  }

  const base = `Expected ${expected}, cart has ${actual}.`;

  // Add the concrete gap for numeric quantity conditions, which is the single
  // most useful thing a merchant can read off a failed simulation.
  const numericKinds = ["product_quantity", "cart_quantity", "collection_quantity"];
  if (numericKinds.includes(condition.kind)) {
    const actualNum = Number(actual);
    const expectedNum = Number(expected);
    if (Number.isFinite(actualNum) && Number.isFinite(expectedNum)) {
      const diff = actualNum - expectedNum;
      if (diff > 0) return `${base} That is ${diff} more than the limit.`;
      if (diff < 0) return `${base} That is ${-diff} short of the requirement.`;
    }
  }

  return base;
}

/** Why a rule did or did not fire, for the simulator's "Why?" panel. */
export function explainRuleTrace(trace: RuleTrace): string {
  if (trace.deferred) {
    return `"${trace.rule.name}" could not be fully evaluated at this stage because some information is not available yet.`;
  }
  if (!trace.triggered) {
    return `"${trace.rule.name}" did not apply to this cart.`;
  }
  return trace.action === "BLOCK"
    ? `"${trace.rule.name}" blocked this purchase.`
    : `"${trace.rule.name}" warned the customer but did not block the purchase.`;
}
