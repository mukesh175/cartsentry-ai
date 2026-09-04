/**
 * Purchase Rules Health score.
 *
 * The score is deliberately boring arithmetic over facts we can check, and
 * every point is itemised. A merchant can click "Why is my score 92?" and read
 * the exact list of deductions — no model, no heuristic, no invented weighting.
 *
 * If a factor cannot be measured, it does not appear. Nothing here is
 * estimated.
 */

import prisma from "../../db.server";
import type { TenantContext } from "../tenancy.server";

export interface ScoreFactor {
  label: string;
  detail: string;
  points: number;
  /** Where to go to fix it, when there is something to fix. */
  actionUrl?: string;
}

export interface HealthScore {
  score: number;
  /** "excellent" | "good" | "needs work" — drives the badge tone. */
  band: "excellent" | "good" | "attention";
  factors: ScoreFactor[];
  /** True when the shop has no rules at all; the UI shows onboarding instead. */
  empty: boolean;
}

const MAX_SCORE = 100;

export async function computeHealthScore(ctx: TenantContext): Promise<HealthScore> {
  const [
    totalRules,
    activeRules,
    needsAttention,
    criticalConflicts,
    otherOpenConflicts,
    blockingRulesWithoutWarning,
    lastPublish,
    failedPublish,
  ] = await Promise.all([
    prisma.rule.count({ where: { ...ctx.scope, status: { not: "ARCHIVED" } } }),
    prisma.rule.count({ where: { ...ctx.scope, status: "ACTIVE" } }),
    prisma.rule.count({ where: { ...ctx.scope, status: "NEEDS_ATTENTION" } }),
    prisma.conflict.count({ where: { ...ctx.scope, status: "OPEN", severity: "CRITICAL" } }),
    prisma.conflict.count({
      where: { ...ctx.scope, status: "OPEN", severity: { in: ["HIGH", "MEDIUM"] } },
    }),
    countBlockingRulesWithoutWarning(ctx),
    prisma.functionConfiguration.findFirst({
      where: { ...ctx.scope, status: "PUBLISHED" },
      orderBy: { version: "desc" },
    }),
    prisma.functionConfiguration.findFirst({
      where: { ...ctx.scope, status: "FAILED" },
      orderBy: { version: "desc" },
    }),
  ]);

  if (totalRules === 0) {
    return { score: MAX_SCORE, band: "excellent", factors: [], empty: true };
  }

  const factors: ScoreFactor[] = [];

  // --- Credits -------------------------------------------------------------

  if (needsAttention === 0) {
    factors.push({
      label: "All rules reference resources that exist",
      detail: "No rule points at a deleted product, variant or collection.",
      points: 10,
    });
  }

  if (criticalConflicts === 0) {
    factors.push({
      label: "No critical conflicts",
      detail: "No two rules contradict each other in a way that makes a purchase impossible.",
      points: 10,
    });
  }

  if (activeRules > 0 && lastPublish) {
    factors.push({
      label: "Rules are published to Shopify",
      detail: `Configuration v${lastPublish.version} is live and enforcing ${activeRules} rule${activeRules === 1 ? "" : "s"}.`,
      points: 10,
    });
  }

  // --- Deductions ----------------------------------------------------------

  if (needsAttention > 0) {
    factors.push({
      label: `${needsAttention} rule${needsAttention === 1 ? "" : "s"} need attention`,
      detail:
        "These reference a product or collection that no longer exists, so they are not being enforced.",
      points: -10 * Math.min(needsAttention, 3),
      actionUrl: "/app/rules?needsAttention=true",
    });
  }

  if (criticalConflicts > 0) {
    factors.push({
      label: `${criticalConflicts} critical conflict${criticalConflicts === 1 ? "" : "s"}`,
      detail: "Two or more rules contradict each other. Affected customers cannot complete a purchase.",
      points: -15 * Math.min(criticalConflicts, 3),
      actionUrl: "/app/conflicts",
    });
  }

  if (otherOpenConflicts > 0) {
    factors.push({
      label: `${otherOpenConflicts} unreviewed conflict${otherOpenConflicts === 1 ? "" : "s"}`,
      detail: "Worth a look, but they do not make any purchase impossible.",
      points: -5 * Math.min(otherOpenConflicts, 2),
      actionUrl: "/app/conflicts",
    });
  }

  if (failedPublish && (!lastPublish || failedPublish.version > lastPublish.version)) {
    factors.push({
      label: "Latest rule changes are not live",
      detail:
        "The most recent publish to Shopify failed. Your previously published rules are still being enforced.",
      points: -20,
      actionUrl: "/app/settings",
    });
  }

  if (blockingRulesWithoutWarning > 0 && ctx.plan.capabilities.canUseWarnings) {
    factors.push({
      label: `${blockingRulesWithoutWarning} blocking rule${blockingRulesWithoutWarning === 1 ? "" : "s"} without a storefront warning`,
      detail:
        "Customers only find out at checkout. Turning on an early warning tells them in the cart instead.",
      points: -5 * Math.min(blockingRulesWithoutWarning, 2),
      actionUrl: "/app/rules",
    });
  }

  // Credits total 30, so normalise against that rather than letting a healthy
  // shop sit at 30/100.
  const credits = factors.filter((f) => f.points > 0).reduce((t, f) => t + f.points, 0);
  const penalties = factors.filter((f) => f.points < 0).reduce((t, f) => t + f.points, 0);
  const score = Math.max(0, Math.min(MAX_SCORE, MAX_SCORE - Math.abs(penalties) - (30 - credits)));

  return {
    score,
    band: score >= 90 ? "excellent" : score >= 70 ? "good" : "attention",
    factors,
    empty: false,
  };
}

/**
 * Blocking rules with no storefront warning configured.
 * A blocking rule the customer only discovers at checkout is a support ticket
 * waiting to happen, which is why it costs points.
 */
async function countBlockingRulesWithoutWarning(ctx: TenantContext): Promise<number> {
  const rules = await prisma.rule.findMany({
    where: { ...ctx.scope, status: "ACTIVE" },
    select: { definition: true, warningConfig: true },
  });

  return rules.filter((rule) => {
    const definition = rule.definition as { action?: { type?: string } };
    const warning = rule.warningConfig as { enabled?: boolean };
    return definition?.action?.type === "BLOCK" && warning?.enabled !== true;
  }).length;
}
