# ADE 竞品三方对比：OpenIDEA vs Lithe vs Terax

> [OpenIDEA](https://github.com/l0ng-ai/openidea)（Rust 重构的 IntelliJ IDEA 工作流）、
> [Lithe-IDEA](https://github.com/1lck/Lithe-IDEA)（面向 Java 与 AI 协作的低内存 IntelliJ IDEA 替代品）
> 与 Terax（AI 原生、终端优先的 ADE）的三方对比，2026-10 基于各仓库源码级调研编写。
> 仅作产品决策参考，不是架构规范。若与 `TERAX.md` 冲突，以 `TERAX.md` 为准。
> 英文版：`ade-competitor-comparison.md`。

## 1. 项目概述

| | OpenIDEA | Lithe (Lithe-IDEA) | Terax |
|---|---|---|---|
| 仓库 | `l0ng-ai/openidea` | `1lck/Lithe-IDEA` | `crynta/terax-ai` |
| 定位 | 桌面 IDE，IntelliJ 工作流克隆（主打轻量） | 低内存 IntelliJ IDEA 替代品，Java/Spring Boot 优先 + AI 协作 | 终端优先、AI 原生的 ADE |
| 语言重点 | 60+ 语言 | Java / Spring Boot 优先；其余按需 | 多语言，终端优先 |
| 前端 | React 19 + CodeMirror 6 + Tauri 2 | macOS：SwiftUI/AppKit + Monaco；Windows：React + Monaco + Tauri 2 | React 19 + TS + libghostty-vt WASM + Tauri 2 |
| 后端 | 26 个 Rust crate | Rust `lithe-core` + `lithe-git-host` + 平台适配 | Rust 单 crate（git、pty、fs、agent） |
| 编辑器引擎 | CodeMirror 6（自研扩展体系） | Monaco 0.55（VS Code 引擎） | 类 CodeMirror 自研 + Ghostty 终端模型 |
| 内存 | 主打轻量 | 打开项目后基线约 300-400 MB | 安装包 ~7-8 MB，运行内存极低 |
| AI 故事 | IDE 动作 + LSP；非 AI 原生 | AI 协作是主打：agent、AI 提交信息、本地工具导入提供商 | AI 作为原生原语（agent、补全、语音） |

## 2. 定位与理念

**OpenIDEA** 是「用 Rust 重构 IntelliJ IDEA 工作方式」的开源替代品：镜像 IDEA 的键位、工具窗口与 Search Everywhere，卖点是轻量（打开约 770 文件项目比 IDEA 快 3 到 12 倍）。它仍然是桌面 IDE：编辑器用 CodeMirror 6，后端 26 个 Rust crate，数据库、Docker、Spring Boot 都在范围内。

**Lithe** 明确面向 AI 后时代：「AI 写代码，Lithe 帮你理解、运行、审查」。它是低内存的 IDEA 替代品（基线 300-400 MB），优先服务 Java 与 Spring Boot 开发者，保留核心工作流：浏览、编辑、导航、搜索、Maven、运行/调试、Git 差异审查、本地历史与数据库。它同时维护两套原生 UI（macOS 用 SwiftUI/AppKit，Windows 用 React），共享确定性 Rust 核心、JSON 契约与 Monaco 编辑器。Agent 与 AI 协作（Codex/Claude 风格 agent、AI 提交信息、提供商导入）是头牌功能。

**Terax** 是 AI 原生、终端优先的 ADE：原生 PTY 后端 + 现代 UI，含多标签终端、集成编辑器、文件树、源码控制与一等公民的 AI agent 系统（BYOK 或全本地模型）。路线图明确「不是 IDE 克隆」，选择性整合高价值编辑器能力（LSP、AI 补全、格式化、源码控制、预览），不背传统 IDE 的重运行时与常驻后台服务。

## 3. 编辑器与修改标识架构

### 3.1 编辑器引擎

- **OpenIDEA** 用 **CodeMirror 6** + 自研 `editor/api.ts` 贡献注册表。所有功能（VCS 变更、断点、覆盖率、书签、运行标记）通过 `gutterLaneMarkers` / `scrollbarMarks` Facet 贡献到同一条 lane。
- **Lithe** 两个平台都用 **Monaco 0.55**（VS Code 编辑器），封装在 `frontend/editor`。Git 修改标识是 Monaco 行装饰，在 UI 线程用 Monaco 自带 diff 对比「实时模型」与「Git index（暂存基线）」，打字停顿 250 ms 后重算、单次 diff 预算 150 ms；点击标记弹内联差异并可暂存单个 hunk。
- **Terax** 用基于 CodeMirror 的自研编辑器 + libghostty-vt WASM 终端模型。编辑器修改 lane 是统一 lane API；自 v0.9.23 起修改 hunk 由 Rust 后端计算（`git::line_hunks`），编辑器只做偏移映射 + 编辑时增量、防抖重拉。

### 3.2 修改标识数据源

- **OpenIDEA**：Rust 端 `vcs_line_hunks` 用 gix 对 HEAD 算 hunk，返回结构化 `LineHunk[]`；编辑器映射偏移、编辑时 remap、防抖重拉。
- **Lithe**：修改标识**在编辑器内**用 Monaco 自带行 diff（`linesDiffComputers`）计算，对比实时模型与 Git index（暂存基线）。150 ms 预算意味着太大、来不及 diff 的文件不显示标记而不是卡住输入。
- **Terax**：Rust 端 `git_line_hunks` 用 `similar` crate 对 HEAD 与未保存缓冲区算 hunk，返回结构化 hunk；编辑器映射偏移、编辑时 remap、防抖重拉。行尾归一化在后端完成。

三者收敛到同一 UX（行号左侧彩色条、点击预览、概览条），差异在「diff 跑在哪」：OpenIDEA 与 Terax 在 Rust 计算（不占 UI 线程、跨平台一致），Lithe 在编辑器里用 Monaco 自带 diff（与差异编辑器共享同一真相源，代价是 UI 线程时间预算）。

## 4. AI 协助

- **OpenIDEA**：AI 不是头牌。它是带动作注册表、LSP、插件机制的 IDE；AI 故事主要是「IDE 动作 + 语言服务器」。
- **Lithe**：AI 协作为头牌。Rust 侧有 agent-host（Codex/Claude 风格）、AI 生成提交信息（可定制格式）、从本地工具导入提供商设置（如 Claude Code / Codex 订阅）、MCP 注册表、`agent-acp` 契约。Java/Spring 特有 AI 流（运行标记、导航）由 Rust 计算。
- **Terax**：AI 是原生原语。agent 子系统（BYOK 或本地）、AI 补全、编辑差异、实时上下文桥、语音都是一等公民；agent 可驱动终端、编辑文件，工具面暴露 shell 执行。

## 5. 平台与打包

- **OpenIDEA**：Tauri 2，macOS / Windows / Linux。React 19 + CodeMirror 6，按领域拆分 Rust crate。
- **Lithe**：macOS 是参考产品（SwiftUI/AppKit + Monaco），Windows 是独立 React/Tauri 实现，共享 Rust `lithe-core`、JSON 契约与 Monaco。Homebrew cask + 应用内一键更新；macOS 用 Sparkle 差分更新（对运行时只读 bundle 有严格规则）。数据库连接作为社区插件发布（仅 macOS）。
- **Terax**：Tauri 2，macOS / Linux / Windows。单 Rust crate 持有 PTY、git、fs、agent、IPC；前端 React 19 + TS + libghostty-vt WASM。Windows 用 SignPath 签名。

## 6. 对 Terax 的可借鉴评估

每项借鉴按 Terax 质量门槛（正确性、性能、安全、UI/UX、架构）与「始终轻量、终端优先、AI 原生」定位评判。另见 [OpenIDEA 功能评估](openidea-review_zh.md) 与 [统一 gutter Lane 重构设计](gutter-lane-design_zh.md)。

| # | Lithe 机制 | Terax 落地点 | 成本 | 匹配度 |
|---|---|---|---|---|
| 1 | Rust 计算修改标识 + 点击预览内联 diff | Terax 自 v0.9.23 已实现后端 hunk；可借鉴其「单 hunk 暂存」的 peek 交互 | 低 | 高 |
| 2 | 本地快照历史（过往文件状态时间线） | 新增：轻量按文件本地历史契合 Terax 的 ADE 角色 | 中 | 中 |
| 3 | AI 生成提交信息（可定制格式） | Terax 源码控制面板可加 AI 提交信息生成（BYOK），契合 AI 优先定位 | 低 | 高 |
| 4 | 从本地工具导入提供商设置（Claude Code / Codex） | Terax 已支持多提供商；从已装 CLI 工具导入 key/模型是低成本 UX 收益 | 低 | 中 |
| 5 | Rust `lithe-core` + JSON 契约 + 平台各自 UI（macOS SwiftUI / Windows React） | Terax 有意用单一 Tauri UI 覆盖全平台；除非原生 macOS UI 成为目标，否则不匹配 | 高 | 低 |
| 6 | Monaco 编辑器（VS Code 引擎） | Terax 基于 CodeMirror 的编辑器更轻且已统一；不匹配 | 高 | 低 |
| 7 | 按需语言服务 / 分语言开关 | Terax 的 LSP 已按需；分语言启用开关在低内存机器上有用 | 低 | 中 |
| 8 | MCP 注册表 + 服务器库 | Terax 的 AI 工具面可暴露 MCP 注册表接入社区服务器 | 中 | 高 |

## 7. 明确不借鉴

- **数据库插件 / SQL 历史 / CRUD 导出**（Lithe）：重型 IDE 功能，与 Terax 终端优先定位冲突。
- **Maven / Gradle / Spring Boot 运行配置**（Lithe）：Java 构建工具中心化；Terax 聚焦 shell/agent 驱动运行。
- **Docker Compose / 构建系统插件 / 依赖浏览器**（Lithe）：IDE 工作区工具。
- **完整 IntelliJ 键位与工具窗口停靠**（OpenIDEA）：Terax「不是 IDE 克隆」。
- **Eclipse/OSGi 插件平台**（Lithe）：重型插件运行时。

## 8. 结论

三个项目印证了同一条演进路径：保留 IDE 的核心编辑/导航/diff 工作流，同时砍掉重型常驻服务；AI 协作从侧边栏变成主界面。

对 Terax 而言，从 Lithe 最高价值的借鉴是：(1) 为已经 Rust 计算的修改标识补上「点击预览 + 单 hunk 暂存」交互；(2) 源码控制加 AI 提交信息生成（契合 AI 优先）；(3) 从已装 CLI 工具导入提供商设置；(4) 为 AI 工具面加 MCP 注册表。Lithe 的平台各自原生 UI（macOS SwiftUI）与 Monaco 引擎，与 OpenIDEA 的桌面 IDE 机制一样，属于 Terax 刻意不借鉴的范围：Terax 是终端优先的 ADE，不是 IDE 克隆。

## 参考

- [OpenIDEA 功能评估](openidea-review_zh.md) - OpenIDEA 对 Terax 的借鉴评估。
- [统一 gutter Lane 重构设计](gutter-lane-design_zh.md) - Terax 已实现的 lane API。
- [TERAX.md](../../TERAX.md) - 架构唯一真源。
