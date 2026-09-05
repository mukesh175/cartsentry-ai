/**
 * Small presentational pieces shared across the rule screens.
 *
 * Status is never communicated by colour alone — every badge carries a word —
 * so the UI stays readable for colour-blind merchants and in high-contrast
 * modes (see docs/ARCHITECTURE.md, accessibility).
 */

import type { ReactNode } from "react";
import { t } from "../lib/i18n";

type Tone = "info" | "success" | "warning" | "critical" | "neutral";

const STATUS_TONE: Record<string, Tone> = {
  ACTIVE: "success",
  DRAFT: "info",
  DISABLED: "neutral",
  ARCHIVED: "neutral",
  ERROR: "critical",
  NEEDS_ATTENTION: "warning",
};

export function RuleStatusBadge({ status }: { status: string }) {
  return (
    <s-badge tone={STATUS_TONE[status] ?? "neutral"}>{t(`rule.status.${status}`)}</s-badge>
  );
}

const SEVERITY_TONE: Record<string, Tone> = {
  CRITICAL: "critical",
  HIGH: "critical",
  MEDIUM: "warning",
  LOW: "info",
  INFO: "neutral",
};

export function SeverityBadge({ severity }: { severity: string }) {
  return <s-badge tone={SEVERITY_TONE[severity] ?? "neutral"}>{t(`conflict.severity.${severity}`)}</s-badge>;
}

const OUTCOME_TONE: Record<string, Tone> = {
  PASS: "success",
  WARNING: "warning",
  BLOCKED: "critical",
  NOT_APPLICABLE: "neutral",
  DEFERRED: "info",
};

export function OutcomeBadge({ outcome }: { outcome: string }) {
  return <s-badge tone={OUTCOME_TONE[outcome] ?? "neutral"}>{t(`outcome.${outcome}`)}</s-badge>;
}

/**
 * Standard empty state: an icon, a heading, an explanation, and a way forward.
 *
 * The icon carries no meaning on its own — the heading always says the same
 * thing in words — so nothing is lost if icons fail to load.
 */
export function EmptyState({
  icon = "shield-check-mark",
  tone = "info",
  heading,
  description,
  children,
}: {
  icon?: string;
  tone?: Tone;
  heading: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <s-box padding="large-500">
      <s-stack direction="block" gap="base" alignItems="center">
        <s-box
          padding="base"
          borderRadius="large"
          background="subdued"
          inlineSize="auto"
        >
          <s-icon type={icon as never} tone={tone} />
        </s-box>
        <s-heading>{heading}</s-heading>
        <s-paragraph>{description}</s-paragraph>
        {children ? (
          <s-stack direction="inline" gap="base" alignItems="center">
            {children}
          </s-stack>
        ) : null}
      </s-stack>
    </s-box>
  );
}

/**
 * A numbered step in an explanatory sequence — used to show a new merchant the
 * shape of the product before they have any data to look at.
 */
export function StepCard({
  step,
  icon,
  title,
  description,
}: {
  step: number;
  icon: string;
  title: string;
  description: string;
}) {
  return (
    <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
      <s-stack direction="block" gap="small-400">
        <s-stack direction="inline" gap="small-300" alignItems="center">
          <s-icon type={icon as never} tone="info" />
          <s-text type="strong">
            {step}. {title}
          </s-text>
        </s-stack>
        <s-text color="subdued">{description}</s-text>
      </s-stack>
    </s-box>
  );
}

/**
 * Renders an AppError payload from an action. Shows the merchant-facing
 * message plus any field errors; never a stack trace or provider text.
 */
export function ErrorBanner({
  error,
}: {
  error?: { code?: string; message?: string; details?: unknown } | null;
}) {
  if (!error?.message) return null;

  const fieldErrors =
    error.details && typeof error.details === "object" && "fieldErrors" in error.details
      ? (error.details as { fieldErrors: Record<string, string> }).fieldErrors
      : null;

  return (
    <s-banner tone="critical" heading={error.message}>
      {fieldErrors ? (
        <s-unordered-list>
          {Object.entries(fieldErrors).map(([field, message]) => (
            <s-list-item key={field}>{message}</s-list-item>
          ))}
        </s-unordered-list>
      ) : null}
    </s-banner>
  );
}

/** Upgrade prompt shown where a feature is gated by the plan. */
export function PlanGate({
  featureName,
  requiredPlanTitle,
}: {
  featureName: string;
  requiredPlanTitle: string;
}) {
  return (
    <s-banner tone="info" heading={`${featureName} is available on ${requiredPlanTitle}`}>
      <s-paragraph>
        Upgrade to unlock this feature. Your existing rules are unaffected either way.
      </s-paragraph>
      <s-button href="/app/billing" variant="primary">
        View plans
      </s-button>
    </s-banner>
  );
}

/** WHEN / THEN preview of a rule, used before activation and in the builder. */
export function RulePreview({
  when,
  logic,
  negate,
  then,
  message,
}: {
  when: string[];
  logic: "AND" | "OR";
  negate: boolean;
  then: string;
  message: string;
}) {
  return (
    <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
      <s-stack direction="block" gap="small-200">
        <s-text type="strong">WHEN</s-text>
        {negate ? <s-text color="subdued">it is NOT true that…</s-text> : null}
        <s-unordered-list>
          {when.map((clause, index) => (
            <s-list-item key={clause}>
              {index > 0 ? <s-text type="strong">{logic} </s-text> : null}
              {clause}
            </s-list-item>
          ))}
        </s-unordered-list>

        <s-text type="strong">THEN</s-text>
        <s-paragraph>{then}</s-paragraph>

        <s-text type="strong">CUSTOMER SEES</s-text>
        <s-paragraph>{message}</s-paragraph>
      </s-stack>
    </s-box>
  );
}
