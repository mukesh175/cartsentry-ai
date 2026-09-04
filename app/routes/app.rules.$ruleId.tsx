import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useActionData, useLoaderData, useNavigation, useSubmit } from "react-router";

import { requireTenant } from "../lib/tenancy.server";
import {
  activateRule,
  archiveRule,
  checkActivation,
  disableRule,
  duplicateRule,
  deleteRule,
  listVersions,
  restoreVersion,
  updateRule,
} from "../lib/rules/rules.server";
import { ruleDetailAnalytics } from "../lib/analytics/analytics.server";
import { toAppError } from "../lib/errors.server";
import { RuleBuilder, type RuleFormValue } from "../components/RuleBuilder";
import { ErrorBanner, RuleStatusBadge } from "../components/rule-ui";
import type { RuleDefinition } from "@cartsentry/engine";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const ctx = await requireTenant(request);
  const rule = await ctx.requireRule(params.ruleId!);

  const [activation, analytics, versions] = await Promise.all([
    checkActivation(ctx, rule.id),
    ruleDetailAnalytics(ctx, rule.id),
    ctx.plan.capabilities.canUseRuleVersionHistory
      ? listVersions(ctx, rule.id).catch(() => [])
      : Promise.resolve([]),
  ]);

  const value: RuleFormValue = {
    name: rule.name,
    description: rule.description ?? "",
    message: rule.message,
    priority: rule.priority,
    definition: rule.definition as RuleDefinition,
    warningConfig: {
      enabled: false,
      title: "",
      message: "",
      severity: "warning",
      showOnProduct: true,
      showInCart: true,
      icon: "alert",
      ...(rule.warningConfig as object),
    } as RuleFormValue["warningConfig"],
  };

  return {
    ruleId: rule.id,
    status: rule.status,
    attentionReason: rule.attentionReason,
    value,
    activation,
    currencyCode: ctx.shop.currencyCode ?? "USD",
    warningsAllowed: ctx.plan.capabilities.canUseWarnings,
    versionHistoryAllowed: ctx.plan.capabilities.canUseRuleVersionHistory,
    versions: versions.map((v) => ({
      version: v.version,
      note: v.note,
      createdAt: v.createdAt.toISOString(),
    })),
    activity: analytics.activity.map((a) => ({
      id: a.id,
      summary: a.summary,
      createdAt: a.createdAt.toISOString(),
    })),
    openConflicts: analytics.openConflicts,
  };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const ctx = await requireTenant(request);
  const ruleId = params.ruleId!;
  const form = await request.formData();
  const intent = String(form.get("intent"));

  try {
    switch (intent) {
      case "save":
        await updateRule(ctx, ruleId, JSON.parse(String(form.get("payload"))));
        return { ok: true as const, message: "Rule saved." };
      case "activate":
        await activateRule(ctx, ruleId);
        return { ok: true as const, message: "Rule activated and published to Shopify." };
      case "disable":
        await disableRule(ctx, ruleId);
        return { ok: true as const, message: "Rule disabled." };
      case "archive":
        await archiveRule(ctx, ruleId);
        return { ok: true as const, message: "Rule archived." };
      case "duplicate": {
        const copy = await duplicateRule(ctx, ruleId);
        return { ok: true as const, message: "Duplicated.", redirectTo: `/app/rules/${copy.id}` };
      }
      case "delete":
        await deleteRule(ctx, ruleId);
        return { ok: true as const, message: "Rule deleted.", redirectTo: "/app/rules" };
      case "restore":
        await restoreVersion(ctx, ruleId, Number(form.get("version")));
        return { ok: true as const, message: "Version restored." };
      default:
        return { ok: false as const, error: { code: "VALIDATION", message: "Unknown action." } };
    }
  } catch (error) {
    const appError = toAppError(error, ctx.requestId);
    return { ok: false as const, error: appError.toPayload() };
  }
};

export default function RuleDetail() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const submit = useSubmit();

  const [value, setValue] = useState<RuleFormValue>(data.value);
  const [confirmingActivation, setConfirmingActivation] = useState(false);

  const busy = navigation.state !== "idle";

  const run = (intent: string, extra: Record<string, string> = {}) =>
    submit({ intent, ...extra }, { method: "post" });

  const save = () => submit({ intent: "save", payload: JSON.stringify(value) }, { method: "post" });

  return (
    <s-page heading={data.value.name || "Rule"}>
      <s-button
        slot="primary-action"
        variant="primary"
        onClick={save}
        disabled={busy}
        {...(busy ? { loading: true } : {})}
      >
        Save
      </s-button>
      <s-button slot="secondary-actions" href="/app/rules" variant="tertiary">
        Back to rules
      </s-button>

      {actionData && !actionData.ok ? (
        <s-section>
          <ErrorBanner error={actionData.error} />
        </s-section>
      ) : null}

      {actionData?.ok && actionData.message ? (
        <s-section>
          <s-banner tone="success" heading={actionData.message} />
        </s-section>
      ) : null}

      <s-section>
        <s-stack direction="inline" gap="base" alignItems="center">
          <RuleStatusBadge status={data.status} />
          {data.openConflicts > 0 ? (
            <s-link href="/app/conflicts">
              {data.openConflicts} open conflict{data.openConflicts === 1 ? "" : "s"}
            </s-link>
          ) : null}
        </s-stack>
      </s-section>

      {data.attentionReason ? (
        <s-section>
          <s-banner tone="warning" heading="This rule needs attention">
            <s-paragraph>{data.attentionReason}</s-paragraph>
            <s-paragraph>
              It is not being enforced. Pick a replacement product below, or disable the rule.
            </s-paragraph>
          </s-banner>
        </s-section>
      ) : null}

      <s-section heading="Activation">
        <s-stack direction="block" gap="base">
          {data.status === "ACTIVE" ? (
            <>
              <s-paragraph>
                This rule is live and applies to customers now.
              </s-paragraph>
              <s-button onClick={() => run("disable")} disabled={busy}>
                Disable rule
              </s-button>
            </>
          ) : (
            <>
              {data.activation.ok ? (
                <s-paragraph>
                  This rule is ready to activate. We recommend testing it in the simulator first.
                </s-paragraph>
              ) : (
                <s-banner tone="critical" heading="This rule cannot be activated yet">
                  <s-unordered-list>
                    {data.activation.blockers.map((blocker) => (
                      <s-list-item key={blocker.code}>{blocker.message}</s-list-item>
                    ))}
                  </s-unordered-list>
                </s-banner>
              )}

              <s-stack direction="inline" gap="base">
                <s-button href={`/app/simulator?ruleId=${data.ruleId}`}>Run simulation</s-button>
                <s-button
                  variant="primary"
                  disabled={!data.activation.ok || busy}
                  onClick={() => setConfirmingActivation(true)}
                >
                  Activate rule
                </s-button>
              </s-stack>
            </>
          )}
        </s-stack>
      </s-section>

      {confirmingActivation ? (
        <s-section>
          <s-banner tone="warning" heading="Activate this rule?">
            <s-paragraph>
              Activating this rule may prevent customers from completing affected purchases. It
              takes effect as soon as it is published to Shopify.
            </s-paragraph>
            <s-stack direction="inline" gap="base">
              <s-button
                variant="primary"
                disabled={busy}
                onClick={() => {
                  setConfirmingActivation(false);
                  run("activate");
                }}
              >
                Yes, activate
              </s-button>
              <s-button variant="tertiary" onClick={() => setConfirmingActivation(false)}>
                Cancel
              </s-button>
            </s-stack>
          </s-banner>
        </s-section>
      ) : null}

      <RuleBuilder
        value={value}
        onChange={setValue}
        currencyCode={data.currencyCode}
        warningsAllowed={data.warningsAllowed}
      />

      <s-section slot="aside" heading="Manage">
        <s-stack direction="block" gap="small-300">
          <s-button onClick={() => run("duplicate")} disabled={busy}>
            Duplicate
          </s-button>
          <s-button onClick={() => run("archive")} disabled={busy}>
            Archive
          </s-button>
          <s-button
            variant="tertiary"
            tone="critical"
            disabled={busy}
            onClick={() => run("delete")}
          >
            Delete
          </s-button>
        </s-stack>
      </s-section>

      {data.versionHistoryAllowed && data.versions.length > 0 ? (
        <s-section slot="aside" heading="Version history">
          <s-stack direction="block" gap="small-300">
            {data.versions.slice(0, 10).map((version) => (
              <s-stack key={version.version} direction="inline" gap="base" alignItems="center">
                <s-text>
                  v{version.version} — {version.note ?? "Saved"}
                </s-text>
                <s-button
                  variant="tertiary"
                  disabled={busy}
                  onClick={() => run("restore", { version: String(version.version) })}
                >
                  Restore
                </s-button>
              </s-stack>
            ))}
          </s-stack>
        </s-section>
      ) : null}

      {data.activity.length > 0 ? (
        <s-section slot="aside" heading="Recent activity">
          <s-unordered-list>
            {data.activity.slice(0, 8).map((entry) => (
              <s-list-item key={entry.id}>
                {entry.summary}
                <s-text color="subdued"> — {new Date(entry.createdAt).toLocaleString()}</s-text>
              </s-list-item>
            ))}
          </s-unordered-list>
        </s-section>
      ) : null}
    </s-page>
  );
}
