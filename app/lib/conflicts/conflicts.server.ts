/**
 * Conflict scanning and resolution.
 *
 * The detector itself is pure and lives in the engine. This module persists
 * results, keeps a rescan idempotent (via fingerprints), and preserves the
 * merchant's decisions — a conflict they chose to ignore stays ignored until
 * the underlying rules actually change.
 */

import prisma from "../../db.server";
import { detectConflicts, type RuleDefinition } from "@cartsentry/engine";
import { AppError } from "../errors.server";
import type { TenantContext } from "../tenancy.server";
import { recordActivity } from "../activity.server";

export interface ScanSummary {
  total: number;
  critical: number;
  created: number;
  resolved: number;
}

/**
 * Rescan the shop's rules.
 *
 * Conflicts that no longer reproduce are marked RESOLVED rather than deleted,
 * so the merchant can see that something they were warned about went away.
 */
export async function scanConflicts(ctx: TenantContext): Promise<ScanSummary> {
  const rules = await prisma.rule.findMany({
    where: { ...ctx.scope, status: { in: ["ACTIVE", "DRAFT"] } },
  });

  const detected = detectConflicts(
    rules.map((r) => ({
      id: r.id,
      name: r.name,
      status: r.status,
      priority: r.priority,
      definition: r.definition as RuleDefinition,
    })),
  );

  const existing = await prisma.conflict.findMany({ where: ctx.scope });
  const existingByFingerprint = new Map(existing.map((c) => [c.fingerprint, c]));
  const detectedFingerprints = new Set(detected.map((d) => d.fingerprint));

  let created = 0;

  for (const conflict of detected) {
    const prior = existingByFingerprint.get(conflict.fingerprint);

    if (!prior) {
      created += 1;
      await prisma.conflict.create({
        data: {
          shopId: ctx.shopId,
          ruleId: conflict.ruleId,
          relatedRuleId: conflict.relatedRuleId,
          fingerprint: conflict.fingerprint,
          type: conflict.type,
          severity: conflict.severity,
          confidence: conflict.confidence,
          explanation: conflict.explanation,
          scenario: (conflict.scenario ?? undefined) as object | undefined,
          suggestedFix: conflict.suggestedFix,
          status: "OPEN",
        },
      });

      if (conflict.severity === "CRITICAL") {
        await notifyCriticalConflict(ctx, conflict.fingerprint, conflict.explanation);
      }
      continue;
    }

    // Still present. Refresh the wording but keep the merchant's IGNORED
    // decision — re-opening it on every scan would be nagging, not helping.
    await prisma.conflict.update({
      where: { id: prior.id },
      data: {
        severity: conflict.severity,
        confidence: conflict.confidence,
        explanation: conflict.explanation,
        suggestedFix: conflict.suggestedFix,
        scenario: (conflict.scenario ?? undefined) as object | undefined,
        status: prior.status === "RESOLVED" ? "OPEN" : prior.status,
        resolvedAt: prior.status === "RESOLVED" ? null : prior.resolvedAt,
      },
    });
  }

  // Anything previously found that no longer reproduces.
  const goneAway = existing.filter(
    (c) => !detectedFingerprints.has(c.fingerprint) && c.status !== "RESOLVED",
  );
  for (const conflict of goneAway) {
    await prisma.conflict.update({
      where: { id: conflict.id },
      data: { status: "RESOLVED", resolvedAt: new Date() },
    });
  }

  if (created > 0) {
    await recordActivity(ctx, {
      eventType: "CONFLICT_DETECTED",
      summary: `Conflict scan found ${created} new issue${created === 1 ? "" : "s"}.`,
      metadata: { created, total: detected.length },
    });
  }

  return {
    total: detected.length,
    critical: detected.filter((c) => c.severity === "CRITICAL").length,
    created,
    resolved: goneAway.length,
  };
}

export async function listConflicts(ctx: TenantContext, status?: string[]) {
  return prisma.conflict.findMany({
    where: {
      ...ctx.scope,
      ...(status?.length ? { status: { in: status as never } } : {}),
    },
    orderBy: [{ severity: "asc" }, { createdAt: "desc" }],
    include: {
      rule: { select: { id: true, name: true, status: true } },
      relatedRule: { select: { id: true, name: true, status: true } },
    },
    take: 200,
  });
}

export async function openConflictCount(ctx: TenantContext): Promise<{ open: number; critical: number }> {
  const [open, critical] = await Promise.all([
    prisma.conflict.count({ where: { ...ctx.scope, status: "OPEN" } }),
    prisma.conflict.count({ where: { ...ctx.scope, status: "OPEN", severity: "CRITICAL" } }),
  ]);
  return { open, critical };
}

async function requireConflict(ctx: TenantContext, conflictId: string) {
  const conflict = await prisma.conflict.findFirst({
    where: { id: conflictId, shopId: ctx.shopId },
  });
  if (!conflict) throw new AppError("NOT_FOUND");
  return conflict;
}

/**
 * Mark a conflict as intentionally accepted.
 * Never changes the merchant's rules — dismissing the warning is the only
 * effect, which is the point.
 */
export async function ignoreConflict(ctx: TenantContext, conflictId: string): Promise<void> {
  const conflict = await requireConflict(ctx, conflictId);
  await prisma.conflict.update({
    where: { id: conflict.id },
    data: { status: "IGNORED" },
  });
  await recordActivity(ctx, {
    eventType: "CONFLICT_IGNORED",
    ruleId: conflict.ruleId,
    summary: `Dismissed a ${conflict.severity.toLowerCase()} conflict.`,
    metadata: { fingerprint: conflict.fingerprint },
  });
}

export async function reopenConflict(ctx: TenantContext, conflictId: string): Promise<void> {
  const conflict = await requireConflict(ctx, conflictId);
  await prisma.conflict.update({
    where: { id: conflict.id },
    data: { status: "OPEN", resolvedAt: null },
  });
}

async function notifyCriticalConflict(
  ctx: TenantContext,
  fingerprint: string,
  explanation: string,
): Promise<void> {
  await prisma.notification.upsert({
    where: { shopId_dedupeKey: { shopId: ctx.shopId, dedupeKey: `conflict:${fingerprint}` } },
    create: {
      shopId: ctx.shopId,
      type: "CRITICAL_CONFLICT",
      severity: "CRITICAL",
      title: "Two of your rules contradict each other",
      body: explanation.slice(0, 500),
      actionUrl: "/app/conflicts",
      dedupeKey: `conflict:${fingerprint}`,
    },
    // Already notified about this exact pair — do not resurface it.
    update: {},
  });
}
