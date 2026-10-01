import { defaultExclude, defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./vite.config";

// Vitest reuses the app's Vite config (aliases, plugins). We only add a test
// block here so we don't mix Vite build options with test settings.
//
// `.claude/worktrees/**` are Claude Code worktree checkouts that live inside
// the repo but must never be picked up by the test runner — they resolve
// packages against a different module graph and produce duplicate/flaky runs
// (seen as intermittent languageResolver failures under parallel execution).
//
// `languageResolver` loads `@replit/codemirror-lang-svelte`, whose
// `svelteLanguage` is a module-level singleton wired to CodeMirror's shared
// javascript/css language instances. Under vitest's default threaded pool,
// parallel workers race that shared setup and intermittently drop the nested
// directives (`on:click` → `DirectiveOn`), failing the Svelte tree assertion.
// Routing just this file to a dedicated serial forks project keeps the rest of
// the suite parallel-fast and makes the Svelte parse deterministic.
const SERIAL_FILE = "src/modules/editor/lib/languageResolver.test.ts";

export default defineConfig(async (env) => {
  // The app's Vite config (aliases, plugins). Inline projects do NOT inherit
  // the root's `resolve`, so each project re-merges the full base config.
  const base = await viteConfig(env);
  const commonTest = {
    exclude: [...defaultExclude, ".claude/**"],
  };
  const projects = [
    // Everything except the Svelte file, on the default fast pool.
    mergeConfig(base, {
      test: {
        ...commonTest,
        name: "main",
        exclude: [...defaultExclude, ".claude/**", SERIAL_FILE],
      },
    }),
    // Just the Svelte language test, isolated in its own serial process.
    mergeConfig(base, {
      test: {
        ...commonTest,
        name: "languageResolver-serial",
        include: [SERIAL_FILE],
        pool: "forks",
        fileParallelism: false,
      },
    }),
  ];
  return mergeConfig(base, { test: { ...commonTest, projects } });
});
