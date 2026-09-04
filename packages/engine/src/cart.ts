/**
 * The normalised cart the rule engine evaluates against.
 *
 * Two things produce a `EvaluationCart`:
 *   1. the Shopify Function, from its `Input` (see extensions/.../adapt.js)
 *   2. the simulator, from a merchant-authored scenario
 *
 * Both go through the *same* evaluator, which is what makes "what the simulator
 * says" and "what actually happens at checkout" agree.
 *
 * Runs inside the Shopify Function — no Node or Prisma imports.
 */

export interface EvaluationLine {
  /** gid://shopify/Product/... — absent if the Function input omitted it. */
  productGid?: string;
  variantGid?: string;
  title: string;
  quantity: number;
  /** Per-unit amount in the cart's presentment currency. */
  unitPrice: number;
  /** Collection gids this line's product belongs to. */
  collectionGids: string[];
}

export interface EvaluationBuyer {
  signedIn: boolean;
  /** Lowercased customer tags. Empty for guests. */
  tags: string[];
  /** Guests are treated as 0. */
  numberOfOrders: number;
}

export interface EvaluationCart {
  lines: EvaluationLine[];
  /** Sum of line unitPrice * quantity, in `currencyCode`. */
  subtotal: number;
  currencyCode: string;
  buyer: EvaluationBuyer;
  /**
   * ISO 3166-1 alpha-2 shipping destination, or `null` when no delivery address
   * is known yet. `null` is meaningful: country conditions are undeterminable,
   * not false.
   */
  shippingCountry: string | null;
  /**
   * Where in the buyer journey this evaluation happens. Warnings are useful in
   * the cart; blocking matters at checkout.
   */
  stage: "CART_INTERACTION" | "CHECKOUT_INTERACTION" | "CHECKOUT_COMPLETION";
}

/** Total units across all lines. */
export function totalQuantity(cart: EvaluationCart): number {
  return cart.lines.reduce((sum, line) => sum + line.quantity, 0);
}

/** Units of a specific product, optionally narrowed to one variant. */
export function quantityOfProduct(
  cart: EvaluationCart,
  productGid: string,
  variantGid?: string,
): number {
  return cart.lines.reduce((sum, line) => {
    if (variantGid) {
      return line.variantGid === variantGid ? sum + line.quantity : sum;
    }
    return line.productGid === productGid ? sum + line.quantity : sum;
  }, 0);
}

/** Units belonging to a collection. */
export function quantityInCollection(cart: EvaluationCart, collectionGid: string): number {
  return cart.lines.reduce(
    (sum, line) => (line.collectionGids.includes(collectionGid) ? sum + line.quantity : sum),
    0,
  );
}

/**
 * Recompute the subtotal from lines. The simulator uses this so a merchant
 * cannot author a scenario whose subtotal contradicts its own line items.
 */
export function computeSubtotal(lines: EvaluationLine[]): number {
  const cents = lines.reduce(
    (sum, line) => sum + Math.round(line.unitPrice * 100) * line.quantity,
    0,
  );
  return cents / 100;
}

export function emptyCart(currencyCode = "USD"): EvaluationCart {
  return {
    lines: [],
    subtotal: 0,
    currencyCode,
    buyer: { signedIn: false, tags: [], numberOfOrders: 0 },
    shippingCountry: null,
    stage: "CART_INTERACTION",
  };
}
