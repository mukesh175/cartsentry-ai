import type { ActionFunctionArgs } from "react-router";

import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { logger } from "../lib/logger.server";

/**
 * Shopify's mandatory privacy webhooks, all three on one verified endpoint.
 *
 * `authenticate.webhook` verifies the HMAC before we act; an unsigned or
 * tampered request never reaches the switch below.
 *
 * CartSentry stores no customer personal data — no names, emails, addresses or
 * order contents. The validation function reads cart data on Shopify's servers
 * and never sends it to us. That makes the customer topics honest no-ops, which
 * we say explicitly rather than pretending to erase something.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);
  logger.info({ shop, topic }, "Compliance webhook received");

  switch (topic) {
    case "CUSTOMERS_DATA_REQUEST":
      // Nothing to return: we hold no personal data for any customer.
      logger.info({ shop, topic }, "No customer personal data is stored by this app");
      break;

    case "CUSTOMERS_REDACT":
      // Nothing to erase, for the same reason.
      logger.info({ shop, topic }, "No customer personal data to redact");
      break;

    case "SHOP_REDACT": {
      // This is the real deletion point. Cascades remove rules, versions,
      // simulations, conflicts, activity, metrics, AI requests and notifications.
      const deleted = await prisma.shop.deleteMany({ where: { shopDomain: shop } });
      await prisma.session.deleteMany({ where: { shop } });
      logger.info({ shop, topic, deleted: deleted.count }, "Shop data erased");
      break;
    }

    default:
      logger.warn({ shop, topic }, "Unhandled compliance topic");
      return new Response("Unhandled topic", { status: 404 });
  }

  // Acknowledge regardless; a non-2xx makes Shopify retry a no-op forever.
  void payload;
  return new Response();
};
