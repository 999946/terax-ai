import { defaultExclude, defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./vite.config";

// Vitest reuses the app's Vite config (aliases, plugins). We only add a test
// block here so we don't mix Vite build options with test settings.
//
// `.claude/worktrees/**` are Claude Code worktree checkouts that live inside
// the repo but must never be picked up by the test runner — they resolve
// packages against a different module graph and produce duplicate/flaky runs
// (seen as intermittent languageResolver failures under parallel execution).
export default defineConfig(async (env) =>
  mergeConfig(await viteConfig(env), {
    test: {
      exclude: [...defaultExclude, ".claude/**"],
    },
  }),
);
