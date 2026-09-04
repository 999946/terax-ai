# Terax 功能清单与实现细节

> 适用版本：0.8.7 · 文档性质：功能总览与实现速查（以 `TERAX.md` 为架构权威来源，本文件补充功能面与实现细节）

## 1. 项目概览

**Terax** 是一款开源、轻量、以终端为优先的 AI 原生开发环境（ADE）。约 **7–8 MB** 磁盘占用，无遥测、无账号。

| 维度 | 说明 |
|---|---|
| 技术栈 | Tauri 2 + Rust 后端，React 19 + TypeScript + xterm.js (WebGL) 前端，Vercel AI SDK v6 |
| Bundle id | `app.crynta.terax` |
| 包管理器 | pnpm |
| 平台 | macOS / Linux / Windows |
| 前端检查 | `pnpm lint` · `pnpm check-types` · `pnpm test` |
| Rust 检查 | `cargo clippy --all-targets --locked -- -D warnings` · `cargo nextest run --locked`（本地回退 `cargo test --locked`） |

### 核心定位

- **终端为优先（terminal-first）**：原生 PTY 后端 + WebGL 渲染器。
- **自带 AI 侧栏**：BYOK（自带 Key），或完全本地模型。
- **自带工具集**：代码编辑器、文件浏览器、带 git 图谱的源码控制、Web 预览窗格。
- **极简与性能**：未用功能零开销；每次改动都要权衡内存、IPC 往返、重渲染、依赖体积。

### 质量基线（Quality bar）

正确性（含边界/并发）、性能（轻量即产品）、安全（IPC/fs/网络/AI 工具面全边界校验）、UI/UX 打磨、架构（纯函数功能核 + 薄命令壳）。核心子系统改动需配套测试锁定不变量。

---

## 2. 架构总览：双进程模型

**Rust 拥有全部 OS 访问权**。Webview 不直接接触文件系统、进程或 shell——一切通过 `invoke()` 调用注册在 `src-tauri/src/lib.rs` 的 Tauri 命令。

```
Webview (React)  --invoke()-->  Tauri 命令(Rust)  --OS 访问-->  文件系统/进程/shell/网络/keychain
```

- 前端不可直接访问文件/进程/shell；全部经 IPC。
- 代码路径别名 `@/*` → `src/*`；前端跨模块一律用 `@/...`，不用相对路径。

### 前端布局

单窗口 React 应用。Tab 是**可辨识联合**（`kind`: `terminal | editor | preview | markdown | ai-diff | git-diff | git-history | git-commit-file`），切换时**不卸载**——用 `invisible pointer-events-none` 隐藏，保证 PTY 与开发服务器后台持续运行。

---

## 3. 后端功能模块与实现细节（Rust）

后端模块位于 `src-tauri/src/modules/`。命令注册表见 `src-tauri/src/lib.rs::run()`（第 247–340 行附近）。

### 3.1 pty —— 交互式终端会话

- 长生命周期交互式 PTY（xterm ↔ portable-pty），由 `PtyState`（`RwLock<HashMap<u32, Arc<Session>>>` + `AtomicU32`）管理。
- 输出经 Tauri `Channel<PtyEvent>` 流式推送。
- **命令**：`pty_open` / `pty_write` / `pty_resize` / `pty_close` / `pty_close_all` / `pty_has_foreground_process` / `pty_has_foreground_job` / `pty_shell_name` / `pty_list_shells`。
- **Shell 集成**：注入 init 脚本（`src-tauri/src/modules/pty/scripts/`）发射 **OSC 7**（cwd）与 **OSC 133 A/B/C/D**（prompt 边界 + 退出码）：
  - Unix：`zshenv/zprofile/zlogin/zshrc.zsh`、`bashrc.bash`；fish 装到 `~/.config/fish/conf.d/terax.fish`。
  - Windows：`profile.ps1`，经 `pwsh -NoLogo -NoExit -ExecutionPolicy Bypass -File` 传入；shell 优先级 `pwsh` (7+) → `powershell` (5.1) → `cmd`。
- **终端输入**：Enter 用 `\r` (CR) 而非 `\n` (LF)——Windows PowerShell 要求 CR。
- **Windows 细节**：
  - ConPTY 需 `SPAWN_LOCK`（Mutex）包住 `openpty + spawn_command`，并发 spawn 会导致 PTY 输出管道停滞。
  - 每个 ConPTY 子进程挂到带 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` 的 **Job Object**（`pty/job.rs`），句柄释放时内核杀掉整个子树（含 `npm run dev` 这类后代），避免孤儿进程。
- **Agent 检测**：`pty/agent_detect.rs` 在 PTY reader 字节过滤器上，armed 于 `OSC 133;C;<cmd>` 或标记自 armed，发射 `terax:agent-signal` 转换（`started/working/attention/finished/exited`），仅由 OSC 序列驱动（不从裸输出判定，TUI 重绘不抖动）；无 agent 运行零开销。

### 3.2 fs —— 文件系统

- **命令分组**：
  - 树/列表：`fs_list_subdirs` / `fs_read_dir`
  - 文件 IO：`fs_read_file` / `fs_write_file` / `fs_stat` / `fs_canonicalize`
  - 变更：`fs_create_file` / `fs_create_dir` / `fs_rename` / `fs_delete` / `fs_copy`
  - 监听：`fs_watch_add` / `fs_watch_remove`（基于 notify crate 的 watcher）
  - 搜索：`fs_search` / `fs_list_files`
  - 内容搜索：`fs_grep` / `fs_grep_interactive` / `fs_glob`（由 `ignore` + `grep-*` crate 驱动）
- **路径规范化**：统一 canonical path helper；前端 canonical 路径一律**正斜杠**。

### 3.3 git —— 源码控制

- 全部命令经工作区授权注册表（`WorkspaceRegistry`）把关，支持 WSL（`WorkspaceEnv`）。
- **命令**（18+）：`git_list_repos` / `git_resolve_repo` / `git_panel_snapshot` / `git_status` / `git_diff` / `git_diff_content` / `git_stage` / `git_unstage` / `git_discard` / `git_commit` / `git_fetch` / `git_pull_ff_only` / `git_push` / `git_log` / `git_show_commit` / `git_commit_files` / `git_commit_file_diff` / `git_remote_url` / `git_list_branches` / `git_checkout_branch`。
- 异步命令在 `spawn_blocking` 里跑 `operations`；porcelain v2 解析器 + 类型 + 错误（`git/parser.rs` / `types.rs` / `errors.rs`）。
- **多仓库**：`git_list_repos` 迭代 DFS 遍历授权工作区发现所有 git 仓库（跳过 `.git/node_modules/target/dist/build`），配合前端 `useMultiSourceControl` 支持多仓库目标。

### 3.4 shell —— 一次性命令 / agent shell / 后台进程

- `shell_run_command`：一次性子 shell 执行，供 AI 工具用（Windows `-NoProfile -Command`，Unix `$SHELL -lc`），共享 helper `build_oneshot_command`。
- `shell_session_*`：跨调用持久的 agent shell。
- `shell_bg_*`（`spawn`/`logs`/`kill`/`list`）：长期后台进程（dev server 等）带**有界环形缓冲**日志捕获。

### 3.5 workspace —— 授权与 WSL

- `workspace_authorize` / `workspace_current_dir`：spawn/git/AI 的 cwd 授权注册表（canonical root + 1s 缓存）。
- WSL 桥：`wsl_list_distros` / `wsl_default_distro` / `wsl_home`。

### 3.6 lsp —— 语言服务器主机

- `lsp_detect` / `lsp_host_pid` / `lsp_resolve_root` / `lsp_spawn` / `lsp_send` / `lsp_kill`。
- 哑 JSON-RPC 管道：`Content-Length` 分帧 + 进程生命周期在 Rust（`lsp/framing.rs`，纯且已测）；协议智能在前端。
- spawn cwd 经工作区注册表；二进制经捕获的 login-shell env 解析（`lsp/env.rs`）。
- root 检测向上找 marker 但**不越过 `$HOME`**；Unix 独立进程组并组杀（cargo check / proc-macro 子进程随 server 死），Windows 用 `proc::job::ProcessJob`；`RunEvent::Exit` 时全部会话被杀。

### 3.7 net —— AI 网络代理（SSRF 防护）

- `ai_http_request` / `ai_http_stream` / `lm_ping`。
- 校验 http(s)；默认阻断 metadata/私网地址；DNS 分类 + 将 IP 钉住对抗 **DNS rebinding**；净化请求头；处理重定向；流式走 channel。

### 3.8 secrets —— 密钥存储

- `secrets_get/set/delete/get_all`，经 `keyring` crate（OS keychain），service 常量 `terax-ai`；Linux 用文件回退（`#[cfg(target_os = "linux")]`）。密钥**绝不落盘**、不进设置 store 或 localStorage。

### 3.9 其它后端模块

- **proc**：平台 helper `hide_console` + 内部 `ProcessJob`（pty/plugin 共用 kill-on-close）。
- **vibrancy**：`window_backdrop_kind` / `window_set_backdrop`。macOS `NSVisualEffectMaterial::UnderWindowBackground`；Windows 11 Mica（经 `RtlGetVersion` 判断 build ≥ 22000）；Linux 返回 `none`（模糊归合成器）。
- **agent**（Rust 侧）：`agent_enable_hooks(agent)` / `agent_hooks_status(agent)`——为 Claude Code / Codex / Gemini CLI 等终端 agent 安装 `OSC 777` 通知 hook（数据驱动 `AgentSpec`，原子写、保留外部配置、幂等；`TERAX_TERMINAL` 门控）。
- **control**：`control_frontend_ready` / `control_respond`——本地控制服务器（stdin / HTTP 类协议），供 CLI 调用前端。
- **plugin**：`plugin_list/register/delete/set_enabled/snapshot/dispatch_event/entry_read/write`——Node 事件处理器插件系统（`PluginState: Arc<Mutex<PluginRuntime>>`）。
- **history**：`history_suggest/commands/record/list`——解析 zsh/bash/fish 历史，索引化建议/补全。
- **open_settings_window**：独立设置窗口，可选 `tab` 参数深链到某节。

---

## 4. 前端功能模块与实现细节（React）

前端共 **24 个模块**（`src/modules/`）。状态管理：Zustand（ai/agents/lsp/plugin/settings/spaces/terminal/theme/workspace）、React Context（i18n/theme/source-control）、组件 props/hooks（editor/explorer/preview/markdown/git-history/tabs）。

### 4.1 terminal —— 终端

- 核心：`TerminalPane` / `TerminalStack` / `PaneTreeView`；`block/` 组件 + `lib/blockController`。
- **WebGL renderer pool**：slot 池化 + `DormantRing`（休眠环），保证"命令中绝不序列化"不变量。
- **Shell 集成**：`lib/osc-handlers`（解析 OSC 7/133）；IME 桥（`imeBridge`，处理 macOS 韩/中文输入法）。
- 拖放：`useTerminalFileDrop` + `dropStore`（Zustand）；终端内链接（`terminalLinks`）；字体（`useTerminalFont`）。
- 后台 agent 活动订阅（`agentActivity`）。

### 4.2 explorer —— 文件浏览器

- `FileExplorer` / `TreeRow` / `InlineInput` / `ExplorerSearch`。
- 文件树浏览、搜索、inline 新建/重命名；自然（数字感知）排序；`useFileTree` 防止 canonical cwd 首次到达时误清空树/闪烁。
- 文件图标库：`explorer/lib/fileIcons.ts`（2000+ 图标映射）。

### 4.3 editor —— 代码编辑器

- 基于 CodeMirror：`EditorStack`(+Lazy) / `EditorPane` / `EditorPaneHandle` / `NewEditorDialog`。
- **AI diff**：`AiDiffStack`——AI 建议的编辑打开到**左右分栏 diff tab**（`ai-diff` kind），用户逐 hunk 接受/拒绝后再真正写文件。
- **Git diff**：`GitDiffStack`——源码控制 diff 分栏。
- 语言解析：`lib/languageResolver` + `languageDefinitions`（50+ 语言，含 Svelte 专用 mode）；诊断经 `diagnosticsStore`（Zustand）。

### 4.4 source-control —— 源码控制面板

- `SourceControlPanel`(+Lazy) / `useSourceControl` / `useSourceControlPanel`。
- **多仓库**：`useMultiSourceControl` / `useRepositoryTargeting` / `useRepositoryTarget`——支持多个 git 仓库作为目标。
- 变更树（`changeTree` / `repositoryTarget`）、stage/unstage/提交；`deriveFileEntries` 做去重 + staged/unstaged 合并。

### 4.5 git-history —— git 图谱

- `GitHistoryPane` / `GitHistoryStack`(+Lazy) / `GraphRail`。
- `lib/graph.ts`（`layoutGraph` / `laneColor` 提交图谱布局）；`lib/remoteWebUrl.ts` 远程网页链接。
- 提交图谱、提交详情/搜索、跳转远程。

### 4.6 preview —— 网页预览

- `PreviewStack` / `PreviewPane` / `PreviewAddressBar`；地址栏、网页/资源预览、导航。

### 4.7 markdown —— Markdown

- `MarkdownPreviewPane` / `MarkdownViewToggle` / `MarkdownLink`；渲染预览、编辑/预览切换、链接。

### 4.8 ai —— AI 子系统（最庞大模块，79 文件）

**提供商（BYOK）**：`@ai-sdk/*` 的 OpenAI / Anthropic / Google / xAI / Cerebras / Groq / DeepSeek / Mistral / OpenRouter，加 OpenAI-compatible（任意 base URL）；本地离线（key 可选、运行时给 model id）：LM Studio / MLX / Ollama。提供商列表在 `config.ts`（`PROVIDERS`）。

- **Key 存储**：OS keychain（`secrets_*` 命令），`KEYRING_SERVICE = "terax-ai"`。
- **Agent**（`lib/agent.ts`）：`Experimental_Agent` + `stopWhen: stepCountIs(MAX_AGENT_STEPS)`；系统提示在 `config.ts`。
- **Sub-agents**（`agents/registry.ts` / `runSubagent.ts`）：命名子 agent（各自系统提示 + 工具子集），由主 agent 经 `run_subagent` 工具调用。
- **Sessions**（`lib/sessions.ts` + `store/chatStore.ts`）：命名会话，经 `tauri-plugin-store` 持久化到 `terax-ai-sessions.json`；`chatStore` 持模块级 `Map<sessionId, Chat<UIMessage>>`；`AgentRunBridge` 镜像到盘 + 自动从首条用户消息派生标题；切换 key 清空 chat map、会话保留。
- **Composer**（`lib/composer.tsx`）：React context，共享输入状态（文本/附件/语音）。附件含 image/text-file/`selection`（来自 `attachSelection`，包装为 `<selection source="terminal|editor">…</selection>`）。
- **语音输入**：流式转写管线。
- **Live context bridge**：`App.tsx` 调 `setLive({ getCwd, getTerminalContext, … })`，让工具读当前活动终端的 cwd + 最近 300 行缓冲；**惰性**（不预快照）。
- **Tools**（`tools/tools.ts` + `ai/tools/*`）：`read_file` / `list_directory` / `fs_search` / `fs_grep` 自动执行；`write_file` / `create_directory` / `rename` / `delete` / `run_command` / `shell_session_run` / `shell_bg_spawn` 置 `needsApproval: true` 暂停等 UI 确认卡。`lib/security.ts` 是**拒绝清单**，拒绝明显 secret 路径（`.env*`、`.ssh/`、凭据、keychain 目录），读写双路径都套。
- **Edit diffs**：AI 编辑走 `ai-diff` tab 逐 hunk 接受/拒绝。
- **Prompt snippets**（`#handle`）：可复用提示片段（非 skills）。

### 4.9 agents —— Agent 启动/通知

- `AgentLauncherPanel` + `lib/launcher.ts`：持久化各 agent 启动命令，原子构建**平衡的 1–4 窗格 tab**。
- 支持内置 Terax agent + 终端编码 agent（Claude Code / Codex / Gemini CLI / Pi / OpenCode / Grok）。
- `store/agentStore.ts`（terminal `sessions` + `localAgent` + `notifications`）；共享路由 `lib/route.ts`（聚焦可见抑制、失焦 OS 通知、聚焦但隐藏 in-app Sonner toast）。
- `NotificationBell` 管理面；toast 用 Sonner；`lib/agentIcon.tsx` 品牌标记。

### 4.10 command-palette —— 命令面板

- `CommandPalette` / `commands.ts`；`lib/fuzzy.ts` / `mode.ts` / `mru.ts`（模糊搜索 / 模式 / MRU）；`hooks/useAsyncQuery` / `useCommandHistory` / `useContentSearch`。命令搜索执行 + 导航。

### 4.11 theme —— 主题引擎

- **自定义主题引擎**（无 `next-themes`）：`ThemeProvider` + `applyTheme` 写 CSS 变量；内置预设 `theme/themes/`（terax-default / xcode / claude / kanagawa / kanagawa-dragon / tokyo-night / catppuccin / rose-pine / everforest / nord / gruvbox / dracula / solarized / tide / sage / caffeine），各可选配对 `editorTheme`（`resolveEditorThemeId`）。
- 用户主题：`customThemes.ts` + `validateTheme.ts`；可选背景图 `bgImageStore.ts` + `SurfaceLayer`。
- **窗口毛玻璃**：`WindowVibrancyBridge`（仅主窗口），`html[data-vibrancy="on"]` 使 chrome 磨砂、pane 保持实底。

### 4.12 tabs —— 标签与分栏

- `TabBar` / `TabIcon` / `NewTabMenu` / `TabSwitcherHud`。
- `lib/useTabs`：`MAX_PANES = 4`，打开/关闭/重排；`useTabSwitcher` 快捷切换；`tabLabel` / `useWorkspaceCwd` / `useWindowTitle`。后台 agent 活动订阅。

### 4.13 spaces —— 工作区空间

- `SpaceSwitcher` / `SpaceContent` / `SpacePanel` / `SpaceAvatar`。
- `lib/useSpaces`（Zustand）+ `useSpacesBoot` / `useSpacePersistence` / `useSpacesDirectorySync` / `activeSpace` / `serialize` / `spaceColor` / `filesystem`。
- 空间（name / root / env / color / 每空间 tab 持久化）创建/切换/重命名/目录同步。

### 4.14 其余前端模块

- **sidebar**：`SidebarRail` / `useSidebarPanel` / `useSidebarPanel`——侧栏视图切换、宽度拖拽/持久化。
- **statusbar**：`StatusBar` / `CwdBreadcrumb` / `DiagnosticsBadge` / `WorkspaceEnvSelector`。
- **settings**：`preferences.ts`（`usePreferencesStore` / `readBgFastPath`）——主题、编辑器/终端字体、字号、word wrap、cursor 常量/强转；`openSettingsWindow.ts` 独立窗口。
- **shortcuts**：`shortcuts.ts` + `lib/shortcutLabel` / `useShortcutLabel` / `shortcutScope`；`lib/useShortcutLabel` 快捷键注册/标签/作用域。
- **i18n**：`LocaleProvider` + `locale.ts` / `config.ts` / `messages/`；支持多语言（中英西德法日韩葡波俄印尼印地等）。
- **updater**：`UpdaterDialog` / `useUpdater`——基于 `tauri-plugin-updater` 的检查/下载/安装。
- **control**：`useControlBridge` + `lib/context.ts`——CLI 控制平面桥接。
- **plugin**：`bridge.ts`（`pluginBridge`）/ `events.ts` / `types.ts` / `store.ts`（`usePluginStore`）——插件事件/状态。
- **workspace**：`env.ts` + `useWorkspaceEnvStore`（Zustand）——本地/远程工作区环境选择与 scope（`LOCAL_WORKSPACE`）。
- **header**：`Header` / `SearchInline`——顶部工作区/搜索/窗口操作。

---

## 5. 安全模型

- **IPC 边界**：webview 无直接 OS 访问，全经授权命令。
- **工作区授权**：spawn/git/AI 的 cwd 必须落在授权注册表内；canonical 路径缓存 + 防止越权遍历。
- **secret 拒绝清单**：AI 工具的读写路径都套 `.env*` / `.ssh/` / 凭据 / keychain 目录拒绝。
- **AI 工具审批**：写/删/执行类工具 `needsApproval` 暂停等 UI 确认。
- **SSRF 防护**：net 代理校验 http(s)，阻断 metadata/私网，DNS 分类 + IP 钉住对抗 rebinding，净化请求头。
- **keychain 处理**：密钥只进 OS keychain，绝不落盘/设置 store/localStorage。
- **OSC 信任**：终端输出中的控制序列按白名单处理。

---

## 6. 构建与发布

### Bundle 配置（`tauri.conf.json`）

- `bundle.targets: "all"` + 平台分节。
- macOS：`minimumSystemVersion: 10.15`；`titleBarStyle: Overlay` + `hiddenTitle`（原生红绿灯）；`transparent` + `macOSPrivateApi`（NSVisualEffectView 所需，故不进 App Store）。
- Linux：`decorations: false` + `transparent`；deb 依赖 `libwebkit2gtk-4.1-0` / `libgtk-3-0`；AppImage 自带媒体框架。
- Windows：NSIS 安装器 `currentUser` 模式（免管理员）；WebView2 `embedBootstrapper`（离线安装）；自定义 `WindowControls`。
- **自动更新**：公共 minisign 公钥；产物在 `https://github.com/crynta/terax-ai/releases/latest/download/latest.json`。

### GitHub Actions（`.github/workflows/`）

| 工作流 | 触发 | 作用 |
|---|---|---|
| `ci.yml` | PR/push 到 main | 常规 CI |
| `build-dmg.yml` | 打 `v*` tag + 手动 | 构建并发布 macOS DMG（双架构）到 GitHub Release |
| `update-nix-sources.yml` | release published + 手动 | 从 release 产物算 SRI 哈希更新 `nix/sources.json` 并提 PR |
| `signpath-test.yml` | 手动 | SignPath 签名链路测试 |

> 说明：早期存在 `release.yml`（打 tag 触发全平台 Tauri 发布 + Windows/Linux 产物 + `latest.json` updater 清单修补），已在 v0.8.7 后移除，改由 `build-dmg.yml` 承担 macOS DMG 发布。

### 版本管理

- 版本号分散在 5 处：`package.json` / `tauri.conf.json` / `src-tauri/Cargo.toml`（`[package]` + `[workspace.package]`）/ `src-tauri/Cargo.lock`（terax / terax-cli / terax-control-protocol 三包）/ `nix/sources.json`。
- **一键升级**：`pnpm version:bump <版本> [--commit] [--tag]`（`scripts/bump-version.mjs`）——一次同步全部 5 处，且不误改 `Cargo.lock` 里的 `rand` 等依赖版本；`nix/sources.json` 的 hashes 不在此脚本处理（由发布后 workflow 重新计算）。
- tag 规范：`v0.8.7`（附注 tag）。

---

## 7. 测试

- **前端**：vitest，111 个测试文件 / 745+ 用例；`pnpm test`（vitest run）。
- **后端**：`cargo test --locked` / `cargo nextest run --locked`（4 个集成测试目标：git_operations / fs_search / shell_background 等）。
- **核心子系统不变量**（TERAX.md）：terminal/shell spawn、workspace auth、git、fs、IPC、AI tool surface 的改动须有测试锁定。
- **测试注意**：vitest 配置已排除 `.claude/**`，避免递归发现 Claude Code worktree 副本造成重复/抖动执行。

---

## 8. 已知注意事项（Known gotchas）

- React 19 strict mode dev 下 `useEffect` 双挂载 → 终端首帧 spawn 两次，首个 PTY 立即清理（配合 `SPAWN_LOCK` 串行）。
- Windows PowerShell 进程生命周期：`killer.kill()` 只杀直接子进程；后代靠 Job Object 处理，别移除 Job。
- Tab `cwd` 存储：OSC 7 带正斜杠（`parseOsc7` 把 `/C:` → `C:`）；Windows 上消费 `tab.cwd` 传给 Rust fs 命令时须规范化分隔符。
- 评论规范：默认无注释，代码自解释；**全程不用 em-dash**；**不用 emoji**。

---

*本文档由对 TERAX.md、后端命令注册表与前端 24 个模块的只读探查整理而成。架构权威来源仍是 `TERAX.md`。*
