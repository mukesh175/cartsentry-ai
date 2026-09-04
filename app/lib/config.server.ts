/**
 * Typed, validated environment configuration.
 *
 * Parsed once at module load so a misconfigured deployment fails fast and
 * loudly rather than at the first merchant request. Never import this from
 * anything that reaches the browser bundle.
 */

import { z } from "zod";

const booleanish = z
  .enum(["true", "false", "1", "0", ""])
  .default("false")
  .transform((v) => v === "true" || v === "1");

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),

  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),

  SHOPIFY_APP_URL: z.string().url().optional(),
  SHOPIFY_APP_HANDLE: z.string().default("cartsentry-ai"),

  // AI is optional by design: the app must stay fully usable without it.
  AI_PROVIDER: z.enum(["anthropic", "gemini", "groq", "none"]).default("none"),
  AI_API_KEY: z.string().optional(),
  AI_MODEL: z.string().default("gemini-2.5-flash"),
  AI_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120_000).default(20_000),
  AI_MAX_REQUESTS_PER_HOUR: z.coerce.number().int().min(1).max(10_000).default(60),

  AI_FALLBACK_PROVIDER: z.enum(["anthropic", "gemini", "groq", "none"]).default("none"),
  AI_FALLBACK_MODEL: z.string().optional(),

  ANTHROPIC_API_KEY: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),
  GROQ_API_KEY: z.string().optional(),

  DEMO_MODE: booleanish,
});

function parseEnv() {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}

const env = parseEnv();

/**
 * Demo mode is a development affordance only. Refuse to honour it in
 * production so a stray environment variable can never make a live merchant
 * see fabricated data.
 */
const demoMode = env.DEMO_MODE && env.NODE_ENV !== "production";
if (env.DEMO_MODE && env.NODE_ENV === "production") {
  // eslint-disable-next-line no-console
  console.error(
    "[cartsentry] DEMO_MODE was set in production and has been ignored. Demo data is never served to live shops.",
  );
}

/** Resolve the API key for a provider, preferring the provider-specific variable. */
function keyFor(provider: string): string | undefined {
  switch (provider) {
    case "anthropic":
      return env.ANTHROPIC_API_KEY || env.AI_API_KEY;
    case "gemini":
      return env.GEMINI_API_KEY || env.AI_API_KEY;
    case "groq":
      return env.GROQ_API_KEY || env.AI_API_KEY;
    default:
      return undefined;
  }
}

export const config = {
  nodeEnv: env.NODE_ENV,
  isProduction: env.NODE_ENV === "production",
  logLevel: env.LOG_LEVEL,
  appUrl: env.SHOPIFY_APP_URL,
  appHandle: env.SHOPIFY_APP_HANDLE,
  demoMode,

  ai: {
    provider: env.AI_PROVIDER,
    model: env.AI_MODEL,
    apiKey: keyFor(env.AI_PROVIDER),
    timeoutMs: env.AI_TIMEOUT_MS,
    maxRequestsPerHour: env.AI_MAX_REQUESTS_PER_HOUR,
    fallback:
      env.AI_FALLBACK_PROVIDER === "none"
        ? null
        : {
            provider: env.AI_FALLBACK_PROVIDER,
            model: env.AI_FALLBACK_MODEL ?? env.AI_MODEL,
            apiKey: keyFor(env.AI_FALLBACK_PROVIDER),
          },
  },
} as const;

/**
 * Whether the AI Rule Creator can run at all. The UI uses this to hide the
 * feature rather than show a button that cannot work (see docs/LIMITATIONS.md).
 */
export function aiIsConfigured(): boolean {
  if (config.ai.provider !== "none" && config.ai.apiKey) return true;
  return Boolean(config.ai.fallback?.apiKey);
}
