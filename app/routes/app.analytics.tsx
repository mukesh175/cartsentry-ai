import type { LoaderFunctionArgs } from "react-router";
import { Form, useLoaderData } from "react-router";

import { requireTenant } from "../lib/tenancy.server";
import { ruleAnalytics, type DateRange } from "../lib/analytics/analytics.server";
import { AppError } from "../lib/errors.server";

const RANGES: { value: DateRange; label: string }[] = [
  { value: "today", label: "Today" },
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
  { value: "90d", label: "Last 90 days" },
];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const ctx = await requireTenant(request);
  const url = new URL(request.url);
  const range = (url.searchParams.get("range") as DateRange) ?? "30d";

  try {
    const analytics = await ruleAnalytics(ctx, { range });
    return {
      ok: true as const,
      range,
      analytics: {
        ...analytics,
        from: analytics.from.toISOString(),
        to: analytics.to.toISOString(),
      },
      advancedAllowed: ctx.plan.capabilities.canUseAdvancedAnalytics,
      planTitle: ctx.plan.title,
    };
  } catch (error) {
    if (error instanceof AppError && error.code === "PLAN_LIMIT") {
      return {
        ok: false as const,
        range,
        planTitle: ctx.plan.title,
        advancedAllowed: false,
      };
    }
    throw error;
  }
};

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <s-box padding="base" borderWidth="base" borderRadius="base">
      <s-stack direction="block" gap="small-500">
        <s-text color="subdued">{label}</s-text>
        <s-heading>{value}</s-heading>
      </s-stack>
    </s-box>
  );
}

export default function Analytics() {
  const data = useLoaderData<typeof loader>();

  if (!data.ok) {
    return (
      <s-page heading="Analytics">
        <s-section>
          <s-banner tone="info" heading="Longer date ranges are available on Growth">
            <s-paragraph>
              Your {data.planTitle} plan includes shorter ranges. Upgrade for 90-day and custom
              reporting.
            </s-paragraph>
            <s-button href="/app/billing" variant="primary">
              View plans
            </s-button>
          </s-banner>
          <s-button href="/app/analytics?range=30d">Back to last 30 days</s-button>
        </s-section>
      </s-page>
    );
  }

  const { analytics } = data;

  return (
    <s-page heading="Analytics">
      <s-section>
        <Form method="get">
          <s-stack direction="inline" gap="base" alignItems="end">
            <s-select label="Date range" name="range" value={data.range}>
              {RANGES.map((range) => (
                <s-option key={range.value} value={range.value}>
                  {range.label}
                </s-option>
              ))}
            </s-select>
            <s-button type="submit">Apply</s-button>
          </s-stack>
        </Form>
      </s-section>

      <s-section>
        <s-banner tone="info" heading="What these numbers cover">
          <s-paragraph>
            These are the actions CartSentry can observe directly: rules you created and activated,
            simulations you ran, conflicts detected, and publishes to Shopify.
          </s-paragraph>
          <s-paragraph>
            CartSentry does not report how many shoppers hit a rule at checkout. Shopify Functions
            run on Shopify&rsquo;s servers and do not report per-shopper events back to apps, so any such
            figure would be an estimate. We would rather show you nothing than a number we made up.
          </s-paragraph>
        </s-banner>
      </s-section>

      {analytics.clipped ? (
        <s-section>
          <s-banner tone="warning" heading="Range shortened to fit your plan">
            <s-paragraph>
              Your {data.planTitle} plan keeps {analytics.retentionDays} days of history, so this
              report starts at {new Date(analytics.from).toLocaleDateString()}.
            </s-paragraph>
          </s-banner>
        </s-section>
      ) : null}

      <s-section heading="Activity in this period">
        <s-grid gridTemplateColumns="repeat(auto-fit, minmax(160px, 1fr))" gap="base">
          <Stat label="Simulations run" value={analytics.totals.simulations} />
          <Stat label="AI rules drafted" value={analytics.totals.aiRequests} />
          <Stat label="Rules created" value={analytics.totals.rulesCreated} />
          <Stat label="Rules activated" value={analytics.totals.rulesActivated} />
          <Stat label="Conflict scans with findings" value={analytics.totals.conflictsDetected} />
          <Stat label="Publishes to Shopify" value={analytics.totals.publishes} />
        </s-grid>
      </s-section>

      {analytics.daily.length > 0 ? (
        <s-section heading="Daily activity">
          <s-table>
            <s-table-header-row>
              <s-table-header>Date</s-table-header>
              <s-table-header>Simulations</s-table-header>
              <s-table-header>AI requests</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {analytics.daily.map((point) => (
                <s-table-row key={point.date}>
                  <s-table-cell>{point.date}</s-table-cell>
                  <s-table-cell>{point.simulations}</s-table-cell>
                  <s-table-cell>{point.aiRequests}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        </s-section>
      ) : null}

      {analytics.topRules.length > 0 ? (
        <s-section heading="Most-edited rules">
          <s-table>
            <s-table-header-row>
              <s-table-header>Rule</s-table-header>
              <s-table-header>Status</s-table-header>
              <s-table-header>Logged events</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {analytics.topRules.map((rule) => (
                <s-table-row key={rule.ruleId}>
                  <s-table-cell>
                    <s-link href={`/app/rules/${rule.ruleId}`}>{rule.name}</s-link>
                  </s-table-cell>
                  <s-table-cell>{rule.status.toLowerCase()}</s-table-cell>
                  <s-table-cell>{rule.events}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        </s-section>
      ) : null}
    </s-page>
  );
}
