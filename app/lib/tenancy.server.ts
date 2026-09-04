/**
 * Multi-tenancy.
 *
 * Every merchant-facing loader and action starts by calling `requireTenant`,
 * which authenticates with Shopify and resolves the `Shop` row. From then on
 * all data access goes through the returned `TenantContext`, whose helpers
 * inject `shopId` into the where-clause.
 *
 * The reason this exists as a wrapper rather than a convention: a forgotten
 * `where: { shopId }` is a cross-tenant data leak, and conventions get
 * forgotten. See tests in app/lib/__tests__/tenancy.test.ts.
 */

import type { Prisma, Rule, Shop } from "@prisma/client";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { AppError } from "./errors.server";
import { contextLogger, newRequestId } from "./logger.server";
import { PLANS, type PlanDefinition, type PlanName } from "./billing/plans";

export interface TenantContext {
  requestId: string;
  shop: Shop;
  shopId: string;
  shopDomain: string;
  plan: PlanDefinition;
  planName: PlanName;
  log: ReturnType<typeof contextLogger>;

  /** Prisma `where` fragment scoped to this shop. Spread it into every query. */
  scope: { shopId: string };

  /**
   * Fetch a rule that provably belongs to this shop, or throw NOT_FOUND.
   * Returning NOT_FOUND rather than FORBIDDEN is deliberate: it does not reveal
   * that another shop's rule with that id exists.
   */
  requireRule(ruleId: string): Promise<Rule>;
}

/** Upsert the Shop row from the authenticated session and return the context. */
export async function requireTenant(request: Request): Promise<
  TenantContext & { admin: Awaited<ReturnType<typeof authenticate.admin>>["admin"] }
> {
  const { admin, session } = await authenticate.admin(request);
  const requestId = newRequestId();

  const shop = await prisma.shop.upsert({
    where: { shopDomain: session.shop },
    create: { shopDomain: session.shop },
    // Reinstalls come back through here; clear the uninstall marker.
    update: { uninstalledAt: null },
  });

  const subscription = await prisma.subscription.findUnique({ where: { shopId: shop.id } });
  const planName: PlanName = subscription?.status === "ACTIVE" ? subscription.plan : "FREE";

  const log = contextLogger({ requestId, shopDomain: shop.shopDomain, shopId: shop.id });

  return {
    requestId,
    shop,
    shopId: shop.id,
    shopDomain: shop.shopDomain,
    plan: PLANS[planName],
    planName,
    log,
    admin,
    scope: { shopId: shop.id },

    async requireRule(ruleId: string) {
      const rule = await prisma.rule.findFirst({
        where: { id: ruleId, shopId: shop.id },
      });
      if (!rule) {
        log.warn({ ruleId }, "Rule not found within tenant scope");
        throw new AppError("NOT_FOUND");
      }
      return rule;
    },
  };
}

/**
 * Resolve a Shop by domain without an HTTP session. Used by webhook handlers,
 * which authenticate via HMAC rather than a session.
 */
export async function shopByDomain(shopDomain: string): Promise<Shop | null> {
  return prisma.shop.findUnique({ where: { shopDomain } });
}

/**
 * Guard for raw Prisma filters assembled from user input (search, filters).
 * Forces `shopId` last so a caller-supplied field cannot override it.
 */
export function scoped<T extends Prisma.RuleWhereInput>(
  shopId: string,
  where: T,
): T & { shopId: string } {
  return { ...where, shopId };
}
