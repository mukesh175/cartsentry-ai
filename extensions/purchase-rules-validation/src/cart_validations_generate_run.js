// @ts-check
/**
 * CartSentry AI — Cart and Checkout Validation Function.
 *
 * Runs on Shopify's servers on every cart interaction and at checkout. Its job
 * is narrow on purpose: adapt Shopify's input into the shared engine's cart
 * shape, run the shared evaluator, and turn triggered BLOCK rules into
 * validation errors.
 *
 * The evaluation logic itself lives in @cartsentry/engine and is the same code
 * the admin simulator runs, so a merchant who tests a scenario in the app sees
 * what checkout will actually do.
 *
 * Failure policy: this function must never throw. A Function that errors can
 * block every checkout in the store, which is far worse than a rule silently
 * not applying. Every failure path returns "no operations" and the app surfaces
 * the problem to the merchant in the admin instead.
 */

import { evaluate, expand, safeParseConfig } from "@cartsentry/engine";

/**
 * @typedef {import("@cartsentry/engine").EvaluationCart} EvaluationCart
 * @typedef {import("@cartsentry/engine").EvaluationLine} EvaluationLine
 */

/** Where a cart-wide error is attached. */
const CART_TARGET = "$.cart";

/**
 * Shopify's buyer journey step maps directly onto the engine's stage.
 * @param {string | undefined} step
 * @returns {EvaluationCart["stage"]}
 */
function toStage(step) {
  if (step === "CHECKOUT_COMPLETION") return "CHECKOUT_COMPLETION";
  if (step === "CHECKOUT_INTERACTION") return "CHECKOUT_INTERACTION";
  return "CART_INTERACTION";
}

/**
 * Build the engine's cart from the Function input.
 *
 * @param {any} input
 * @param {Record<string, string[]>} collectionMembers collection gid -> product gids
 * @returns {EvaluationCart}
 */
function adaptCart(input, collectionMembers) {
  const cart = input?.cart ?? {};

  // Invert the compiled membership map once, so each line is a single lookup
  // instead of scanning every collection.
  /** @type {Record<string, string[]>} */
  const collectionsByProduct = {};
  for (const collectionGid of Object.keys(collectionMembers)) {
    for (const productGid of collectionMembers[collectionGid] ?? []) {
      (collectionsByProduct[productGid] ||= []).push(collectionGid);
    }
  }

  /** @type {EvaluationLine[]} */
  const lines = [];
  for (const line of cart.lines ?? []) {
    const merchandise = line?.merchandise;
    // Gift cards and custom merchandise are not ProductVariants and carry no
    // product identity, so no product rule can meaningfully apply to them.
    if (!merchandise || merchandise.__typename !== "ProductVariant") continue;

    const productGid = merchandise.product?.id;
    lines.push({
      productGid,
      variantGid: merchandise.id,
      title: merchandise.product?.title ?? merchandise.title ?? "",
      quantity: line.quantity ?? 0,
      unitPrice: Number(line.cost?.amountPerQuantity?.amount ?? 0),
      collectionGids: productGid ? (collectionsByProduct[productGid] ?? []) : [],
    });
  }

  const customer = cart.buyerIdentity?.customer ?? null;

  // hasTags comes back as [{ tag, hasTag }]; the engine wants the tags the
  // customer actually has, lowercased.
  const tags = [];
  for (const entry of customer?.hasTags ?? []) {
    if (entry?.hasTag && typeof entry.tag === "string") {
      tags.push(entry.tag.toLowerCase());
    }
  }

  // `null` rather than a default: the engine treats an unknown country as
  // undeterminable and will not fire a country rule on a guess.
  const shippingCountry =
    cart.deliveryGroups?.[0]?.deliveryAddress?.countryCode ?? null;

  return {
    lines,
    subtotal: Number(cart.cost?.subtotalAmount?.amount ?? 0),
    currencyCode: cart.cost?.subtotalAmount?.currencyCode ?? "USD",
    buyer: {
      signedIn: Boolean(customer),
      tags,
      numberOfOrders: customer?.numberOfOrders ?? 0,
    },
    shippingCountry,
    stage: toStage(input?.buyerJourney?.step),
  };
}

/**
 * @param {any} input
 * @returns {{operations: any[]}}
 */
export function cartValidationsGenerateRun(input) {
  const NO_OPERATIONS = { operations: [] };

  try {
    const config = safeParseConfig(input?.validation?.metafield?.value);
    if (config.rules.length === 0) return NO_OPERATIONS;

    const cart = adaptCart(input, config.c);
    const result = evaluate(expand(config), cart);

    if (result.blocks.length === 0) return NO_OPERATIONS;

    // Blocks arrive highest-priority-first from the evaluator. Shopify shows
    // these to the customer verbatim, so the merchant's own wording is what
    // they read.
    const errors = result.blocks.map((block) => ({
      message: block.message,
      target: CART_TARGET,
    }));

    return { operations: [{ validationAdd: { errors } }] };
  } catch (_error) {
    // Fail open. A thrown error here would block checkout store-wide.
    return NO_OPERATIONS;
  }
}
