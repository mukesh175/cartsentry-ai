/**
 * Plan definitions and entitlements.
 *
 * Entitlements are evaluated on the server for every mutation. The UI reads the
 * same table to decide what to show, but a hidden button is a courtesy, not a
 * control — see `assertEntitled` in entitlements.server.ts.
 */

export type PlanName = "FREE" | "STARTER" | "GROWTH" | "PRO";

export interface PlanDefinition {
  name: PlanName;
  title: string;
  /** Monthly price in USD. */
  price: number;
  /** Shopify's recurring pricing interval. */
  interval: "EVERY_30_DAYS";
  tagline: string;
  features: string[];
  limits: {
    /** Rules that may be ACTIVE at once. Draft/disabled rules are never counted. */
    maxActiveRules: number;
    /** Simulations per calendar month. `null` means no hard cap (fair use). */
    maxSimulationsPerMonth: number | null;
    /** AI rule generations per calendar month. 0 means the feature is unavailable. */
    maxAiRequestsPerMonth: number;
    /** Days of activity log and analytics history retained and shown. */
    historyRetentionDays: number;
  };
  capabilities: {
    canUseAI: boolean;
    canUseSimulator: boolean;
    canUseWarnings: boolean;
    canUseAdvancedConflictDetection: boolean;
    canUseAdvancedAnalytics: boolean;
    canExportData: boolean;
    canUseRuleVersionHistory: boolean;
  };
}

/**
 * `maxActiveRules` is additionally capped by Shopify: a shop may have at most
 * 25 validation functions, and CartSentry compiles all active rules into a
 * single validation, so the platform limit is not the binding constraint here.
 * See docs/LIMITATIONS.md.
 */
export const PLANS: Record<PlanName, PlanDefinition> = {
  FREE: {
    name: "FREE",
    title: "Free",
    price: 0,
    interval: "EVERY_30_DAYS",
    tagline: "Try purchase rules on one or two products.",
    features: [
      "3 active rules",
      "10 simulations per month",
      "Basic rule templates",
      "Basic conflict detection",
      "Basic analytics",
    ],
    limits: {
      maxActiveRules: 3,
      maxSimulationsPerMonth: 10,
      maxAiRequestsPerMonth: 0,
      historyRetentionDays: 7,
    },
    capabilities: {
      canUseAI: false,
      canUseSimulator: true,
      canUseWarnings: false,
      canUseAdvancedConflictDetection: false,
      canUseAdvancedAnalytics: false,
      canExportData: false,
      canUseRuleVersionHistory: false,
    },
  },

  STARTER: {
    name: "STARTER",
    title: "Starter",
    price: 9,
    interval: "EVERY_30_DAYS",
    tagline: "Everyday purchase limits with customer warnings.",
    features: [
      "10 active rules",
      "Unlimited simulations (fair use)",
      "All rule templates",
      "Storefront customer warnings",
      "Rule version history",
    ],
    limits: {
      maxActiveRules: 10,
      maxSimulationsPerMonth: null,
      maxAiRequestsPerMonth: 0,
      historyRetentionDays: 30,
    },
    capabilities: {
      canUseAI: false,
      canUseSimulator: true,
      canUseWarnings: true,
      canUseAdvancedConflictDetection: false,
      canUseAdvancedAnalytics: false,
      canExportData: false,
      canUseRuleVersionHistory: true,
    },
  },

  GROWTH: {
    name: "GROWTH",
    title: "Growth",
    price: 29,
    interval: "EVERY_30_DAYS",
    tagline: "Describe a rule in plain English and test it before it goes live.",
    features: [
      "25 active rules",
      "AI Rule Creator",
      "Advanced simulator",
      "Advanced conflict detection",
      "Advanced analytics",
      "Priority support",
    ],
    limits: {
      maxActiveRules: 25,
      maxSimulationsPerMonth: null,
      maxAiRequestsPerMonth: 200,
      historyRetentionDays: 90,
    },
    capabilities: {
      canUseAI: true,
      canUseSimulator: true,
      canUseWarnings: true,
      canUseAdvancedConflictDetection: true,
      canUseAdvancedAnalytics: true,
      canExportData: false,
      canUseRuleVersionHistory: true,
    },
  },

  PRO: {
    name: "PRO",
    title: "Pro",
    price: 79,
    interval: "EVERY_30_DAYS",
    tagline: "For complex catalogues and agencies.",
    features: [
      "100 active rules",
      "AI Rule Creator",
      "Advanced simulator",
      "Advanced conflict detection",
      "Advanced analytics",
      "Full activity history",
      "CSV export",
      "Priority support",
    ],
    limits: {
      maxActiveRules: 100,
      maxSimulationsPerMonth: null,
      maxAiRequestsPerMonth: 1000,
      historyRetentionDays: 365,
    },
    capabilities: {
      canUseAI: true,
      canUseSimulator: true,
      canUseWarnings: true,
      canUseAdvancedConflictDetection: true,
      canUseAdvancedAnalytics: true,
      canExportData: true,
      canUseRuleVersionHistory: true,
    },
  },
};

export const PLAN_ORDER: PlanName[] = ["FREE", "STARTER", "GROWTH", "PRO"];

export type Capability = keyof PlanDefinition["capabilities"];

export function planFor(name: PlanName): PlanDefinition {
  return PLANS[name];
}

/** True when `to` is a strictly lower tier than `from`. */
export function isDowngrade(from: PlanName, to: PlanName): boolean {
  return PLAN_ORDER.indexOf(to) < PLAN_ORDER.indexOf(from);
}

/** The cheapest plan that includes a capability — used for upgrade prompts. */
export function lowestPlanWith(capability: Capability): PlanDefinition | null {
  for (const name of PLAN_ORDER) {
    if (PLANS[name].capabilities[capability]) return PLANS[name];
  }
  return null;
}
