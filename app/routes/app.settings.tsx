import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useActionData, useLoaderData, useNavigation, useSubmit } from "react-router";
import { useState } from "react";
import { z } from "zod";

import prisma from "../db.server";
import { requireTenant } from "../lib/tenancy.server";
import { publishRules, rollbackTo } from "../lib/shopify/validation.server";
import { revalidateRuleResources } from "../lib/shopify/resources.server";
import { recordActivity } from "../lib/activity.server";
import { aiIsConfigured, config } from "../lib/config.server";
import { AppError, toAppError } from "../lib/errors.server";
import { ErrorBanner } from "../components/rule-ui";

const SettingsSchema = z.object({
  notifyOnConflict: z.boolean(),
  notifyOnFunctionError: z.boolean(),
  notifyOnRuleError: z.boolean(),
  defaultWarningSeverity: z.enum(["info", "warning", "critical"]),
});

type Settings = z.infer<typeof SettingsSchema>;

const DEFAULT_SETTINGS: Settings = {
  notifyOnConflict: true,
  notifyOnFunctionError: true,
  notifyOnRuleError: true,
  defaultWarningSeverity: "warning",
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const ctx = await requireTenant(request);

  const configurations = await prisma.functionConfiguration.findMany({
    where: ctx.scope,
    orderBy: { version: "desc" },
    take: 10,
  });

  return {
    shopDomain: ctx.shopDomain,
    shopName: ctx.shop.name,
    currencyCode: ctx.shop.currencyCode,
    timezone: ctx.shop.timezone,
    planTitle: ctx.plan.title,
    retentionDays: ctx.plan.limits.historyRetentionDays,
    settings: { ...DEFAULT_SETTINGS, ...(ctx.shop.settings as object) } as Settings,
    aiConfigured: aiIsConfigured(),
    aiProvider: config.ai.provider,
    aiModel: config.ai.model,
    configurations: configurations.map((configuration) => ({
      version: configuration.version,
      status: configuration.status,
      byteSize: configuration.byteSize,
      publishedAt: configuration.publishedAt?.toISOString() ?? null,
      error: configuration.error,
    })),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const ctx = await requireTenant(request);
  const form = await request.formData();
  const intent = String(form.get("intent"));

  try {
    if (intent === "saveSettings") {
      const parsed = SettingsSchema.safeParse(JSON.parse(String(form.get("settings"))));
      if (!parsed.success) throw new AppError("VALIDATION");

      await prisma.shop.update({
        where: { id: ctx.shopId },
        data: { settings: parsed.data as object },
      });
      await recordActivity(ctx, {
        eventType: "SETTINGS_CHANGED",
        summary: "Updated app settings.",
      });
      return { ok: true as const, message: "Settings saved." };
    }

    if (intent === "republish") {
      const outcome = await publishRules(ctx);
      return {
        ok: true as const,
        message:
          outcome.status === "UNCHANGED"
            ? "Your rules were already up to date on Shopify."
            : `Published configuration v${outcome.version}.`,
        warnings: outcome.warnings,
      };
    }

    if (intent === "revalidate") {
      const result = await revalidateRuleResources(ctx);
      return {
        ok: true as const,
        message: `Checked all rule references. ${result.flagged} newly flagged, ${result.cleared} cleared.`,
      };
    }

    if (intent === "rollback") {
      await rollbackTo(ctx, Number(form.get("version")));
      return { ok: true as const, message: "Rolled back to the selected configuration." };
    }

    return { ok: false as const, error: { code: "VALIDATION", message: "Unknown action." } };
  } catch (error) {
    const appError = toAppError(error, ctx.requestId);
    return { ok: false as const, error: appError.toPayload() };
  }
};

export default function SettingsPage() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const submit = useSubmit();

  const [settings, setSettings] = useState<Settings>(data.settings);
  const busy = navigation.state !== "idle";

  const patch = (updates: Partial<Settings>) => setSettings((c) => ({ ...c, ...updates }));

  return (
    <s-page heading="Settings">
      <s-button
        slot="primary-action"
        variant="primary"
        disabled={busy}
        onClick={() =>
          submit({ intent: "saveSettings", settings: JSON.stringify(settings) }, { method: "post" })
        }
      >
        Save settings
      </s-button>

      {actionData && !actionData.ok ? (
        <s-section>
          <ErrorBanner error={actionData.error} />
        </s-section>
      ) : null}

      {actionData?.ok ? (
        <s-section>
          <s-banner tone="success" heading={actionData.message}>
            {"warnings" in actionData && actionData.warnings?.length ? (
              <s-unordered-list>
                {actionData.warnings.map((warning) => (
                  <s-list-item key={warning}>{warning}</s-list-item>
                ))}
              </s-unordered-list>
            ) : null}
          </s-banner>
        </s-section>
      ) : null}

      <s-section heading="General">
        <s-stack direction="block" gap="small-300">
          <s-text>
            Store: <s-text type="strong">{data.shopName ?? data.shopDomain}</s-text>
          </s-text>
          <s-text color="subdued">Domain: {data.shopDomain}</s-text>
          <s-text color="subdued">Currency: {data.currencyCode ?? "Not synced yet"}</s-text>
          <s-text color="subdued">Timezone: {data.timezone ?? "Not synced yet"}</s-text>
          <s-text color="subdued">Plan: {data.planTitle}</s-text>
        </s-stack>
      </s-section>

      <s-section heading="Notifications">
        <s-stack direction="block" gap="base">
          <s-switch
            label="Alert me about critical rule conflicts"
            checked={settings.notifyOnConflict}
            onChange={(event) =>
              patch({ notifyOnConflict: (event.target as HTMLInputElement).checked })
            }
          />
          <s-switch
            label="Alert me when rules fail to publish to Shopify"
            checked={settings.notifyOnFunctionError}
            onChange={(event) =>
              patch({ notifyOnFunctionError: (event.target as HTMLInputElement).checked })
            }
          />
          <s-switch
            label="Alert me when a rule references a deleted product"
            checked={settings.notifyOnRuleError}
            onChange={(event) =>
              patch({ notifyOnRuleError: (event.target as HTMLInputElement).checked })
            }
          />
        </s-stack>
      </s-section>

      <s-section heading="Warnings">
        <s-select
          label="Default warning style for new rules"
          value={settings.defaultWarningSeverity}
          onChange={(event) =>
            patch({
              defaultWarningSeverity: (event.target as HTMLSelectElement)
                .value as Settings["defaultWarningSeverity"],
            })
          }
        >
          <s-option value="info">Informational</s-option>
          <s-option value="warning">Warning</s-option>
          <s-option value="critical">Critical</s-option>
        </s-select>
      </s-section>

      <s-section heading="AI">
        {data.aiConfigured ? (
          <s-stack direction="block" gap="small-300">
            <s-text>
              Provider: <s-text type="strong">{data.aiProvider}</s-text> ({data.aiModel})
            </s-text>
            <s-text color="subdued">
              Configured by this app&rsquo;s operator. The AI only drafts rules for your review — it never
              activates anything and never has access to your customer data.
            </s-text>
          </s-stack>
        ) : (
          <s-paragraph>
            No AI provider is configured. Every rule type can still be built with the manual rule
            builder.
          </s-paragraph>
        )}
      </s-section>

      <s-section heading="Data">
        <s-stack direction="block" gap="small-300">
          <s-paragraph>
            CartSentry stores your rules, simulations and activity log. It does not store customer
            names, email addresses, or order contents.
          </s-paragraph>
          <s-text color="subdued">
            Activity and analytics history is kept for {data.retentionDays} days on your plan.
          </s-text>
          <s-text color="subdued">
            Uninstalling the app deletes all of this store&rsquo;s data. See Help for details.
          </s-text>
        </s-stack>
      </s-section>

      <s-section heading="Advanced">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            Your active rules are compiled into a configuration and published to Shopify. If
            something looks out of sync, republish or re-check your rule references.
          </s-paragraph>

          <s-stack direction="inline" gap="base">
            <s-button
              disabled={busy}
              onClick={() => submit({ intent: "republish" }, { method: "post" })}
            >
              Republish rules to Shopify
            </s-button>
            <s-button
              disabled={busy}
              onClick={() => submit({ intent: "revalidate" }, { method: "post" })}
            >
              Re-check rule references
            </s-button>
          </s-stack>

          {data.configurations.length > 0 ? (
            <s-table>
              <s-table-header-row>
                <s-table-header>Version</s-table-header>
                <s-table-header>Status</s-table-header>
                <s-table-header>Size</s-table-header>
                <s-table-header>Published</s-table-header>
                <s-table-header />
              </s-table-header-row>
              <s-table-body>
                {data.configurations.map((configuration) => (
                  <s-table-row key={configuration.version}>
                    <s-table-cell>v{configuration.version}</s-table-cell>
                    <s-table-cell>
                      <s-badge
                        tone={
                          configuration.status === "PUBLISHED"
                            ? "success"
                            : configuration.status === "FAILED"
                              ? "critical"
                              : "neutral"
                        }
                      >
                        {configuration.status.toLowerCase()}
                      </s-badge>
                    </s-table-cell>
                    <s-table-cell>{configuration.byteSize} bytes</s-table-cell>
                    <s-table-cell>
                      {configuration.publishedAt
                        ? new Date(configuration.publishedAt).toLocaleString()
                        : "—"}
                    </s-table-cell>
                    <s-table-cell>
                      {configuration.status === "PUBLISHED" ? (
                        <s-button
                          variant="tertiary"
                          disabled={busy}
                          onClick={() =>
                            submit(
                              { intent: "rollback", version: String(configuration.version) },
                              { method: "post" },
                            )
                          }
                        >
                          Roll back to this
                        </s-button>
                      ) : configuration.error ? (
                        <s-text tone="critical">{configuration.error.slice(0, 120)}</s-text>
                      ) : null}
                    </s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>
          ) : null}
        </s-stack>
      </s-section>
    </s-page>
  );
}
