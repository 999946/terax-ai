# OpenIDEA 功能借鉴评估

> 本文是外部项目 [OpenIDEA](https://github.com/l0ng-ai/openidea)（Rust 重构的 IntelliJ IDEA 开源替代品）针对 Terax 的借鉴评估，2026-10 编写。
> 仅作产品决策参考，不是架构规范。若与 `TERAX.md` 冲突，以 `TERAX.md` 为准。

## 1. 项目概述

OpenIDEA 是一个用 Rust 重构 IntelliJ IDEA 工作流（键位映射、工具窗口、Search Everywhere）的原生 IDE，支持 60+ 语言，构建于 macOS / Windows / Linux。核心是 26 个 Rust crate，前端为 React 19 + CodeMirror 6 + Tauri 2。其主打轻量（打开 770 文件项目比 IDEA 快 3 到 12 倍）。

Terax 与 openidea 定位完全不同。openidea 是桌面 IDE，Terax 是终端优先的轻量 ADE，ROADMAP 明确声明 `Not an IDE clone`。因此 openidea 的多数功能（数据库、Docker、构建工具、Spring Boot）不应照搬，但存在 5 个机制级的借鉴点，它们不增加包体积、不违背轻量定位，反而偿还架构债务并强化 AI 场景。

## 2. 机制级借鉴点

### 1. 编辑器装饰统一 Lane API（最高价值）

**openidea 做法**（`src/editor/api.ts`）：一个 `EditorContribution` 注册表，所有功能通过统一契约向编辑器贡献扩展：

- `gutterLaneMarkers`：一个 Facet，VCS 变更、断点、覆盖率、书签、运行标记共享同一条 lane。
- `scrollbarMarks`：右缘滚动条概览统一 Facet。
- `registerSaveParticipant`：保存钩子。
- `getNavigationHistory`：前进/后退历史。

任何功能只 import `editor/api`，不 import 编辑器内部实现；`TextEditorHandle` 只在 tab 可见时存在，后台 tab 只保留 EditorState。

**Terax 现状**（`src/modules/editor/lib/`）：每个功能各自调 `gutter()` 造一个 gutter：

- `modifiedLines.ts` -> `cm-ml-gutter`（3px 变更条）
- `diffHunkMarkers.ts` -> `cm-hunk-check-gutter`（勾选框）
- `overviewRuler.ts` -> 独立 `cm-editor-overview` div（左/右缘概览）

问题：每条 gutter 占独立列宽，功能一多（变更 + 冲突 + LSP + 覆盖率 + 书签）gutter 会越堆越宽、列位错乱；`overviewRuler` 用裸 DOM 而非 Facet，与 CodeMirror 装饰体系脱节。

**评估**：不是新功能，而是架构债务偿还。把已有的修改指示条、冲突标记、概览条收进一个 `gutterLaneMarkers` 风格的 Facet，后续加覆盖率 / 书签 / 断点零成本。不增加运行成本，反而减少重复 DOM。

### 2. 动作注册表 + when 条件（IDEA ActionManager 模型）

**openidea 做法**（`src/platform/actions.ts`）：

```ts
registerAction({ id, title, category, when, keyWhen, toggled, run })
```

- 菜单 / 快捷键 / 工具栏 / Search Everywhere Actions Tab / 插件命令全部指向同一注册表。
- `when` 基于 ContextKeys 求值，`toggled` 让 toggle 动作在搜索面板显示 ON/OFF。
- 默认键位独立于动作定义（keymap 层），动作可被菜单传参（`arg`）。
- 插件命令通过同一 `register-action` 注入，动作本身成为插件扩展点。

**Terax 现状**（`src/modules/command-palette/commands.ts`）：`commands()` 返回静态 `PaletteItem[]` 数组，`disabledReason` 手写判断。问题：命令注册是静态数组，插件 / 功能无法增量注入；无统一 `when` 求值引擎，菜单 / 工具栏 / 快捷键各自引用命令，无单一真相源；命令只进命令面板，不构成 IDE 层动作总线。

**评估**：把 `commands.ts` 升级为动作注册表，`when` 用纯函数求值。成本低（不改 UI），收益是插件系统 + 快捷键 + 菜单统一。需保留现有快捷键体系兼容。

### 3. 虚拟文档只读标签

**openidea 做法**（`EditorDocContext.virtual` + `editor/api.ts`）：只读虚拟文档（语言服务器提供的库类内容），`path` 是其 URI 而非文件，自动屏蔽文件类功能（VCS、本地历史、TODO、断点）。

**Terax 现状**：预览与编辑器分离，没有在编辑器标签里打开库源码 / 远端文件 / 内存文档的虚拟文档能力。

**评估**：结合 Terax 的 AI 场景（AI agent 提到库函数、git 远端文件、grep 命中 -> 在编辑器标签打开只读虚拟文档），是最贴合 AI 原生定位的借鉴点。

### 4. 部分 hunk 提交与 diff 导航

**openidea 做法**（`vcs/` 体系）：`DiffEditor` + `MergeEditor` + `DiffNavigator` + `hunkInclusion.ts`（按 hunk 勾选包含/排除）+ `diffAnnotations`。

**Terax 现状**：已有 `GitDiffPane.tsx` + `DiffOverview.tsx` + hunk 勾选暂存（`diffHunkMarkers.ts`），覆盖 diff 视图、按 hunk 暂存/撤销、概览条。差距：`hunkInclusion`（选择性包含部分 hunk 进 commit）；`diffNavigator`（差异块循环导航）；三方合并编辑器（冲突解决 UI）。

**评估**：部分 hunk 提交 + diff 导航小而高价值，纯前端。三方合并编辑器是重型功能，建议暂缓。

### 5. Run Anything 快速执行

**openidea 做法**（`runAnything.ts` + `contextRun.ts`）：输入即搜运行配置 / 动作，支持在当前选中目录上下文运行、before-launch 钩子、外部工具。

**Terax 现状**：block terminal 支持 rerun 已执行命令，命令面板 `Cmd+P` 有 files/history 模式，AI 工具能跑 shell。但缺一个"输入命令名 -> 选择 -> 在指定 cwd 执行"的统一入口。

**评估**：不照搬运行配置概念，而是给命令面板加 `>` 前缀执行模式（输入 shell 命令 -> 在活动 pane 的 cwd 执行或新建 block）。与终端优先定位契合，复用已有 shell 能力。

## 3. 优先级矩阵

| # | 借鉴点 | openidea 机制 | Terax 落地点 | 成本 | 定位匹配 |
|---|--------|--------------|-------------|------|---------|
| 1 | 统一 gutter Lane | `gutterLaneMarkers` Facet | `editor/lib` 重构 | 中 | 高 |
| 2 | 虚拟文档只读标签 | `EditorDocContext.virtual` | AI 工具 -> 编辑器 | 中 | 高 |
| 3 | 动作注册表 + when | ActionManager | `command-palette` 重构 | 中 | 高 |
| 4 | 部分 hunk 提交 / diff 导航 | `hunkInclusion` + `DiffNavigator` | `GitDiffPane` | 低 | 高 |
| 5 | Run Anything 快速执行 | `runAnything` | `command-palette` | 低 | 高 |

## 4. 不建议借鉴项

与 Terax "Not an IDE clone" 定位冲突，明确排除：

- 数据库工具（sqlx 连接池 + 对象浏览器）
- Maven / Gradle 构建工具窗口
- Docker / GitHub PR 服务树
- Spring Boot / jdtls Java 调试（JVM 工具链）
- WASM 插件宿主（wasmtime），Terax 已有 JS 插件，重写成本高

## 5. 结论

openidea 对 Terax 最有价值的是统一的 gutter Lane、虚拟文档标签、动作注册表三个架构机制，而非具体功能。它们不增加包体积，不违背轻量定位，反而偿还架构债务并强化 AI 场景，与 Terax ROADMAP 的 "AI as a primitive + lightweight always" 高度一致。其余功能列为候选，按用户需求度排期。

## 参考

- [TERAX.md](../TERAX.md) - 架构真相源
- [ROADMAP.md](../ROADMAP.md) - 产品方向与范围
- [docs/README.md](../README.md) - 贡献者文档索引
