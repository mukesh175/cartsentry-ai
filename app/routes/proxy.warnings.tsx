import type { LoaderFunctionArgs } from "react-router";

import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { logger } from "../lib/logger.server";
import type { RuleDefinition, WarningConfig } from "@cartsentry/engine";

/**
 * App proxy: the storefront warning configuration.
 *
 * Served through Shopify's app proxy, so the request arrives signed and
 * `authenticate.public.appProxy` verifies it before we answer. That is what
 * lets us key the response by shop without trusting a query parameter.
 *
 * What is deliberately NOT in this response:
 *   - rule ids, internal names, priorities, or the full rule definitions
 *   - anything about rules the merchant did not enable a warning for
 *   - anything about BLOCK-only enforcement
 *
 * The payload is a minimal projection: just enough for the theme block to know
 * when to show which sentence. Enforcement is server-side and does not depend
 * on any of this, so a shopper reading this endpoint learns nothing they could
 * use to get around a rule.
 */

interface StorefrontCondition {
  kind: string;
  operator?: string;
  value?: number;
  present?: boolean;
  productId?: string;
  variantId?: string;
}

/** Conditions the storefront script can actually evaluate from cart.js. */
const STOREFRONT_KINDS = new Set([
  "product_quantity",
  "cart_quantity",
  "cart_subtotal",
  "product_present",
]);

/** `gid://shopify/Product/123` -> `123`, which is what cart.js exposes. */
function numericId(gid: string): string | undefined {
  const match = gid.match(/\/(\d+)$/);
  return match ? match[1] : undefined;
}

function projectCondition(condition: RuleDefinition["conditions"][number]): StorefrontCondition | null {
  if (!STOREFRONT_KINDS.has(condition.kind)) return null;

  const base: StorefrontCondition = { kind: condition.kind };

  if ("product" in condition && condition.product) {
    const id = numericId(condition.product.gid);
    if (!id) return null;
    base.productId = id;
  }
  if ("variant" in condition && condition.variant) {
    base.variantId = numericId(condition.variant.gid);
  }
  if ("operator" in condition) base.operator = condition.operator as string;
  if ("value" in condition && typeof condition.value === "number") base.value = condition.value;
  if ("present" in condition) base.present = condition.present;

  return base;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.public.appProxy(request);

  const empty = () =>
    Response.json(
      { rules: [] },
      { headers: { "cache-control": "public, max-age=300" } },
    );

  if (!session?.shop) return empty();

  try {
    const shop = await prisma.shop.findUnique({ where: { shopDomain: session.shop } });
    if (!shop || shop.uninstalledAt) return empty();

    const rules = await prisma.rule.findMany({
      where: { shopId: shop.id, status: "ACTIVE" },
      orderBy: { priority: "desc" },
      select: { definition: true, message: true, warningConfig: true },
    });

    const payload = rules.flatMap((rule) => {
      const warning = rule.warningConfig as WarningConfig;
      if (!warning?.enabled || !warning.showInCart) return [];

      const definition = rule.definition as RuleDefinition;
      const conditions = definition.conditions.map(projectCondition);

      // If any condition cannot be checked on the storefront, drop the rule
      // entirely rather than showing a warning we cannot stand behind.
      if (conditions.some((c) => c === null)) return [];

      return [
        {
          logic: definition.logic,
          negate: definition.negate,
          conditions: conditions as StorefrontCondition[],
          title: warning.title || "",
          message: warning.message || rule.message,
          severity: warning.severity || "warning",
        },
      ];
    });

    return Response.json(
      { rules: payload },
      {
        headers: {
          // Short cache: warnings should follow a rule change quickly, but this
          // endpoint is hit by every shopper on the cart page.
          "cache-control": "public, max-age=300",
        },
      },
    );
  } catch (error) {
    logger.error({ err: error, shop: session.shop }, "App proxy warning lookup failed");
    // Fail quiet: no warnings is a degraded experience, an error page is a
    // broken storefront.
    return empty();
  }
};
