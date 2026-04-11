const enLocale = require("./locales/en");
const plLocale = require("./locales/pl");
const ukLocale = require("./locales/uk");

const SUPPORTED_LOCALES = ["pl", "en", "uk"];
const DEFAULT_LOCALE = "en";

const LOCALE_LABELS = {
  pl: "Polski",
  en: "English",
  uk: "Українська",
};

const LOCALE_RESOURCES = {
  pl: plLocale,
  en: enLocale,
  uk: ukLocale,
};

const DIACRITIC_CHAR_CLASS = {
  a: "[aą]",
  c: "[cć]",
  e: "[eę]",
  l: "[lł]",
  n: "[nń]",
  o: "[oó]",
  s: "[sś]",
  z: "[zźż]",
};

const escapeRegExp = (text) =>
  String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function normalizeLocale(rawLocale) {
  if (typeof rawLocale !== "string") {
    return null;
  }
  const candidate = rawLocale.trim().toLowerCase();
  if (SUPPORTED_LOCALES.includes(candidate)) {
    return candidate;
  }
  return null;
}

function detectLocaleFromHeader(rawHeader) {
  const header = String(rawHeader || "").trim();
  if (!header) {
    return null;
  }

  const candidates = header
    .split(",")
    .map((item) => item.trim().split(";")[0].toLowerCase())
    .map((item) => item.split("-")[0]);

  for (const candidate of candidates) {
    if (SUPPORTED_LOCALES.includes(candidate)) {
      return candidate;
    }
  }
  return null;
}

function normalizeKey(rawValue) {
  return String(rawValue || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

const normalizedStaticMap = {};
const englishKeyByNormalized = new Map();
const legacyPolishSourceToEnglishKey = new Map();
const LEGACY_SOURCE_ALIASES = {
  Logowanie: "Sign in",
  Rejestracja: "Sign up",
  "Zmiana hasla": "Change password",
  Ukonczona: "Completed",
};

for (const locale of SUPPORTED_LOCALES) {
  const map = new Map();
  const staticEntries = LOCALE_RESOURCES[locale]?.static || {};

  for (const [source, translated] of Object.entries(staticEntries)) {
    map.set(normalizeKey(source), translated);
  }

  normalizedStaticMap[locale] = map;
}

for (const englishKey of Object.keys(enLocale.static || {})) {
  englishKeyByNormalized.set(normalizeKey(englishKey), englishKey);
}

for (const [englishKey, polishValue] of Object.entries(plLocale.static || {})) {
  const normalizedPolish = normalizeKey(polishValue);
  if (!legacyPolishSourceToEnglishKey.has(normalizedPolish)) {
    legacyPolishSourceToEnglishKey.set(normalizedPolish, englishKey);
  }
}

for (const [legacySource, englishKey] of Object.entries(LEGACY_SOURCE_ALIASES)) {
  legacyPolishSourceToEnglishKey.set(normalizeKey(legacySource), englishKey);
}

function resolveEnglishKey(sourceText) {
  const normalized = normalizeKey(sourceText);
  return (
    englishKeyByNormalized.get(normalized) ||
    legacyPolishSourceToEnglishKey.get(normalized) ||
    null
  );
}

function translateFromStatic(locale, sourceText) {
  const englishKey = resolveEnglishKey(sourceText);
  if (!englishKey) {
    return null;
  }
  return (LOCALE_RESOURCES[locale]?.static || {})[englishKey] || null;
}

function translateFromDynamic(locale, sourceText) {
  const rules = LOCALE_RESOURCES[locale]?.dynamic || [];
  for (const rule of rules) {
    if (!(rule.pattern instanceof RegExp) || typeof rule.replace !== "function") {
      continue;
    }

    const match = String(sourceText).match(rule.pattern);
    if (!match) {
      continue;
    }

    return rule.replace(...match.slice(1));
  }
  return null;
}

function translateWithLocaleOnly(locale, sourceText) {
  const staticTranslation = translateFromStatic(locale, sourceText);
  if (staticTranslation) {
    return staticTranslation;
  }

  const dynamicTranslation = translateFromDynamic(locale, sourceText);
  if (dynamicTranslation) {
    return dynamicTranslation;
  }

  return null;
}

function translate(locale, sourceText) {
  if (!sourceText) {
    return sourceText;
  }

  const resolvedLocale = normalizeLocale(locale) || DEFAULT_LOCALE;
  const localized = translateWithLocaleOnly(resolvedLocale, sourceText);
  if (localized) {
    return localized;
  }

  if (resolvedLocale !== "en") {
    const englishFallback = translateWithLocaleOnly("en", sourceText);
    if (englishFallback) {
      return englishFallback;
    }
  }

  return sourceText;
}

function charToRegexFragment(character) {
  if (/\s/u.test(character)) {
    return "\\s+";
  }

  const normalized = character
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

  if (DIACRITIC_CHAR_CLASS[normalized]) {
    return DIACRITIC_CHAR_CLASS[normalized];
  }

  return escapeRegExp(character);
}

const allSourceKeys = Array.from(
  new Set([
    ...Object.keys(enLocale.static || {}),
    ...Object.keys(plLocale.static || {}),
    ...Object.keys(ukLocale.static || {}),
    ...Object.values(plLocale.static || {}),
    ...Object.keys(LEGACY_SOURCE_ALIASES),
  ])
);

const htmlReplaceRules = allSourceKeys
  .sort((left, right) => right.length - left.length)
  .map((sourceKey) => ({
    regex: new RegExp(
      `(?<![\\p{L}\\p{N}])${
        sourceKey
          .split("")
          .map((character) => charToRegexFragment(character))
          .join("")
      }(?![\\p{L}\\p{N}])`,
      "giu"
    ),
    sourceKey,
  }));

function translateHtml(locale, html) {
  if (!html) {
    return html;
  }

  const resolvedLocale = normalizeLocale(locale) || DEFAULT_LOCALE;
  const scriptOrStyleBlocks = [];
  const protectedHtml = String(html).replace(
    /<(script|style)\b[^>]*>[\s\S]*?<\/\1>/giu,
    (block) => {
      const token = `__I18N_BLOCK_${scriptOrStyleBlocks.length}__`;
      scriptOrStyleBlocks.push(block);
      return token;
    }
  );

  function translateFragment(fragment) {
    let result = fragment;

    for (const rule of htmlReplaceRules) {
      const replacement = translate(resolvedLocale, rule.sourceKey);
      if (!replacement || replacement === rule.sourceKey) {
        continue;
      }
      result = result.replace(rule.regex, replacement);
    }

    const localizedDynamicRules = LOCALE_RESOURCES[resolvedLocale]?.dynamic || [];
    for (const rule of localizedDynamicRules) {
      if (!(rule.pattern instanceof RegExp) || typeof rule.replace !== "function") {
        continue;
      }
      result = result.replace(rule.pattern, (...args) => {
        const groups = args.slice(1, -2);
        return rule.replace(...groups);
      });
    }

    if (resolvedLocale !== "en") {
      for (const rule of enLocale.dynamic || []) {
        if (!(rule.pattern instanceof RegExp) || typeof rule.replace !== "function") {
          continue;
        }
        result = result.replace(rule.pattern, (...args) => {
          const groups = args.slice(1, -2);
          return rule.replace(...groups);
        });
      }
    }

    return result;
  }

  const translated = protectedHtml.replace(/>([^<>]+)</g, (match, content) => {
    return `>${translateFragment(content)}<`;
  });

  return translated.replace(/__I18N_BLOCK_(\d+)__/g, (_token, indexRaw) => {
    const index = Number(indexRaw);
    return scriptOrStyleBlocks[index] || "";
  });
}

function withLocale(currentUrl, localeCode) {
  const safeLocale = normalizeLocale(localeCode) || DEFAULT_LOCALE;
  const input = String(currentUrl || "/");
  const [pathnameRaw, queryRaw = ""] = input.split("?");
  const pathname = pathnameRaw || "/";
  const params = new URLSearchParams(queryRaw);
  params.set("lang", safeLocale);
  const queryString = params.toString();
  return queryString ? `${pathname}?${queryString}` : pathname;
}

module.exports = {
  SUPPORTED_LOCALES,
  DEFAULT_LOCALE,
  LOCALE_LABELS,
  normalizeLocale,
  detectLocaleFromHeader,
  translate,
  translateHtml,
  withLocale,
};
