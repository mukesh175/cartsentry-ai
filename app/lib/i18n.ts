/**
 * Minimal translation layer.
 *
 * Deliberately small: the point right now is that UI strings live behind a
 * lookup rather than inline in components, so adding a locale later is a data
 * change and not a rewrite of every screen. English is the only bundled locale.
 *
 * When a locale is added, replace `DICTIONARIES` with per-locale files and read
 * the active locale from the Shopify session's `locale`. Nothing else in the
 * app needs to change.
 */

export type Locale = "en";

/** Locales the architecture is ready for; only `en` currently has a dictionary. */
export const PLANNED_LOCALES = ["en", "hi", "es", "fr", "de", "pt"] as const;

const en: Record<string, string> = {
  "app.name": "CartSentry AI",
  "app.tagline": "Prevent invalid purchases before checkout.",

  "rule.status.ACTIVE": "Active",
  "rule.status.DRAFT": "Draft",
  "rule.status.DISABLED": "Disabled",
  "rule.status.ARCHIVED": "Archived",
  "rule.status.ERROR": "Error",
  "rule.status.NEEDS_ATTENTION": "Needs attention",

  "conflict.severity.CRITICAL": "Critical",
  "conflict.severity.HIGH": "High",
  "conflict.severity.MEDIUM": "Medium",
  "conflict.severity.LOW": "Low",
  "conflict.severity.INFO": "Info",

  "conflict.confidence.confirmed": "Confirmed conflict",
  "conflict.confidence.potential": "Potential conflict",
  "conflict.confidence.overlap": "Possible overlap",

  "outcome.PASS": "Pass",
  "outcome.WARNING": "Warning",
  "outcome.BLOCKED": "Blocked",
  "outcome.NOT_APPLICABLE": "Did not apply",
  "outcome.DEFERRED": "Not yet determinable",

  "action.BLOCK": "Block purchase",
  "action.WARN": "Warn customer",
};

const DICTIONARIES: Record<Locale, Record<string, string>> = { en };

let activeLocale: Locale = "en";

export function setLocale(locale: string): void {
  const base = locale.split("-")[0] as Locale;
  if (base in DICTIONARIES) activeLocale = base;
}

/**
 * Look up a string. Returns the key itself when missing, which makes an
 * untranslated string obvious in the UI rather than rendering as blank.
 */
export function t(key: string, replacements?: Record<string, string | number>): string {
  const template = DICTIONARIES[activeLocale][key] ?? DICTIONARIES.en[key] ?? key;
  if (!replacements) return template;

  return Object.entries(replacements).reduce(
    (text, [name, value]) => text.replaceAll(`{${name}}`, String(value)),
    template,
  );
}
