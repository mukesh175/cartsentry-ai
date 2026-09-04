/**
 * The rule simulator.
 *
 * Answers "what happens if I activate this?" before a merchant finds out from
 * a customer. It runs the *same* evaluator the Shopify Function runs, so the
 * result is a prediction of the real thing rather than a separate model of it.
 *
 * What it deliberately does not claim: it is not a replica of Shopify checkout.
 * It evaluates CartSentry rules against a described cart. Taxes, shipping,
 * discounts, inventory and other apps' validations are outside it, and the UI
 * says so.
 */

import { z } from "zod";

import prisma from "../../db.server";
import {
  computeSubtotal,
  evaluate,
  explainCondition,
  explainConditionTrace,
  explainRuleTrace,
  SUPPORTED_CUSTOMER_TAGS,
  type EvaluableRule,
  type EvaluationCart,
  type EvaluationLine,
  type RuleDefinition,
} from "@cartsentry/engine";
import { AppError } from "../errors.server";
import type { TenantContext } from "../tenancy.server";
import { assertCanSimulate } from "../billing/entitlements.server";
import { incrementUsage, recordActivity } from "../activity.server";

export const ScenarioLineSchema = z.object({
  productGid: z.string().min(1),
  productTitle: z.string().max(255).default(""),
  variantGid: z.string().optional(),
  quantity: z.number().int().min(1).max(10_000),
  unitPrice: z.number().min(0).max(1_000_000),
  /** Collections this product belongs to, chosen in the simulator UI. */
  collectionGids: z.array(z.string()).default([]),
});

export const ScenarioSchema = z.object({
  name: z.string().max(120).optional(),
  lines: z.array(ScenarioLineSchema).min(1, "Add at least one product to the cart").max(50),
  currencyCode: z.string().length(3).default("USD"),
  buyer: z
    .object({
      signedIn: z.boolean().default(false),
      tags: z.array(z.enum(SUPPORTED_CUSTOMER_TAGS)).default([]),
      numberOfOrders: z.number().int().min(0).max(100_000).default(0),
    })
    .default({ signedIn: false, tags: [], numberOfOrders: 0 }),
  shippingCountry: z
    .string()
    .length(2)
    .nullable()
    .default(null),
  stage: z
    .enum(["CART_INTERACTION", "CHECKOUT_INTERACTION", "CHECKOUT_COMPLETION"])
    .default("CHECKOUT_INTERACTION"),
});

export type Scenario = z.infer<typeof ScenarioSchema>;

export interface TimelineStep {
  label: string;
  detail: string;
  status: "info" | "pass" | "warning" | "blocked";
}

export interface RuleOutcome {
  ruleId: string;
  ruleName: string;
  status: "PASS" | "WARNING" | "BLOCKED" | "NOT_APPLICABLE" | "DEFERRED";
  explanation: string;
  /** Per-condition detail powering the "Why?" panel. */
  conditions: {
    description: string;
    outcome: string;
    expected: string;
    actual: string;
    explanation: string;
  }[];
  suggestedFix: string | null;
}

export interface SimulationOutput {
  outcome: "PASS" | "WARNING" | "BLOCKED";
  timeline: TimelineStep[];
  rules: RuleOutcome[];
  blockingMessages: string[];
  warningMessages: string[];
  subtotal: number;
  currencyCode: string;
  /** Rules skipped because they are not live; shown so results are not misread. */
  evaluatedRuleCount: number;
}

function toCart(scenario: Scenario): EvaluationCart {
  const lines: EvaluationLine[] = scenario.lines.map((line) => ({
    productGid: line.productGid,
    variantGid: line.variantGid,
    title: line.productTitle,
    quantity: line.quantity,
    unitPrice: line.unitPrice,
    collectionGids: line.collectionGids,
  }));

  return {
    lines,
    // Always derived, never taken from input, so a scenario cannot describe a
    // subtotal that contradicts its own line items.
    subtotal: computeSubtotal(lines),
    currencyCode: scenario.currencyCode,
    buyer: scenario.buyer,
    shippingCountry: scenario.shippingCountry,
    stage: scenario.stage,
  };
}

/**
 * Build the customer-journey timeline. Steps mirror what a shopper actually
 * does, which is what makes a failure legible to a non-technical merchant.
 */
function buildTimeline(scenario: Scenario, output: Omit<SimulationOutput, "timeline">): TimelineStep[] {
  const steps: TimelineStep[] = [{
    label: "Customer opens the store",
    detail: scenario.buyer.signedIn
      ? `Signed in${scenario.buyer.tags.length ? ` with tags: ${scenario.buyer.tags.join(", ")}` : ""}`
      : "Shopping as a guest",
    status: "info",
  }];

  for (const line of scenario.lines) {
    steps.push({
      label: `Adds ${line.quantity} × ${line.productTitle || "product"}`,
      detail: `${(line.unitPrice * line.quantity).toFixed(2)} ${scenario.currencyCode}`,
      status: "info",
    });
  }

  steps.push({
    label: "Cart subtotal",
    detail: `${output.subtotal.toFixed(2)} ${scenario.currencyCode}`,
    status: "info",
  });

  steps.push({
    label: `${output.evaluatedRuleCount} rule${output.evaluatedRuleCount === 1 ? "" : "s"} evaluated`,
    detail:
      output.evaluatedRuleCount === 0
        ? "No active or draft rules apply to this store yet."
        : "CartSentry checks every rule against the cart.",
    status: "info",
  });

  for (const message of output.warningMessages) {
    steps.push({ label: "Customer sees a warning", detail: message, status: "warning" });
  }

  if (output.outcome === "BLOCKED") {
    steps.push({
      label: "Checkout attempt",
      detail: "Shopify prevents the purchase and shows the rule's message.",
      status: "blocked",
    });
    for (const message of output.blockingMessages) {
      steps.push({ label: "Customer sees", detail: message, status: "blocked" });
    }
  } else {
    steps.push({
      label: "Checkout attempt",
      detail: "The purchase is allowed to proceed.",
      status: "pass",
    });
  }

  return steps;
}

function suggestFix(outcome: RuleOutcome): string | null {
  if (outcome.status !== "BLOCKED" && outcome.status !== "WARNING") return null;
  const failing = outcome.conditions.find((c) => c.outcome === "true");
  if (!failing) return null;
  return `To let this cart through, change "${outcome.ruleName}" so that ${failing.description} is no longer true, or adjust its threshold.`;
}

/**
 * Run a scenario against the shop's rules.
 *
 * `ruleIds` limits evaluation to specific rules — used by the rule builder to
 * preview a single unsaved rule. When omitted, every ACTIVE and DRAFT rule is
 * evaluated, so a merchant sees interactions between rules too.
 */
export async function simulate(
  ctx: TenantContext,
  rawScenario: unknown,
  options: { ruleIds?: string[]; extraRules?: EvaluableRule[]; persist?: boolean } = {},
): Promise<SimulationOutput> {
  await assertCanSimulate(ctx);

  const parsed = ScenarioSchema.safeParse(rawScenario);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path.join(".") || "scenario";
      if (!fieldErrors[key]) fieldErrors[key] = issue.message;
    }
    throw new AppError("VALIDATION", { details: { fieldErrors } });
  }
  const scenario = parsed.data;

  const stored = await prisma.rule.findMany({
    where: {
      ...ctx.scope,
      status: { in: ["ACTIVE", "DRAFT"] },
      ...(options.ruleIds ? { id: { in: options.ruleIds } } : {}),
    },
  });

  const rules: EvaluableRule[] = [
    ...stored.map((r) => ({
      id: r.id,
      name: r.name,
      priority: r.priority,
      message: r.message,
      definition: r.definition as RuleDefinition,
    })),
    ...(options.extraRules ?? []),
  ];

  const cart = toCart(scenario);
  const result = evaluate(rules, cart);

  const ruleOutcomes: RuleOutcome[] = result.traces.map((trace) => {
    const status: RuleOutcome["status"] = trace.deferred
      ? "DEFERRED"
      : !trace.triggered
        ? "NOT_APPLICABLE"
        : trace.action === "BLOCK"
          ? "BLOCKED"
          : "WARNING";

    const outcome: RuleOutcome = {
      ruleId: trace.rule.id,
      ruleName: trace.rule.name,
      status,
      explanation: explainRuleTrace(trace),
      conditions: trace.conditions.map((c) => ({
        description: explainCondition(c.condition),
        outcome: c.outcome,
        expected: c.expected,
        actual: c.actual,
        explanation: explainConditionTrace(c),
      })),
      suggestedFix: null,
    };
    outcome.suggestedFix = suggestFix(outcome);
    return outcome;
  });

  const partial: Omit<SimulationOutput, "timeline"> = {
    outcome: result.outcome,
    rules: ruleOutcomes,
    blockingMessages: result.blocks.map((b) => b.message),
    warningMessages: result.warnings.map((w) => w.message),
    subtotal: cart.subtotal,
    currencyCode: cart.currencyCode,
    evaluatedRuleCount: rules.length,
  };

  const output: SimulationOutput = { ...partial, timeline: buildTimeline(scenario, partial) };

  if (options.persist !== false) {
    await prisma.simulation.create({
      data: {
        shopId: ctx.shopId,
        name: scenario.name,
        scenario: scenario as object,
        result: output as unknown as object,
        outcome: output.outcome,
      },
    });
    await incrementUsage(ctx, "simulations");
    await recordActivity(ctx, {
      eventType: "SIMULATION_RUN",
      summary: `Ran a simulation — result: ${output.outcome}.`,
      metadata: { outcome: output.outcome, rules: rules.length },
    });
  }

  return output;
}
