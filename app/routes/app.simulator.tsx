import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useActionData, useLoaderData, useNavigation, useSubmit } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";

import prisma from "../db.server";
import { requireTenant } from "../lib/tenancy.server";
import { simulate, type SimulationOutput } from "../lib/simulator/simulator.server";
import { entitlementSnapshot } from "../lib/billing/entitlements.server";
import { toAppError } from "../lib/errors.server";
import { SUPPORTED_CUSTOMER_TAGS } from "@cartsentry/engine";
import { ErrorBanner, OutcomeBadge } from "../components/rule-ui";

interface ScenarioLine {
  productGid: string;
  productTitle: string;
  quantity: number;
  unitPrice: number;
  collectionGids: string[];
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const ctx = await requireTenant(request);
  const url = new URL(request.url);
  const ruleId = url.searchParams.get("ruleId");

  const [entitlements, rules] = await Promise.all([
    entitlementSnapshot(ctx),
    prisma.rule.findMany({
      where: { ...ctx.scope, status: { in: ["ACTIVE", "DRAFT"] } },
      select: { id: true, name: true, status: true },
      orderBy: { priority: "desc" },
    }),
  ]);

  return {
    entitlements,
    rules,
    focusRuleId: ruleId,
    currencyCode: ctx.shop.currencyCode ?? "USD",
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const ctx = await requireTenant(request);
  const form = await request.formData();

  try {
    const scenario = JSON.parse(String(form.get("scenario")));
    const ruleIdRaw = form.get("ruleId");
    const ruleIds = ruleIdRaw ? [String(ruleIdRaw)] : undefined;

    const result = await simulate(ctx, scenario, { ruleIds });
    return { ok: true as const, result };
  } catch (error) {
    const appError = toAppError(error, ctx.requestId);
    return { ok: false as const, error: appError.toPayload() };
  }
};

const STEP_TONE: Record<string, "info" | "success" | "warning" | "critical"> = {
  info: "info",
  pass: "success",
  warning: "warning",
  blocked: "critical",
};

export default function Simulator() {
  const { entitlements, rules, focusRuleId, currencyCode } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const submit = useSubmit();
  const shopify = useAppBridge();

  const [lines, setLines] = useState<ScenarioLine[]>([]);
  const [signedIn, setSignedIn] = useState(false);
  const [tags, setTags] = useState<string[]>([]);
  const [orderCount, setOrderCount] = useState(0);
  const [country, setCountry] = useState("");
  const [scopeRuleId, setScopeRuleId] = useState(focusRuleId ?? "");
  const [pickerError, setPickerError] = useState<string | null>(null);

  const running = navigation.state === "submitting";
  const outOfSimulations =
    entitlements.maxSimulationsPerMonth !== null &&
    entitlements.simulationsThisMonth >= entitlements.maxSimulationsPerMonth;

  const addProduct = async () => {
    setPickerError(null);
    try {
      const selection = await shopify.resourcePicker({ type: "product", multiple: false });
      if (!selection?.length) return;
      const product = selection[0] as {
        id: string;
        title: string;
        variants?: { price?: string }[];
      };
      setLines((current) => [
        ...current,
        {
          productGid: product.id,
          productTitle: product.title,
          quantity: 1,
          unitPrice: Number(product.variants?.[0]?.price ?? 0),
          collectionGids: [],
        },
      ]);
    } catch {
      setPickerError("The product picker could not be opened. Reload the page and try again.");
    }
  };

  const updateLine = (index: number, updates: Partial<ScenarioLine>) =>
    setLines((current) => current.map((line, i) => (i === index ? { ...line, ...updates } : line)));

  const run = () => {
    const scenario = {
      lines,
      currencyCode,
      buyer: { signedIn, tags, numberOfOrders: orderCount },
      shippingCountry: country ? country.toUpperCase() : null,
      stage: "CHECKOUT_INTERACTION",
    };
    submit(
      { scenario: JSON.stringify(scenario), ...(scopeRuleId ? { ruleId: scopeRuleId } : {}) },
      { method: "post" },
    );
  };

  const result: SimulationOutput | null = actionData?.ok ? actionData.result : null;

  return (
    <s-page heading="Simulator">
      <s-button
        slot="primary-action"
        variant="primary"
        onClick={run}
        disabled={lines.length === 0 || running || outOfSimulations}
        {...(running ? { loading: true } : {})}
      >
        Run simulation
      </s-button>

      {actionData && !actionData.ok ? (
        <s-section>
          <ErrorBanner error={actionData.error} />
        </s-section>
      ) : null}

      {pickerError ? (
        <s-section>
          <s-banner tone="critical" heading={pickerError} />
        </s-section>
      ) : null}

      {outOfSimulations ? (
        <s-section>
          <s-banner tone="warning" heading="You have used this month's simulations">
            <s-paragraph>
              Your plan includes {entitlements.maxSimulationsPerMonth} simulations per month.
              Upgrade for unlimited testing.
            </s-paragraph>
            <s-button href="/app/billing" variant="primary">
              View plans
            </s-button>
          </s-banner>
        </s-section>
      ) : null}

      <s-section heading="Test customer journey">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            Describe a cart and CartSentry evaluates your rules against it using the same logic
            that runs at checkout. This tests your CartSentry rules only — it does not simulate
            taxes, shipping, discounts, inventory, or other apps.
          </s-paragraph>

          <s-select
            label="Rules to evaluate"
            value={scopeRuleId}
            onChange={(event) => setScopeRuleId((event.target as HTMLSelectElement).value)}
          >
            <s-option value="">All active and draft rules</s-option>
            {rules.map((rule) => (
              <s-option key={rule.id} value={rule.id}>
                {rule.name} ({rule.status.toLowerCase()})
              </s-option>
            ))}
          </s-select>
        </s-stack>
      </s-section>

      <s-section heading="Cart">
        <s-stack direction="block" gap="base">
          {lines.length === 0 ? (
            <s-paragraph>Add at least one product to build a test cart.</s-paragraph>
          ) : (
            <s-table>
              <s-table-header-row>
                <s-table-header>Product</s-table-header>
                <s-table-header>Quantity</s-table-header>
                <s-table-header>Unit price</s-table-header>
                <s-table-header />
              </s-table-header-row>
              <s-table-body>
                {lines.map((line, index) => (
                  <s-table-row key={`${line.productGid}-${index}`}>
                    <s-table-cell>{line.productTitle}</s-table-cell>
                    <s-table-cell>
                      <s-number-field
                        label="Quantity"
                        labelAccessibilityVisibility="exclusive"
                        min={1}
                        value={String(line.quantity)}
                        onChange={(event) =>
                          updateLine(index, {
                            quantity: Number((event.target as HTMLInputElement).value),
                          })
                        }
                      />
                    </s-table-cell>
                    <s-table-cell>
                      <s-money-field
                        label="Unit price"
                        labelAccessibilityVisibility="exclusive"
                        value={String(line.unitPrice)}
                        onChange={(event) =>
                          updateLine(index, {
                            unitPrice: Number((event.target as HTMLInputElement).value),
                          })
                        }
                      />
                    </s-table-cell>
                    <s-table-cell>
                      <s-button
                        variant="tertiary"
                        accessibilityLabel={`Remove ${line.productTitle}`}
                        onClick={() => setLines((c) => c.filter((_, i) => i !== index))}
                      >
                        Remove
                      </s-button>
                    </s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>
          )}

          <s-button onClick={addProduct}>Add product</s-button>
        </s-stack>
      </s-section>

      <s-section heading="Customer">
        <s-stack direction="block" gap="base">
          <s-switch
            label="Signed in"
            checked={signedIn}
            details="Guests have no tags and no order history."
            onChange={(event) => setSignedIn((event.target as HTMLInputElement).checked)}
          />

          {signedIn ? (
            <>
              <s-stack direction="block" gap="small-400">
                <s-text type="strong">Customer tags</s-text>
                <s-stack direction="inline" gap="small-400">
                  {SUPPORTED_CUSTOMER_TAGS.map((tag) => (
                    <s-checkbox
                      key={tag}
                      label={tag}
                      checked={tags.includes(tag)}
                      onChange={(event) =>
                        setTags((current) =>
                          (event.target as HTMLInputElement).checked
                            ? [...current, tag]
                            : current.filter((t) => t !== tag),
                        )
                      }
                    />
                  ))}
                </s-stack>
              </s-stack>

              <s-number-field
                label="Previous orders"
                min={0}
                value={String(orderCount)}
                onChange={(event) =>
                  setOrderCount(Number((event.target as HTMLInputElement).value))
                }
              />
            </>
          ) : null}

          <s-text-field
            label="Delivery country code"
            value={country}
            details="Two-letter code, e.g. US. Leave empty to simulate a customer who has not entered an address yet."
            onChange={(event) => setCountry((event.target as HTMLInputElement).value)}
          />
        </s-stack>
      </s-section>

      {result ? (
        <>
          <s-section heading="Result">
            <s-stack direction="block" gap="base">
              <s-stack direction="inline" gap="base" alignItems="center">
                <OutcomeBadge outcome={result.outcome} />
                <s-text>
                  Subtotal {result.subtotal.toFixed(2)} {result.currencyCode} ·{" "}
                  {result.evaluatedRuleCount} rule
                  {result.evaluatedRuleCount === 1 ? "" : "s"} evaluated
                </s-text>
              </s-stack>

              {result.blockingMessages.map((message) => (
                <s-banner key={message} tone="critical" heading="Customer is blocked">
                  <s-paragraph>{message}</s-paragraph>
                </s-banner>
              ))}
              {result.warningMessages.map((message) => (
                <s-banner key={message} tone="warning" heading="Customer sees a warning">
                  <s-paragraph>{message}</s-paragraph>
                </s-banner>
              ))}
            </s-stack>
          </s-section>

          <s-section heading="Customer journey">
            <s-stack direction="block" gap="small-300">
              {result.timeline.map((step, index) => (
                <s-box
                  key={`${step.label}-${index}`}
                  padding="base"
                  borderWidth="base"
                  borderRadius="base"
                >
                  <s-stack direction="inline" gap="base" alignItems="center">
                    <s-badge tone={STEP_TONE[step.status]}>{step.status}</s-badge>
                    <s-stack direction="block" gap="small-500">
                      <s-text type="strong">{step.label}</s-text>
                      <s-text color="subdued">{step.detail}</s-text>
                    </s-stack>
                  </s-stack>
                </s-box>
              ))}
            </s-stack>
          </s-section>

          <s-section heading="Why?">
            <s-stack direction="block" gap="base">
              {result.rules.map((rule) => (
                <s-box key={rule.ruleId} padding="base" borderWidth="base" borderRadius="base">
                  <s-stack direction="block" gap="small-300">
                    <s-stack direction="inline" gap="base" alignItems="center">
                      <OutcomeBadge outcome={rule.status} />
                      <s-text type="strong">{rule.ruleName}</s-text>
                    </s-stack>
                    <s-paragraph>{rule.explanation}</s-paragraph>

                    <s-table>
                      <s-table-header-row>
                        <s-table-header>Condition</s-table-header>
                        <s-table-header>Expected</s-table-header>
                        <s-table-header>Actual</s-table-header>
                      </s-table-header-row>
                      <s-table-body>
                        {rule.conditions.map((condition, index) => (
                          <s-table-row key={index}>
                            <s-table-cell>
                              <s-stack direction="block" gap="small-500">
                                <s-text>{condition.description}</s-text>
                                <s-text color="subdued">{condition.explanation}</s-text>
                              </s-stack>
                            </s-table-cell>
                            <s-table-cell>{condition.expected}</s-table-cell>
                            <s-table-cell>{condition.actual}</s-table-cell>
                          </s-table-row>
                        ))}
                      </s-table-body>
                    </s-table>

                    {rule.suggestedFix ? (
                      <s-banner tone="info" heading="Recommended fix">
                        <s-paragraph>{rule.suggestedFix}</s-paragraph>
                        <s-button href={`/app/rules/${rule.ruleId}`}>Edit this rule</s-button>
                      </s-banner>
                    ) : null}
                  </s-stack>
                </s-box>
              ))}
            </s-stack>
          </s-section>
        </>
      ) : null}
    </s-page>
  );
}
