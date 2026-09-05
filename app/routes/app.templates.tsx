import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";

import { requireTenant } from "../lib/tenancy.server";
import { TEMPLATES } from "../lib/rules/templates";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const ctx = await requireTenant(request);
  return {
    // Templates are static, but the merchant's chosen problem reorders them so
    // the most relevant one is first.
    primaryProblem: ctx.shop.primaryProblem,
    templates: TEMPLATES.map((template) => ({
      id: template.id,
      title: template.title,
      summary: template.summary,
      problem: template.problem,
      requiresProduct: template.requiresProduct,
      requiresCollection: template.requiresCollection,
    })),
  };
};

export default function Templates() {
  const { templates, primaryProblem } = useLoaderData<typeof loader>();

  const ordered = primaryProblem
    ? [
        ...templates.filter((t) => t.problem === primaryProblem),
        ...templates.filter((t) => t.problem !== primaryProblem),
      ]
    : templates;

  return (
    <s-page heading="Templates">
      <s-section>
        <s-paragraph>
          Each template opens the rule builder pre-filled. You choose the products and thresholds,
          then test it before anything goes live.
        </s-paragraph>
      </s-section>

      <s-section heading={`${templates.length} templates`}>
        <s-grid gridTemplateColumns="repeat(auto-fit, minmax(260px, 1fr))" gap="base">
          {ordered.map((template) => (
            <s-box key={template.id} padding="base" borderWidth="base" borderRadius="base">
              <s-stack direction="block" gap="small-300">
                <s-stack direction="inline" gap="small-400" alignItems="center">
                  <s-icon type="wand" tone="info" size="small" />
                  <s-text type="strong">{template.title}</s-text>
                </s-stack>
                <s-text color="subdued">{template.summary}</s-text>

                {template.requiresProduct > 0 || template.requiresCollection > 0 ? (
                  <s-text color="subdued">
                    You will choose{" "}
                    {template.requiresProduct > 0
                      ? `${template.requiresProduct} product${template.requiresProduct === 1 ? "" : "s"}`
                      : ""}
                    {template.requiresProduct > 0 && template.requiresCollection > 0 ? " and " : ""}
                    {template.requiresCollection > 0
                      ? `${template.requiresCollection} collection${template.requiresCollection === 1 ? "" : "s"}`
                      : ""}
                    .
                  </s-text>
                ) : null}

                <s-button href={`/app/rules/new?template=${template.id}`} variant="primary">
                  Use this template
                </s-button>
              </s-stack>
            </s-box>
          ))}
        </s-grid>
      </s-section>
    </s-page>
  );
}
