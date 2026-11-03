import { beforeEach, describe, expect, it, vi } from "vitest";

// The preferences store reads Tauri persistence on import in the app; stub the
// module so the pure matcher can be exercised with an in-memory override map.
const userShortcuts: Record<string, unknown> = {};
vi.mock("@/modules/settings/preferences", () => ({
  usePreferencesStore: {
    getState: () => ({ shortcuts: userShortcuts }),
  },
}));

const { matchesShortcut } = await import("./matchesShortcut");

function event(over: Partial<KeyboardEvent>): KeyboardEvent {
  return {
    key: "",
    code: "",
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    ...over,
  } as KeyboardEvent;
}

describe("matchesShortcut", () => {
  beforeEach(() => {
    for (const key of Object.keys(userShortcuts)) delete userShortcuts[key];
  });

  it("matches the diff viewer's default bindings", () => {
    expect(matchesShortcut(event({ key: "F7" }), "diff.nextDifference")).toBe(
      true,
    );
    expect(
      matchesShortcut(
        event({ key: "F7", shiftKey: true }),
        "diff.prevDifference",
      ),
    ).toBe(true);
    expect(matchesShortcut(event({ key: "F4" }), "diff.jumpToSource")).toBe(
      true,
    );
  });

  it("rejects the same key with a stray modifier", () => {
    expect(
      matchesShortcut(
        event({ key: "F7", metaKey: true }),
        "diff.nextDifference",
      ),
    ).toBe(false);
  });

  it("prefers a user override over the default binding", () => {
    userShortcuts["diff.nextDifference"] = [{ key: "F8" }];
    expect(matchesShortcut(event({ key: "F7" }), "diff.nextDifference")).toBe(
      false,
    );
    expect(matchesShortcut(event({ key: "F8" }), "diff.nextDifference")).toBe(
      true,
    );
  });
});
