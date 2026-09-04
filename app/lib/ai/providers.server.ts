/**
 * AI provider adapters.
 *
 * Every provider is reduced to one operation: given a system prompt and a
 * user message, return a JSON string. Nothing else about the provider leaks
 * into the rest of the app, so swapping or adding one is a change confined to
 * this file.
 *
 * All three providers are asked for JSON-only output, and the caller validates
 * the result against a strict schema regardless — a provider that ignores the
 * instruction produces a rejected request, not a malformed rule.
 */

import { config } from "../config.server";
import { logger } from "../logger.server";

export type ProviderName = "anthropic" | "gemini" | "groq";

export interface ProviderRequest {
  system: string;
  user: string;
  maxOutputTokens: number;
}

export interface ProviderResult {
  text: string;
  provider: ProviderName;
  model: string;
  latencyMs: number;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly kind: "TIMEOUT" | "RATE_LIMITED" | "UNAVAILABLE" | "BAD_RESPONSE",
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

interface ProviderConfig {
  provider: ProviderName;
  model: string;
  apiKey: string;
}

async function withTimeout<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.ai.timeoutMs);
  try {
    return await work(controller.signal);
  } catch (error) {
    if (controller.signal.aborted) {
      throw new ProviderError(`Provider timed out after ${config.ai.timeoutMs}ms`, "TIMEOUT");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function classifyStatus(status: number, body: string): ProviderError {
  if (status === 429) return new ProviderError("Provider rate limit reached", "RATE_LIMITED");
  if (status >= 500) return new ProviderError(`Provider error ${status}`, "UNAVAILABLE");
  return new ProviderError(`Provider rejected the request (${status}): ${body.slice(0, 200)}`, "BAD_RESPONSE");
}

// ---------------------------------------------------------------------------
// Anthropic
// ---------------------------------------------------------------------------

async function callAnthropic(cfg: ProviderConfig, req: ProviderRequest): Promise<string> {
  return withTimeout(async (signal) => {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal,
      headers: {
        "content-type": "application/json",
        "x-api-key": cfg.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: cfg.model,
        max_tokens: req.maxOutputTokens,
        system: req.system,
        messages: [{ role: "user", content: req.user }],
      }),
    });

    if (!response.ok) throw classifyStatus(response.status, await response.text());

    const body = await response.json();
    const text = body?.content?.find((c: { type: string }) => c.type === "text")?.text;
    if (typeof text !== "string") {
      throw new ProviderError("Provider returned no text content", "BAD_RESPONSE");
    }
    return text;
  });
}

// ---------------------------------------------------------------------------
// Google Gemini
// ---------------------------------------------------------------------------

async function callGemini(cfg: ProviderConfig, req: ProviderRequest): Promise<string> {
  return withTimeout(async (signal) => {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(cfg.model)}:generateContent`;

    const response = await fetch(url, {
      method: "POST",
      signal,
      headers: {
        "content-type": "application/json",
        // Header rather than a query parameter: keys in URLs end up in logs.
        "x-goog-api-key": cfg.apiKey,
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: req.system }] },
        contents: [{ role: "user", parts: [{ text: req.user }] }],
        generationConfig: {
          maxOutputTokens: req.maxOutputTokens,
          temperature: 0,
          responseMimeType: "application/json",
        },
      }),
    });

    if (!response.ok) throw classifyStatus(response.status, await response.text());

    const body = await response.json();
    const text = body?.candidates?.[0]?.content?.parts
      ?.map((p: { text?: string }) => p.text ?? "")
      .join("");
    if (typeof text !== "string" || text.length === 0) {
      throw new ProviderError("Provider returned no text content", "BAD_RESPONSE");
    }
    return text;
  });
}

// ---------------------------------------------------------------------------
// Groq (OpenAI-compatible chat completions)
// ---------------------------------------------------------------------------

async function callGroq(cfg: ProviderConfig, req: ProviderRequest): Promise<string> {
  return withTimeout(async (signal) => {
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      signal,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: cfg.model,
        max_tokens: req.maxOutputTokens,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: req.system },
          { role: "user", content: req.user },
        ],
      }),
    });

    if (!response.ok) throw classifyStatus(response.status, await response.text());

    const body = await response.json();
    const text = body?.choices?.[0]?.message?.content;
    if (typeof text !== "string") {
      throw new ProviderError("Provider returned no text content", "BAD_RESPONSE");
    }
    return text;
  });
}

const ADAPTERS: Record<ProviderName, (cfg: ProviderConfig, req: ProviderRequest) => Promise<string>> = {
  anthropic: callAnthropic,
  gemini: callGemini,
  groq: callGroq,
};

function primary(): ProviderConfig | null {
  if (config.ai.provider === "none" || !config.ai.apiKey) return null;
  return { provider: config.ai.provider, model: config.ai.model, apiKey: config.ai.apiKey };
}

function fallback(): ProviderConfig | null {
  const fb = config.ai.fallback;
  if (!fb || !fb.apiKey) return null;
  return { provider: fb.provider, model: fb.model, apiKey: fb.apiKey };
}

/**
 * Run the request against the configured provider, falling back to the
 * secondary one when the primary is unavailable or rate limited.
 *
 * A BAD_RESPONSE is not retried on the fallback: the request itself was wrong,
 * so a second provider would reject it too.
 */
export async function generate(req: ProviderRequest): Promise<ProviderResult> {
  const candidates = [primary(), fallback()].filter(Boolean) as ProviderConfig[];
  if (candidates.length === 0) {
    throw new ProviderError("No AI provider is configured", "UNAVAILABLE");
  }

  let lastError: ProviderError | null = null;

  for (const [index, cfg] of candidates.entries()) {
    const started = Date.now();
    try {
      const text = await ADAPTERS[cfg.provider](cfg, req);
      return { text, provider: cfg.provider, model: cfg.model, latencyMs: Date.now() - started };
    } catch (error) {
      const providerError =
        error instanceof ProviderError
          ? error
          : new ProviderError(error instanceof Error ? error.message : String(error), "UNAVAILABLE");

      // Never log the prompt or the key — only which provider failed and why.
      logger.warn(
        { provider: cfg.provider, kind: providerError.kind, attempt: index + 1 },
        "AI provider call failed",
      );

      if (providerError.kind === "BAD_RESPONSE") throw providerError;
      lastError = providerError;
    }
  }

  throw lastError ?? new ProviderError("All AI providers failed", "UNAVAILABLE");
}
