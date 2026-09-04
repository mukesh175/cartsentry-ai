import { useState } from "react";
import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";

import { requireTenant } from "../lib/tenancy.server";
import { SUPPORTED_CUSTOMER_TAGS } from "@cartsentry/engine";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await requireTenant(request);
  return { supportedTags: [...SUPPORTED_CUSTOMER_TAGS] };
};

interface Topic {
  id: string;
  title: string;
  body: string[];
}

export default function Help() {
  const { supportedTags } = useLoaderData<typeof loader>();
  const [openTopic, setOpenTopic] = useState<string | null>("how-rules-work");

  const topics: Topic[] = [
    {
      id: "how-rules-work",
      title: "How rules work",
      body: [
        "A rule has two halves: the conditions that describe when it applies, and the action it takes when they match.",
        "Conditions describe when the rule FIRES. A rule that blocks purchases of more than 5 units has the condition 'quantity is greater than 5' — because that is the situation you want to stop, not the situation you want to allow.",
        "Rules with a BLOCK action stop the purchase and show your message. Rules with a WARN action show a message but let the customer continue.",
        "Priority decides the order rules are evaluated and which message a customer sees first when several apply. 100 is highest, 50 is normal.",
      ],
    },
    {
      id: "how-validation-works",
      title: "How enforcement works",
      body: [
        "When you activate a rule, CartSentry compiles all of your active rules into a single configuration and publishes it to Shopify as a Cart and Checkout Validation Function.",
        "That function runs on Shopify's own servers, on every cart change and at checkout. It is the same mechanism Shopify provides to all apps, on every Shopify plan — it is not a checkout script, a theme hack, or a workaround.",
        "Because it runs server-side, a customer cannot bypass it by editing the page or using an alternative checkout such as Shop Pay or Apple Pay.",
        "If our function ever fails to run, Shopify lets the purchase through rather than blocking your entire store. We would rather miss one rule than stop every sale.",
      ],
    },
    {
      id: "how-warnings-work",
      title: "How storefront warnings work",
      body: [
        "Blocking a customer at checkout works, but it is a frustrating place to find out. Warnings tell them earlier, in the cart or on the product page.",
        "Warnings are shown by the CartSentry theme app extension. Add the CartSentry app block to your cart template in the theme editor to enable them.",
        "Warnings are advisory. The rule is still enforced by the validation function even if a customer never sees the warning.",
      ],
    },
    {
      id: "shopify-plans",
      title: "Shopify plans and what needs Shopify Plus",
      body: [
        "Cart and Checkout Validation Functions — the mechanism CartSentry uses to enforce rules — are available on every Shopify plan. You do not need Shopify Plus to use CartSentry.",
        "Shopify Plus is required for things CartSentry deliberately does not attempt: editing the checkout page itself with checkout.liquid, and some checkout UI extension placements.",
        "CartSentry will never claim to unlock a Plus-only capability, and does not work around Shopify's plan restrictions. Where something is not possible on your plan, the app says so plainly.",
      ],
    },
    {
      id: "customer-tags",
      title: "Why only some customer tags are available",
      body: [
        `Rules can use these tags: ${supportedTags.join(", ")}.`,
        "This is a real technical constraint, not a paywall. A Shopify Function asks Shopify for specific customer tags by name, and the list of names is fixed when the function is deployed — it cannot be changed per store at runtime.",
        "If you need a different tag, contact support. Adding one is a change to the app's deployed function, which we can do for tags that are widely useful.",
      ],
    },
    {
      id: "collections",
      title: "How collection rules stay up to date",
      body: [
        "A Shopify Function cannot look up which products are in a collection while it runs, so CartSentry resolves collection membership when your rules are published.",
        "This means a product added to a collection takes effect the next time your rules are published. Use 'Republish rules to Shopify' in Settings to refresh immediately.",
        "Collections with more than 250 products are truncated. If you rely on a very large collection, a product-based rule is more reliable.",
      ],
    },
    {
      id: "testing",
      title: "How to test a rule",
      body: [
        "Open the Simulator, add the products a customer would have, set the quantities, and run it.",
        "The simulator runs the exact same rule engine that runs at checkout, so a PASS or BLOCKED result is a genuine prediction rather than an approximation.",
        "It does not simulate taxes, shipping, discounts, inventory, or other apps' validations. Those can still affect a real checkout.",
        "Every failed rule shows what it expected, what the cart actually had, and the gap between them.",
      ],
    },
    {
      id: "conflicts",
      title: "How to resolve conflicts",
      body: [
        "A critical conflict means two rules cannot both be satisfied — for example a minimum of 5 and a maximum of 3 on the same product. Any affected customer is blocked no matter what they do.",
        "CartSentry only marks something critical when it can prove the contradiction. Lower-severity findings are things worth reviewing, not necessarily mistakes.",
        "You cannot activate a rule that has an unresolved critical conflict. Fix the thresholds, or disable one of the two rules.",
        "Dismissing a conflict never changes your rules — it only hides the warning.",
      ],
    },
    {
      id: "billing",
      title: "Billing",
      body: [
        "Charges go through Shopify and appear on your regular Shopify invoice. You approve every charge before it applies.",
        "Downgrading or cancelling never deletes your rules. If you end up with more active rules than your new plan allows, everything keeps working — you simply cannot activate more until you are back under the limit.",
        "Free plan simulations reset at the start of each calendar month.",
      ],
    },
    {
      id: "privacy",
      title: "Privacy and data",
      body: [
        "CartSentry stores your rules, your simulations, and an activity log. It stores your store's domain, name, currency and timezone.",
        "It does not store customer names, email addresses, addresses, or order contents. The validation function reads cart data on Shopify's servers and does not send it to us.",
        "When you uninstall, all data for your store is deleted. Shopify's customer data request, customer redact and shop redact webhooks are all implemented.",
      ],
    },
    {
      id: "troubleshooting",
      title: "Troubleshooting",
      body: [
        "A rule is not being enforced: check its status is Active, and check Settings for a failed publish.",
        "A rule says 'Needs attention': it references a product or collection that was deleted. Pick a replacement, or disable the rule.",
        "Warnings are not appearing on the storefront: add the CartSentry app block to your cart template in the theme editor.",
        "Rules look out of date at checkout: use 'Republish rules to Shopify' in Settings.",
      ],
    },
  ];

  return (
    <s-page heading="Help">
      <s-section>
        <s-paragraph>
          CartSentry prevents invalid purchases using Shopify&rsquo;s own validation mechanism. These
          topics explain exactly how it works, including what it cannot do.
        </s-paragraph>
      </s-section>

      {topics.map((topic) => (
        <s-section key={topic.id} heading={topic.title}>
          <s-stack direction="block" gap="small-300">
            <s-button
              variant="tertiary"
              onClick={() => setOpenTopic((current) => (current === topic.id ? null : topic.id))}
            >
              {openTopic === topic.id ? "Hide" : "Read"}
            </s-button>
            {openTopic === topic.id
              ? topic.body.map((paragraph) => (
                  <s-paragraph key={paragraph.slice(0, 40)}>{paragraph}</s-paragraph>
                ))
              : null}
          </s-stack>
        </s-section>
      ))}

      <s-section slot="aside" heading="Still stuck?">
        <s-stack direction="block" gap="small-300">
          <s-paragraph>
            Email support and include your store domain. If a rule is behaving unexpectedly, a
            screenshot of the Simulator result tells us almost everything we need.
          </s-paragraph>
          <s-link href="mailto:support@cartsentry.app">support@cartsentry.app</s-link>
        </s-stack>
      </s-section>
    </s-page>
  );
}
