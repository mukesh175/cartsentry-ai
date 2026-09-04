/**
 * Shopify billing.
 *
 * Uses the Admin API's `appSubscriptionCreate` so charges appear on the
 * merchant's Shopify invoice — the only billing method the App Store permits
 * for this kind of app.
 *
 * Downgrade policy, which is the part that matters most to merchants: we never
 * delete or deactivate rules to fit a smaller plan. A shop that drops below its
 * rule count keeps every rule and simply cannot activate more until it is back
 * under the limit. See docs/BILLING.md.
 */

import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

import prisma from "../../db.server";
import { AppError } from "../errors.server";
import type { TenantContext } from "../tenancy.server";
import { recordActivity } from "../activity.server";
import { PLANS, PLAN_ORDER, isDowngrade, type PlanName } from "./plans";
import { config } from "../config.server";

type FullContext = TenantContext & { admin: AdminApiContext };

/** Test charges on development stores; real charges everywhere else. */
function isTestCharge(): boolean {
  return !config.isProduction;
}

export interface DowngradeImpact {
  plan: PlanName;
  activeRules: number;
  maxActiveRules: number;
  /** Rules over the new limit. They are kept, not deleted. */
  excess: number;
  losesCapabilities: string[];
}

/**
 * What changing to `target` would mean, computed before the merchant confirms.
 * Nothing is applied here.
 */
export async function previewPlanChange(
  ctx: TenantContext,
  target: PlanName,
): Promise<DowngradeImpact> {
  const plan = PLANS[target];
  const activeRules = await prisma.rule.count({ where: { ...ctx.scope, status: "ACTIVE" } });

  const losesCapabilities: string[] = [];
  if (isDowngrade(ctx.planName, target)) {
    const current = ctx.plan.capabilities;
    const next = plan.capabilities;
    const labels: Record<string, string> = {
      canUseAI: "AI Rule Creator",
      canUseWarnings: "Storefront customer warnings",
      canUseAdvancedConflictDetection: "Advanced conflict detection",
      canUseAdvancedAnalytics: "Advanced analytics",
      canExportData: "CSV export",
      canUseRuleVersionHistory: "Rule version history",
    };
    for (const key of Object.keys(labels)) {
      const k = key as keyof typeof current;
      if (current[k] && !next[k]) losesCapabilities.push(labels[key]!);
    }
  }

  return {
    plan: target,
    activeRules,
    maxActiveRules: plan.limits.maxActiveRules,
    excess: Math.max(0, activeRules - plan.limits.maxActiveRules),
    losesCapabilities,
  };
}

/**
 * Start a plan change. Paid plans return a confirmation URL the merchant must
 * approve in Shopify; the subscription is only recorded ACTIVE once Shopify
 * confirms it in `confirmSubscription`.
 */
export async function startSubscription(
  ctx: FullContext,
  target: PlanName,
  returnUrl: string,
): Promise<{ confirmationUrl: string | null }> {
  if (!PLAN_ORDER.includes(target)) throw new AppError("VALIDATION");

  const plan = PLANS[target];

  // Free needs no Shopify charge; apply it immediately and cancel any paid one.
  if (plan.price === 0) {
    await cancelActiveSubscription(ctx);
    await prisma.subscription.upsert({
      where: { shopId: ctx.shopId },
      create: { shopId: ctx.shopId, plan: "FREE", status: "ACTIVE" },
      update: { plan: "FREE", status: "ACTIVE", shopifySubscriptionId: null, cancelledAt: null },
    });
    await recordActivity(ctx, {
      eventType: "BILLING_CHANGED",
      summary: "Switched to the Free plan.",
      metadata: { plan: "FREE" },
    });
    return { confirmationUrl: null };
  }

  const response = await ctx.admin.graphql(
    `#graphql
    mutation CartSentrySubscribe(
      $name: String!
      $returnUrl: URL!
      $test: Boolean!
      $lineItems: [AppSubscriptionLineItemInput!]!
    ) {
      appSubscriptionCreate(
        name: $name
        returnUrl: $returnUrl
        test: $test
        lineItems: $lineItems
        replacementBehavior: STANDARD
      ) {
        appSubscription { id status }
        confirmationUrl
        userErrors { field message }
      }
    }`,
    {
      variables: {
        name: `CartSentry AI — ${plan.title}`,
        returnUrl,
        test: isTestCharge(),
        lineItems: [
          {
            plan: {
              appRecurringPricingDetails: {
                price: { amount: plan.price, currencyCode: "USD" },
                interval: plan.interval,
              },
            },
          },
        ],
      },
    },
  );

  const body = await response.json();
  const payload = body?.data?.appSubscriptionCreate;
  const errors = payload?.userErrors ?? [];

  if (errors.length > 0) {
    ctx.log.error({ errors }, "appSubscriptionCreate returned user errors");
    throw new AppError("SHOPIFY_API", { details: { step: "appSubscriptionCreate" } });
  }

  // PENDING until the merchant approves it in Shopify.
  await prisma.subscription.upsert({
    where: { shopId: ctx.shopId },
    create: {
      shopId: ctx.shopId,
      plan: target,
      status: "PENDING",
      shopifySubscriptionId: payload.appSubscription.id,
      test: isTestCharge(),
    },
    update: {
      plan: target,
      status: "PENDING",
      shopifySubscriptionId: payload.appSubscription.id,
      test: isTestCharge(),
      cancelledAt: null,
    },
  });

  return { confirmationUrl: payload.confirmationUrl };
}

/**
 * Re-read the subscription from Shopify and record the result.
 * Called when the merchant returns from the approval screen, and whenever the
 * billing page loads, so a subscription cancelled in the Shopify admin is
 * noticed without waiting for a webhook.
 */
export async function syncSubscription(ctx: FullContext): Promise<PlanName> {
  const response = await ctx.admin.graphql(
    `#graphql
    query CartSentryActiveSubscriptions {
      currentAppInstallation {
        activeSubscriptions {
          id
          name
          status
          test
          currentPeriodEnd
          lineItems {
            plan {
              pricingDetails {
                ... on AppRecurringPricing {
                  price { amount currencyCode }
                }
              }
            }
          }
        }
      }
    }`,
  );

  const body = await response.json();
  const active = body?.data?.currentAppInstallation?.activeSubscriptions ?? [];
  const current = active.find((s: { status: string }) => s.status === "ACTIVE") ?? null;

  if (!current) {
    // No active charge — the shop is on Free. Rules are preserved.
    const existing = await prisma.subscription.findUnique({ where: { shopId: ctx.shopId } });
    if (existing && existing.plan !== "FREE") {
      await prisma.subscription.update({
        where: { shopId: ctx.shopId },
        data: { plan: "FREE", status: "ACTIVE", shopifySubscriptionId: null, cancelledAt: new Date() },
      });
      await recordActivity(ctx, {
        eventType: "BILLING_CHANGED",
        summary: "Subscription ended. The store is now on the Free plan. All rules were kept.",
        metadata: { previousPlan: existing.plan },
      });
    } else if (!existing) {
      await prisma.subscription.create({
        data: { shopId: ctx.shopId, plan: "FREE", status: "ACTIVE" },
      });
    }
    return "FREE";
  }

  const price = Number(
    current.lineItems?.[0]?.plan?.pricingDetails?.price?.amount ?? 0,
  );
  const matched = PLAN_ORDER.find((name) => PLANS[name].price === price) ?? "FREE";

  await prisma.subscription.upsert({
    where: { shopId: ctx.shopId },
    create: {
      shopId: ctx.shopId,
      plan: matched,
      status: "ACTIVE",
      shopifySubscriptionId: current.id,
      test: Boolean(current.test),
      renewedAt: current.currentPeriodEnd ? new Date(current.currentPeriodEnd) : null,
    },
    update: {
      plan: matched,
      status: "ACTIVE",
      shopifySubscriptionId: current.id,
      test: Boolean(current.test),
      renewedAt: current.currentPeriodEnd ? new Date(current.currentPeriodEnd) : null,
      cancelledAt: null,
    },
  });

  return matched;
}

export async function cancelActiveSubscription(ctx: FullContext): Promise<void> {
  const existing = await prisma.subscription.findUnique({ where: { shopId: ctx.shopId } });
  if (!existing?.shopifySubscriptionId) return;

  const response = await ctx.admin.graphql(
    `#graphql
    mutation CartSentryCancel($id: ID!) {
      appSubscriptionCancel(id: $id) {
        appSubscription { id status }
        userErrors { field message }
      }
    }`,
    { variables: { id: existing.shopifySubscriptionId } },
  );

  const body = await response.json();
  const errors = body?.data?.appSubscriptionCancel?.userErrors ?? [];
  if (errors.length > 0) {
    // A subscription already gone from Shopify's side is not an error for us.
    ctx.log.warn({ errors }, "appSubscriptionCancel reported user errors");
  }

  await prisma.subscription.update({
    where: { shopId: ctx.shopId },
    data: { plan: "FREE", status: "CANCELLED", shopifySubscriptionId: null, cancelledAt: new Date() },
  });

  await recordActivity(ctx, {
    eventType: "BILLING_CHANGED",
    summary: "Cancelled the paid subscription. All rules were kept.",
    metadata: { previousPlan: existing.plan },
  });
}
