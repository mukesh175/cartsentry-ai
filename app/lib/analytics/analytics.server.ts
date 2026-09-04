/**
 * Rule analytics.
 *
 * Scope note, and it matters: CartSentry reports what CartSentry can observe —
 * simulations run, rules published, rules flagged, conflicts found, and the
 * counters the app itself increments.
 *
 * It does NOT report checkout conversion, revenue saved, or how many customers
 * hit a rule at checkout. Shopify Functions run on Shopify's servers and do not
 * call back into the app, so per-shopper enforcement events are not observable
 * from here. Rather than estimate them, the UI says so. See docs/LIMITATIONS.md.
 */

import prisma from "../../db.server";
import type { TenantContext } from "../tenancy.server";
import { assertEntitled } from "../billing/entitlements.server";
import { startOfUtcDay } from "../activity.server";

export type DateRange = "today" | "7d" | "30d" | "90d" | "custom";

export interface AnalyticsQuery {
  range: DateRange;
  from?: string;
  to?: string;
}

export interface DailyPoint {
  date: string;
  simulations: number;
  aiRequests: number;
}

export interface AnalyticsResult {
  from: Date;
  to: Date;
  totals: {
    simulations: number;
    aiRequests: number;
    rulesCreated: number;
    rulesActivated: number;
    conflictsDetected: number;
    publishes: number;
  };
  daily: DailyPoint[];
  topRules: { ruleId: string; name: string; status: string; events: number }[];
  /** Retention actually applied, so the UI can say "last 30 days on your plan". */
  retentionDays: number;
  /** True when the requested range was clipped by the plan's retention. */
  clipped: boolean;
}

function resolveRange(query: AnalyticsQuery, retentionDays: number): { from: Date; to: Date; clipped: boolean } {
  const to = new Date();
  let from = new Date();

  switch (query.range) {
    case "today":
      from = startOfUtcDay();
      break;
    case "7d":
      from.setUTCDate(from.getUTCDate() - 7);
      break;
    case "90d":
      from.setUTCDate(from.getUTCDate() - 90);
      break;
    case "custom":
      if (query.from) from = new Date(query.from);
      break;
    case "30d":
    default:
      from.setUTCDate(from.getUTCDate() - 30);
  }

  const earliest = new Date();
  earliest.setUTCDate(earliest.getUTCDate() - retentionDays);

  const clipped = from < earliest;
  return { from: clipped ? earliest : from, to, clipped };
}

export async function ruleAnalytics(
  ctx: TenantContext,
  query: AnalyticsQuery = { range: "30d" },
): Promise<AnalyticsResult> {
  if (query.range === "90d" || query.range === "custom") {
    assertEntitled(ctx, "canUseAdvancedAnalytics");
  }

  const retentionDays = ctx.plan.limits.historyRetentionDays;
  const { from, to, clipped } = resolveRange(query, retentionDays);

  const [metrics, activity] = await Promise.all([
    prisma.usageMetric.findMany({
      where: { ...ctx.scope, date: { gte: startOfUtcDay(from), lte: to } },
      orderBy: { date: "asc" },
    }),
    prisma.activityLog.findMany({
      where: { ...ctx.scope, createdAt: { gte: from, lte: to } },
      select: { eventType: true, ruleId: true },
    }),
  ]);

  const countOf = (eventType: string) =>
    activity.filter((a) => a.eventType === eventType).length;

  const eventsByRule = new Map<string, number>();
  for (const entry of activity) {
    if (!entry.ruleId) continue;
    eventsByRule.set(entry.ruleId, (eventsByRule.get(entry.ruleId) ?? 0) + 1);
  }

  const topRuleIds = [...eventsByRule.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([ruleId]) => ruleId);

  const topRuleRecords = topRuleIds.length
    ? await prisma.rule.findMany({
        where: { ...ctx.scope, id: { in: topRuleIds } },
        select: { id: true, name: true, status: true },
      })
    : [];

  const topRules = topRuleRecords
    .map((rule) => ({
      ruleId: rule.id,
      name: rule.name,
      status: rule.status,
      events: eventsByRule.get(rule.id) ?? 0,
    }))
    .sort((a, b) => b.events - a.events);

  return {
    from,
    to,
    totals: {
      simulations: metrics.reduce((sum, m) => sum + m.simulations, 0),
      aiRequests: metrics.reduce((sum, m) => sum + m.aiRequests, 0),
      rulesCreated: countOf("RULE_CREATED"),
      rulesActivated: countOf("RULE_ACTIVATED"),
      conflictsDetected: countOf("CONFLICT_DETECTED"),
      publishes: countOf("FUNCTION_CONFIG_PUBLISHED"),
    },
    daily: metrics.map((m) => ({
      date: m.date.toISOString().slice(0, 10),
      simulations: m.simulations,
      aiRequests: m.aiRequests,
    })),
    topRules,
    retentionDays,
    clipped,
  };
}

/** Per-rule detail for the rule page. */
export async function ruleDetailAnalytics(ctx: TenantContext, ruleId: string) {
  await ctx.requireRule(ruleId);

  const since = new Date();
  since.setUTCDate(since.getUTCDate() - ctx.plan.limits.historyRetentionDays);

  const [activity, versions, conflicts] = await Promise.all([
    prisma.activityLog.findMany({
      where: { ...ctx.scope, ruleId, createdAt: { gte: since } },
      orderBy: { createdAt: "desc" },
      take: 25,
    }),
    prisma.ruleVersion.count({ where: { ruleId } }),
    prisma.conflict.count({
      where: { ...ctx.scope, status: "OPEN", OR: [{ ruleId }, { relatedRuleId: ruleId }] },
    }),
  ]);

  return { activity, versionCount: versions, openConflicts: conflicts };
}
