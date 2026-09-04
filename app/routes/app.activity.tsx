import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";

import { requireTenant } from "../lib/tenancy.server";
import { recentActivity } from "../lib/activity.server";
import { EmptyState } from "../components/rule-ui";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const ctx = await requireTenant(request);
  const entries = await recentActivity(ctx, 100);

  return {
    retentionDays: ctx.plan.limits.historyRetentionDays,
    planTitle: ctx.plan.title,
    entries: entries.map((entry) => ({
      id: entry.id,
      eventType: entry.eventType,
      summary: entry.summary,
      actor: entry.actor,
      createdAt: entry.createdAt.toISOString(),
      ruleName: entry.rule?.name ?? null,
      ruleId: entry.rule?.id ?? null,
      metadata: entry.metadata as Record<string, unknown>,
    })),
  };
};

/** Events that represent a change to what customers experience. */
const IMPACTFUL = new Set([
  "RULE_ACTIVATED",
  "RULE_DISABLED",
  "RULE_DELETED",
  "FUNCTION_CONFIG_PUBLISHED",
  "FUNCTION_CONFIG_FAILED",
  "FUNCTION_CONFIG_ROLLED_BACK",
  "BILLING_CHANGED",
]);

export default function Activity() {
  const { entries, retentionDays, planTitle } = useLoaderData<typeof loader>();

  if (entries.length === 0) {
    return (
      <s-page heading="Activity">
        <s-section>
          <EmptyState
            heading="Nothing logged yet"
            description="Every rule change, simulation, conflict and publish is recorded here."
          >
            <s-button href="/app/rules/new" variant="primary">
              Create your first rule
            </s-button>
          </EmptyState>
        </s-section>
      </s-page>
    );
  }

  return (
    <s-page heading="Activity">
      <s-section>
        <s-paragraph>
          An audit trail of everything that changed, who changed it, and when. Your {planTitle} plan
          keeps {retentionDays} days of history.
        </s-paragraph>
      </s-section>

      <s-section heading={`${entries.length} events`}>
        <s-table>
          <s-table-header-row>
            <s-table-header>When</s-table-header>
            <s-table-header>Event</s-table-header>
            <s-table-header>Rule</s-table-header>
            <s-table-header>By</s-table-header>
          </s-table-header-row>
          <s-table-body>
            {entries.map((entry) => (
              <s-table-row key={entry.id}>
                <s-table-cell>{new Date(entry.createdAt).toLocaleString()}</s-table-cell>
                <s-table-cell>
                  <s-stack direction="block" gap="small-500">
                    <s-stack direction="inline" gap="small-400" alignItems="center">
                      {IMPACTFUL.has(entry.eventType) ? (
                        <s-badge tone="info">Customer impact</s-badge>
                      ) : null}
                      <s-text>{entry.summary}</s-text>
                    </s-stack>
                    {entry.metadata && "before" in entry.metadata ? (
                      <s-text color="subdued">
                        Changed from {JSON.stringify(entry.metadata.before)} to{" "}
                        {JSON.stringify(entry.metadata.after)}
                      </s-text>
                    ) : null}
                  </s-stack>
                </s-table-cell>
                <s-table-cell>
                  {entry.ruleId && entry.ruleName ? (
                    <s-link href={`/app/rules/${entry.ruleId}`}>{entry.ruleName}</s-link>
                  ) : (
                    <s-text color="subdued">—</s-text>
                  )}
                </s-table-cell>
                <s-table-cell>{entry.actor ?? "—"}</s-table-cell>
              </s-table-row>
            ))}
          </s-table-body>
        </s-table>
      </s-section>
    </s-page>
  );
}
