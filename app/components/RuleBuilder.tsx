/**
 * The visual, no-code rule builder.
 *
 * Conditions are rendered from a data-driven registry rather than a switch per
 * rule type, so adding a condition kind is a change in one table and not a new
 * branch in the UI (see CONDITION_SPECS).
 *
 * Resource selection uses App Bridge's official picker rather than a bespoke
 * product search.
 */

import { useCallback, useMemo, useState } from "react";
import { useAppBridge } from "@shopify/app-bridge-react";

import {
  OPERATOR_LABELS,
  SUPPORTED_CUSTOMER_TAGS,
  explainRule,
  rulePreviewLines,
  type Condition,
  type RuleDefinition,
  type ResourceRef,
} from "@cartsentry/engine";
import { RulePreview } from "./rule-ui";

export interface RuleFormValue {
  name: string;
  description: string;
  message: string;
  priority: number;
  definition: RuleDefinition;
  warningConfig: {
    enabled: boolean;
    title: string;
    message: string;
    severity: "info" | "warning" | "critical";
    showOnProduct: boolean;
    showInCart: boolean;
    icon: "none" | "alert" | "info" | "lock";
  };
}

type ConditionKind = Condition["kind"];

interface ConditionSpec {
  kind: ConditionKind;
  label: string;
  /** Which resource picker, if any, this condition needs. */
  resource: "product" | "collection" | null;
  /** Operators offered for this condition. */
  operators: readonly string[];
  /** Shape of the value input. */
  value: "integer" | "money" | "boolean" | "tag" | "country-list" | "currency-list" | "none";
  hint?: string;
}

const NUMERIC_OPERATORS = ["gt", "gte", "lt", "lte", "eq", "neq"] as const;

const CONDITION_SPECS: ConditionSpec[] = [
  {
    kind: "product_quantity",
    label: "Quantity of a product",
    resource: "product",
    operators: NUMERIC_OPERATORS,
    value: "integer",
    hint: "Counts every variant of the product unless you pick one.",
  },
  {
    kind: "cart_quantity",
    label: "Total items in the cart",
    resource: null,
    operators: NUMERIC_OPERATORS,
    value: "integer",
  },
  {
    kind: "cart_subtotal",
    label: "Cart subtotal",
    resource: null,
    operators: NUMERIC_OPERATORS,
    value: "money",
    hint: "Compared before tax and shipping.",
  },
  {
    kind: "collection_quantity",
    label: "Quantity from a collection",
    resource: "collection",
    operators: NUMERIC_OPERATORS,
    value: "integer",
  },
  {
    kind: "product_present",
    label: "A product is / is not in the cart",
    resource: "product",
    operators: [],
    value: "boolean",
  },
  {
    kind: "collection_present",
    label: "An item from a collection is / is not in the cart",
    resource: "collection",
    operators: [],
    value: "boolean",
  },
  {
    kind: "customer_tag",
    label: "Customer tag",
    resource: null,
    operators: ["contains", "not_contains"],
    value: "tag",
    hint: "Only these tags can be enforced by Shopify Functions. See Help for why.",
  },
  {
    kind: "customer_signed_in",
    label: "Customer is signed in",
    resource: null,
    operators: [],
    value: "boolean",
  },
  {
    kind: "customer_order_count",
    label: "Customer's previous order count",
    resource: null,
    operators: NUMERIC_OPERATORS,
    value: "integer",
    hint: "Guests count as 0 previous orders.",
  },
  {
    kind: "shipping_country",
    label: "Delivery country",
    resource: null,
    operators: ["in", "not_in"],
    value: "country-list",
    hint: "Only checked once the customer has entered a delivery address.",
  },
  {
    kind: "currency",
    label: "Cart currency",
    resource: null,
    operators: ["in", "not_in"],
    value: "currency-list",
  },
];

function specFor(kind: ConditionKind): ConditionSpec {
  return CONDITION_SPECS.find((s) => s.kind === kind)!;
}

const EMPTY_REF: ResourceRef = { gid: "", title: "", missing: false };

function defaultCondition(kind: ConditionKind, currencyCode: string): Condition {
  switch (kind) {
    case "product_quantity":
      return { kind, product: EMPTY_REF, operator: "gt", value: 5 };
    case "cart_quantity":
      return { kind, operator: "gt", value: 10 };
    case "cart_subtotal":
      return { kind, operator: "lt", value: 50, currencyCode };
    case "collection_quantity":
      return { kind, collection: EMPTY_REF, operator: "gt", value: 3 };
    case "product_present":
      return { kind, product: EMPTY_REF, present: true };
    case "collection_present":
      return { kind, collection: EMPTY_REF, present: true };
    case "customer_tag":
      return { kind, operator: "contains", value: "wholesale" };
    case "customer_signed_in":
      return { kind, value: true };
    case "customer_order_count":
      return { kind, operator: "eq", value: 0 };
    case "shipping_country":
      return { kind, operator: "in", value: ["US"] };
    case "currency":
      return { kind, operator: "in", value: ["USD"] };
  }
}

export function RuleBuilder({
  value,
  onChange,
  currencyCode,
  warningsAllowed,
}: {
  value: RuleFormValue;
  onChange: (next: RuleFormValue) => void;
  currencyCode: string;
  warningsAllowed: boolean;
}) {
  const shopify = useAppBridge();
  const [pickerError, setPickerError] = useState<string | null>(null);

  const definition = value.definition;

  const patch = useCallback(
    (updates: Partial<RuleFormValue>) => onChange({ ...value, ...updates }),
    [onChange, value],
  );

  const patchDefinition = useCallback(
    (updates: Partial<RuleDefinition>) =>
      patch({ definition: { ...definition, ...updates } }),
    [patch, definition],
  );

  const updateCondition = useCallback(
    (index: number, next: Condition) => {
      const conditions = [...definition.conditions];
      conditions[index] = next;
      patchDefinition({ conditions });
    },
    [definition.conditions, patchDefinition],
  );

  const removeCondition = (index: number) => {
    if (definition.conditions.length === 1) return;
    patchDefinition({ conditions: definition.conditions.filter((_, i) => i !== index) });
  };

  const addCondition = () => {
    if (definition.conditions.length >= 10) return;
    patchDefinition({
      conditions: [...definition.conditions, defaultCondition("cart_quantity", currencyCode)],
    });
  };

  /** Open Shopify's own resource picker rather than rolling our own search. */
  const pickResource = useCallback(
    async (index: number, type: "product" | "collection") => {
      setPickerError(null);
      try {
        const selection = await shopify.resourcePicker({
          type,
          multiple: false,
          action: "select",
        });
        if (!selection || selection.length === 0) return;

        const picked = selection[0] as { id: string; title: string };
        const condition = definition.conditions[index]!;
        const ref: ResourceRef = { gid: picked.id, title: picked.title, missing: false };

        updateCondition(
          index,
          type === "product"
            ? ({ ...condition, product: ref } as Condition)
            : ({ ...condition, collection: ref } as Condition),
        );
      } catch {
        setPickerError(
          "The product picker could not be opened. Reload the page and try again.",
        );
      }
    },
    [shopify, definition.conditions, updateCondition],
  );

  const preview = useMemo(() => rulePreviewLines(definition), [definition]);
  const summary = useMemo(() => explainRule(definition), [definition]);

  const conditionComplete = (condition: Condition): boolean => {
    if ("product" in condition && condition.product && !condition.product.gid) return false;
    if ("collection" in condition && condition.collection && !condition.collection.gid) return false;
    return true;
  };

  return (
    <s-stack direction="block" gap="large-100">
      {pickerError ? <s-banner tone="critical" heading={pickerError} /> : null}

      <s-section heading="Rule details">
        <s-stack direction="block" gap="base">
          <s-text-field
            label="Rule name"
            name="name"
            value={value.name}
            required
            onChange={(event) =>
              patch({ name: (event.target as HTMLInputElement).value })
            }
          />
          <s-text-area
            label="Description"
            name="description"
            details="For your team. Customers never see this."
            value={value.description}
            onChange={(event) =>
              patch({ description: (event.target as HTMLTextAreaElement).value })
            }
          />
          <s-number-field
            label="Priority"
            name="priority"
            min={0}
            max={100}
            value={String(value.priority)}
            details="Higher priority rules are evaluated first and their message is shown first. 50 is normal."
            onChange={(event) =>
              patch({ priority: Number((event.target as HTMLInputElement).value) })
            }
          />
        </s-stack>
      </s-section>

      <s-section heading="When">
        <s-stack direction="block" gap="base">
          <s-stack direction="inline" gap="base" alignItems="end">
            <s-select
              label="Match"
              value={definition.logic}
              onChange={(event) =>
                patchDefinition({
                  logic: (event.target as HTMLSelectElement).value as "AND" | "OR",
                })
              }
            >
              <s-option value="AND">All of these conditions</s-option>
              <s-option value="OR">Any of these conditions</s-option>
            </s-select>
            <s-switch
              label="Invert (NOT)"
              checked={definition.negate}
              details="The rule fires when the conditions above are NOT met."
              onChange={(event) =>
                patchDefinition({ negate: (event.target as HTMLInputElement).checked })
              }
            />
          </s-stack>

          {definition.conditions.map((condition, index) => {
            const spec = specFor(condition.kind);
            const incomplete = !conditionComplete(condition);

            return (
              <s-box
                key={index}
                padding="base"
                borderWidth="base"
                borderRadius="base"
                background={incomplete ? "subdued" : undefined}
              >
                <s-stack direction="block" gap="small-200">
                  <s-stack direction="inline" gap="base" alignItems="center">
                    <s-select
                      label={index === 0 ? "Condition" : `${definition.logic} condition`}
                      value={condition.kind}
                      onChange={(event) =>
                        updateCondition(
                          index,
                          defaultCondition(
                            (event.target as HTMLSelectElement).value as ConditionKind,
                            currencyCode,
                          ),
                        )
                      }
                    >
                      {CONDITION_SPECS.map((option) => (
                        <s-option key={option.kind} value={option.kind}>
                          {option.label}
                        </s-option>
                      ))}
                    </s-select>

                    {definition.conditions.length > 1 ? (
                      <s-button
                        variant="tertiary"
                        accessibilityLabel={`Remove condition ${index + 1}`}
                        onClick={() => removeCondition(index)}
                      >
                        Remove
                      </s-button>
                    ) : null}
                  </s-stack>

                  {spec.resource ? (
                    <ResourceField
                      type={spec.resource}
                      reference={
                        spec.resource === "product"
                          ? (condition as { product?: ResourceRef }).product
                          : (condition as { collection?: ResourceRef }).collection
                      }
                      onPick={() => pickResource(index, spec.resource!)}
                    />
                  ) : null}

                  <ConditionValueFields
                    spec={spec}
                    condition={condition}
                    currencyCode={currencyCode}
                    onChange={(next) => updateCondition(index, next)}
                  />

                  {spec.hint ? <s-text color="subdued">{spec.hint}</s-text> : null}
                </s-stack>
              </s-box>
            );
          })}

          <s-button onClick={addCondition} disabled={definition.conditions.length >= 10}>
            Add condition
          </s-button>
        </s-stack>
      </s-section>

      <s-section heading="Then">
        <s-stack direction="block" gap="base">
          <s-select
            label="Action"
            value={definition.action.type}
            onChange={(event) =>
              patchDefinition({
                action: {
                  type: (event.target as HTMLSelectElement).value as "WARN" | "BLOCK",
                },
              })
            }
          >
            <s-option value="BLOCK">Block the purchase</s-option>
            <s-option value="WARN">Warn the customer only</s-option>
          </s-select>

          <s-text-area
            label="Message customers see"
            name="message"
            required
            value={value.message}
            details="Shown in the cart and at checkout, exactly as written. Plain text, up to 255 characters."
            onChange={(event) =>
              patch({ message: (event.target as HTMLTextAreaElement).value })
            }
          />
        </s-stack>
      </s-section>

      <s-section heading="Storefront warning">
        {warningsAllowed ? (
          <s-stack direction="block" gap="base">
            <s-paragraph>
              Tell customers in the cart, before they reach checkout. Requires the CartSentry app
              block to be added to your theme — see Help.
            </s-paragraph>
            <s-switch
              label="Show an early warning on the storefront"
              checked={value.warningConfig.enabled}
              onChange={(event) =>
                patch({
                  warningConfig: {
                    ...value.warningConfig,
                    enabled: (event.target as HTMLInputElement).checked,
                  },
                })
              }
            />
            {value.warningConfig.enabled ? (
              <>
                <s-text-field
                  label="Warning title"
                  value={value.warningConfig.title}
                  onChange={(event) =>
                    patch({
                      warningConfig: {
                        ...value.warningConfig,
                        title: (event.target as HTMLInputElement).value,
                      },
                    })
                  }
                />
                <s-text-area
                  label="Warning message"
                  details="Leave empty to reuse the customer message above."
                  value={value.warningConfig.message}
                  onChange={(event) =>
                    patch({
                      warningConfig: {
                        ...value.warningConfig,
                        message: (event.target as HTMLTextAreaElement).value,
                      },
                    })
                  }
                />
                <s-stack direction="inline" gap="base">
                  <s-switch
                    label="Show on product pages"
                    checked={value.warningConfig.showOnProduct}
                    onChange={(event) =>
                      patch({
                        warningConfig: {
                          ...value.warningConfig,
                          showOnProduct: (event.target as HTMLInputElement).checked,
                        },
                      })
                    }
                  />
                  <s-switch
                    label="Show in the cart"
                    checked={value.warningConfig.showInCart}
                    onChange={(event) =>
                      patch({
                        warningConfig: {
                          ...value.warningConfig,
                          showInCart: (event.target as HTMLInputElement).checked,
                        },
                      })
                    }
                  />
                </s-stack>
              </>
            ) : null}
          </s-stack>
        ) : (
          <s-banner tone="info" heading="Storefront warnings are available on Starter and above">
            <s-paragraph>
              Your rule will still be enforced at checkout. Upgrading adds an earlier warning in the
              cart.
            </s-paragraph>
            <s-button href="/app/billing">View plans</s-button>
          </s-banner>
        )}
      </s-section>

      <s-section slot="aside" heading="Rule preview">
        <s-stack direction="block" gap="base">
          <RulePreview
            when={preview.when}
            logic={preview.logic}
            negate={preview.negate}
            then={preview.then}
            message={value.message || "(no message yet)"}
          />
          <s-paragraph>{summary}</s-paragraph>
        </s-stack>
      </s-section>
    </s-stack>
  );
}

function ResourceField({
  type,
  reference,
  onPick,
}: {
  type: "product" | "collection";
  reference?: ResourceRef;
  onPick: () => void;
}) {
  const label = type === "product" ? "Product" : "Collection";

  return (
    <s-stack direction="block" gap="small-500">
      <s-text type="strong">{label}</s-text>
      <s-stack direction="inline" gap="base" alignItems="center">
        {reference?.gid ? (
          <s-text>{reference.title || reference.gid}</s-text>
        ) : (
          <s-text color="subdued">No {label.toLowerCase()} selected yet</s-text>
        )}
        <s-button onClick={onPick}>
          {reference?.gid ? `Change ${label.toLowerCase()}` : `Select ${label.toLowerCase()}`}
        </s-button>
      </s-stack>
      {reference?.missing ? (
        <s-text tone="critical">
          This {label.toLowerCase()} no longer exists in your store. Select another one.
        </s-text>
      ) : null}
    </s-stack>
  );
}

function ConditionValueFields({
  spec,
  condition,
  currencyCode,
  onChange,
}: {
  spec: ConditionSpec;
  condition: Condition;
  currencyCode: string;
  onChange: (next: Condition) => void;
}) {
  const set = (updates: Record<string, unknown>) =>
    onChange({ ...condition, ...updates } as Condition);

  const operatorSelect =
    spec.operators.length > 0 ? (
      <s-select
        label="Is"
        value={(condition as { operator?: string }).operator ?? ""}
        onChange={(event) => set({ operator: (event.target as HTMLSelectElement).value })}
      >
        {spec.operators.map((operator) => (
          <s-option key={operator} value={operator}>
            {OPERATOR_LABELS[operator as keyof typeof OPERATOR_LABELS] ?? operator}
          </s-option>
        ))}
      </s-select>
    ) : null;

  switch (spec.value) {
    case "integer":
      return (
        <s-stack direction="inline" gap="base" alignItems="end">
          {operatorSelect}
          <s-number-field
            label="Value"
            min={0}
            value={String((condition as { value?: number }).value ?? 0)}
            onChange={(event) => set({ value: Number((event.target as HTMLInputElement).value) })}
          />
        </s-stack>
      );

    case "money":
      return (
        <s-stack direction="inline" gap="base" alignItems="end">
          {operatorSelect}
          <s-money-field
            label={`Amount (${currencyCode})`}
            value={String((condition as { value?: number }).value ?? 0)}
            onChange={(event) => set({ value: Number((event.target as HTMLInputElement).value) })}
          />
        </s-stack>
      );

    case "boolean": {
      const isPresence = "present" in condition;
      const current = isPresence
        ? (condition as { present: boolean }).present
        : (condition as { value: boolean }).value;

      return (
        <s-select
          label="Is"
          value={String(current)}
          onChange={(event) => {
            const next = (event.target as HTMLSelectElement).value === "true";
            set(isPresence ? { present: next } : { value: next });
          }}
        >
          <s-option value="true">{isPresence ? "In the cart" : "Yes"}</s-option>
          <s-option value="false">{isPresence ? "Not in the cart" : "No"}</s-option>
        </s-select>
      );
    }

    case "tag":
      return (
        <s-stack direction="inline" gap="base" alignItems="end">
          {operatorSelect}
          <s-select
            label="Tag"
            value={String((condition as { value?: string }).value ?? "")}
            onChange={(event) => set({ value: (event.target as HTMLSelectElement).value })}
          >
            {SUPPORTED_CUSTOMER_TAGS.map((tag) => (
              <s-option key={tag} value={tag}>
                {tag}
              </s-option>
            ))}
          </s-select>
        </s-stack>
      );

    case "country-list":
    case "currency-list": {
      const values = ((condition as { value?: string[] }).value ?? []).join(", ");
      const isCountry = spec.value === "country-list";

      return (
        <s-stack direction="inline" gap="base" alignItems="end">
          {operatorSelect}
          <s-text-field
            label={isCountry ? "Country codes" : "Currency codes"}
            value={values}
            details={
              isCountry
                ? "Two-letter codes, comma separated. For example: US, CA, GB"
                : "Three-letter codes, comma separated. For example: USD, EUR"
            }
            onChange={(event) =>
              set({
                value: (event.target as HTMLInputElement).value
                  .split(",")
                  .map((code) => code.trim().toUpperCase())
                  .filter(Boolean),
              })
            }
          />
        </s-stack>
      );
    }

    default:
      return null;
  }
}
