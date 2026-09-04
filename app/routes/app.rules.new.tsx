import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { redirect, useActionData, useLoaderData, useNavigation, useSubmit } from "react-router";

import { requireTenant } from "../lib/tenancy.server";
import { createRule } from "../lib/rules/rules.server";
import { templateById } from "../lib/rules/templates";
import { toAppError } from "../lib/errors.server";
import { entitlementSnapshot } from "../lib/billing/entitlements.server";
import { RuleBuilder, type RuleFormValue } from "../components/RuleBuilder";
import { ErrorBanner } from "../components/rule-ui";
import type { RuleDefinition } from "@cartsentry/engine";

function blankRule(currencyCode: string): RuleFormValue {
  return {
    name: "",
    description: "",
    message: "",
    priority: 50,
    definition: {
      schemaVersion: 1,
      logic: "AND",
      negate: false,
      conditions: [
        { kind: "cart_subtotal", operator: "lt", value: 50, currencyCode },
      ],
      action: { type: "BLOCK" },
    } as RuleDefinition,
    warningConfig: {
      enabled: false,
      title: "",
      message: "",
      severity: "warning",
      showOnProduct: true,
      showInCart: true,
      icon: "alert",
    },
  };
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const ctx = await requireTenant(request);
  const url = new URL(request.url);
  const currencyCode = ctx.shop.currencyCode ?? "USD";

  const templateId = url.searchParams.get("template");
  const template = templateId ? templateById(templateId) : undefined;

  const initial: RuleFormValue = template
    ? {
        ...blankRule(currencyCode),
        ...template.build(),
        warningConfig: blankRule(currencyCode).warningConfig,
      }
    : blankRule(currencyCode);

  const entitlements = await entitlementSnapshot(ctx);

  return {
    initial,
    currencyCode,
    warningsAllowed: ctx.plan.capabilities.canUseWarnings,
    entitlements,
    templateTitle: template?.title ?? null,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const ctx = await requireTenant(request);
  const form = await request.formData();

  try {
    const payload = JSON.parse(String(form.get("payload")));
    const rule = await createRule(ctx, payload);
    // New rules are always drafts; send the merchant to the rule page to test
    // and activate, rather than activating behind their back.
    return redirect(`/app/rules/${rule.id}?created=1`);
  } catch (error) {
    const appError = toAppError(error, ctx.requestId);
    return { ok: false as const, error: appError.toPayload() };
  }
};

export default function NewRule() {
  const { initial, currencyCode, warningsAllowed, entitlements, templateTitle } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const submit = useSubmit();

  const [value, setValue] = useState<RuleFormValue>(initial);
  const saving = navigation.state === "submitting";

  const save = () => submit({ payload: JSON.stringify(value) }, { method: "post" });

  const canSave = value.name.trim().length > 0 && value.message.trim().length > 0;

  return (
    <s-page heading={templateTitle ? `New rule — ${templateTitle}` : "New rule"}>
      <s-button
        slot="primary-action"
        variant="primary"
        onClick={save}
        disabled={!canSave || saving}
        {...(saving ? { loading: true } : {})}
      >
        Save as draft
      </s-button>
      <s-button slot="secondary-actions" href="/app/rules" variant="tertiary">
        Cancel
      </s-button>

      {actionData && !actionData.ok ? (
        <s-section>
          <ErrorBanner error={actionData.error} />
        </s-section>
      ) : null}

      <s-section>
        <s-banner tone="info" heading="New rules are saved as drafts">
          <s-paragraph>
            Nothing changes for your customers until you activate the rule. You will be able to
            test it against a sample cart first.
          </s-paragraph>
        </s-banner>
      </s-section>

      {entitlements.activeRules >= entitlements.maxActiveRules ? (
        <s-section>
          <s-banner tone="warning" heading="You have reached your active rule limit">
            <s-paragraph>
              You can save this draft, but you will need to disable another rule or upgrade before
              you can activate it.
            </s-paragraph>
          </s-banner>
        </s-section>
      ) : null}

      <RuleBuilder
        value={value}
        onChange={setValue}
        currencyCode={currencyCode}
        warningsAllowed={warningsAllowed}
      />
    </s-page>
  );
}
