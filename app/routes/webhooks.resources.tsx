import type { ActionFunctionArgs } from "react-router";

import prisma from "../db.server";
import { authenticate, unauthenticated } from "../shopify.server";
import { contextLogger, logger, newRequestId } from "../lib/logger.server";
import { PLANS, type PlanName } from "../lib/billing/plans";
import { revalidateRuleResources } from "../lib/shopify/resources.server";
import { publishRules } from "../lib/shopify/validation.server";
import type { TenantContext } from "../lib/tenancy.server";
import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

/**
 * Product and collection lifecycle webhooks.
 *
 * Why these matter: a rule that points at a deleted product would otherwise sit
 * there looking active while enforcing nothing. Rather than silently changing
 * the merchant's rule, we mark it "Needs attention", exclude it from the next
 * publish, and tell them.
 *
 * Collection updates matter for a different reason — membership is baked into
 * the published configuration, so a changed collection needs a republish.
 */

/** Build a tenant context for a webhook, which has no session-backed request. */
async function webhookContext(
  shopDomain: string,
): Promise<(TenantContext & { admin: AdminApiContext }) | null> {
  const shop = await prisma.shop.findUnique({ where: { shopDomain } });
  if (!shop || shop.uninstalledAt) return null;

  const subscription = await prisma.subscription.findUnique({ where: { shopId: shop.id } });
  const planName: PlanName = subscription?.status === "ACTIVE" ? subscription.plan : "FREE";
  const requestId = newRequestId();

  // Offline token: webhooks arrive without a merchant session.
  const { admin } = await unauthenticated.admin(shopDomain);

  return {
    requestId,
    shop,
    shopId: shop.id,
    shopDomain,
    plan: PLANS[planName],
    planName,
    log: contextLogger({ requestId, shopDomain, shopId: shop.id }),
    scope: { shopId: shop.id },
    admin,
    async requireRule(ruleId: string) {
      const rule = await prisma.rule.findFirst({ where: { id: ruleId, shopId: shop.id } });
      if (!rule) throw new Error("Rule not found in tenant scope");
      return rule;
    },
  };
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticate.webhook(request);
  logger.info({ shop, topic }, "Resource webhook received");

  const ctx = await webhookContext(shop);
  if (!ctx) {
    // Uninstalled or unknown shop — acknowledge so Shopify stops retrying.
    return new Response();
  }

  try {
    switch (topic) {
      case "PRODUCTS_DELETE":
      case "COLLECTIONS_DELETE": {
        const result = await revalidateRuleResources(ctx);
        if (result.flagged > 0) {
          // A flagged rule is excluded from the configuration, so republish to
          // stop enforcing something that can no longer be evaluated.
          await publishRules(ctx).catch((error) => {
            ctx.log.error({ err: error }, "Republish after resource deletion failed");
          });
        }
        ctx.log.info({ topic, ...result }, "Revalidated rule resources");
        break;
      }

      case "COLLECTIONS_UPDATE": {
        // Membership is compiled into the published configuration, so refresh it.
        const usesCollections = await prisma.rule.count({
          where: {
            ...ctx.scope,
            status: "ACTIVE",
            type: { in: ["COLLECTION_QUANTITY", "COMPOSITE"] },
          },
        });
        if (usesCollections > 0) {
          await publishRules(ctx).catch((error) => {
            ctx.log.error({ err: error }, "Republish after collection update failed");
          });
        }
        break;
      }

      default:
        ctx.log.warn({ topic }, "Unhandled resource topic");
    }
  } catch (error) {
    // Never fail the webhook on our own processing error — Shopify would retry
    // indefinitely. The problem is logged and surfaced in the admin instead.
    ctx.log.error({ err: error, topic }, "Resource webhook processing failed");
  }

  return new Response();
};
