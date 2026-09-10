# AI 子系统

本指南详细说明 `TERAX.md`。如果本文档与 `TERAX.md` 有任何冲突，以 `TERAX.md` 为准。

## 概述

AI 子系统采用 BYOK（自带密钥）模式。它通过 `@ai-sdk/*` 支持云服务商，并通过兼容 OpenAI 的端点支持本地 / 离线服务商。代理层基于 Vercel AI SDK v6 的聊天语义构建：`streamText`、工具定义和 `stopWhen` 步骤限制。

主要入口：`src/modules/ai/lib/agent.ts` 中的 `runAgentStream`。

## 服务商

云服务商定义在 `src/modules/ai/config.ts` 中：

- OpenAI、Anthropic、Google、xAI、Cerebras、Groq、DeepSeek、Mistral、OpenRouter
- 适用于任意自定义 base URL 的 `openai-compatible`
- 本地：LM Studio、MLX、Ollama

`src/modules/ai/lib/agent.ts:76` 中的 `buildLanguageModel` 根据 `provider` 分支，以构造正确的 AI SDK 服务商实例。本地服务商使用带有 `localProxyFetch` 的 `createOpenAICompatible`，允许访问私有网络；云服务商则使用各自专用的 SDK 构造函数。

模型元数据（上下文限制、成本、推理行为）位于 `config.ts` 的模型注册表中。`resolveModel` 将模型 id 映射到其服务商和默认值。

### 添加新的服务商

1. 在 `src/modules/ai/config.ts` 的 `PROVIDERS` 中添加一个 `ProviderInfo` 条目。
2. 在同一文件的模型注册表中添加模型 id 和元数据。
3. 在 `buildLanguageModel`（`src/modules/ai/lib/agent.ts:99`）中添加分支，以构造服务商实例。对于兼容 OpenAI 的 API，通常可以复用 `createOpenAICompatible`。
4. 如果服务商需要 API key，请更新 `config.ts` 中的 `providerNeedsKey` 以及密钥环服务映射。
5. 如果需要专用的 `@ai-sdk/*` 包，请将其添加到 `package.json`，并说明其打包成本的合理性（参见 `CONTRIBUTING.md`）。
6. 新增的内置服务商必须证明其相对于 `openai-compatible` 和 OpenRouter 的独特价值；`CONTRIBUTING.md` 对此有明确说明。

密钥绝不会持久化到操作系统密钥链 / Linux secrets 文件之外的任何位置。

## 代理运行循环

`runAgentStream`（`agent.ts:391`）：

1. 通过 `buildConfiguredLanguageModel` 解析模型。
2. 使用 `selectSystemPrompt(modelId)` 加上可选的人设、自定义指令和 `TERAX.md` 项目记忆，构建稳定的系统提示词。
3. 将 UI 消息转换为模型消息；如果模型不保留推理内容，则清理这些内容；如果超过上下文限制，则压缩旧消息。
4. 使用 `buildTools(ctx)` 提供的工具集和 `stopWhen: stepCountIs(MAX_AGENT_STEPS)`，通过 `streamText` 流式传输。
5. 发出步骤标签、用量增量和完成元数据。

工具集在 `src/modules/ai/tools/tools.ts` 中由 `fs`、`edit`、`search`、`shell`、`subagent`、`terminal`、`todo` 和 `managedAgent` 构建器组装而成。

## 子代理

`src/modules/ai/agents/registry.ts` 定义了只读子代理：`explore`、`code-review`、`security` 和 `general`。每个子代理都有自己的工具白名单和系统提示词。`run_subagent` 不能递归调用（子代理工具集排除了 `run_subagent` 本身）。

## 会话

对话按会话组织。持久化通过 `tauri-plugin-store` 存储在 `terax-ai-sessions.json` 中（`src/modules/ai/lib/sessions.ts`）：

- `sessions` 键：会话元数据列表
- `activeId` 键：活动会话 id
- `messages:<id>` 键：每个会话的消息，按需加载

`AgentRunBridge` 会在每次变更时将活动会话消息镜像到磁盘，并根据第一条用户消息自动生成标题。

## 编写器

`AiComposerProvider`（`src/modules/ai/lib/composer.tsx`）是一个 React 上下文，为停靠式输入栏及其他界面保存共享的输入状态（文本、附件、语音）。附件可以是图像、文本文件，或来自终端或编辑器的 `selection` 芯片。提交时，选区会被包装成 `<selection source="terminal|editor">…</selection>` 块，不会粘贴到文本区域中。

编写器从 `agentMeta.status` 推导 `isBusy`，因此可以在会话完成 hydration 之前安全挂载。

## 工具与审批

工具定义位于 `src/modules/ai/tools/` 下：

- 只读工具（`read_file`、`list_directory`、`grep`、`glob`）通过安全拒绝列表后自动执行。
- 变更工具（`write_file`、`edit`、`multi_edit`、`create_directory`、`bash_run`、`bash_background`）设置 `needsApproval: true`。AI SDK 会暂停，UI 则渲染审批卡片。
- `edit` / `multi_edit` 强制执行编辑前读取不变量：模型必须在本会话早些时候读取过该文件。
- 在计划模式下，变更工具会将编辑排队等待批量审查，而不是立即应用。

审批后自动发送使用 `lastAssistantMessageIsCompleteWithApprovalResponses`。

## 编辑差异

AI 提议的文件编辑会在 `ai-diff` 标签页中打开。用户可以逐个代码块接受或拒绝。只有接受后，`write_file` 或 `edit` 工具才会真正运行。这使审批 UI 与工具执行相互解耦。

## 实时上下文桥接

`App.tsx` 调用 `setLive({ getCwd, getTerminalContext, … })`，使工具能够读取当前活动终端的 cwd 和缓冲区最后 300 行。这种设计是惰性的——工具仅在需要时调用它，而不是为每一轮预先创建快照。

## 不变量

- 保持 Vercel AI SDK v6 的聊天结构（`streamText`、工具、步骤限制）；其余 UI 都依赖这一结构。
- 密钥只能通过 `secrets_*` 命令使用；绝不能写入磁盘、设置存储或 `localStorage`。
- 新服务商必须说明其打包成本和独特价值的合理性。
- 变更工具需要审批；只读工具仍须通过拒绝列表。

## 另请参阅

- [`TERAX.md`](../../TERAX.md) - 架构事实来源
- [`docs/README.md`](../README.md) - 贡献者指南索引
- [双进程模型](two-process-model.md) - IPC 边界和命令目录
- [安全模型](security-model.md) - 每个工具必须遵守的边界
