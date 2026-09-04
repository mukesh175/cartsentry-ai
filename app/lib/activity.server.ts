/**
 * Activity log and usage metrics.
 *
 * The activity log is the merchant's audit trail: who changed what, when, and
 * what it looked like before. Writes here are best-effort — a logging failure
 * must never roll back the merchant's actual change — so every call is
 * defensively wrapped.
 */

import prisma from "../db.server";
import type { TenantContext } from "./tenancy.server";

export type ActivityEvent =
  | "RULE_CREATED"
  | "RULE_UPDATED"
  | "RULE_ACTIVATED"
  | "RULE_DISABLED"
  | "RULE_DELETED"
  | "RULE_DUPLICATED"
  | "RULE_ARCHIVED"
  | "RULE_RESTORED"
  | "RULE_NEEDS_ATTENTION"
  | "SIMULATION_RUN"
  | "CONFLICT_DETECTED"
  | "CONFLICT_RESOLVED"
  | "CONFLICT_IGNORED"
  | "AI_RULE_GENERATED"
  | "BILLING_CHANGED"
  | "SETTINGS_CHANGED"
  | "FUNCTION_CONFIG_PUBLISHED"
  | "FUNCTION_CONFIG_FAILED"
  | "FUNCTION_CONFIG_ROLLED_BACK"
  | "APP_INSTALLED"
  | "APP_UNINSTALLED";

export interface ActivityInput {
  eventType: ActivityEvent;
  summary: string;
  ruleId?: string;
  actor?: string;
  /** Before/after snapshots for auditable changes. Never include tokens or PII. */
  metadata?: Record<string, unknown>;
}

export async function recordActivity(
  ctx: Pick<TenantContext, "shopId" | "log">,
  input: ActivityInput,
): Promise<void> {
  try {
    await prisma.activityLog.create({
      data: {
        shopId: ctx.shopId,
        ruleId: input.ruleId,
        eventType: input.eventType,
        actor: input.actor ?? "merchant",
        summary: input.summary,
        metadata: (input.metadata ?? {}) as object,
      },
    });
  } catch (error) {
    ctx.log.warn({ err: error, eventType: input.eventType }, "Failed to write activity log entry");
  }
}

type MetricField = "ruleChecks" | "warnings" | "failures" | "blocks" | "simulations" | "aiRequests";

/** Increment today's usage counter. Upserts so the first event of a day creates the row. */
export async function incrementUsage(
  ctx: Pick<TenantContext, "shopId" | "log">,
  field: MetricField,
  by = 1,
): Promise<void> {
  const today = startOfUtcDay();
  try {
    await prisma.usageMetric.upsert({
      where: { shopId_date: { shopId: ctx.shopId, date: today } },
      create: { shopId: ctx.shopId, date: today, [field]: by },
      update: { [field]: { increment: by } },
    });
  } catch (error) {
    ctx.log.warn({ err: error, field }, "Failed to record usage metric");
  }
}

export function startOfUtcDay(date = new Date()): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/** Activity within the plan's retention window, newest first. */
export async function recentActivity(ctx: TenantContext, limit = 50) {
  const since = new Date();
  since.setUTCDate(since.getUTCDate() - ctx.plan.limits.historyRetentionDays);

  return prisma.activityLog.findMany({
    where: { ...ctx.scope, createdAt: { gte: since } },
    orderBy: { createdAt: "desc" },
    take: Math.min(limit, 200),
    include: { rule: { select: { id: true, name: true } } },
  });
}
