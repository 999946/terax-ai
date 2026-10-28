import { afterEach, describe, expect, it, vi } from "vitest";
import { editorDiagnosticsEnabled } from "@/modules/editor/lib/editorDiagnosticsEnabled";

describe("editor diagnostic switch", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("has no release work until diagnostics are enabled", () => {
    vi.stubEnv("DEV", false);
    const getItem = vi.fn().mockReturnValue(null);
    vi.stubGlobal("window", { localStorage: { getItem } });
    expect(editorDiagnosticsEnabled()).toBe(false);
    getItem.mockReturnValue("1");
    expect(editorDiagnosticsEnabled()).toBe(true);
  });

  it("tolerates webviews that disable local storage", () => {
    vi.stubEnv("DEV", false);
    vi.stubGlobal("window", {
      get localStorage() {
        throw new Error("denied");
      },
    });
    expect(editorDiagnosticsEnabled()).toBe(false);
  });
});
