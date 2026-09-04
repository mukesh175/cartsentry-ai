import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import {
  Form,
  useActionData,
  useLoaderData,
  useNavigation,
  useSearchParams,
  useSubmit,
} from "react-router";

import { requireTenant } from "../lib/tenancy.server";
import {
  activateRule,
  archiveRule,
  deleteRule,
  disableRule,
  duplicateRule,
  listRules,
} from "../lib/rules/rules.server";
import { entitlementSnapshot } from "../lib/billing/entitlements.server";
import { toAppError } from "../lib/errors.server";
import { EmptyState, ErrorBanner, RuleStatusBadge } from "../components/rule-ui";
import { explainRule } from "@cartsentry/engine";
import type { RuleDefinition } from "@cartsentry/engine";

const STATUSES = ["ACTIVE", "DRAFT", "DISABLED", "NEEDS_ATTENTION", "ARCHIVED"];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const ctx = await requireTenant(request);
  const url = new URL(request.url);

  const filters = {
    search: url.searchParams.get("search") ?? undefined,
    status: url.searchParams.getAll("status"),
    needsAttention: url.searchParams.get("needsAttention") === "true",
    sort: (url.searchParams.get("sort") as "updated" | "name" | "priority") ?? "updated",
    page: Number(url.searchParams.get("page") ?? 1),
  };

  const [result, entitlements] = await Promise.all([
    listRules(ctx, filters),
    entitlementSnapshot(ctx),
  ]);

  return {
    ...result,
    rules: result.rules.map((rule) => ({
      id: rule.id,
      name: rule.name,
      description: rule.description,
      type: rule.type,
      status: rule.status,
      priority: rule.priority,
      updatedAt: rule.updatedAt.toISOString(),
      attentionReason: rule.attentionReason,
      conflictCount: rule._count.conflicts,
      warningsEnabled: (rule.warningConfig as { enabled?: boolean })?.enabled === true,
      summary: explainRule(rule.definition as RuleDefinition),
    })),
    entitlements,
    filters,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const ctx = await requireTenant(request);
  const form = await request.formData();
  const intent = String(form.get("intent"));
  const ruleId = String(form.get("ruleId"));

  try {
    switch (intent) {
      case "activate":
        await activateRule(ctx, ruleId);
        return { ok: true, message: "Rule activated and published to Shopify." };
      case "disable":
        await disableRule(ctx, ruleId);
        return { ok: true, message: "Rule disabled." };
      case "archive":
        await archiveRule(ctx, ruleId);
        return { ok: true, message: "Rule archived." };
      case "duplicate":
        await duplicateRule(ctx, ruleId);
        return { ok: true, message: "Rule duplicated as a draft." };
      case "delete":
        await deleteRule(ctx, ruleId);
        return { ok: true, message: "Rule deleted." };
      default:
        return { ok: false, error: { code: "VALIDATION", message: "Unknown action." } };
    }
  } catch (error) {
    const appError = toAppError(error, ctx.requestId);
    return { ok: false, error: appError.toPayload() };
  }
};

export default function RulesIndex() {
  const { rules, total, page, pageCount, entitlements, filters } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigation = useNavigation();
  const submit = useSubmit();

  const busy = navigation.state !== "idle";

  const toggleStatus = (status: string) => {
    const next = new URLSearchParams(searchParams);
    const current = next.getAll("status");
    next.delete("status");
    const updated = current.includes(status)
      ? current.filter((s) => s !== status)
      : [...current, status];
    for (const value of updated) next.append("status", value);
    next.delete("page");
    setSearchParams(next);
  };

  if (total === 0 && !filters.search && filters.status.length === 0) {
    return (
      <s-page heading="Rules">
        <s-button slot="primary-action" href="/app/rules/new" variant="primary">
          Create rule
        </s-button>
        <s-section>
          <EmptyState
            heading="No purchase rules yet"
            description="A rule describes when a purchase should be blocked or a customer warned. Start from scratch or pick a template."
          >
            <s-button href="/app/rules/new" variant="primary">
              Create rule
            </s-button>
            <s-button href="/app/templates">Browse templates</s-button>
          </EmptyState>
        </s-section>
      </s-page>
    );
  }

  return (
    <s-page heading="Rules">
      <s-button slot="primary-action" href="/app/rules/new" variant="primary">
        Create rule
      </s-button>

      {actionData && !actionData.ok ? (
        <s-section>
          <ErrorBanner error={actionData.error} />
        </s-section>
      ) : null}

      {entitlements.overRuleLimit ? (
        <s-section>
          <s-banner tone="warning" heading="You have more active rules than your plan allows">
            <s-paragraph>
              You have {entitlements.activeRules} active rules and your plan supports{" "}
              {entitlements.maxActiveRules}. Nothing has been deleted and your existing rules keep
              working. You cannot activate more rules until you are back under the limit.
            </s-paragraph>
            <s-stack direction="inline" gap="base">
              <s-button href="/app/billing" variant="primary">
                Upgrade
              </s-button>
              <s-button href="/app/rules?status=ACTIVE">Review active rules</s-button>
            </s-stack>
          </s-banner>
        </s-section>
      ) : null}

      <s-section>
        <s-stack direction="block" gap="base">
          <Form method="get">
            <s-stack direction="inline" gap="base" alignItems="end">
              <s-search-field
                label="Search rules"
                name="search"
                value={filters.search ?? ""}
                placeholder="Search by name or description"
              />
              <s-select label="Sort by" name="sort" value={filters.sort}>
                <s-option value="updated">Recently modified</s-option>
                <s-option value="name">Name</s-option>
                <s-option value="priority">Priority</s-option>
              </s-select>
              <s-button type="submit">Apply</s-button>
            </s-stack>
          </Form>

          <s-stack direction="inline" gap="small-300">
            {STATUSES.map((status) => (
              // Selection carries an explicit label as well as the variant, so the
              // filter state is never conveyed by colour alone.
              <s-button
                key={status}
                variant={filters.status.includes(status) ? "primary" : "tertiary"}
                accessibilityLabel={`${filters.status.includes(status) ? "Remove" : "Add"} filter: ${status.replace("_", " ").toLowerCase()}`}
                onClick={() => toggleStatus(status)}
              >
                {status.replace("_", " ").toLowerCase()}
              </s-button>
            ))}
          </s-stack>
        </s-stack>
      </s-section>

      <s-section heading={`${total} rule${total === 1 ? "" : "s"}`}>
        <s-table>
          <s-table-header-row>
            <s-table-header>Rule</s-table-header>
            <s-table-header>Status</s-table-header>
            <s-table-header>Priority</s-table-header>
            <s-table-header>Modified</s-table-header>
            <s-table-header>Actions</s-table-header>
          </s-table-header-row>
          <s-table-body>
            {rules.map((rule) => (
              <s-table-row key={rule.id}>
                <s-table-cell>
                  <s-stack direction="block" gap="small-500">
                    <s-link href={`/app/rules/${rule.id}`}>{rule.name}</s-link>
                    <s-text color="subdued">{rule.summary}</s-text>
                    {rule.attentionReason ? (
                      <s-text tone="warning">{rule.attentionReason}</s-text>
                    ) : null}
                    <s-stack direction="inline" gap="small-500">
                      {rule.warningsEnabled ? <s-badge tone="info">Warning on</s-badge> : null}
                      {rule.conflictCount > 0 ? (
                        <s-badge tone="warning">
                          {rule.conflictCount} conflict{rule.conflictCount === 1 ? "" : "s"}
                        </s-badge>
                      ) : null}
                    </s-stack>
                  </s-stack>
                </s-table-cell>
                <s-table-cell>
                  <RuleStatusBadge status={rule.status} />
                </s-table-cell>
                <s-table-cell>{rule.priority}</s-table-cell>
                <s-table-cell>{new Date(rule.updatedAt).toLocaleDateString()}</s-table-cell>
                <s-table-cell>
                  <s-stack direction="inline" gap="small-500">
                    {rule.status === "ACTIVE" ? (
                      <s-button
                        variant="tertiary"
                        disabled={busy}
                        onClick={() =>
                          submit({ intent: "disable", ruleId: rule.id }, { method: "post" })
                        }
                      >
                        Disable
                      </s-button>
                    ) : rule.status === "DRAFT" || rule.status === "DISABLED" ? (
                      <s-button
                        variant="tertiary"
                        disabled={busy}
                        onClick={() =>
                          submit({ intent: "activate", ruleId: rule.id }, { method: "post" })
                        }
                      >
                        Activate
                      </s-button>
                    ) : null}
                    <s-button
                      variant="tertiary"
                      disabled={busy}
                      onClick={() =>
                        submit({ intent: "duplicate", ruleId: rule.id }, { method: "post" })
                      }
                    >
                      Duplicate
                    </s-button>
                    <s-button variant="tertiary" href={`/app/rules/${rule.id}`}>
                      Edit
                    </s-button>
                  </s-stack>
                </s-table-cell>
              </s-table-row>
            ))}
          </s-table-body>
        </s-table>

        {pageCount > 1 ? (
          <s-stack direction="inline" gap="base" alignItems="center">
            <s-button
              disabled={page <= 1}
              href={`/app/rules?${new URLSearchParams({ ...Object.fromEntries(searchParams), page: String(page - 1) })}`}
            >
              Previous
            </s-button>
            <s-text>
              Page {page} of {pageCount}
            </s-text>
            <s-button
              disabled={page >= pageCount}
              href={`/app/rules?${new URLSearchParams({ ...Object.fromEntries(searchParams), page: String(page + 1) })}`}
            >
              Next
            </s-button>
          </s-stack>
        ) : null}
      </s-section>
    </s-page>
  );
}
