import { describe, expect, it } from "vitest";
import { en } from "./messages/en";
import { zhCN } from "./messages/zh-CN";
import { interpolate, isLocalePreference, resolveLocale } from "./locale";

const placeholders = (message: string) =>
  [...message.matchAll(/{([^{}]+)}/g)].map((match) => match[1]).sort();

describe("locale", () => {
  it("resolves Chinese system locales", () => {
    expect(resolveLocale("system", "zh-CN")).toBe("zh-CN");
    expect(resolveLocale("system", "zh-TW")).toBe("zh-CN");
  });

  it("falls back to English for other system locales", () => {
    expect(resolveLocale("system", "fr-FR")).toBe("en");
  });

  it("honors explicit preferences", () => {
    expect(resolveLocale("en", "zh-CN")).toBe("en");
    expect(resolveLocale("zh-CN", "en-US")).toBe("zh-CN");
  });

  it("validates preferences and interpolates values", () => {
    expect(isLocalePreference("en")).toBe(true);
    expect(isLocalePreference("fr")).toBe(false);
    expect(interpolate("Install v{version}", { version: "1.2.3" })).toBe(
      "Install v1.2.3",
    );
  });

  it("keeps English and Chinese message keys in parity", () => {
    expect(Object.keys(zhCN).sort()).toEqual(Object.keys(en).sort());
  });

  it("keeps interpolation placeholders in parity between locales", () => {
    for (const key of Object.keys(en) as Array<keyof typeof en>) {
      expect(placeholders(zhCN[key]), key).toEqual(placeholders(en[key]));
    }
  });
});
