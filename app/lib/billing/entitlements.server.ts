/**
 * Server-side entitlement enforcement.
 *
 * Every gated action calls one of these before doing work. The UI also reads
 * entitlements to hide unavailable features, but that is presentation only —
 * a request that reaches the server without an entitlement is rejected here.
 */

import prisma from "../../db.server";
import { AppError } from "../errors.server";
import type { TenantContext } from "../tenancy.server";
import { type Capability, lowestPlanWith } from "./plans";

export interface EntitlementSnapshot {
  planName: string;
  capabilities: Record<Capability, boolean>;
  activeRules: number;
  maxActiveRules: number;
  simulationsThisMonth: number;
  maxSimulationsPerMonth: number | null;
  aiRequestsThisMonth: number;
  maxAiRequestsPerMonth: number;
  /** True when the shop is over its active-rule allowance (e.g. after a downgrade). */
  overRuleLimit: boolean;
}

function startOfMonth(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export async function entitlementSnapshot(ctx: TenantContext): Promise<EntitlementSnapshot> {
  const since = startOfMonth();

  const [activeRules, simulationsThisMonth, aiRequestsThisMonth] = await Promise.all([
    prisma.rule.count({ where: { ...ctx.scope, status: "ACTIVE" } }),
    prisma.simulation.count({ where: { ...ctx.scope, createdAt: { gte: since } } }),
    prisma.aIRequest.count({
      where: { ...ctx.scope, createdAt: { gte: since }, status: "SUCCESS" },
    }),
  ]);

  const { limits, capabilities } = ctx.plan;

  return {
    planName: ctx.plan.name,
    capabilities,
    activeRules,
    maxActiveRules: limits.maxActiveRules,
    simulationsThisMonth,
    maxSimulationsPerMonth: limits.maxSimulationsPerMonth,
    aiRequestsThisMonth,
    maxAiRequestsPerMonth: limits.maxAiRequestsPerMonth,
    overRuleLimit: activeRules > limits.maxActiveRules,
  };
}

/** Throw PLAN_LIMIT unless the shop's plan includes `capability`. */
export function assertEntitled(ctx: TenantContext, capability: Capability): void {
  if (ctx.plan.capabilities[capability]) return;

  const upgrade = lowestPlanWith(capability);
  ctx.log.info({ capability, plan: ctx.plan.name }, "Blocked by plan entitlement");
  throw new AppError("PLAN_LIMIT", {
    details: {
      capability,
      currentPlan: ctx.plan.name,
      requiredPlan: upgrade?.name ?? null,
      requiredPlanTitle: upgrade?.title ?? null,
    },
  });
}

/**
 * Throw when activating another rule would exceed the plan's allowance.
 *
 * Only ACTIVE rules count. Downgrading never deletes rules — it can leave a
 * shop over the limit, and this check then prevents activating more while
 * leaving the existing ones alone (see docs/BILLING.md).
 */
export async function assertCanActivateRule(ctx: TenantContext): Promise<void> {
  const activeRules = await prisma.rule.count({
    where: { ...ctx.scope, status: "ACTIVE" },
  });

  if (activeRules < ctx.plan.limits.maxActiveRules) return;

  throw new AppError("PLAN_LIMIT", {
    details: {
      capability: "maxActiveRules",
      currentPlan: ctx.plan.name,
      activeRules,
      maxActiveRules: ctx.plan.limits.maxActiveRules,
    },
  });
}

export async function assertCanSimulate(ctx: TenantContext): Promise<void> {
  const cap = ctx.plan.limits.maxSimulationsPerMonth;
  if (cap === null) return;

  const used = await prisma.simulation.count({
    where: { ...ctx.scope, createdAt: { gte: startOfMonth() } },
  });
  if (used < cap) return;

  throw new AppError("PLAN_LIMIT", {
    details: { capability: "maxSimulationsPerMonth", used, cap, currentPlan: ctx.plan.name },
  });
}

export async function assertCanUseAI(ctx: TenantContext): Promise<void> {
  assertEntitled(ctx, "canUseAI");

  const cap = ctx.plan.limits.maxAiRequestsPerMonth;
  const used = await prisma.aIRequest.count({
    where: { ...ctx.scope, createdAt: { gte: startOfMonth() }, status: "SUCCESS" },
  });
  if (used < cap) return;

  throw new AppError("PLAN_LIMIT", {
    details: { capability: "maxAiRequestsPerMonth", used, cap, currentPlan: ctx.plan.name },
  });
}
