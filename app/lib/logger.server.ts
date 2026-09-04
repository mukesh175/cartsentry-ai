/**
 * Structured logging.
 *
 * Redaction is enforced at the logger, not left to call sites: access tokens,
 * API keys and session secrets must never reach a log sink even if someone
 * later logs a whole request or session object by mistake.
 */

import pino from "pino";
import { config } from "./config.server";

const REDACTED_PATHS = [
  "accessToken",
  "access_token",
  "refreshToken",
  "apiKey",
  "api_key",
  "AI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "GROQ_API_KEY",
  "SHOPIFY_API_SECRET",
  "SESSION_SECRET",
  "authorization",
  "cookie",
  "*.accessToken",
  "*.refreshToken",
  "*.apiKey",
  "req.headers.authorization",
  "req.headers.cookie",
];

export const logger = pino({
  level: config.logLevel,
  redact: { paths: REDACTED_PATHS, censor: "[redacted]" },
  base: { app: "cartsentry" },
  // Pretty transports pull in extra deps and break on serverless; JSON is what
  // Vercel's log drain wants anyway.
  formatters: {
    level: (label) => ({ level: label }),
  },
});

export interface RequestContext {
  requestId: string;
  shopDomain?: string;
  shopId?: string;
}

/** A child logger carrying request/shop identity onto every line. */
export function contextLogger(ctx: RequestContext) {
  return logger.child(ctx);
}

export function newRequestId(): string {
  return crypto.randomUUID();
}
