/**
 * Conflict detection.
 *
 * Design constraint from the product spec: never call something a conflict
 * unless it can be *proved* from the rule definitions. A false CRITICAL costs
 * the merchant more trust than a missed MEDIUM, so every detector here either
 * demonstrates an impossibility or downgrades itself to a lower confidence.
 *
 * Confidence levels:
 *   confirmed  — provably impossible to satisfy, or provably redundant
 *   potential  — same scope, outcomes disagree, but a cart could avoid both
 *   overlap    — rules can co-fire; worth a look, not necessarily wrong
 *
 * Scope matters: two rules only conflict if they can apply to the same cart at
 * the same time. Rules gated on mutually exclusive customer tags or countries
 * are not in conflict, and `scopesCanOverlap` is what stops the noise.
 */

import type { Condition, RuleDefinition } from "./rule-schema";

export type ConflictSeverity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO";
export type ConflictConfidence = "confirmed" | "potential" | "overlap";

export interface ConflictInput {
  id: string;
  name: string;
  status: string;
  priority: number;
  definition: RuleDefinition;
}

export interface DetectedConflict {
  /** Stable across scans so a rescan updates rather than duplicates. */
  fingerprint: string;
  type: string;
  severity: ConflictSeverity;
  confidence: ConflictConfidence;
  ruleId: string;
  relatedRuleId: string | null;
  explanation: string;
  /** A concrete cart that demonstrates the problem, when one exists. */
  scenario: { description: string } | null;
  suggestedFix: string;
}

// ---------------------------------------------------------------------------
// Numeric interval reasoning
// ---------------------------------------------------------------------------

/**
 * The set of values a numeric condition permits, as a closed integer interval.
 * `null` bounds mean unbounded.
 */
interface Interval {
  min: number | null;
  max: number | null;
}

/**
 * Convert a numeric condition into the interval of values that *trigger* it.
 *
 * Careful: a BLOCK rule fires on the values it matches, so "block when
 * quantity > 5" triggers on [6, ∞) and therefore *permits* [0, 5]. The
 * conflict analysis below works on permitted ranges, which is what a merchant
 * actually reasons about.
 */
function triggerInterval(condition: Condition, integer: boolean): Interval | null {
  if (!("operator" in condition) || !("value" in condition)) return null;
  if (typeof condition.value !== "number") return null;

  const v = condition.value;
  const step = integer ? 1 : 0.01;

  switch (condition.operator) {
    case "gt":
      return { min: v + step, max: null };
    case "gte":
      return { min: v, max: null };
    case "lt":
      return { min: null, max: v - step };
    case "lte":
      return { min: null, max: v };
    case "eq":
      return { min: v, max: v };
    case "neq":
      // Complement of a point is not an interval; not analysable this way.
      return null;
    default:
      return null;
  }
}

/** Values a BLOCK rule leaves available — the complement of its trigger interval. */
function permittedInterval(trigger: Interval, integer: boolean): Interval | null {
  const step = integer ? 1 : 0.01;
  if (trigger.min !== null && trigger.max === null) return { min: null, max: trigger.min - step };
  if (trigger.max !== null && trigger.min === null) return { min: trigger.max + step, max: null };
  // A point trigger leaves a disjoint complement; not a single interval.
  return null;
}

function intersect(a: Interval, b: Interval): Interval {
  return {
    min: a.min === null ? b.min : b.min === null ? a.min : Math.max(a.min, b.min),
    max: a.max === null ? b.max : b.max === null ? a.max : Math.min(a.max, b.max),
  };
}

function isEmpty(interval: Interval): boolean {
  return interval.min !== null && interval.max !== null && interval.min > interval.max;
}

function describe(interval: Interval, unit: string): string {
  if (interval.min !== null && interval.max !== null) {
    return `between ${fmt(interval.min)} and ${fmt(interval.max)} ${unit}`;
  }
  if (interval.min !== null) return `at least ${fmt(interval.min)} ${unit}`;
  if (interval.max !== null) return `at most ${fmt(interval.max)} ${unit}`;
  return `any number of ${unit}`;
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

/**
 * The "subject" a numeric condition constrains. Two rules can only contradict
 * each other numerically if they constrain the same subject.
 */
function numericSubject(condition: Condition): { key: string; label: string; unit: string; integer: boolean } | null {
  switch (condition.kind) {
    case "product_quantity":
      return {
        key: `product:${condition.product.gid}:${condition.variant?.gid ?? "*"}`,
        label: `"${condition.product.title}"`,
        unit: "units",
        integer: true,
      };
    case "cart_quantity":
      return { key: "cart:quantity", label: "the cart", unit: "items", integer: true };
    case "cart_subtotal":
      return {
        key: `cart:subtotal:${condition.currencyCode}`,
        label: "the cart subtotal",
        unit: condition.currencyCode,
        integer: false,
      };
    case "collection_quantity":
      return {
        key: `collection:${condition.collection.gid}`,
        label: `"${condition.collection.title}"`,
        unit: "items",
        integer: true,
      };
    default:
      return null;
  }
}

/** Conditions that gate *who* or *where* a rule applies to. */
function scopeConditions(definition: RuleDefinition): Condition[] {
  return definition.conditions.filter((c) =>
    ["customer_tag", "customer_signed_in", "shipping_country", "currency"].includes(c.kind),
  );
}

/**
 * Can a single cart satisfy both rules' scope gates at once?
 *
 * Returns false only when the scopes are provably disjoint — e.g. one rule
 * requires the "wholesale" tag and the other requires its absence. Anything
 * else returns true, so uncertainty never suppresses a real conflict.
 */
function scopesCanOverlap(a: RuleDefinition, b: RuleDefinition): boolean {
  // OR-logic rules can fire from any single condition, so their scope gates are
  // not actually required; treat them as unconstrained.
  if (a.logic === "OR" || b.logic === "OR") return true;
  if (a.negate || b.negate) return true;

  const scopeA = scopeConditions(a);
  const scopeB = scopeConditions(b);

  for (const ca of scopeA) {
    for (const cb of scopeB) {
      if (ca.kind === "customer_tag" && cb.kind === "customer_tag") {
        if (
          ca.value.toLowerCase() === cb.value.toLowerCase() &&
          ca.operator !== cb.operator
        ) {
          return false; // one requires the tag, the other requires its absence
        }
      }
      if (ca.kind === "customer_signed_in" && cb.kind === "customer_signed_in") {
        if (ca.value !== cb.value) return false;
      }
      if (ca.kind === "shipping_country" && cb.kind === "shipping_country") {
        if (ca.operator === "in" && cb.operator === "in") {
          const shared = ca.value.filter((v) => cb.value.includes(v));
          if (shared.length === 0) return false;
        }
      }
      if (ca.kind === "currency" && cb.kind === "currency") {
        if (ca.operator === "in" && cb.operator === "in") {
          const shared = ca.value.filter((v) => cb.value.includes(v));
          if (shared.length === 0) return false;
        }
      }
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Fingerprinting
// ---------------------------------------------------------------------------

function fingerprint(type: string, ruleIds: string[]): string {
  return `${type}:${[...ruleIds].sort().join("|")}`;
}

// ---------------------------------------------------------------------------
// Detectors
// ---------------------------------------------------------------------------

/** Only BLOCK rules restrict what a customer can do, so only they can contradict. */
function isBlocking(rule: ConflictInput): boolean {
  return rule.definition.action.type === "BLOCK";
}

/** Rules that actually affect shoppers, plus drafts (so problems surface before activation). */
function isConsidered(rule: ConflictInput): boolean {
  return rule.status === "ACTIVE" || rule.status === "DRAFT";
}

/**
 * Impossible numeric range: two BLOCK rules on the same subject whose permitted
 * ranges do not intersect. Nothing the customer does can satisfy both.
 */
function detectImpossibleRange(a: ConflictInput, b: ConflictInput): DetectedConflict | null {
  if (!isBlocking(a) || !isBlocking(b)) return null;
  if (!scopesCanOverlap(a.definition, b.definition)) return null;

  for (const ca of a.definition.conditions) {
    const subjectA = numericSubject(ca);
    if (!subjectA) continue;

    for (const cb of b.definition.conditions) {
      const subjectB = numericSubject(cb);
      if (!subjectB || subjectA.key !== subjectB.key) continue;

      const triggerA = triggerInterval(ca, subjectA.integer);
      const triggerB = triggerInterval(cb, subjectB.integer);
      if (!triggerA || !triggerB) continue;

      const permittedA = permittedInterval(triggerA, subjectA.integer);
      const permittedB = permittedInterval(triggerB, subjectB.integer);
      if (!permittedA || !permittedB) continue;

      const both = intersect(permittedA, permittedB);
      if (!isEmpty(both)) continue;

      return {
        fingerprint: fingerprint("IMPOSSIBLE_RANGE", [a.id, b.id]),
        type: "IMPOSSIBLE_RANGE",
        severity: "CRITICAL",
        confidence: "confirmed",
        ruleId: a.id,
        relatedRuleId: b.id,
        explanation:
          `"${a.name}" allows ${describe(permittedA, subjectA.unit)} for ${subjectA.label}, ` +
          `while "${b.name}" allows ${describe(permittedB, subjectB.unit)}. ` +
          `No value satisfies both, so every affected cart is blocked.`,
        scenario: {
          description: `Any cart containing ${subjectA.label} is blocked, whatever the quantity.`,
        },
        suggestedFix: `Widen or remove one of the two limits so their permitted ranges overlap.`,
      };
    }
  }
  return null;
}

/**
 * Redundancy: two BLOCK rules on the same subject where one's permitted range
 * fully contains the other's. The looser rule can never be the binding one.
 */
function detectRedundantRange(a: ConflictInput, b: ConflictInput): DetectedConflict | null {
  if (!isBlocking(a) || !isBlocking(b)) return null;
  if (!scopesCanOverlap(a.definition, b.definition)) return null;

  for (const ca of a.definition.conditions) {
    const subjectA = numericSubject(ca);
    if (!subjectA) continue;

    for (const cb of b.definition.conditions) {
      const subjectB = numericSubject(cb);
      if (!subjectB || subjectA.key !== subjectB.key) continue;

      const tA = triggerInterval(ca, subjectA.integer);
      const tB = triggerInterval(cb, subjectB.integer);
      if (!tA || !tB) continue;

      const pA = permittedInterval(tA, subjectA.integer);
      const pB = permittedInterval(tB, subjectB.integer);
      if (!pA || !pB) continue;

      // Same direction only: a min and a max are complementary, not redundant.
      const sameDirection =
        (pA.max !== null && pB.max !== null && pA.min === null && pB.min === null) ||
        (pA.min !== null && pB.min !== null && pA.max === null && pB.max === null);
      if (!sameDirection) continue;

      const aStricter =
        (pA.max !== null && pB.max !== null && pA.max < pB.max) ||
        (pA.min !== null && pB.min !== null && pA.min > pB.min);
      const equal = pA.max === pB.max && pA.min === pB.min;
      if (equal) continue;

      const [stricter, looser] = aStricter ? [a, b] : [b, a];
      return {
        fingerprint: fingerprint("REDUNDANT_RULE", [a.id, b.id]),
        type: "REDUNDANT_RULE",
        severity: "LOW",
        confidence: "confirmed",
        ruleId: looser.id,
        relatedRuleId: stricter.id,
        explanation:
          `"${stricter.name}" is stricter than "${looser.name}" for ${subjectA.label} and applies to the same carts, ` +
          `so "${looser.name}" can never be the rule that stops a purchase.`,
        scenario: null,
        suggestedFix: `Keep "${stricter.name}" and archive "${looser.name}", unless the looser rule exists to show a different message.`,
      };
    }
  }
  return null;
}

/**
 * Requirement vs incompatibility: one rule says A requires B, another says A
 * cannot be bought with B. Any cart containing A is then unsellable.
 */
function detectRequirementContradiction(
  a: ConflictInput,
  b: ConflictInput,
): DetectedConflict | null {
  if (!isBlocking(a) || !isBlocking(b)) return null;
  if (!scopesCanOverlap(a.definition, b.definition)) return null;

  const pairA = presencePair(a.definition);
  const pairB = presencePair(b.definition);
  if (!pairA || !pairB) return null;

  // Same two products, but one rule fires when B is present and the other when
  // B is absent — given A is present in both.
  const sameProducts =
    pairA.anchor === pairB.anchor && pairA.other === pairB.other;
  if (!sameProducts) return null;
  if (pairA.otherPresent === pairB.otherPresent) return null;

  const [requires, forbids] = pairA.otherPresent ? [b, a] : [a, b];

  return {
    fingerprint: fingerprint("REQUIREMENT_CONTRADICTION", [a.id, b.id]),
    type: "REQUIREMENT_CONTRADICTION",
    severity: "CRITICAL",
    confidence: "confirmed",
    ruleId: a.id,
    relatedRuleId: b.id,
    explanation:
      `"${requires.name}" requires ${pairA.otherLabel} to be in the cart with ${pairA.anchorLabel}, ` +
      `while "${forbids.name}" blocks that exact combination. ` +
      `A customer who adds ${pairA.anchorLabel} is blocked whether or not they add ${pairA.otherLabel}.`,
    scenario: {
      description: `Cart with ${pairA.anchorLabel} only → blocked by "${requires.name}". Cart with ${pairA.anchorLabel} and ${pairA.otherLabel} → blocked by "${forbids.name}".`,
    },
    suggestedFix: `Decide which relationship is correct and disable the other rule.`,
  };
}

/** Extract the (anchor present, other present/absent) shape of a two-product rule. */
function presencePair(definition: RuleDefinition): {
  anchor: string;
  anchorLabel: string;
  other: string;
  otherLabel: string;
  otherPresent: boolean;
} | null {
  if (definition.logic !== "AND" || definition.negate) return null;
  const presence = definition.conditions.filter((c) => c.kind === "product_present");
  if (presence.length !== 2 || definition.conditions.length !== 2) return null;

  const [first, second] = presence as Extract<Condition, { kind: "product_present" }>[];
  // The anchor is the product that must be present in both readings.
  const anchorCondition = first.present ? first : second;
  const otherCondition = anchorCondition === first ? second : first;
  if (!anchorCondition.present) return null;

  return {
    anchor: anchorCondition.product.gid,
    anchorLabel: `"${anchorCondition.product.title}"`,
    other: otherCondition.product.gid,
    otherLabel: `"${otherCondition.product.title}"`,
    otherPresent: otherCondition.present,
  };
}

/**
 * Two rules that can fire on the same cart with different actions (one warns,
 * one blocks). Not wrong, but the warning is cosmetic — the block wins.
 */
function detectActionOverlap(a: ConflictInput, b: ConflictInput): DetectedConflict | null {
  if (a.definition.action.type === b.definition.action.type) return null;
  if (!scopesCanOverlap(a.definition, b.definition)) return null;
  if (!sameSubjects(a.definition, b.definition)) return null;

  const [warn, block] =
    a.definition.action.type === "WARN" ? [a, b] : [b, a];

  return {
    fingerprint: fingerprint("ACTION_OVERLAP", [a.id, b.id]),
    type: "ACTION_OVERLAP",
    severity: "MEDIUM",
    confidence: "potential",
    ruleId: warn.id,
    relatedRuleId: block.id,
    explanation:
      `"${warn.name}" warns and "${block.name}" blocks on the same thing. ` +
      `When both apply the customer is blocked, so the warning only changes what they read on the way there.`,
    scenario: null,
    suggestedFix: `This is fine if the warning is meant as an early heads-up. If not, align the two rules' thresholds.`,
  };
}

function sameSubjects(a: RuleDefinition, b: RuleDefinition): boolean {
  const keysA = new Set(
    a.conditions.map((c) => numericSubject(c)?.key).filter(Boolean) as string[],
  );
  if (keysA.size === 0) return false;
  return b.conditions.some((c) => {
    const key = numericSubject(c)?.key;
    return key ? keysA.has(key) : false;
  });
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const DETECTORS = [
  detectImpossibleRange,
  detectRequirementContradiction,
  detectRedundantRange,
  detectActionOverlap,
];

/**
 * Scan every pair of considered rules. Returns at most one conflict per
 * (type, pair) so a rescan is idempotent.
 */
export function detectConflicts(rules: ConflictInput[]): DetectedConflict[] {
  const considered = rules.filter(isConsidered);
  const found = new Map<string, DetectedConflict>();

  for (let i = 0; i < considered.length; i += 1) {
    for (let j = i + 1; j < considered.length; j += 1) {
      for (const detect of DETECTORS) {
        const conflict = detect(considered[i]!, considered[j]!);
        if (conflict && !found.has(conflict.fingerprint)) {
          found.set(conflict.fingerprint, conflict);
        }
      }
    }
  }

  return [...found.values()].sort(
    (a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity),
  );
}

const SEVERITY_ORDER: ConflictSeverity[] = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"];

/** Critical conflicts gate activation (see docs/ARCHITECTURE.md, activation safety). */
export function hasCriticalConflict(conflicts: DetectedConflict[], ruleId: string): boolean {
  return conflicts.some(
    (c) =>
      c.severity === "CRITICAL" &&
      c.confidence === "confirmed" &&
      (c.ruleId === ruleId || c.relatedRuleId === ruleId),
  );
}
