/**
 * @cartsentry/engine — the shared rule engine.
 *
 * Imported by both the admin app and the Cart & Checkout Validation Function,
 * so that what the simulator predicts and what checkout enforces are the same
 * code path rather than two implementations kept in step by hand.
 *
 * Constraint for everything in this package: no Node, Prisma, or React imports.
 * `rule-schema` is the only module that pulls in zod, and the Function imports
 * it for types only, so zod never reaches the Function bundle.
 */

export * from "./rule-schema";
export * from "./cart";
export * from "./evaluate";
export * from "./explain";
export * from "./compile";
export * from "./conflicts";
