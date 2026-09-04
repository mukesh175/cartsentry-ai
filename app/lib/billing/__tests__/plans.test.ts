import { describe, expect, it } from "vitest";

import { PLANS, PLAN_ORDER, isDowngrade, lowestPlanWith, planFor } from "../plans";

describe("plan definitions", () => {
  it("prices increase with tier", () => {
    const prices = PLAN_ORDER.map((name) => PLANS[name].price);
    const sorted = [...prices].sort((a, b) => a - b);
    expect(prices).toEqual(sorted);
  });

  it("active rule limits increase with tier", () => {
    const limits = PLAN_ORDER.map((name) => PLANS[name].limits.maxActiveRules);
    const sorted = [...limits].sort((a, b) => a - b);
    expect(limits).toEqual(sorted);
  });

  it("history retention increases with tier", () => {
    const retention = PLAN_ORDER.map((name) => PLANS[name].limits.historyRetentionDays);
    const sorted = [...retention].sort((a, b) => a - b);
    expect(retention).toEqual(sorted);
  });

  it("never removes a capability at a higher tier", () => {
    const capabilities = Object.keys(PLANS.FREE.capabilities) as (keyof typeof PLANS.FREE.capabilities)[];

    for (const capability of capabilities) {
      let seenEnabled = false;
      for (const name of PLAN_ORDER) {
        const enabled = PLANS[name].capabilities[capability];
        if (seenEnabled && !enabled) {
          throw new Error(`${capability} is enabled on a lower plan than ${name} but disabled on it`);
        }
        if (enabled) seenEnabled = true;
      }
    }
  });

  it("keeps the simulator available on every plan, including Free", () => {
    for (const name of PLAN_ORDER) {
      expect(PLANS[name].capabilities.canUseSimulator).toBe(true);
    }
  });

  it("only offers AI where a monthly AI quota exists", () => {
    for (const name of PLAN_ORDER) {
      const plan = PLANS[name];
      if (plan.capabilities.canUseAI) {
        expect(plan.limits.maxAiRequestsPerMonth).toBeGreaterThan(0);
      } else {
        expect(plan.limits.maxAiRequestsPerMonth).toBe(0);
      }
    }
  });

  it("charges nothing on the Free plan", () => {
    expect(PLANS.FREE.price).toBe(0);
  });
});

describe("isDowngrade", () => {
  it("detects a move to a lower tier", () => {
    expect(isDowngrade("PRO", "FREE")).toBe(true);
    expect(isDowngrade("GROWTH", "STARTER")).toBe(true);
  });

  it("does not treat an upgrade as a downgrade", () => {
    expect(isDowngrade("FREE", "PRO")).toBe(false);
    expect(isDowngrade("STARTER", "GROWTH")).toBe(false);
  });

  it("does not treat the same plan as a downgrade", () => {
    expect(isDowngrade("GROWTH", "GROWTH")).toBe(false);
  });
});

describe("lowestPlanWith", () => {
  it("finds the cheapest plan offering a capability", () => {
    expect(lowestPlanWith("canUseAI")?.name).toBe("GROWTH");
    expect(lowestPlanWith("canUseWarnings")?.name).toBe("STARTER");
    expect(lowestPlanWith("canExportData")?.name).toBe("PRO");
  });

  it("returns Free for a capability every plan has", () => {
    expect(lowestPlanWith("canUseSimulator")?.name).toBe("FREE");
  });
});

describe("planFor", () => {
  it("returns the matching definition", () => {
    expect(planFor("GROWTH").title).toBe("Growth");
  });
});
