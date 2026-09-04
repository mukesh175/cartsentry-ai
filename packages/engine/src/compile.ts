/**
 * Compiles stored rules into the compact configuration the Shopify Function
 * reads at runtime.
 *
 * Why a separate representation:
 *   - the Function receives its configuration as a metafield on the Validation,
 *     and metafield values are size-capped, so verbose keys are expensive
 *   - stored rules carry admin-only data (descriptions, cached titles, warning
 *     styling) that the Function has no use for
 *   - keeping the wire format separate means the merchant-facing schema can
 *     evolve without a Shopify redeploy
 *
 * The compiled form is still evaluated by the *same* evaluator, so the
 * simulator and production agree. `expand()` is the inverse used by tests and
 * by the Function to rebuild `EvaluableRule`s.
 *
 * No Node imports — this module is bundled into the Function.
 */

import type { RuleDefinition } from "./rule-schema";
import type { EvaluableRule } from "./evaluate";

/** Shopify caps metafield values; stay well under it and fail loudly if we near it. */
export const MAX_CONFIG_BYTES = 60_000;

export interface CompiledRule {
  /** Rule id, so runtime events can be attributed back to a rule. */
  i: string;
  /** Name — kept because merchants need it in error attribution, kept short. */
  n: string;
  /** Priority. */
  p: number;
  /** Customer-facing message. */
  m: string;
  /** The definition, unchanged. It is already compact and fully typed. */
  d: RuleDefinition;
}

export interface CompiledConfig {
  /** Config format version, so an older deployed Function can refuse a newer config. */
  v: 1;
  rules: CompiledRule[];
  /**
   * Collection membership, resolved at compile time: collection gid -> product gids.
   *
   * The Function cannot resolve this at runtime. `Product.inAnyCollection(ids:)`
   * needs literal collection IDs, and a Function's input query is static per
   * deploy, so per-shop collection IDs cannot be injected into it. We therefore
   * expand collections through the Admin API when compiling and refresh the
   * expansion on collection webhooks.
   *
   * Trade-off, documented in docs/LIMITATIONS.md: very large collections inflate
   * the configuration, and membership changes take effect on the next publish
   * rather than instantly.
   */
  c: Record<string, string[]>;
}

export interface CompileResult {
  config: CompiledConfig;
  json: string;
  byteSize: number;
  checksum: string;
  /** Non-fatal notes worth showing the merchant, e.g. rules skipped. */
  warnings: string[];
}

export interface CompilableRule {
  id: string;
  name: string;
  priority: number;
  message: string;
  definition: RuleDefinition;
  status: string;
}

/**
 * FNV-1a. A checksum here only needs to answer "did the config change?" so a
 * fast non-cryptographic hash is the right tool; it is never a security
 * boundary.
 */
export function checksum(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

/**
 * Build the runtime configuration from a shop's rules.
 *
 * Only ACTIVE rules are compiled. A rule referencing a deleted resource is
 * skipped rather than compiled, because the Function cannot evaluate it and a
 * silently-always-true rule would be worse than an absent one.
 */
export function compile(
  rules: CompilableRule[],
  collectionMembers: Record<string, string[]> = {},
): CompileResult {
  const warnings: string[] = [];
  const compiled: CompiledRule[] = [];

  for (const rule of rules) {
    if (rule.status !== "ACTIVE") continue;

    const missing = missingResourceTitles(rule.definition);
    if (missing.length > 0) {
      warnings.push(
        `"${rule.name}" was not published because it references ${missing.join(", ")}, which no longer exist in this store.`,
      );
      continue;
    }

    compiled.push({
      i: rule.id,
      n: rule.name,
      p: rule.priority,
      m: rule.message,
      d: rule.definition,
    });
  }

  // Highest priority first, so the Function emits the most important message
  // first without re-sorting at runtime.
  compiled.sort((a, b) => (b.p !== a.p ? b.p - a.p : a.n.localeCompare(b.n)));

  // Only ship membership for collections the compiled rules actually reference,
  // so an unused large collection never inflates the configuration.
  const referenced = new Set<string>();
  for (const rule of compiled) {
    for (const condition of rule.d.conditions) {
      if ("collection" in condition && condition.collection) {
        referenced.add(condition.collection.gid);
      }
    }
  }
  const c: Record<string, string[]> = {};
  for (const gid of referenced) {
    c[gid] = collectionMembers[gid] ?? [];
    if (!collectionMembers[gid]) {
      warnings.push(
        `Collection membership for one of the referenced collections could not be resolved, so rules using it will not match any items until the next successful publish.`,
      );
    }
  }

  const config: CompiledConfig = { v: 1, rules: compiled, c };
  const json = JSON.stringify(config);
  const size = byteLength(json);

  if (size > MAX_CONFIG_BYTES) {
    warnings.push(
      `The compiled configuration is ${size} bytes, over the ${MAX_CONFIG_BYTES} byte limit. Reduce the number of active rules or shorten rule messages.`,
    );
  }

  return { config, json, byteSize: size, checksum: checksum(json), warnings };
}

/** True when the config is too large to publish. */
export function exceedsSizeLimit(result: CompileResult): boolean {
  return result.byteSize > MAX_CONFIG_BYTES;
}

function missingResourceTitles(definition: RuleDefinition): string[] {
  const missing: string[] = [];
  for (const condition of definition.conditions) {
    if ("product" in condition && condition.product?.missing) {
      missing.push(`the product "${condition.product.title || "unknown"}"`);
    }
    if ("variant" in condition && condition.variant?.missing) {
      missing.push(`the variant "${condition.variant.title || "unknown"}"`);
    }
    if ("collection" in condition && condition.collection?.missing) {
      missing.push(`the collection "${condition.collection.title || "unknown"}"`);
    }
  }
  return missing;
}

/** Inverse of `compile` — rebuild evaluable rules from the wire format. */
export function expand(config: CompiledConfig): EvaluableRule[] {
  return config.rules.map((r) => ({
    id: r.i,
    name: r.n,
    priority: r.p,
    message: r.m,
    definition: r.d,
  }));
}

/**
 * Parse a configuration string that came from a metafield.
 * Returns an empty rule set rather than throwing: a Function that crashes
 * blocks checkout for everyone, so an unreadable config must fail open.
 */
export function safeParseConfig(raw: string | null | undefined): CompiledConfig {
  if (!raw) return { v: 1, rules: [], c: {} };
  try {
    const parsed = JSON.parse(raw) as CompiledConfig;
    if (!parsed || parsed.v !== 1 || !Array.isArray(parsed.rules)) {
      return { v: 1, rules: [], c: {} };
    }
    return { ...parsed, c: parsed.c ?? {} };
  } catch {
    return { v: 1, rules: [], c: {} };
  }
}
