import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { en } from "./messages/en";
import { zhCN } from "./messages/zh-CN";

export const resources = {
  en: { translation: en },
  "zh-CN": { translation: zhCN },
} as const;

void i18n.use(initReactI18next).init({
  resources,
  lng: "en",
  fallbackLng: "en",
  supportedLngs: ["en", "zh-CN"],
  defaultNS: "translation",
  ns: ["translation"],
  keySeparator: false,
  interpolation: {
    escapeValue: false,
    prefix: "{",
    suffix: "}",
  },
  react: {
    useSuspense: false,
  },
});

export default i18n;
