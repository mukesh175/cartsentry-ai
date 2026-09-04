import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { redirect, useActionData, useLoaderData, useNavigation, useSubmit } from "react-router";

import { requireTenant } from "../lib/tenancy.server";
import { interpretRuleRequest } from "../lib/ai/rule-creator.server";
import { createRule } from "../lib/rules/rules.server";
import { aiIsConfigured } from "../lib/config.server";
import { entitlementSnapshot } from "../lib/billing/entitlements.server";
import { toAppError } from "../lib/errors.server";
import { ErrorBanner, PlanGate, RulePreview } from "../components/rule-ui";
import { rulePreviewLines } from "@cartsentry/engine";

const EXAMPLES = [
  "Customers cannot buy more than 5 units of my Premium T-Shirt.",
  "Wholesale customers must spend at least $500 before they can check out.",
  "The starter kit must be bought together with the installation service.",
  "Limit orders from the Limited Edition collection to 2 items.",
];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const ctx = await requireTenant(request);
  const entitlements = await entitlementSnapshot(ctx);

  return {
    configured: aiIsConfigured(),
    allowed: ctx.plan.capabilities.canUseAI,
    planTitle: ctx.plan.title,
    entitlements,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const ctx = await requireTenant(request);
  const form = await request.formData();
  const intent = String(form.get("intent"));

  try {
    if (intent === "interpret") {
      const interpretation = await interpretRuleRequest(ctx, {
        request: String(form.get("request")),
      });
      return { ok: true as const, interpretation };
    }

    if (intent === "save") {
      const rule = await createRule(ctx, JSON.parse(String(form.get("payload"))));
      return redirect(`/app/rules/${rule.id}?fromAi=1`);
    }

    return { ok: false as const, error: { code: "VALIDATION", message: "Unknown action." } };
  } catch (error) {
    const appError = toAppError(error, ctx.requestId);
    return { ok: false as const, error: appError.toPayload() };
  }
};

export default function AiRuleCreator() {
  const { configured, allowed, planTitle, entitlements } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const submit = useSubmit();

  const [request, setRequest] = useState("");
  const busy = navigation.state === "submitting";

  if (!allowed) {
    return (
      <s-page heading="AI Rule Creator">
        <s-section>
          <PlanGate featureName="The AI Rule Creator" requiredPlanTitle="Growth" />
        </s-section>
        <s-section>
          <s-paragraph>
            You can build every rule type by hand on your {planTitle} plan — the AI only saves
            typing, it does not unlock extra capability.
          </s-paragraph>
          <s-button href="/app/rules/new" variant="primary">
            Build a rule manually
          </s-button>
        </s-section>
      </s-page>
    );
  }

  if (!configured) {
    return (
      <s-page heading="AI Rule Creator">
        <s-section>
          <s-banner tone="warning" heading="The AI Rule Creator is not available right now">
            <s-paragraph>
              No AI provider is configured for this installation. Every rule can still be built with
              the manual rule builder.
            </s-paragraph>
            <s-button href="/app/rules/new" variant="primary">
              Build a rule manually
            </s-button>
          </s-banner>
        </s-section>
      </s-page>
    );
  }

  const interpretation = actionData?.ok ? actionData.interpretation : null;
  const response = interpretation?.response;

  return (
    <s-page heading="AI Rule Creator">
      {actionData && !actionData.ok ? (
        <s-section>
          <ErrorBanner error={actionData.error} />
          <s-button href="/app/rules/new">Build this rule manually instead</s-button>
        </s-section>
      ) : null}

      <s-section heading="Describe the rule">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            Write what you want in plain English. CartSentry turns it into a rule you review before
            anything goes live — nothing is activated automatically.
          </s-paragraph>

          <s-text-area
            label="What should this rule do?"
            value={request}
            rows={4}
            onChange={(event) => setRequest((event.target as HTMLTextAreaElement).value)}
          />

          <s-stack direction="block" gap="small-400">
            <s-text color="subdued">Examples</s-text>
            {EXAMPLES.map((example) => (
              <s-link key={example} href="#" onClick={() => setRequest(example)}>
                {example}
              </s-link>
            ))}
          </s-stack>

          <s-stack direction="inline" gap="base" alignItems="center">
            <s-button
              variant="primary"
              disabled={request.trim().length < 10 || busy}
              {...(busy ? { loading: true } : {})}
              onClick={() => submit({ intent: "interpret", request }, { method: "post" })}
            >
              Interpret with AI
            </s-button>
            <s-text color="subdued">
              {entitlements.aiRequestsThisMonth} of {entitlements.maxAiRequestsPerMonth} used this
              month
            </s-text>
          </s-stack>
        </s-stack>
      </s-section>

      {response?.kind === "clarification" ? (
        <s-section heading="One thing first">
          <s-banner tone="info" heading={response.question}>
            <s-stack direction="block" gap="small-300">
              <s-paragraph>
                Pick the option you meant and we will draft the rule from there.
              </s-paragraph>
              {response.options.map((option) => (
                <s-button
                  key={option}
                  onClick={() =>
                    submit(
                      { intent: "interpret", request: `${request}\n\nTo clarify: ${option}` },
                      { method: "post" },
                    )
                  }
                >
                  {option}
                </s-button>
              ))}
            </s-stack>
          </s-banner>
        </s-section>
      ) : null}

      {interpretation && response?.kind === "rule" ? (
        <>
          <s-section heading="AI interpretation">
            <s-stack direction="block" gap="base">
              <s-stack direction="inline" gap="base" alignItems="center">
                <s-badge
                  tone={
                    response.confidence === "high"
                      ? "success"
                      : response.confidence === "medium"
                        ? "info"
                        : "warning"
                  }
                >
                  {response.confidence} confidence
                </s-badge>
                <s-text color="subdued">
                  {interpretation.provider} · {interpretation.model}
                </s-text>
              </s-stack>

              <s-text type="strong">{response.name}</s-text>
              <s-paragraph>{interpretation.explanation}</s-paragraph>

              <RulePreview
                {...rulePreviewLines(response.definition)}
                message={response.message}
              />

              {response.assumptions.length > 0 ? (
                <s-banner tone="warning" heading="Assumptions the AI made">
                  <s-unordered-list>
                    {response.assumptions.map((assumption) => (
                      <s-list-item key={assumption}>{assumption}</s-list-item>
                    ))}
                  </s-unordered-list>
                </s-banner>
              ) : null}

              <s-banner tone="info" heading="Check the products before activating">
                <s-paragraph>
                  The AI does not know your product IDs. Any product or collection in this rule is a
                  placeholder — open the rule after saving and select the real one.
                </s-paragraph>
              </s-banner>

              <s-stack direction="inline" gap="base">
                <s-button
                  variant="primary"
                  disabled={busy}
                  onClick={() =>
                    submit(
                      {
                        intent: "save",
                        payload: JSON.stringify({
                          name: response.name,
                          description: response.description,
                          message: response.message,
                          priority: response.priority,
                          definition: response.definition,
                          warningConfig: {
                            enabled: false,
                            title: "",
                            message: "",
                            severity: "warning",
                            showOnProduct: true,
                            showInCart: true,
                            icon: "alert",
                          },
                        }),
                      },
                      { method: "post" },
                    )
                  }
                >
                  Save as draft and edit
                </s-button>
                <s-button variant="tertiary" onClick={() => setRequest("")}>
                  Start over
                </s-button>
              </s-stack>
            </s-stack>
          </s-section>
        </>
      ) : null}
    </s-page>
  );
}
