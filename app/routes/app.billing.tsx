import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useActionData, useLoaderData, useNavigation, useSubmit } from "react-router";
import { useEffect, useState } from "react";

import { requireTenant } from "../lib/tenancy.server";
import {
  cancelActiveSubscription,
  previewPlanChange,
  startSubscription,
  syncSubscription,
} from "../lib/billing/billing.server";
import { entitlementSnapshot } from "../lib/billing/entitlements.server";
import { PLANS, PLAN_ORDER, isDowngrade, type PlanName } from "../lib/billing/plans";
import { toAppError } from "../lib/errors.server";
import { ErrorBanner } from "../components/rule-ui";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const ctx = await requireTenant(request);

  // Re-read from Shopify so a subscription cancelled in the Shopify admin is
  // reflected here without waiting for a webhook.
  await syncSubscription(ctx).catch((error) => {
    ctx.log.warn({ err: error }, "Could not sync subscription from Shopify");
  });

  const fresh = await requireTenant(request);
  const entitlements = await entitlementSnapshot(fresh);

  return {
    currentPlan: fresh.planName,
    entitlements,
    plans: PLAN_ORDER.map((name) => PLANS[name]),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const ctx = await requireTenant(request);
  const form = await request.formData();
  const intent = String(form.get("intent"));

  try {
    if (intent === "preview") {
      const impact = await previewPlanChange(ctx, String(form.get("plan")) as PlanName);
      return { ok: true as const, impact };
    }

    if (intent === "subscribe") {
      const url = new URL(request.url);
      const returnUrl = `${url.origin}/app/billing`;
      const { confirmationUrl } = await startSubscription(
        ctx,
        String(form.get("plan")) as PlanName,
        returnUrl,
      );
      return { ok: true as const, confirmationUrl };
    }

    if (intent === "cancel") {
      await cancelActiveSubscription(ctx);
      return { ok: true as const, message: "Subscription cancelled. All your rules were kept." };
    }

    return { ok: false as const, error: { code: "VALIDATION", message: "Unknown action." } };
  } catch (error) {
    const appError = toAppError(error, ctx.requestId);
    return { ok: false as const, error: appError.toPayload() };
  }
};

export default function Billing() {
  const { currentPlan, entitlements, plans } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const submit = useSubmit();
  const [pendingPlan, setPendingPlan] = useState<PlanName | null>(null);

  const busy = navigation.state !== "idle";

  const confirmationUrl =
    actionData?.ok && "confirmationUrl" in actionData ? actionData.confirmationUrl : null;

  // Shopify's charge approval screen cannot render inside the embedded iframe,
  // so send the top-level window there. Done in an effect rather than during
  // render, since navigating is a side effect.
  useEffect(() => {
    if (confirmationUrl) {
      (window.top ?? window).location.href = confirmationUrl;
    }
  }, [confirmationUrl]);

  const impact = actionData?.ok && "impact" in actionData ? actionData.impact : null;

  return (
    <s-page heading="Billing">
      {actionData && !actionData.ok ? (
        <s-section>
          <ErrorBanner error={actionData.error} />
        </s-section>
      ) : null}

      {actionData?.ok && "message" in actionData && actionData.message ? (
        <s-section>
          <s-banner tone="success" heading={actionData.message} />
        </s-section>
      ) : null}

      <s-section>
        <s-stack direction="block" gap="small-300">
          <s-text>
            You are on the <s-text type="strong">{PLANS[currentPlan].title}</s-text> plan.
          </s-text>
          <s-text color="subdued">
            {entitlements.activeRules} of {entitlements.maxActiveRules} active rules used.
          </s-text>
        </s-stack>
      </s-section>

      {entitlements.overRuleLimit ? (
        <s-section>
          <s-banner tone="warning" heading="You are over your plan's active rule limit">
            <s-paragraph>
              You currently have {entitlements.activeRules} active rules. Your plan supports{" "}
              {entitlements.maxActiveRules}. Nothing has been deleted — your rules and their
              settings are all intact, and the ones already live keep working. You just cannot
              activate more until you are back under the limit.
            </s-paragraph>
            <s-stack direction="inline" gap="base">
              <s-button href="/app/rules?status=ACTIVE">Review active rules</s-button>
            </s-stack>
          </s-banner>
        </s-section>
      ) : null}

      {impact && pendingPlan ? (
        <s-section>
          <s-banner
            tone={impact.excess > 0 || impact.losesCapabilities.length > 0 ? "warning" : "info"}
            heading={`Switch to ${PLANS[pendingPlan].title}?`}
          >
            <s-stack direction="block" gap="small-300">
              {impact.excess > 0 ? (
                <s-paragraph>
                  You have {impact.activeRules} active rules and {PLANS[pendingPlan].title}{" "}
                  supports {impact.maxActiveRules}. We will not delete or disable anything — your
                  rules stay exactly as they are, and you will need to bring the count down before
                  activating new ones.
                </s-paragraph>
              ) : null}

              {impact.losesCapabilities.length > 0 ? (
                <>
                  <s-text type="strong">You would lose access to:</s-text>
                  <s-unordered-list>
                    {impact.losesCapabilities.map((capability) => (
                      <s-list-item key={capability}>{capability}</s-list-item>
                    ))}
                  </s-unordered-list>
                </>
              ) : null}

              <s-stack direction="inline" gap="base">
                <s-button
                  variant="primary"
                  disabled={busy}
                  onClick={() => submit({ intent: "subscribe", plan: pendingPlan }, { method: "post" })}
                >
                  Confirm
                </s-button>
                <s-button variant="tertiary" onClick={() => setPendingPlan(null)}>
                  Cancel
                </s-button>
              </s-stack>
            </s-stack>
          </s-banner>
        </s-section>
      ) : null}

      <s-section heading="Plans">
        <s-grid gridTemplateColumns="repeat(auto-fit, minmax(240px, 1fr))" gap="base">
          {plans.map((plan) => {
            const isCurrent = plan.name === currentPlan;
            const downgrade = isDowngrade(currentPlan, plan.name);

            return (
              <s-box key={plan.name} padding="base" borderWidth="base" borderRadius="base">
                <s-stack direction="block" gap="small-300">
                  <s-stack direction="inline" gap="small-400" alignItems="center">
                    <s-text type="strong">{plan.title}</s-text>
                    {isCurrent ? <s-badge tone="success">Current plan</s-badge> : null}
                  </s-stack>

                  <s-heading>
                    {plan.price === 0 ? "Free" : `$${plan.price}`}
                    {plan.price > 0 ? <s-text color="subdued"> / month</s-text> : null}
                  </s-heading>

                  <s-text color="subdued">{plan.tagline}</s-text>

                  <s-unordered-list>
                    {plan.features.map((feature) => (
                      <s-list-item key={feature}>{feature}</s-list-item>
                    ))}
                  </s-unordered-list>

                  {isCurrent ? (
                    plan.price > 0 ? (
                      <s-button
                        variant="tertiary"
                        disabled={busy}
                        onClick={() => submit({ intent: "cancel" }, { method: "post" })}
                      >
                        Cancel subscription
                      </s-button>
                    ) : null
                  ) : (
                    <s-button
                      variant={downgrade ? "tertiary" : "primary"}
                      disabled={busy}
                      onClick={() => {
                        setPendingPlan(plan.name);
                        submit({ intent: "preview", plan: plan.name }, { method: "post" });
                      }}
                    >
                      {downgrade ? "Downgrade" : "Upgrade"} to {plan.title}
                    </s-button>
                  )}
                </s-stack>
              </s-box>
            );
          })}
        </s-grid>
      </s-section>

      <s-section slot="aside" heading="How billing works">
        <s-unordered-list>
          <s-list-item>Charges appear on your regular Shopify invoice.</s-list-item>
          <s-list-item>You approve every charge in Shopify before it applies.</s-list-item>
          <s-list-item>
            Downgrading or cancelling never deletes your rules. They are kept exactly as configured.
          </s-list-item>
          <s-list-item>
            <s-link href="/app/help">Read the full billing documentation</s-link>
          </s-list-item>
        </s-unordered-list>
      </s-section>
    </s-page>
  );
}
