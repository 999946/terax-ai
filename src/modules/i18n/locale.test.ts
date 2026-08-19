import { describe, expect, it } from "vitest";
import { interpolate, isLocalePreference, resolveLocale } from "./locale";

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
});
