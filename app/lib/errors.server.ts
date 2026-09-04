/**
 * Application errors and the single place where they become user-facing text.
 *
 * The rule: merchants see a plain sentence and a next step; technical detail
 * goes to the log with a request id they can quote to support. Raw messages
 * from Shopify, Prisma or an AI provider are never rendered.
 */

import { logger } from "./logger.server";

export type ErrorCode =
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "VALIDATION"
  | "PLAN_LIMIT"
  | "RATE_LIMITED"
  | "CONFLICT_BLOCKED"
  | "SHOPIFY_API"
  | "FUNCTION_PUBLISH"
  | "AI_UNAVAILABLE"
  | "AI_INVALID_OUTPUT"
  | "DATABASE"
  | "INTERNAL";

/** Messages a merchant reads. No status codes, no stack traces, no jargon. */
const USER_MESSAGES: Record<ErrorCode, string> = {
  UNAUTHENTICATED: "Your session has expired. Reload the page to continue.",
  FORBIDDEN: "You do not have access to this resource.",
  NOT_FOUND: "We could not find what you were looking for. It may have been deleted.",
  VALIDATION: "Some details need fixing before this can be saved.",
  PLAN_LIMIT: "Your current plan does not include this. Upgrade to continue.",
  RATE_LIMITED: "That is a lot of requests in a short time. Wait a moment and try again.",
  CONFLICT_BLOCKED:
    "This rule has an unresolved critical conflict. Resolve it before activating.",
  SHOPIFY_API: "Shopify did not respond as expected. Please try again in a moment.",
  FUNCTION_PUBLISH:
    "We could not publish your rules to Shopify. Your previous working rules are still live.",
  AI_UNAVAILABLE:
    "The AI Rule Creator is unavailable right now. You can still build this rule manually.",
  AI_INVALID_OUTPUT:
    "We could not turn that description into a rule. Try rephrasing it, or build the rule manually.",
  DATABASE: "We could not save your changes. Please try again.",
  INTERNAL: "Something went wrong on our side. Please try again.",
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  /** Extra context for the UI, e.g. which fields failed validation. */
  readonly details?: unknown;
  readonly cause?: unknown;

  constructor(
    code: ErrorCode,
    options: { status?: number; details?: unknown; cause?: unknown; message?: string } = {},
  ) {
    super(options.message ?? code);
    this.name = "AppError";
    this.code = code;
    this.status = options.status ?? defaultStatus(code);
    this.details = options.details;
    this.cause = options.cause;
  }

  /** Safe to send to the browser. */
  toPayload() {
    return { ok: false as const, code: this.code, message: USER_MESSAGES[this.code], details: this.details };
  }
}

function defaultStatus(code: ErrorCode): number {
  switch (code) {
    case "UNAUTHENTICATED":
      return 401;
    case "FORBIDDEN":
      return 403;
    case "NOT_FOUND":
      return 404;
    case "VALIDATION":
    case "CONFLICT_BLOCKED":
      return 422;
    case "PLAN_LIMIT":
      return 402;
    case "RATE_LIMITED":
      return 429;
    default:
      return 500;
  }
}

export function userMessage(code: ErrorCode): string {
  return USER_MESSAGES[code];
}

/**
 * Normalise anything thrown into an AppError, logging the technical detail.
 * `requestId` is echoed to the merchant so a support ticket can be traced.
 */
export function toAppError(error: unknown, requestId?: string): AppError {
  if (error instanceof AppError) {
    logger.warn({ requestId, code: error.code, details: error.details }, error.message);
    return error;
  }

  // React Router / Shopify throw Responses for redirects and auth bounces.
  // Those are control flow, not errors — callers must re-throw them.
  if (error instanceof Response) {
    throw error;
  }

  const message = error instanceof Error ? error.message : String(error);
  logger.error(
    { requestId, err: error instanceof Error ? { name: error.name, stack: error.stack } : undefined },
    `Unhandled error: ${message}`,
  );
  return new AppError("INTERNAL", { cause: error });
}
