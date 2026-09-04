/**
 * Rule CRUD.
 *
 * Every mutation here does the same four things in the same order:
 *   1. validate the payload against the canonical schema
 *   2. check the plan entitlement
 *   3. write, inside the shop's tenant scope
 *   4. record activity, and republish to Shopify when enforcement changed
 *
 * Activation is the one operation with extra gates — see `activateRule`.
 */

import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import type { Prisma, Rule } from "@prisma/client";

import prisma from "../../db.server";
import {
  RuleInputSchema,
  deriveRuleType,
  detectConflicts,
  hasCriticalConflict,
  referencedResources,
  type RuleDefinition,
  type RuleInput,
} from "@cartsentry/engine";
import { AppError } from "../errors.server";
import type { TenantContext } from "../tenancy.server";
import { recordActivity } from "../activity.server";
import { assertCanActivateRule, assertEntitled } from "../billing/entitlements.server";
import { publishRules } from "../shopify/validation.server";
import { checkResources } from "../shopify/resources.server";

type FullContext = TenantContext & { admin: AdminApiContext };

export interface RuleListFilters {
  search?: string;
  status?: string[];
  type?: string[];
  needsAttention?: boolean;
  sort?: "updated" | "name" | "priority";
  page?: number;
  perPage?: number;
}

/** Parse and validate a rule payload, converting zod issues into field errors. */
export function parseRuleInput(raw: unknown): RuleInput {
  const parsed = RuleInputSchema.safeParse(raw);
  if (parsed.success) return parsed.data;

  const fieldErrors: Record<string, string> = {};
  for (const issue of parsed.error.issues) {
    const key = issue.path.join(".") || "form";
    // Keep the first message per field; later ones are usually consequences.
    if (!fieldErrors[key]) fieldErrors[key] = issue.message;
  }
  throw new AppError("VALIDATION", { details: { fieldErrors } });
}

export async function listRules(ctx: TenantContext, filters: RuleListFilters = {}) {
  const perPage = Math.min(filters.perPage ?? 25, 100);
  const page = Math.max(filters.page ?? 1, 1);

  const where: Prisma.RuleWhereInput = {
    // Spread first so nothing below can be overridden by caller input.
    ...(filters.search
      ? {
          OR: [
            { name: { contains: filters.search, mode: "insensitive" as const } },
            { description: { contains: filters.search, mode: "insensitive" as const } },
          ],
        }
      : {}),
    ...(filters.status?.length ? { status: { in: filters.status as never } } : {}),
    ...(filters.type?.length ? { type: { in: filters.type as never } } : {}),
    ...(filters.needsAttention ? { status: "NEEDS_ATTENTION" as const } : {}),
    // shopId last: it is the security boundary and must win.
    shopId: ctx.shopId,
  };

  const orderBy: Prisma.RuleOrderByWithRelationInput =
    filters.sort === "name"
      ? { name: "asc" }
      : filters.sort === "priority"
        ? { priority: "desc" }
        : { updatedAt: "desc" };

  const [rules, total] = await Promise.all([
    prisma.rule.findMany({
      where,
      orderBy,
      skip: (page - 1) * perPage,
      take: perPage,
      include: {
        _count: { select: { conflicts: true } },
      },
    }),
    prisma.rule.count({ where }),
  ]);

  return { rules, total, page, perPage, pageCount: Math.max(Math.ceil(total / perPage), 1) };
}

export async function createRule(ctx: FullContext, raw: unknown): Promise<Rule> {
  const input = parseRuleInput(raw);
  if (input.warningConfig.enabled) assertEntitled(ctx, "canUseWarnings");

  await assertReferencedResourcesExist(ctx, input.definition);

  const rule = await prisma.rule.create({
    data: {
      shopId: ctx.shopId,
      name: input.name,
      description: input.description,
      type: deriveRuleType(input.definition),
      // New rules always start as drafts. Activation is a separate, gated step.
      status: "DRAFT",
      priority: input.priority,
      definition: input.definition as object,
      message: input.message,
      warningConfig: input.warningConfig as object,
    },
  });

  await snapshotVersion(rule, "Created");
  await recordActivity(ctx, {
    eventType: "RULE_CREATED",
    ruleId: rule.id,
    summary: `Created rule "${rule.name}".`,
  });

  return rule;
}

export async function updateRule(ctx: FullContext, ruleId: string, raw: unknown): Promise<Rule> {
  const existing = await ctx.requireRule(ruleId);
  const input = parseRuleInput(raw);
  if (input.warningConfig.enabled) assertEntitled(ctx, "canUseWarnings");

  await assertReferencedResourcesExist(ctx, input.definition);

  const updated = await prisma.rule.update({
    where: { id: existing.id },
    data: {
      name: input.name,
      description: input.description,
      type: deriveRuleType(input.definition),
      priority: input.priority,
      definition: input.definition as object,
      message: input.message,
      warningConfig: input.warningConfig as object,
      // Editing clears a previous resource problem; revalidation re-flags it if
      // it is still broken.
      attentionReason: null,
      status: existing.status === "NEEDS_ATTENTION" ? "DRAFT" : existing.status,
    },
  });

  await snapshotVersion(updated, "Edited");
  await recordActivity(ctx, {
    eventType: "RULE_UPDATED",
    ruleId: updated.id,
    summary: `Edited rule "${updated.name}".`,
    metadata: {
      before: { name: existing.name, message: existing.message, priority: existing.priority },
      after: { name: updated.name, message: updated.message, priority: updated.priority },
    },
  });

  // An edit to a live rule changes what customers experience, so republish.
  if (updated.status === "ACTIVE") await publishRules(ctx);

  return updated;
}

export interface ActivationCheck {
  ok: boolean;
  blockers: { code: string; message: string }[];
}

/**
 * Everything that must hold before a rule can go live. Exposed separately so
 * the UI can show the same list on the confirmation dialog that the server
 * enforces on submit.
 */
export async function checkActivation(ctx: FullContext, ruleId: string): Promise<ActivationCheck> {
  const rule = await ctx.requireRule(ruleId);
  const blockers: { code: string; message: string }[] = [];

  if (rule.status === "NEEDS_ATTENTION") {
    blockers.push({
      code: "MISSING_RESOURCE",
      message: rule.attentionReason ?? "This rule references a resource that no longer exists.",
    });
  }

  const activeCount = await prisma.rule.count({ where: { ...ctx.scope, status: "ACTIVE" } });
  if (rule.status !== "ACTIVE" && activeCount >= ctx.plan.limits.maxActiveRules) {
    blockers.push({
      code: "PLAN_LIMIT",
      message: `Your ${ctx.plan.title} plan allows ${ctx.plan.limits.maxActiveRules} active rules and you already have ${activeCount}.`,
    });
  }

  const all = await prisma.rule.findMany({
    where: { ...ctx.scope, status: { in: ["ACTIVE", "DRAFT"] } },
  });
  const conflicts = detectConflicts(
    all.map((r) => ({
      id: r.id,
      name: r.name,
      status: r.status,
      priority: r.priority,
      definition: r.definition as RuleDefinition,
    })),
  );

  if (hasCriticalConflict(conflicts, rule.id)) {
    const relevant = conflicts.find(
      (c) => c.severity === "CRITICAL" && (c.ruleId === rule.id || c.relatedRuleId === rule.id),
    );
    blockers.push({
      code: "CRITICAL_CONFLICT",
      message: relevant?.explanation ?? "This rule has an unresolved critical conflict.",
    });
  }

  return { ok: blockers.length === 0, blockers };
}

export async function activateRule(ctx: FullContext, ruleId: string): Promise<Rule> {
  const rule = await ctx.requireRule(ruleId);
  await assertCanActivateRule(ctx);

  const check = await checkActivation(ctx, ruleId);
  if (!check.ok) {
    const critical = check.blockers.find((b) => b.code === "CRITICAL_CONFLICT");
    throw new AppError(critical ? "CONFLICT_BLOCKED" : "VALIDATION", {
      details: { blockers: check.blockers },
    });
  }

  const updated = await prisma.rule.update({
    where: { id: rule.id },
    data: { status: "ACTIVE", activatedAt: new Date() },
  });

  await recordActivity(ctx, {
    eventType: "RULE_ACTIVATED",
    ruleId: rule.id,
    summary: `Activated rule "${rule.name}". It now applies to customers.`,
  });

  await publishRules(ctx);
  return updated;
}

export async function disableRule(ctx: FullContext, ruleId: string): Promise<Rule> {
  const rule = await ctx.requireRule(ruleId);
  const updated = await prisma.rule.update({
    where: { id: rule.id },
    data: { status: "DISABLED" },
  });

  await recordActivity(ctx, {
    eventType: "RULE_DISABLED",
    ruleId: rule.id,
    summary: `Disabled rule "${rule.name}". It no longer applies to customers.`,
  });

  await publishRules(ctx);
  return updated;
}

export async function archiveRule(ctx: FullContext, ruleId: string): Promise<Rule> {
  const rule = await ctx.requireRule(ruleId);
  const wasActive = rule.status === "ACTIVE";

  const updated = await prisma.rule.update({
    where: { id: rule.id },
    data: { status: "ARCHIVED", archivedAt: new Date() },
  });

  await recordActivity(ctx, {
    eventType: "RULE_ARCHIVED",
    ruleId: rule.id,
    summary: `Archived rule "${rule.name}".`,
  });

  if (wasActive) await publishRules(ctx);
  return updated;
}

export async function duplicateRule(ctx: FullContext, ruleId: string): Promise<Rule> {
  const rule = await ctx.requireRule(ruleId);

  const copy = await prisma.rule.create({
    data: {
      shopId: ctx.shopId,
      name: `${rule.name} (copy)`.slice(0, 120),
      description: rule.description,
      type: rule.type,
      status: "DRAFT",
      priority: rule.priority,
      definition: rule.definition as object,
      message: rule.message,
      warningConfig: rule.warningConfig as object,
    },
  });

  await snapshotVersion(copy, `Duplicated from "${rule.name}"`);
  await recordActivity(ctx, {
    eventType: "RULE_DUPLICATED",
    ruleId: copy.id,
    summary: `Duplicated "${rule.name}" as "${copy.name}".`,
  });

  return copy;
}

export async function deleteRule(ctx: FullContext, ruleId: string): Promise<void> {
  const rule = await ctx.requireRule(ruleId);
  const wasActive = rule.status === "ACTIVE";

  await prisma.rule.delete({ where: { id: rule.id } });

  await recordActivity(ctx, {
    eventType: "RULE_DELETED",
    summary: `Deleted rule "${rule.name}".`,
    metadata: { name: rule.name, type: rule.type },
  });

  if (wasActive) await publishRules(ctx);
}

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

async function snapshotVersion(rule: Rule, note: string): Promise<void> {
  const last = await prisma.ruleVersion.aggregate({
    where: { ruleId: rule.id },
    _max: { version: true },
  });

  await prisma.ruleVersion.create({
    data: {
      ruleId: rule.id,
      version: (last._max.version ?? 0) + 1,
      note,
      configuration: {
        name: rule.name,
        description: rule.description,
        priority: rule.priority,
        message: rule.message,
        definition: rule.definition,
        warningConfig: rule.warningConfig,
      } as object,
    },
  });
}

export async function listVersions(ctx: TenantContext, ruleId: string) {
  assertEntitled(ctx, "canUseRuleVersionHistory");
  await ctx.requireRule(ruleId);
  return prisma.ruleVersion.findMany({
    where: { ruleId },
    orderBy: { version: "desc" },
    take: 50,
  });
}

/**
 * Restore a previous version's configuration onto the rule.
 * The restored payload is re-validated, so a version saved under an older
 * schema cannot reintroduce an invalid rule.
 */
export async function restoreVersion(
  ctx: FullContext,
  ruleId: string,
  version: number,
): Promise<Rule> {
  assertEntitled(ctx, "canUseRuleVersionHistory");
  const rule = await ctx.requireRule(ruleId);

  const snapshot = await prisma.ruleVersion.findUnique({
    where: { ruleId_version: { ruleId, version } },
  });
  if (!snapshot) throw new AppError("NOT_FOUND");

  const restored = await updateRule(ctx, rule.id, snapshot.configuration);

  await recordActivity(ctx, {
    eventType: "RULE_RESTORED",
    ruleId: rule.id,
    summary: `Restored "${rule.name}" to version ${version}.`,
    metadata: { version },
  });

  return restored;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Refuse to save a rule that points at resources the shop does not have.
 * Catching it here means a merchant gets a fixable form error instead of a rule
 * that silently never fires.
 */
async function assertReferencedResourcesExist(
  ctx: FullContext,
  definition: RuleDefinition,
): Promise<void> {
  const refs = referencedResources(definition);
  if (refs.length === 0) return;

  const checks = await checkResources(
    ctx.admin,
    refs.map((r) => r.gid),
  );
  const missing = refs.filter((r) => checks.get(r.gid)?.exists === false);
  if (missing.length === 0) return;

  throw new AppError("VALIDATION", {
    details: {
      fieldErrors: {
        "definition.conditions": `${missing.map((m) => `"${m.title || m.gid}"`).join(", ")} could not be found in this store. Choose a different product or collection.`,
      },
    },
  });
}
