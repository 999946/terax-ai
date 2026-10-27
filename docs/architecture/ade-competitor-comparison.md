# ADE competitor comparison: OpenIDEA vs Lithe vs Terax

> Three-way comparison of [OpenIDEA](https://github.com/l0ng-ai/openidea) (Rust rewrite of the
> IntelliJ IDEA workflow), [Lithe-IDEA](https://github.com/1lck/Lithe-IDEA) (a low-memory IntelliJ
> IDEA alternative for Java and AI collaboration), and Terax (an AI-native, terminal-first ADE).
> Written 2026-10 from source-level review of each repo. This is a product-decision reference, not
> an architecture spec. If it conflicts with `TERAX.md`, `TERAX.md` wins. The Chinese translation
> lives in `ade-competitor-comparison_zh.md`.

## 1. Overview

| | OpenIDEA | Lithe (Lithe-IDEA) | Terax |
|---|---|---|---|
| Repo | `l0ng-ai/openidea` | `1lck/Lithe-IDEA` | `crynta/terax-ai` |
| Positioning | Desktop IDE, IntelliJ workflow clone (lightweight) | Low-memory IntelliJ IDEA alternative, Java/Spring-Boot-first + AI collaboration | Terminal-first, AI-native ADE |
| Primary language focus | 60+ languages | Java / Spring Boot first; many languages on demand | Polyglot, terminal-first |
| Frontend | React 19 + CodeMirror 6 + Tauri 2 | macOS: SwiftUI/AppKit + Monaco; Windows: React + Monaco + Tauri 2 | React 19 + TS + libghostty-vt WASM + Tauri 2 |
| Backend | 26 Rust crates | Rust `lithe-core` + `lithe-git-host` + host adapters | Rust single-crate (git, pty, fs, agent) |
| Editor engine | CodeMirror 6 (custom) | Monaco 0.55 (VS Code engine) | CodeMirror-like custom + Ghostty terminal model |
| Memory | lightweight claim | 300-400 MB baseline after opening a project | ~7-8 MB bundle, minimal RAM |
| AI story | IDE actions + LSP; not AI-native | AI agents, AI commit messages, provider import from local tools | AI as a native primitive (agents, autocomplete, voice) |

## 2. Positioning and philosophy

**OpenIDEA** is "an open-source Rust rewrite of the IntelliJ IDEA way of working": it mirrors
IDEA's keymap, tool windows and Search Everywhere, and its selling point is lightness (opening a
~770-file project is 3-12x faster than IDEA). It is still a desktop IDE: the editor is CodeMirror 6,
the backend is 26 Rust crates, and features such as database, Docker and Spring Boot are in scope.

**Lithe** targets the post-AI-dev world explicitly: "AI writes the code. Lithe helps you
understand it, run it, and review it." It is a low-memory IDEA alternative (300-400 MB baseline)
built first for Java and Spring Boot developers, keeping core workflows: browsing, editing,
navigation, search, Maven, run/debug, Git diff review, local history and databases. It ships two
native UIs (SwiftUI/AppKit on macOS, React on Windows) that share a deterministic Rust core, JSON
contracts and the Monaco editor. Agent and AI collaboration (Codex/Claude-style agents, AI commit
messages, provider import) are a headline feature.

**Terax** is an AI-native, terminal-first ADE: a native PTY backend + a modern UI with multi-tab
terminals, an integrated editor, file explorer, source control and a first-class AI agent system
that works with BYOK or fully local models. Its roadmap is explicit: "Not an IDE clone." It
selectively integrates high-value editor capabilities (LSP, AI autocomplete, formatting, source
control, previews) without the heavyweight runtime and always-on background services of a
traditional IDE.

## 3. Editor and change-marker architecture

### 3.1 Editor engine

- **OpenIDEA** uses **CodeMirror 6** with a custom `editor/api.ts` contribution registry. Every
  feature (VCS changes, breakpoints, coverage, bookmarks, run markers) contributes through
  `gutterLaneMarkers` / `scrollbarMarks` facets onto a single lane.
- **Lithe** uses **Monaco 0.55** (VS Code's editor) on both platforms, wrapped in
  `frontend/editor`. Git change markers are Monaco line decorations computed against the Git index
  on the UI thread after a 250 ms typing pause, with a 150 ms diff budget; click-to-peek shows an
  inline diff and can stage a single hunk.
- **Terax** uses a CodeMirror-based custom editor plus the libghostty-vt WASM terminal model. The
  editor change lane is a unified lane API; since v0.9.23 the change hunks are computed in the Rust
  backend (`git::line_hunks`) and the editor only maps hunk offsets through edits, with a debounced
  refetch.

### 3.2 Change-marker data source

- **OpenIDEA**: `vcs_line_hunks` in Rust computes hunks against HEAD via gix and returns structured
  `LineHunk[]`; the editor maps offsets and remaps through edits, with debounced refetch.
- **Lithe**: the change markers are computed **in the editor** with Monaco's own line diff
  (`linesDiffComputers`), comparing the live model against the Git index (staged base). A 150 ms
  budget means files too large to diff quickly show no markers rather than blocking input.
- **Terax**: `git_line_hunks` in Rust diffs HEAD against the unsaved buffer (`similar` crate) and
  returns structured hunks; the editor maps offsets and remaps through edits, with debounced
  refetch. EOL normalization is handled in the backend.

All three converge on the same UX (colored bars left of line numbers, click-to-peek, overview
strip). The architecture difference is where the diff runs: OpenIDEA and Terax compute hunks in
Rust (off the UI thread, consistent across platforms), Lithe computes them in the editor with
Monaco's own diff (keeps a single source of truth with its diff editor, at the cost of a UI-thread
time budget).

## 4. AI assistance

- **OpenIDEA**: AI is not a headline. It is an IDE with action registry, LSP and plugin
  mechanisms; the AI story is mostly "IDE actions + language servers".
- **Lithe**: AI collaboration is a headline. It hosts Codex/Claude-style agents (agent-host in
  Rust), AI-generated commit messages with customizable formats, provider settings import from
  local tools (e.g. Claude Code / Codex subscriptions), MCP registry, and an `agent-acp` contract.
  Java/Spring-specific AI flows (run markers, navigation) are Rust-computed.
- **Terax**: AI is a native primitive. The agent subsystem (BYOK or local), AI autocomplete, edit
  diffs, live context bridge and voice are first-class; agents can drive the terminal and edit
  files, and tools surface shell execution.

## 5. Platform and packaging

- **OpenIDEA**: Tauri 2, macOS / Windows / Linux. React 19 + CodeMirror 6. Rust crates per area.
- **Lithe**: macOS is the reference product (SwiftUI/AppKit + Monaco), Windows is an independent
  React/Tauri implementation sharing Rust `lithe-core`, JSON contracts and Monaco. Homebrew cask and
  one-click in-app updates; Sparkle differential updates on macOS (with strict runtime read-only
  bundle rules). Database connections ship as a community plugin (macOS only).
- **Terax**: Tauri 2 on macOS / Linux / Windows. A single Rust crate owns PTY, git, fs, agent and
  IPC; the frontend is React 19 + TypeScript with libghostty-vt WASM. SignPath-signed on Windows.

## 6. Borrowing assessment for Terax

Each candidate borrowing is judged against Terax's quality bar (correctness, performance,
security, UI/UX, architecture) and its "lightweight always, terminal-first, AI as primitive"
stance. See also [OpenIDEA feature review](openidea-review.md) and
[Unified gutter Lane refactor design](gutter-lane-design.md).

| # | Lithe mechanism | Terax landing point | Cost | Fit |
|---|---|---|---|---|
| 1 | Rust-computed git change markers + click-to-peek inline diff | Already implemented in Terax since v0.9.23 (backend hunks). Peek widget could adopt Lithe's single-hunk staging UX | low | high |
| 2 | Local snapshot history (timeline of past file states) | New: a lightweight per-file local history would fit Terax's ADE role | medium | medium |
| 3 | AI commit message with customizable formats | Terax's source-control panel could add AI commit-message generation (BYOK), matching its AI-first stance | low | high |
| 4 | Provider settings import from local tools (Claude Code / Codex) | Terax already supports many providers; importing API keys/models from installed CLI tools is a low-cost UX win | low | medium |
| 5 | Rust `lithe-core` + JSON contracts + per-platform UI (macOS SwiftUI / Windows React) | Terax intentionally uses one Tauri UI for all platforms; not a fit unless a native-macOS UI becomes a goal | high | low |
| 6 | Monaco editor (VS Code engine) | Terax's CodeMirror-based editor is lighter and already unified; not a fit | high | low |
| 7 | On-demand language services / per-language service switches | Terax's LSP is on-demand; a per-language enable switch could help on low-RAM machines | low | medium |
| 8 | MCP registry + server library | Terax's AI tool surface could expose an MCP registry for community servers | medium | high |

## 7. Explicitly out of scope

- **Database plugin / SQL history / CRUD export** (Lithe): heavy IDE feature, conflicts with
  Terax's terminal-first stance.
- **Maven / Gradle / Spring Boot run configurations** (Lithe): Java-build-tool centric; Terax
  focuses on shell/agent-driven runs.
- **Docker Compose / build-system plugins / dependency browser** (Lithe): IDE workspace tooling.
- **Full IntelliJ keymap and tool-window docking** (OpenIDEA): Terax is "not an IDE clone".
- **Eclipse/OSGi plugin platform** (Lithe): heavyweight plugin runtime.

## 8. Conclusion

The three projects confirm a shared trajectory: lightweight developer tools that keep the
IDE's core editing/navigation/diff workflows while dropping the heavyweight always-on services,
and AI collaboration moving from a sidebar to a primary surface.

For Terax the highest-value borrowings from Lithe are: (1) adopting a click-to-peek +
single-hunk staging UX for the already-Rust-computed change markers, (2) AI commit-message
generation in source control (matches the AI-first stance), (3) provider settings import from
installed CLI tools, and (4) an MCP registry for the AI tool surface. Lithe's native-per-platform
UI (SwiftUI on macOS) and Monaco engine are deliberately out of scope for the same reasons the
OpenIDEA desktop-IDE mechanisms are: Terax is a terminal-first ADE, not an IDE clone.

## See also

- [OpenIDEA feature review](openidea-review.md) - borrowing assessment of OpenIDEA against Terax.
- [Unified gutter Lane refactor design](gutter-lane-design.md) - the lane API Terax implemented.
- [TERAX.md](../../TERAX.md) - the architecture source of truth.
