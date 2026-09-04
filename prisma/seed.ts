/**
 * Development seed data.
 *
 * Creates one clearly-labelled fake shop with a spread of rules, including a
 * deliberate critical conflict so the Conflict Center has something real to
 * show while developing.
 *
 * Guard rails, because seeding a live store would be unforgivable:
 *   - refuses to run when NODE_ENV is production
 *   - the shop domain is obviously fake and namespaced with `cartsentry-dev`
 *   - it only ever touches that one shop; a real merchant's row is never read
 *     or written
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const SEED_SHOP_DOMAIN = "cartsentry-dev-seed.myshopify.com";

const PRODUCT_A = "gid://shopify/Product/8000000000001";
const PRODUCT_B = "gid://shopify/Product/8000000000002";
const COLLECTION = "gid://shopify/Collection/9000000000001";

function ref(gid: string, title: string) {
  return { gid, title, missing: false };
}

async function main() {
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "Refusing to seed: NODE_ENV is production. Seed data must never reach a real merchant.",
    );
  }

  // Start clean so re-seeding is idempotent. Cascades clear the rest.
  await prisma.shop.deleteMany({ where: { shopDomain: SEED_SHOP_DOMAIN } });

  const shop = await prisma.shop.create({
    data: {
      shopDomain: SEED_SHOP_DOMAIN,
      name: "CartSentry Dev Store (seed data)",
      currencyCode: "USD",
      timezone: "UTC",
      countryCode: "US",
      onboardingDone: true,
      businessType: "wholesale",
      primaryProblem: "minimum-order",
      subscription: {
        create: { plan: "GROWTH", status: "ACTIVE", test: true },
      },
    },
  });

  const rules = [
    {
      name: "Maximum 5 per order",
      description: "Keeps a popular product in stock for more customers.",
      type: "PRODUCT_QUANTITY" as const,
      status: "ACTIVE" as const,
      priority: 50,
      message: "You can purchase a maximum of 5 units of this product.",
      definition: {
        schemaVersion: 1,
        logic: "AND",
        negate: false,
        conditions: [
          {
            kind: "product_quantity",
            product: ref(PRODUCT_A, "Premium T-Shirt"),
            operator: "gt",
            value: 5,
          },
        ],
        action: { type: "BLOCK" },
      },
      warningConfig: {
        enabled: true,
        title: "Quantity limit",
        message: "",
        severity: "warning",
        showOnProduct: true,
        showInCart: true,
        icon: "alert",
      },
    },
    {
      name: "Wholesale minimum order",
      description: "Wholesale accounts must reach $500 per order.",
      type: "COMPOSITE" as const,
      status: "ACTIVE" as const,
      priority: 80,
      message: "Wholesale orders require a minimum order value of $500.",
      definition: {
        schemaVersion: 1,
        logic: "AND",
        negate: false,
        conditions: [
          { kind: "customer_tag", operator: "contains", value: "wholesale" },
          { kind: "cart_subtotal", operator: "lt", value: 500, currencyCode: "USD" },
        ],
        action: { type: "BLOCK" },
      },
      warningConfig: { enabled: false },
    },
    {
      name: "Starter kit requires installation",
      description: "The starter kit cannot ship without the installation service.",
      type: "REQUIRED_PRODUCT" as const,
      status: "ACTIVE" as const,
      priority: 70,
      message: "The starter kit requires the installation service. Please add it to your cart.",
      definition: {
        schemaVersion: 1,
        logic: "AND",
        negate: false,
        conditions: [
          { kind: "product_present", product: ref(PRODUCT_A, "Starter Kit"), present: true },
          { kind: "product_present", product: ref(PRODUCT_B, "Installation Service"), present: false },
        ],
        action: { type: "BLOCK" },
      },
      warningConfig: { enabled: false },
    },
    {
      // Deliberately contradicts the rule above, so the Conflict Center has a
      // genuine CRITICAL finding to display during development.
      name: "Starter kit cannot ship with installation",
      description: "Seeded on purpose to demonstrate conflict detection.",
      type: "PRODUCT_COMBINATION" as const,
      status: "DRAFT" as const,
      priority: 70,
      message: "These two items cannot be purchased together.",
      definition: {
        schemaVersion: 1,
        logic: "AND",
        negate: false,
        conditions: [
          { kind: "product_present", product: ref(PRODUCT_A, "Starter Kit"), present: true },
          { kind: "product_present", product: ref(PRODUCT_B, "Installation Service"), present: true },
        ],
        action: { type: "BLOCK" },
      },
      warningConfig: { enabled: false },
    },
    {
      name: "Limited edition cap",
      description: "At most 2 items from the limited edition range.",
      type: "COLLECTION_QUANTITY" as const,
      status: "DRAFT" as const,
      priority: 60,
      message: "You can order a maximum of 2 limited edition items.",
      definition: {
        schemaVersion: 1,
        logic: "AND",
        negate: false,
        conditions: [
          {
            kind: "collection_quantity",
            collection: ref(COLLECTION, "Limited Edition"),
            operator: "gt",
            value: 2,
          },
        ],
        action: { type: "BLOCK" },
      },
      warningConfig: { enabled: false },
    },
  ];

  for (const rule of rules) {
    const created = await prisma.rule.create({
      data: {
        shopId: shop.id,
        name: rule.name,
        description: rule.description,
        type: rule.type,
        status: rule.status,
        priority: rule.priority,
        message: rule.message,
        definition: rule.definition as object,
        warningConfig: rule.warningConfig as object,
        activatedAt: rule.status === "ACTIVE" ? new Date() : null,
      },
    });

    await prisma.ruleVersion.create({
      data: {
        ruleId: created.id,
        version: 1,
        note: "Seeded",
        configuration: rule as unknown as object,
      },
    });

    await prisma.activityLog.create({
      data: {
        shopId: shop.id,
        ruleId: created.id,
        eventType: "RULE_CREATED",
        actor: "seed",
        summary: `Created rule "${rule.name}".`,
      },
    });
  }

  console.log(`Seeded ${rules.length} rules for ${SEED_SHOP_DOMAIN}`);
  console.log("This shop is development-only. It is never served to a real merchant.");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
