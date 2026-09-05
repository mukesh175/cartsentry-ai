import { useState } from "react";
import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";

import prisma from "../db.server";
import { requireTenant } from "../lib/tenancy.server";
import { computeHealthScore } from "../lib/dashboard/health.server";
import { entitlementSnapshot } from "../lib/billing/entitlements.server";
import { openConflictCount } from "../lib/conflicts/conflicts.server";
import { startOfUtcDay } from "../lib/activity.server";
import { aiIsConfigured } from "../lib/config.server";
import { EmptyState, StepCard } from "../components/rule-ui";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const ctx = await requireTenant(request);

  const monthStart = new Date();
  monthStart.setUTCDate(monthStart.getUTCDate() - 30);

  const [health, entitlements, conflicts, activeRules, needsAttention, usage, lastPublish, notifications] =
    await Promise.all([
      computeHealthScore(ctx),
      entitlementSnapshot(ctx),
      openConflictCount(ctx),
      prisma.rule.count({ where: { ...ctx.scope, status: "ACTIVE" } }),
      prisma.rule.count({ where: { ...ctx.scope, status: "NEEDS_ATTENTION" } }),
      prisma.usageMetric.aggregate({
        where: { ...ctx.scope, date: { gte: startOfUtcDay(monthStart) } },
        _sum: { simulations: true, aiRequests: true },
      }),
      prisma.functionConfiguration.findFirst({
        where: { ...ctx.scope, status: "PUBLISHED" },
        orderBy: { version: "desc" },
        select: { version: true, publishedAt: true },
      }),
      prisma.notification.findMany({
        where: { ...ctx.scope, readAt: null },
        orderBy: { createdAt: "desc" },
        take: 3,
      }),
    ]);

  return {
    shopDomain: ctx.shopDomain,
    shopName: ctx.shop.name ?? ctx.shopDomain,
    planTitle: ctx.plan.title,
    // Hide the AI entry point rather than show a button that cannot work.
    aiAvailable: aiIsConfigured() && ctx.plan.capabilities.canUseAI,
    health,
    entitlements,
    conflicts,
    activeRules,
    needsAttention,
    simulations30d: usage._sum.simulations ?? 0,
    aiRequests30d: usage._sum.aiRequests ?? 0,
    lastPublish,
    notifications,
    onboardingDone: ctx.shop.onboardingDone,
  };
};

/** The three rules merchants reach for first, by a wide margin. */
const STARTERS = [
  {
    template: "max-product-quantity",
    icon: "product",
    title: "Limit quantity per order",
    example: "At most 5 units of one product per order.",
  },
  {
    template: "min-order-value",
    icon: "money",
    title: "Minimum order value",
    example: "Carts must reach $50 before checkout.",
  },
  {
    template: "wholesale-minimum",
    icon: "person",
    title: "Wholesale minimum",
    example: "Tagged wholesale accounts must spend $500.",
  },
];

/**
 * A single dashboard metric.
 *
 * `tone` is applied to the icon and the value, never used alone to convey
 * meaning — the label and detail line always say it in words too.
 */
function Kpi({
  label,
  value,
  detail,
  icon,
  tone = "info",
  href,
}: {
  label: string;
  value: string | number;
  detail?: string;
  icon: string;
  tone?: "info" | "success" | "warning" | "critical" | "neutral";
  href?: string;
}) {
  const body = (
    <s-box padding="base" borderWidth="base" borderRadius="base">
      <s-stack direction="block" gap="small-300">
        <s-stack direction="inline" gap="small-400" alignItems="center">
          <s-icon type={icon as never} tone={tone} size="small" />
          <s-text color="subdued">{label}</s-text>
        </s-stack>
        <s-heading>{value}</s-heading>
        {detail ? <s-text color="subdued">{detail}</s-text> : null}
      </s-stack>
    </s-box>
  );

  return href ? (
    <s-clickable href={href} accessibilityLabel={`${label}: ${value}. ${detail ?? ""}`}>
      {body}
    </s-clickable>
  ) : (
    body
  );
}

export default function Dashboard() {
  const data = useLoaderData<typeof loader>();
  const [showScoreDetail, setShowScoreDetail] = useState(false);

  const {
    health,
    entitlements,
    conflicts,
    activeRules,
    needsAttention,
    lastPublish,
    notifications,
  } = data;

  if (health.empty) {
    return (
      <s-page heading="CartSentry AI">
        <s-section>
          <EmptyState
            icon="shield-check-mark"
            tone="success"
            heading="Your store is protected by CartSentry AI"
            description="Create a purchase rule and Shopify will enforce it in the cart and at checkout — on every plan, no code required."
          >
            <s-button href="/app/rules/new" variant="primary">
              Create rule
            </s-button>
            <s-button href="/app/templates">Start from a template</s-button>
            {data.aiAvailable ? (
              <s-button href="/app/ai" variant="tertiary">
                Create with AI
              </s-button>
            ) : null}
          </EmptyState>
        </s-section>

        <s-section heading="How CartSentry works">
          <s-grid gridTemplateColumns="repeat(auto-fit, minmax(220px, 1fr))" gap="base">
            <StepCard
              step={1}
              icon="wand"
              title="Build"
              description="Pick a condition and a limit. No code — choose your product, set the number, write the message customers see."
            />
            <StepCard
              step={2}
              icon="play"
              title="Test"
              description="Run the rule against a sample cart and see exactly what a customer would experience, before it goes live."
            />
            <StepCard
              step={3}
              icon="lock"
              title="Enforce"
              description="Shopify blocks the purchase on its own servers — including Shop Pay, Apple Pay and Google Pay."
            />
          </s-grid>
        </s-section>

        <s-section heading="Popular starting points">
          <s-grid gridTemplateColumns="repeat(auto-fit, minmax(220px, 1fr))" gap="base">
            {STARTERS.map((starter) => (
              <s-clickable
                key={starter.template}
                href={`/app/rules/new?template=${starter.template}`}
                accessibilityLabel={`Create a rule from the ${starter.title} template`}
              >
                <s-box padding="base" borderWidth="base" borderRadius="base">
                  <s-stack direction="block" gap="small-400">
                    <s-stack direction="inline" gap="small-400" alignItems="center">
                      <s-icon type={starter.icon as never} tone="info" size="small" />
                      <s-text type="strong">{starter.title}</s-text>
                    </s-stack>
                    <s-text color="subdued">{starter.example}</s-text>
                  </s-stack>
                </s-box>
              </s-clickable>
            ))}
          </s-grid>
        </s-section>

        <s-section slot="aside" heading="Good to know">
          <s-stack direction="block" gap="small-300">
            <s-paragraph>
              Rules are enforced by Shopify&rsquo;s own cart and checkout validation, so a customer
              cannot get around them by editing the page.
            </s-paragraph>
            <s-paragraph>
              Nothing goes live until you activate it. New rules are always saved as drafts.
            </s-paragraph>
            <s-link href="/app/help">Read how it works</s-link>
          </s-stack>
        </s-section>
      </s-page>
    );
  }

  return (
    <s-page heading="CartSentry AI">
      <s-button slot="primary-action" href="/app/rules/new" variant="primary">
        Create rule
      </s-button>

      <s-section>
        <s-stack direction="block" gap="small-200">
          <s-text color="subdued">
            Store: {data.shopName} · Plan: {data.planTitle}
          </s-text>
        </s-stack>
      </s-section>

      {notifications.length > 0 ? (
        <s-section>
          <s-stack direction="block" gap="small-200">
            {notifications.map((notification) => (
              <s-banner
                key={notification.id}
                tone={notification.severity === "CRITICAL" ? "critical" : "warning"}
                heading={notification.title}
              >
                <s-paragraph>{notification.body}</s-paragraph>
                {notification.actionUrl ? (
                  <s-button href={notification.actionUrl}>Review</s-button>
                ) : null}
              </s-banner>
            ))}
          </s-stack>
        </s-section>
      ) : null}

      <s-section heading="Purchase Rules Health">
        <s-stack direction="block" gap="base">
          <s-stack direction="inline" gap="base" alignItems="center">
            <s-heading>{health.score} / 100</s-heading>
            <s-badge
              tone={
                health.band === "excellent"
                  ? "success"
                  : health.band === "good"
                    ? "info"
                    : "warning"
              }
            >
              {health.band === "excellent"
                ? "Healthy"
                : health.band === "good"
                  ? "Good"
                  : "Needs attention"}
            </s-badge>
            <s-button variant="tertiary" onClick={() => setShowScoreDetail((v) => !v)}>
              {showScoreDetail ? "Hide breakdown" : `Why is my score ${health.score}?`}
            </s-button>
          </s-stack>

          {showScoreDetail ? (
            <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
              <s-stack direction="block" gap="small-300">
                <s-paragraph>
                  The score starts at 100. Each item below adds or removes points. Nothing is
                  estimated — every factor is something CartSentry can check directly.
                </s-paragraph>
                <s-table>
                  <s-table-header-row>
                    <s-table-header>Factor</s-table-header>
                    <s-table-header>Points</s-table-header>
                  </s-table-header-row>
                  <s-table-body>
                    {health.factors.map((factor) => (
                      <s-table-row key={factor.label}>
                        <s-table-cell>
                          <s-stack direction="block" gap="small-500">
                            <s-text type="strong">{factor.label}</s-text>
                            <s-text color="subdued">{factor.detail}</s-text>
                            {factor.actionUrl ? (
                              <s-link href={factor.actionUrl}>Fix this</s-link>
                            ) : null}
                          </s-stack>
                        </s-table-cell>
                        <s-table-cell>
                          <s-text tone={factor.points >= 0 ? "success" : "critical"}>
                            {factor.points > 0 ? `+${factor.points}` : factor.points}
                          </s-text>
                        </s-table-cell>
                      </s-table-row>
                    ))}
                  </s-table-body>
                </s-table>
              </s-stack>
            </s-box>
          ) : null}
        </s-stack>
      </s-section>

      <s-section heading="At a glance">
        <s-grid gridTemplateColumns="repeat(auto-fit, minmax(180px, 1fr))" gap="base">
          <Kpi
            label="Active rules"
            icon="shield-check-mark"
            tone="success"
            href="/app/rules?status=ACTIVE"
            value={activeRules}
            detail={`Limit ${entitlements.maxActiveRules} on ${data.planTitle}`}
          />
          <Kpi
            label="Rules needing attention"
            icon="alert-triangle"
            href="/app/rules?needsAttention=true"
            value={needsAttention}
            detail={needsAttention > 0 ? "Not currently enforced" : "All rules healthy"}
          />
          <Kpi
            label="Open conflicts"
            icon="alert-circle"
            href="/app/conflicts"
            value={conflicts.open}
            detail={conflicts.critical > 0 ? `${conflicts.critical} critical` : "None critical"}
          />
          <Kpi
            label="Simulations (30 days)"
            icon="play"
            href="/app/simulator"
            value={data.simulations30d}
            detail={
              entitlements.maxSimulationsPerMonth === null
                ? "Unlimited on your plan"
                : `${entitlements.simulationsThisMonth} of ${entitlements.maxSimulationsPerMonth} this month`
            }
          />
          <Kpi label="AI rules drafted (30 days)"
            icon="wand" value={data.aiRequests30d} />
          <Kpi
            label="Published to Shopify"
            icon="upload"
            value={lastPublish ? `v${lastPublish.version}` : "Not yet"}
            detail={
              lastPublish?.publishedAt
                ? new Date(lastPublish.publishedAt).toLocaleDateString()
                : "Activate a rule to publish"
            }
          />
        </s-grid>
      </s-section>

      <s-section slot="aside" heading="Next steps">
        <s-unordered-list>
          {needsAttention > 0 ? (
            <s-list-item>
              <s-link href="/app/rules?needsAttention=true">
                Fix {needsAttention} rule{needsAttention === 1 ? "" : "s"} that reference deleted
                products
              </s-link>
            </s-list-item>
          ) : null}
          {conflicts.critical > 0 ? (
            <s-list-item>
              <s-link href="/app/conflicts">
                Resolve {conflicts.critical} critical conflict
                {conflicts.critical === 1 ? "" : "s"}
              </s-link>
            </s-list-item>
          ) : null}
          <s-list-item>
            <s-link href="/app/simulator">Test a customer scenario</s-link>
          </s-list-item>
          <s-list-item>
            <s-link href="/app/templates">Start from a template</s-link>
          </s-list-item>
        </s-unordered-list>
      </s-section>
    </s-page>
  );
}
