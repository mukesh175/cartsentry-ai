import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";

import { requireTenant } from "../lib/tenancy.server";
import { aiIsConfigured } from "../lib/config.server";
import { openConflictCount } from "../lib/conflicts/conflicts.server";
import prisma from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const ctx = await requireTenant(request);

  const [conflicts, unreadNotifications] = await Promise.all([
    openConflictCount(ctx),
    prisma.notification.count({ where: { ...ctx.scope, readAt: null } }),
  ]);

  return {
    apiKey: process.env.SHOPIFY_API_KEY || "",
    shopDomain: ctx.shopDomain,
    planName: ctx.plan.title,
    // The AI section is hidden rather than shown-and-broken when no provider is
    // configured. See docs/LIMITATIONS.md.
    aiAvailable: aiIsConfigured() && ctx.plan.capabilities.canUseAI,
    openConflicts: conflicts.open,
    criticalConflicts: conflicts.critical,
    unreadNotifications,
    onboardingDone: ctx.shop.onboardingDone,
  };
};

export default function App() {
  const { apiKey, aiAvailable, openConflicts } = useLoaderData<typeof loader>();

  return (
    <AppProvider embedded apiKey={apiKey}>
      <s-app-nav>
        <s-link href="/app">Dashboard</s-link>
        <s-link href="/app/rules">Rules</s-link>
        {aiAvailable ? <s-link href="/app/ai">AI Rule Creator</s-link> : null}
        <s-link href="/app/simulator">Simulator</s-link>
        <s-link href="/app/conflicts">
          {openConflicts > 0 ? `Conflicts (${openConflicts})` : "Conflicts"}
        </s-link>
        <s-link href="/app/analytics">Analytics</s-link>
        <s-link href="/app/templates">Templates</s-link>
        <s-link href="/app/activity">Activity</s-link>
        <s-link href="/app/billing">Billing</s-link>
        <s-link href="/app/settings">Settings</s-link>
        <s-link href="/app/help">Help</s-link>
      </s-app-nav>
      <Outlet />
    </AppProvider>
  );
}

// Shopify needs React Router to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
