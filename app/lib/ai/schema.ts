/**
 * The contract for AI output.
 *
 * Deliberately in its own module with **no server dependencies** — no Prisma,
 * no config, no logger. This is the security boundary for AI-generated content
 * (see docs/SECURITY.md), and it must be testable and reviewable without a
 * database or a configured environment standing behind it.
 *
 * `rule-creator.server.ts` re-exports this for convenience.
 */

import { z } from "zod";

import { RuleDefinitionSchema } from "@cartsentry/engine";

/**
 * What the model is allowed to return.
 *
 * Two shapes only: a rule, or a request for clarification. There is no free-text
 * escape hatch, which is what makes the output safe to act on. A prompt
 * injection that succeeds at the model level still cannot produce a condition
 * kind that does not exist, a non-Shopify global ID, an unsupported customer
 * tag, or an action outside WARN/BLOCK — this schema rejects all of it.
 */
export const AIRuleResponseSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("rule"),
    name: z.string().min(1).max(120),
    description: z.string().max(500).default(""),
    message: z.string().min(1).max(255),
    priority: z.number().int().min(0).max(100).default(50),
    definition: RuleDefinitionSchema,
    /** Anything the model had to assume, surfaced to the merchant for review. */
    assumptions: z.array(z.string().max(300)).max(6).default([]),
    confidence: z.enum(["high", "medium", "low"]),
  }),
  z.object({
    kind: z.literal("clarification"),
    /** The specific ambiguity, phrased as a question the merchant can answer. */
    question: z.string().min(1).max(400),
    options: z.array(z.string().max(200)).min(2).max(4),
  }),
]);

export type AIRuleResponse = z.infer<typeof AIRuleResponseSchema>;
