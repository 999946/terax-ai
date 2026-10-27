# OpenIDEA feature review for Terax

> Review of [OpenIDEA](https://github.com/l0ng-ai/openidea) (an open-source Rust rewrite of the
> IntelliJ IDEA workflow), scoped against Terax. Written 2026-10. This is a product-decision
> reference, not an architecture spec. If it conflicts with `TERAX.md`, `TERAX.md` wins.
> The Chinese translation lives in `openidea-review_zh.md`.

## 1. Overview

OpenIDEA rebuilds the IntelliJ IDEA way of working (keymap, tool windows, Search Everywhere) as a
native app with a Rust core. 26 Rust crates, React 19 + CodeMirror 6 + Tauri 2 frontend, 60+
languages, macOS / Windows / Linux. Its selling point is lightness: opening a ~770-file project is
3 to 12x faster than IDEA.

OpenIDEA and Terax have opposite positions: it is a desktop IDE, Terax is a terminal-first,
lightweight ADE. The ROADMAP explicitly says `Not an IDE clone`. So most OpenIDEA features
(database, Docker, build tools, Spring Boot) should not be lifted. But five *mechanism-level*
borrowings add no bundle weight and do not violate the lightweight stance; they repay
architecture debt and sharpen the AI story.

## 2. Mechanism-level borrowings

### 1. Unified gutter Lane API for editor decorations (highest value)

**OpenIDEA** (`src/editor/api.ts`): a single `EditorContribution` registry through which every
feature contributes editor extensions:

- `gutterLaneMarkers`: one Facet shared by VCS changes, breakpoints, coverage, bookmarks and run
  markers on a single lane.
- `scrollbarMarks`: unified right-edge scrollbar overview Facet.
- `registerSaveParticipant`: save hooks.
- `getNavigationHistory`: back/forward.

Features import only `editor/api`, never editor internals; a `TextEditorHandle` exists only while
its tab is visible (background tabs keep just the EditorState).

**Terax today** (`src/modules/editor/lib/`): each feature builds its own gutter via `gutter()`:

- `modifiedLines.ts` -> `cm-ml-gutter` (3px change bar)
- `diffHunkMarkers.ts` -> `cm-hunk-check-gutter` (checkbox)
- `overviewRuler.ts` -> a standalone `cm-editor-overview` div

Problem: each gutter owns its own column width, so as features grow (changes + conflicts + LSP +
coverage + bookmarks) the gutter stack widens and misaligns; `overviewRuler` uses bare DOM instead
of a Facet, detached from the CodeMirror decoration system.

**Verdict**: this is debt repayment, not a new feature. Folding existing change bars, conflict
marks and the overview into a `gutterLaneMarkers`-style Facet makes future coverage / bookmarks /
breakpoints free. It adds no runtime cost and removes duplicate DOM.

### 2. Action registry + `when` conditions (IDEA ActionManager model)

**OpenIDEA** (`src/platform/actions.ts`):

```ts
registerAction({ id, title, category, when, keyWhen, toggled, run })
```

- Menus, keybindings, toolbars, the Search Everywhere Actions tab and plugin commands all resolve
  to the same registry.
- `when` is evaluated against ContextKeys; `toggled` lets toggle actions show an ON/OFF switch.
- Default keybindings live in the keymap layer, separate from the action; actions can take an
  `arg` from an invoker.
- Plugin commands inject through the same `register-action`, so actions themselves are the plugin
  extension point.

**Terax today** (`src/modules/command-palette/commands.ts`): `commands()` returns a static
`PaletteItem[]` array with hand-written `disabledReason`. Problems: registration is a static
array so plugins / features cannot add incrementally; there is no unified `when` evaluation, so
menus / toolbar / shortcuts each reference commands independently without a single source of
truth; commands only feed the palette, not an IDE-wide action bus.

**Verdict**: upgrade `commands.ts` into an action registry with pure-function `when`. Low cost
(no UI change), payoff is unified plugins + shortcuts + menus. Keep the existing keybinding
system compatible.

### 3. Read-only virtual documents

**OpenIDEA** (`EditorDocContext.virtual` + `editor/api.ts`): a read-only virtual document
(library class contents from a language server); `path` is its URI, not a file, so file-based
features (VCS, local history, TODO, breakpoints) are skipped.

**Terax today**: preview and editor are separate; there is no way to open library sources, remote
files or in-memory documents in an editor tab as read-only.

**Verdict**: matches the AI-native stance best: when an agent cites a library function, a remote
git file, or a grep hit, open it in an editor tab as a read-only virtual document.

### 4. Partial-hunk commit and diff navigation

**OpenIDEA** (`vcs/`): `DiffEditor` + `MergeEditor` + `DiffNavigator` + `hunkInclusion.ts`
(include/exclude hunks per commit) + `diffAnnotations`.

**Terax today**: `GitDiffPane.tsx` + `DiffOverview.tsx` + hunk-stage checkboxes
(`diffHunkMarkers.ts`) already cover diff view, per-hunk stage/unstage and the overview bar. Gaps:
`hunkInclusion` (selectively include hunks in a commit); `diffNavigator` (loop between diff
blocks); a three-way merge editor (conflict-resolution UI).

**Verdict**: partial-hunk commit and diff navigation are small, high-value, frontend-only. The
three-way merge editor is heavy; defer.

### 5. Run Anything quick execution

**OpenIDEA** (`runAnything.ts` + `contextRun.ts`): type-to-search run configs / actions, run in
the current directory context, before-launch hooks, external tools.

**Terax today**: block terminal reruns executed commands; the palette `Cmd+P` has files/history
modes; AI tools can run shell. But there is no single "type a command, pick one, run in a chosen
cwd" entry point.

**Verdict**: do not port the run-config concept. Add a `>` prefix execution mode to the command
palette (type a shell command, run in the active pane's cwd or open a new block). Fits the
terminal-first stance and reuses existing shell capability.

## 3. Priority matrix

| # | Borrowing | OpenIDEA mechanism | Terax landing spot | Cost | Fit |
|---|-----------|--------------------|--------------------|------|-----|
| 1 | Unified gutter Lane | `gutterLaneMarkers` Facet | `editor/lib` refactor | medium | high |
| 2 | Read-only virtual docs | `EditorDocContext.virtual` | AI tools -> editor | medium | high |
| 3 | Action registry + when | ActionManager | `command-palette` refactor | medium | high |
| 4 | Partial-hunk commit / diff nav | `hunkInclusion` + `DiffNavigator` | `GitDiffPane` | low | high |
| 5 | Run Anything quick execution | `runAnything` | `command-palette` | low | high |

## 4. Explicitly out of scope

Conflict with the "Not an IDE clone" stance; excluded:

- Database tools (sqlx connection pools + object browser)
- Maven / Gradle build-tool windows
- Docker / GitHub PR services tree
- Spring Boot / jdtls Java debugging (JVM toolchain)
- WASM plugin host (wasmtime); Terax already ships a JS plugin system, rewrite cost is high

## 5. Conclusion

The most valuable borrowings from OpenIDEA are three architecture mechanisms: the unified gutter
Lane, read-only virtual documents, and the action registry. They add no bundle weight, do not
violate the lightweight stance, repay architecture debt and sharpen the AI story, aligning with
the ROADMAP's "AI as a primitive + lightweight always". The rest are candidates to schedule by
user demand.

## See also

- [TERAX.md](../../TERAX.md) - the architecture source of truth
- [ROADMAP.md](../../ROADMAP.md) - product direction and scope
- [docs/README.md](../README.md) - index of contributor guides
