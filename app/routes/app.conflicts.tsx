import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useActionData, useLoaderData, useNavigation, useSubmit } from "react-router";

import { requireTenant } from "../lib/tenancy.server";
import {
  ignoreConflict,
  listConflicts,
  reopenConflict,
  scanConflicts,
} from "../lib/conflicts/conflicts.server";
import { toAppError } from "../lib/errors.server";
import { EmptyState, ErrorBanner, SeverityBadge } from "../components/rule-ui";
import { t } from "../lib/i18n";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const ctx = await requireTenant(request);

  // Scan on load so the page always reflects the current rules rather than a
  // stale snapshot from the last time someone clicked a button.
  await scanConflicts(ctx);
  const conflicts = await listConflicts(ctx);

  return {
    advancedAllowed: ctx.plan.capabilities.canUseAdvancedConflictDetection,
    conflicts: conflicts.map((conflict) => ({
      id: conflict.id,
      type: conflict.type,
      severity: conflict.severity,
      confidence: conflict.confidence,
      explanation: conflict.explanation,
      suggestedFix: conflict.suggestedFix,
      status: conflict.status,
      scenario: (conflict.scenario as { description?: string } | null)?.description ?? null,
      rule: conflict.rule,
      relatedRule: conflict.relatedRule,
    })),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const ctx = await requireTenant(request);
  const form = await request.formData();
  const intent = String(form.get("intent"));

  try {
    switch (intent) {
      case "rescan": {
        const summary = await scanConflicts(ctx);
        return {
          ok: true as const,
          message: `Scan complete. ${summary.total} issue${summary.total === 1 ? "" : "s"} found.`,
        };
      }
      case "ignore":
        await ignoreConflict(ctx, String(form.get("conflictId")));
        return { ok: true as const, message: "Conflict dismissed. Your rules were not changed." };
      case "reopen":
        await reopenConflict(ctx, String(form.get("conflictId")));
        return { ok: true as const, message: "Conflict reopened." };
      default:
        return { ok: false as const, error: { code: "VALIDATION", message: "Unknown action." } };
    }
  } catch (error) {
    const appError = toAppError(error, ctx.requestId);
    return { ok: false as const, error: appError.toPayload() };
  }
};

export default function Conflicts() {
  const { conflicts, advancedAllowed } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const submit = useSubmit();

  const busy = navigation.state !== "idle";
  const open = conflicts.filter((c) => c.status === "OPEN");
  const dismissed = conflicts.filter((c) => c.status !== "OPEN");

  return (
    <s-page heading="Conflict Center">
      <s-button
        slot="primary-action"
        onClick={() => submit({ intent: "rescan" }, { method: "post" })}
        disabled={busy}
        {...(busy ? { loading: true } : {})}
      >
        Rescan rules
      </s-button>

      {actionData && !actionData.ok ? (
        <s-section>
          <ErrorBanner error={actionData.error} />
        </s-section>
      ) : null}

      {actionData?.ok ? (
        <s-section>
          <s-banner tone="success" heading={actionData.message} />
        </s-section>
      ) : null}

      <s-section>
        <s-paragraph>
          CartSentry compares every pair of active and draft rules. A conflict is only marked
          critical when it can be proved that no customer could satisfy both rules — we would
          rather miss a subtle overlap than tell you something is broken when it is not.
        </s-paragraph>
        {!advancedAllowed ? (
          <s-banner tone="info" heading="Advanced conflict detection is available on Growth">
            <s-paragraph>
              You are seeing confirmed contradictions. Advanced detection adds overlap and
              redundancy analysis across larger rule sets.
            </s-paragraph>
            <s-button href="/app/billing">View plans</s-button>
          </s-banner>
        ) : null}
      </s-section>

      {open.length === 0 ? (
        <s-section>
          <EmptyState
            icon="check-circle"
            tone="success"
            heading="No conflicts found"
            description="Your rules can all be satisfied together. We rescan every time you open this page."
          >
            <s-button href="/app/rules">Back to rules</s-button>
          </EmptyState>
        </s-section>
      ) : (
        <s-section heading={`${open.length} open issue${open.length === 1 ? "" : "s"}`}>
          <s-stack direction="block" gap="base">
            {open.map((conflict) => (
              <s-box key={conflict.id} padding="base" borderWidth="base" borderRadius="base">
                <s-stack direction="block" gap="small-300">
                  <s-stack direction="inline" gap="base" alignItems="center">
                    <SeverityBadge severity={conflict.severity} />
                    <s-badge tone="neutral">
                      {t(`conflict.confidence.${conflict.confidence}`)}
                    </s-badge>
                  </s-stack>

                  <s-stack direction="inline" gap="small-400">
                    <s-link href={`/app/rules/${conflict.rule.id}`}>{conflict.rule.name}</s-link>
                    {conflict.relatedRule ? (
                      <>
                        <s-text color="subdued">and</s-text>
                        <s-link href={`/app/rules/${conflict.relatedRule.id}`}>
                          {conflict.relatedRule.name}
                        </s-link>
                      </>
                    ) : null}
                  </s-stack>

                  <s-paragraph>{conflict.explanation}</s-paragraph>

                  {conflict.scenario ? (
                    <s-box padding="base" borderRadius="base" background="subdued">
                      <s-stack direction="block" gap="small-500">
                        <s-text type="strong">What a customer would experience</s-text>
                        <s-text>{conflict.scenario}</s-text>
                      </s-stack>
                    </s-box>
                  ) : null}

                  {conflict.suggestedFix ? (
                    <s-stack direction="block" gap="small-500">
                      <s-text type="strong">Suggested fix</s-text>
                      <s-text>{conflict.suggestedFix}</s-text>
                    </s-stack>
                  ) : null}

                  <s-stack direction="inline" gap="base">
                    <s-button href={`/app/rules/${conflict.rule.id}`}>
                      Review {conflict.rule.name}
                    </s-button>
                    {conflict.relatedRule ? (
                      <s-button href={`/app/rules/${conflict.relatedRule.id}`} variant="tertiary">
                        Review {conflict.relatedRule.name}
                      </s-button>
                    ) : null}
                    <s-button
                      variant="tertiary"
                      disabled={busy}
                      onClick={() =>
                        submit(
                          { intent: "ignore", conflictId: conflict.id },
                          { method: "post" },
                        )
                      }
                    >
                      Dismiss
                    </s-button>
                  </s-stack>
                </s-stack>
              </s-box>
            ))}
          </s-stack>
        </s-section>
      )}

      {dismissed.length > 0 ? (
        <s-section heading="Dismissed and resolved">
          <s-stack direction="block" gap="small-300">
            {dismissed.map((conflict) => (
              <s-stack key={conflict.id} direction="inline" gap="base" alignItems="center">
                <SeverityBadge severity={conflict.severity} />
                <s-text>{conflict.explanation.slice(0, 140)}…</s-text>
                {conflict.status === "IGNORED" ? (
                  <s-button
                    variant="tertiary"
                    disabled={busy}
                    onClick={() =>
                      submit({ intent: "reopen", conflictId: conflict.id }, { method: "post" })
                    }
                  >
                    Reopen
                  </s-button>
                ) : (
                  <s-badge tone="success">Resolved</s-badge>
                )}
              </s-stack>
            ))}
          </s-stack>
        </s-section>
      ) : null}
    </s-page>
  );
}
