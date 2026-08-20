import { usePreferencesStore } from "@/modules/settings/preferences";
import { useEffect, type ReactNode } from "react";
import i18n from "./config";
import { resolveLocale } from "./locale";

export function LocaleProvider({ children }: { children: ReactNode }) {
  const preference = usePreferencesStore((s) => s.locale);
  const locale = resolveLocale(preference);

  useEffect(() => {
    if (i18n.language !== locale) void i18n.changeLanguage(locale);
  }, [locale]);

  return children;
}
