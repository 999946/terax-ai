export type LocalePreference = "system" | "en" | "zh-CN";
export type Locale = "en" | "zh-CN";

export type MessageValue = string | ((params?: Record<string, string | number>) => string);
export type Messages = Record<string, MessageValue>;
