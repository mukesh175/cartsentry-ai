import { useState } from "react";
import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";

import prisma from "../db.server";
import { requireTenant } from "../lib/tenancy.server";
import { computeHealthScore } from "../lib/dashboard/health.server";
import { entitlementSnapshot } from "../lib/billing/entitlements.server";
import { openConflictCount } from "../lib/conflicts/conflicts.server";
import { startOfUtcDay } from "../lib/activity.server";
import { EmptyState } from "../components/rule-ui";

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

function Kpi({ label, value, detail }: { label: string; value: string | number; detail?: string }) {
  return (
    <s-box padding="base" borderWidth="base" borderRadius="base">
      <s-stack direction="block" gap="small-400">
        <s-text color="subdued">{label}</s-text>
        <s-heading>{value}</s-heading>
        {detail ? <s-text color="subdued">{detail}</s-text> : null}
      </s-stack>
    </s-box>
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
            heading="Your store is protected by CartSentry AI"
            description="Create your first purchase rule to stop invalid orders before they reach checkout."
          >
            <s-button href="/app/rules/new" variant="primary">
              Create rule
            </s-button>
            <s-button href="/app/ai">Create with AI</s-button>
            <s-button href="/app/templates" variant="tertiary">
              Explore templates
            </s-button>
          </EmptyState>
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
            value={activeRules}
            detail={`Limit ${entitlements.maxActiveRules} on ${data.planTitle}`}
          />
          <Kpi
            label="Rules needing attention"
            value={needsAttention}
            detail={needsAttention > 0 ? "Not currently enforced" : "All rules healthy"}
          />
          <Kpi
            label="Open conflicts"
            value={conflicts.open}
            detail={conflicts.critical > 0 ? `${conflicts.critical} critical` : "None critical"}
          />
          <Kpi
            label="Simulations (30 days)"
            value={data.simulations30d}
            detail={
              entitlements.maxSimulationsPerMonth === null
                ? "Unlimited on your plan"
                : `${entitlements.simulationsThisMonth} of ${entitlements.maxSimulationsPerMonth} this month`
            }
          />
          <Kpi label="AI rules drafted (30 days)" value={data.aiRequests30d} />
          <Kpi
            label="Published to Shopify"
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
