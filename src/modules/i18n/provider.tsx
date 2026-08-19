import { usePreferencesStore } from "@/modules/settings/preferences";
import { setLocale } from "@/modules/settings/store";
import { createContext, useContext, useMemo, type ReactNode } from "react";
import { en } from "./messages/en";
import { zhCN } from "./messages/zh-CN";
import { interpolate, resolveLocale } from "./locale";
import type { Locale, LocalePreference } from "./types";

const messages: Record<Locale, Record<string, string>> = { en, "zh-CN": zhCN };
type MessageKey = string;

type LocaleContextValue = {
  locale: Locale;
  preference: LocalePreference;
  setPreference: (preference: LocalePreference) => void;
  t: (key: MessageKey, params?: Record<string, string | number>) => string;
};

const LocaleContext = createContext<LocaleContextValue | null>(null);

export function LocaleProvider({ children }: { children: ReactNode }) {
  const preference = usePreferencesStore((s) => s.locale);
  const locale = resolveLocale(preference);
  const value = useMemo<LocaleContextValue>(
    () => ({
      locale,
      preference,
      setPreference: (next) => void setLocale(next),
      t: (key, params) => {
        const value = messages[locale][key] ?? messages.en[key] ?? key;
        return interpolate(value, params);
      },
    }),
    [locale, preference],
  );
  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useLocale(): LocaleContextValue {
  const context = useContext(LocaleContext);
  if (!context) throw new Error("useLocale must be used within LocaleProvider");
  return context;
}
