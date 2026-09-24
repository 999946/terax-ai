import "../styles/globals.css";

import { USE_CUSTOM_WINDOW_CONTROLS } from "@/lib/platform";
import "@/modules/i18n/config";
import { LocaleProvider } from "@/modules/i18n";
import { ThemeProvider } from "@/modules/theme";
import { getCurrentWindow } from "@tauri-apps/api/window";
import ReactDOM from "react-dom/client";
import { SettingsApp } from "./SettingsApp";

if (USE_CUSTOM_WINDOW_CONTROLS) {
  document.documentElement.dataset.chrome = "borderless";
}

ReactDOM.createRoot(
  document.getElementById("settings-root") as HTMLElement,
).render(
  <LocaleProvider>
    <ThemeProvider>
      <SettingsApp />
    </ThemeProvider>
  </LocaleProvider>,
);

const showWindow = () => {
  getCurrentWindow()
    .show()
    .catch((e) => console.error("settings show failed:", e));
};
// rAF is throttled while the webview is hidden, so a hidden settings window
// can sit invisible for a long time before the callback fires. Use a plain
// timeout like the main window does. A 500 ms safety net forces the show again
// if the first attempt was swallowed while the window was still settling.
setTimeout(showWindow, 50);
setTimeout(showWindow, 500);
