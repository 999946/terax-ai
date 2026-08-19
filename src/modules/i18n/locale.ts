import type { Locale, LocalePreference } from "./types";

export function resolveLocale(
  preference: LocalePreference,
  systemLanguage = typeof navigator === "undefined" ? "en" : navigator.language,
): Locale {
  if (preference === "en" || preference === "zh-CN") return preference;
  return systemLanguage.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}

export function isLocalePreference(value: unknown): value is LocalePreference {
  return value === "system" || value === "en" || value === "zh-CN";
}

export function interpolate(
  value: string,
  params?: Record<string, string | number>,
): string {
  if (!params) return value;
  return value.replace(/\{(\w+)\}/g, (match, key: string) =>
    key in params ? String(params[key]) : match,
  );
}
