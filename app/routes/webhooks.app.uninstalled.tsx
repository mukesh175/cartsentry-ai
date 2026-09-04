import type { ActionFunctionArgs } from "react-router";

import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { logger } from "../lib/logger.server";

/**
 * app/uninstalled.
 *
 * Shopify may deliver this more than once, so the handler is idempotent: it
 * marks the shop uninstalled and removes sessions, and a repeat delivery is a
 * no-op rather than an error.
 *
 * Rules are NOT deleted here. A merchant who reinstalls within Shopify's
 * retention window gets their configuration back exactly as they left it.
 * Permanent deletion happens on shop/redact, which is when Shopify tells us the
 * data must actually go.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, session, topic } = await authenticate.webhook(request);
  logger.info({ shop, topic }, "Webhook received");

  if (session) {
    await prisma.session.deleteMany({ where: { shop } });
  }

  await prisma.shop.updateMany({
    where: { shopDomain: shop },
    data: { uninstalledAt: new Date() },
  });

  const record = await prisma.shop.findUnique({ where: { shopDomain: shop } });
  if (record) {
    // Best-effort audit entry; a logging failure must not fail the webhook.
    await prisma.activityLog
      .create({
        data: {
          shopId: record.id,
          eventType: "APP_UNINSTALLED",
          actor: "shopify",
          summary: "The app was uninstalled. Rules are retained in case of reinstall.",
        },
      })
      .catch(() => undefined);

    // The subscription is gone from Shopify's side the moment the app is
    // removed, so reflect that rather than leaving a stale paid plan.
    await prisma.subscription
      .updateMany({
        where: { shopId: record.id },
        data: { status: "CANCELLED", cancelledAt: new Date(), shopifySubscriptionId: null },
      })
      .catch(() => undefined);
  }

  return new Response();
};
