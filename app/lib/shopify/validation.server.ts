/**
 * Publishing compiled rules to Shopify.
 *
 * A shop's active rules are compiled into one configuration document and stored
 * as a metafield on a single Validation, created from our Cart & Checkout
 * Validation Function. One validation, not one per rule: a store may only have
 * 25 validations, and we want that budget spent on other apps, not on us.
 *
 * Safety property this module exists to guarantee: a failed publish never
 * replaces working enforcement. We record the attempt, leave the previous
 * PUBLISHED configuration in place on Shopify, and surface the error to the
 * merchant. See docs/ARCHITECTURE.md.
 */

import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

import prisma from "../../db.server";
import { compile, exceedsSizeLimit, type CompilableRule } from "@cartsentry/engine";
import { AppError } from "../errors.server";
import type { TenantContext } from "../tenancy.server";
import { recordActivity } from "../activity.server";
import { resolveCollectionMembers } from "./resources.server";

/** Reserved app-owned metafield namespace. Shopify scopes `$app:` to our app. */
const METAFIELD_NAMESPACE = "$app:cartsentry";
const METAFIELD_KEY = "rules";

/** Must match `handle` in extensions/purchase-rules-validation/shopify.extension.toml. */
const FUNCTION_HANDLE = "purchase-rules-validation";

interface PublishOutcome {
  status: "PUBLISHED" | "FAILED" | "UNCHANGED";
  version: number;
  checksum: string;
  byteSize: number;
  warnings: string[];
  error?: string;
}

const VALIDATION_FIELDS = `
  id
  enabled
  title
`;

/**
 * Find the Validation this app already created for the shop, if any.
 * Matched on our own stored gid first; falls back to a scan so a lost database
 * row cannot orphan a live validation.
 */
async function findExistingValidation(
  admin: AdminApiContext,
  knownGid: string | null,
): Promise<string | null> {
  if (knownGid) {
    const response = await admin.graphql(
      `#graphql
      query CartSentryValidation($id: ID!) {
        validation(id: $id) { ${VALIDATION_FIELDS} }
      }`,
      { variables: { id: knownGid } },
    );
    const body = await response.json();
    if (body?.data?.validation?.id) return body.data.validation.id;
  }

  // The app can only see its own validations, so the first result is ours.
  const response = await admin.graphql(
    `#graphql
    query CartSentryValidations {
      validations(first: 25) {
        nodes { ${VALIDATION_FIELDS} }
      }
    }`,
  );
  const body = await response.json();
  const nodes = body?.data?.validations?.nodes ?? [];
  return nodes[0]?.id ?? null;
}

function userErrorMessage(errors: { message: string }[] | undefined): string | null {
  if (!errors || errors.length === 0) return null;
  return errors.map((e) => e.message).join("; ");
}

/**
 * Compile the shop's active rules and publish them.
 *
 * Idempotent: if the compiled checksum matches the last PUBLISHED
 * configuration, nothing is sent to Shopify.
 */
export async function publishRules(
  ctx: TenantContext & { admin: AdminApiContext },
): Promise<PublishOutcome> {
  const rules = (await prisma.rule.findMany({
    where: { ...ctx.scope, status: "ACTIVE" },
    orderBy: { priority: "desc" },
  })) as unknown as CompilableRule[];

  // Collection membership cannot be resolved inside the Function, so it is
  // expanded here and shipped in the configuration.
  const collectionMembers = await resolveCollectionMembers(ctx, rules);
  const compiled = compile(rules, collectionMembers);

  const lastPublished = await prisma.functionConfiguration.findFirst({
    where: { ...ctx.scope, status: "PUBLISHED" },
    orderBy: { version: "desc" },
  });

  if (lastPublished?.checksum === compiled.checksum) {
    return {
      status: "UNCHANGED",
      version: lastPublished.version,
      checksum: compiled.checksum,
      byteSize: compiled.byteSize,
      warnings: compiled.warnings,
    };
  }

  if (exceedsSizeLimit(compiled)) {
    throw new AppError("FUNCTION_PUBLISH", {
      details: { reason: "CONFIG_TOO_LARGE", byteSize: compiled.byteSize },
    });
  }

  const nextVersion = ((await prisma.functionConfiguration.aggregate({
    where: ctx.scope,
    _max: { version: true },
  }))._max.version ?? 0) + 1;

  const record = await prisma.functionConfiguration.create({
    data: {
      shopId: ctx.shopId,
      version: nextVersion,
      checksum: compiled.checksum,
      configuration: compiled.config as object,
      byteSize: compiled.byteSize,
      status: "PENDING",
    },
  });

  try {
    const existingGid = await findExistingValidation(
      ctx.admin,
      lastPublished?.validationGid ?? null,
    );

    const metafields = [
      {
        namespace: METAFIELD_NAMESPACE,
        key: METAFIELD_KEY,
        type: "json",
        value: compiled.json,
      },
    ];

    let validationGid: string;

    if (existingGid) {
      const response = await ctx.admin.graphql(
        `#graphql
        mutation CartSentryValidationUpdate($id: ID!, $validation: ValidationUpdateInput!) {
          validationUpdate(id: $id, validation: $validation) {
            validation { id }
            userErrors { field message }
          }
        }`,
        {
          variables: {
            id: existingGid,
            validation: {
              enable: compiled.config.rules.length > 0,
              metafields,
            },
          },
        },
      );
      const body = await response.json();
      const message = userErrorMessage(body?.data?.validationUpdate?.userErrors);
      if (message) throw new Error(message);
      validationGid = body.data.validationUpdate.validation.id;
    } else {
      const response = await ctx.admin.graphql(
        `#graphql
        mutation CartSentryValidationCreate($validation: ValidationCreateInput!) {
          validationCreate(validation: $validation) {
            validation { id }
            userErrors { field message }
          }
        }`,
        {
          variables: {
            validation: {
              functionHandle: FUNCTION_HANDLE,
              title: "CartSentry purchase rules",
              enable: compiled.config.rules.length > 0,
              // If our function ever throws, let the purchase through rather
              // than blocking every checkout in the store.
              blockOnFailure: false,
              metafields,
            },
          },
        },
      );
      const body = await response.json();
      const message = userErrorMessage(body?.data?.validationCreate?.userErrors);
      if (message) throw new Error(message);
      validationGid = body.data.validationCreate.validation.id;
    }

    await prisma.functionConfiguration.update({
      where: { id: record.id },
      data: { status: "PUBLISHED", publishedAt: new Date(), validationGid },
    });

    await recordActivity(ctx, {
      eventType: "FUNCTION_CONFIG_PUBLISHED",
      summary: `Published rule configuration v${nextVersion} (${compiled.config.rules.length} active rules).`,
      metadata: { version: nextVersion, checksum: compiled.checksum, byteSize: compiled.byteSize },
    });

    ctx.log.info(
      { version: nextVersion, rules: compiled.config.rules.length, byteSize: compiled.byteSize },
      "Published rule configuration",
    );

    return {
      status: "PUBLISHED",
      version: nextVersion,
      checksum: compiled.checksum,
      byteSize: compiled.byteSize,
      warnings: compiled.warnings,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);

    // The previous PUBLISHED row is deliberately untouched: whatever Shopify is
    // currently enforcing stays in force.
    await prisma.functionConfiguration.update({
      where: { id: record.id },
      data: { status: "FAILED", error: detail.slice(0, 1000) },
    });

    await recordActivity(ctx, {
      eventType: "FUNCTION_CONFIG_FAILED",
      summary: `Could not publish rule configuration v${nextVersion}. Previous rules remain live.`,
      metadata: { version: nextVersion, error: detail.slice(0, 500) },
    });

    await notifyPublishFailure(ctx, nextVersion);

    ctx.log.error({ version: nextVersion, err: detail }, "Rule configuration publish failed");

    throw new AppError("FUNCTION_PUBLISH", {
      details: { version: nextVersion, previousVersion: lastPublished?.version ?? null },
      cause: error,
    });
  }
}

async function notifyPublishFailure(ctx: TenantContext, version: number): Promise<void> {
  await prisma.notification.upsert({
    where: { shopId_dedupeKey: { shopId: ctx.shopId, dedupeKey: "function-publish-failed" } },
    create: {
      shopId: ctx.shopId,
      type: "FUNCTION_CONFIG_ERROR",
      severity: "CRITICAL",
      title: "Your latest rule changes are not live",
      body: `We could not publish rule configuration v${version} to Shopify. Your previously published rules are still being enforced. Try saving again, or contact support if it keeps failing.`,
      actionUrl: "/app/settings",
      dedupeKey: "function-publish-failed",
    },
    update: { readAt: null, createdAt: new Date() },
  });
}

/**
 * Roll back to a previously published configuration.
 * Refuses to restore anything that was not successfully published, so a broken
 * configuration can never be reinstated.
 */
export async function rollbackTo(
  ctx: TenantContext & { admin: AdminApiContext },
  version: number,
): Promise<void> {
  const target = await prisma.functionConfiguration.findFirst({
    where: { ...ctx.scope, version, status: "PUBLISHED" },
  });
  if (!target) throw new AppError("NOT_FOUND");

  const response = await ctx.admin.graphql(
    `#graphql
    mutation CartSentryValidationRollback($id: ID!, $validation: ValidationUpdateInput!) {
      validationUpdate(id: $id, validation: $validation) {
        validation { id }
        userErrors { field message }
      }
    }`,
    {
      variables: {
        id: target.validationGid,
        validation: {
          metafields: [
            {
              namespace: METAFIELD_NAMESPACE,
              key: METAFIELD_KEY,
              type: "json",
              value: JSON.stringify(target.configuration),
            },
          ],
        },
      },
    },
  );

  const body = await response.json();
  const message = userErrorMessage(body?.data?.validationUpdate?.userErrors);
  if (message) {
    throw new AppError("FUNCTION_PUBLISH", { details: { version }, cause: new Error(message) });
  }

  await recordActivity(ctx, {
    eventType: "FUNCTION_CONFIG_ROLLED_BACK",
    summary: `Rolled back rule configuration to v${version}.`,
    metadata: { version },
  });
}
