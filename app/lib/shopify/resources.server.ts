/**
 * Resolving Shopify resources that rules depend on.
 *
 * Two jobs:
 *   1. expand collections into product ids at compile time, because the
 *      Function cannot do it at runtime (see compile.ts)
 *   2. verify that products, variants and collections a rule references still
 *      exist, so a deleted product marks the rule "Needs attention" rather than
 *      silently changing what it enforces
 */

import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

import prisma from "../../db.server";
import { referencedResources, type RuleDefinition } from "@cartsentry/engine";
import type { TenantContext } from "../tenancy.server";
import { recordActivity } from "../activity.server";

/** Shopify paginates collection products; cap the expansion so one huge collection cannot stall a publish. */
const MAX_COLLECTION_PRODUCTS = 250;
const PAGE_SIZE = 250;

interface RuleLike {
  definition: RuleDefinition;
}

/**
 * Expand every collection referenced by the given rules into its product gids.
 *
 * A collection that fails to resolve is omitted rather than returned empty, so
 * the compiler can tell "no members" apart from "could not read" and warn the
 * merchant accordingly.
 */
export async function resolveCollectionMembers(
  ctx: TenantContext & { admin: AdminApiContext },
  rules: RuleLike[],
): Promise<Record<string, string[]>> {
  const collectionGids = new Set<string>();
  for (const rule of rules) {
    for (const condition of rule.definition.conditions) {
      if ("collection" in condition && condition.collection && !condition.collection.missing) {
        collectionGids.add(condition.collection.gid);
      }
    }
  }
  if (collectionGids.size === 0) return {};

  const members: Record<string, string[]> = {};

  for (const gid of collectionGids) {
    try {
      members[gid] = await fetchCollectionProductGids(ctx.admin, gid);
    } catch (error) {
      ctx.log.warn({ err: error, collection: gid }, "Could not expand collection membership");
      // Deliberately not setting members[gid] — see doc comment.
    }
  }

  return members;
}

async function fetchCollectionProductGids(
  admin: AdminApiContext,
  collectionGid: string,
): Promise<string[]> {
  const gids: string[] = [];
  let cursor: string | null = null;

  while (gids.length < MAX_COLLECTION_PRODUCTS) {
    const response: Response = await admin.graphql(
      `#graphql
      query CartSentryCollectionProducts($id: ID!, $first: Int!, $after: String) {
        collection(id: $id) {
          id
          products(first: $first, after: $after) {
            nodes { id }
            pageInfo { hasNextPage endCursor }
          }
        }
      }`,
      { variables: { id: collectionGid, first: PAGE_SIZE, after: cursor } },
    );

    const body = await response.json();
    const collection = body?.data?.collection;
    if (!collection) throw new Error(`Collection ${collectionGid} not found`);

    for (const node of collection.products?.nodes ?? []) {
      gids.push(node.id);
    }

    const pageInfo = collection.products?.pageInfo;
    if (!pageInfo?.hasNextPage) break;
    cursor = pageInfo.endCursor;
  }

  return gids.slice(0, MAX_COLLECTION_PRODUCTS);
}

export interface ResourceCheck {
  gid: string;
  exists: boolean;
  title: string | null;
}

/** Batch-check that a set of gids still resolve in this shop. */
export async function checkResources(
  admin: AdminApiContext,
  gids: string[],
): Promise<Map<string, ResourceCheck>> {
  const result = new Map<string, ResourceCheck>();
  if (gids.length === 0) return result;

  const unique = [...new Set(gids)];

  // `nodes` returns null in place of anything the shop no longer has, which is
  // exactly the signal we need.
  const response = await admin.graphql(
    `#graphql
    query CartSentryResourceCheck($ids: [ID!]!) {
      nodes(ids: $ids) {
        __typename
        ... on Product { id title }
        ... on ProductVariant { id title }
        ... on Collection { id title }
      }
    }`,
    { variables: { ids: unique } },
  );

  const body = await response.json();
  const nodes: ({ id: string; title?: string } | null)[] = body?.data?.nodes ?? [];

  unique.forEach((gid, index) => {
    const node = nodes[index];
    result.set(gid, {
      gid,
      exists: Boolean(node?.id),
      title: node?.title ?? null,
    });
  });

  return result;
}

/**
 * Re-check every resource a shop's rules reference and update rule status.
 *
 * A rule whose product was deleted becomes NEEDS_ATTENTION and is excluded from
 * the next publish. It is never auto-edited or auto-deleted — the merchant's
 * configuration is theirs.
 */
export async function revalidateRuleResources(
  ctx: TenantContext & { admin: AdminApiContext },
): Promise<{ flagged: number; cleared: number }> {
  const rules = await prisma.rule.findMany({
    where: { ...ctx.scope, status: { in: ["ACTIVE", "DRAFT", "NEEDS_ATTENTION"] } },
  });

  const allGids = rules.flatMap((rule) =>
    referencedResources(rule.definition as RuleDefinition).map((r) => r.gid),
  );
  if (allGids.length === 0) return { flagged: 0, cleared: 0 };

  const checks = await checkResources(ctx.admin, allGids);

  let flagged = 0;
  let cleared = 0;

  for (const rule of rules) {
    const definition = rule.definition as RuleDefinition;
    const refs = referencedResources(definition);

    const missing = refs.filter((ref) => checks.get(ref.gid)?.exists === false);
    const wasFlagged = rule.status === "NEEDS_ATTENTION";

    // Refresh cached titles and the `missing` marker in place.
    const updated = markMissing(definition, checks);

    if (missing.length > 0) {
      if (!wasFlagged) flagged += 1;
      await prisma.rule.update({
        where: { id: rule.id },
        data: {
          definition: updated as object,
          status: "NEEDS_ATTENTION",
          attentionReason: `This rule references ${missing.length === 1 ? "a product or collection" : `${missing.length} products or collections`} that no longer exist in this store.`,
        },
      });
      if (!wasFlagged) {
        await recordActivity(ctx, {
          eventType: "RULE_NEEDS_ATTENTION",
          ruleId: rule.id,
          summary: `"${rule.name}" references a deleted resource and is no longer being enforced.`,
          metadata: { missing: missing.map((m) => m.gid) },
        });
      }
    } else if (wasFlagged) {
      // Everything resolves again — return the rule to DRAFT so the merchant
      // makes the call about re-activating it.
      cleared += 1;
      await prisma.rule.update({
        where: { id: rule.id },
        data: { definition: updated as object, status: "DRAFT", attentionReason: null },
      });
    } else {
      await prisma.rule.update({
        where: { id: rule.id },
        data: { definition: updated as object },
      });
    }
  }

  return { flagged, cleared };
}

/** Return a copy of the definition with `missing` flags and titles refreshed. */
function markMissing(
  definition: RuleDefinition,
  checks: Map<string, ResourceCheck>,
): RuleDefinition {
  const apply = (ref: { gid: string; title: string; missing: boolean }) => {
    const check = checks.get(ref.gid);
    if (!check) return ref;
    return { ...ref, missing: !check.exists, title: check.title ?? ref.title };
  };

  return {
    ...definition,
    conditions: definition.conditions.map((condition) => {
      const next: Record<string, unknown> = { ...condition };
      if ("product" in condition && condition.product) next.product = apply(condition.product);
      if ("variant" in condition && condition.variant) next.variant = apply(condition.variant);
      if ("collection" in condition && condition.collection) {
        next.collection = apply(condition.collection);
      }
      return next as RuleDefinition["conditions"][number];
    }),
  };
}
