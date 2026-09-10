# 安全模型

本指南对 `TERAX.md` 作进一步说明。如果本文档与 `TERAX.md` 有任何冲突，以 `TERAX.md` 为准。

Terax 运行 shell、读写文件，并向 AI 提供商发送数据。安全模型采用纵深防御：没有任何单一防护措施足够可靠，因此每个边界都会在执行操作前验证输入。

## 边界

主要信任边界包括：

1. **IPC 边界** - 在 `src-tauri/src/lib.rs` 中注册的命令，由 `src-tauri/capabilities/default.json` 进行门控。
2. **文件系统边界** - AI 工具通过 `src/modules/ai/lib/security.ts`，PTY spawn 通过工作区授权注册表。
3. **网络边界** - `src-tauri/src/modules/net.rs` 中的 AI HTTP 代理，提供 SSRF 和 DNS 重绑定防护。
4. **密钥存储边界** - 密钥存放在操作系统密钥链中，绝不写入磁盘或 `localStorage`。
5. **终端转义序列边界** - OSC 序列会被解析和处理，但绝不会被盲目信任以修改状态。

## 密钥路径拒绝列表

`src/modules/ai/lib/security.ts` 会拒绝读取和写入明显的密钥路径。这同时适用于**读取和写入**，绝不能绕过。

被阻止的类别包括：

- 文件：`.env*`、`*.pem`、`*.key`、`*.p12`、`id_rsa*`、`known_hosts`、`credentials`、`service-account*.json` 以及类似文件。
- 目录：`~/.ssh`、`~/.gnupg`、`~/.aws`、`~/.kube`、`~/.config/gh`、`~/.git`、系统目录（`/etc`、`/proc`、`/sys`）以及 Windows 凭据存储。
- 系统写入前缀：`/etc/`、`/var/db/`、`/usr/bin/`、`/windows/`、`/program files/` 等。

比较面会对路径进行规范化：将反斜杠转换为正斜杠，去除 Windows 驱动器号，去除 NTFS 备用数据流，去除末尾的点和空格，转换为小写，并合并重复的斜杠。受保护的目录会按精确路径或后代路径匹配，而不是按原始子字符串匹配。

`checkReadableCanonical` 和 `checkWritableCanonical` 也会对路径进行规范化，并重新检查解析后的形式，因此即使一个无害路径下的符号链接指向 `~/.ssh`，也会被拦截。

## 工作区授权注册表

`WorkspaceRegistry`（`src-tauri/src/modules/workspace.rs:20`）跟踪 PTY spawn、git 命令和 AI 工具获准操作的目录。

- `workspace_authorize` 添加目录。
- `authorize_spawn_cwd` 拒绝工作目录位于已授权根目录之外的 spawn。
- `authorize_user_spawn_cwd` 将用户选择的工作目录注册为新的根目录，而不是拒绝它。
- 注册表以启动目录和用户主目录（`workspace.rs:135`）作为初始内容。

这是文件系统边界的允许侧。任何在当前工作区之外启动 shell 或修改文件的新功能，都必须与此注册表交互。

## AI 工具审批流程

在 `src/modules/ai/tools/tools.ts` 中：

- 只读工具（`read_file`、`list_directory`、`grep`、`glob`）通过拒绝列表检查后自动执行。
- 修改工具（`write_file`、`edit`、`multi_edit`、`create_directory`、`run_command`、`shell_session_run`、`shell_bg_spawn`）设置 `needsApproval: true`。AI SDK 会暂停执行，并呈现一个作为确认卡片渲染的 `tool-approval-request` 部分。
- `edit` / `multi_edit` 强制执行编辑前读取不变量：模型必须在本会话早些时候读取过该文件。

审批后自动发送使用 `lastAssistantMessageIsCompleteWithApprovalResponses`。

## SSRF 和 DNS 重绑定防护

`src-tauri/src/modules/net.rs` 代理 AI 提供商请求和本地模型 ping。建立连接前：

1. 解析主机名一次（`resolve_and_classify`）。
2. 将每个解析出的 IP 分类为公共、私有、环回或被阻止的元数据地址。
3. 阻止云元数据端点（`169.254.169.254`、`metadata.google.internal`、AWS IPv6 元数据地址等）。
4. 将 reqwest 固定到解析出的 IP，从而避免第二次 DNS 查询返回不同地址（DNS 重绑定）。

本地 LLM 端点会被明确允许，因为用户通过将 Terax 指向这些端点选择启用它们，但它们仍会被分类并记录日志。

## 密钥存储

API 密钥通过 `secrets_*` 命令（`src-tauri/src/modules/secrets.rs`）存储：

- macOS：通过 `keyring` 使用 Keychain
- Windows：通过 `keyring` 使用 Credential Manager
- Linux：存储在应用本地数据目录中的 JSON 文件中，权限模式为 `0600`（先原子写入 `.tmp`，再重命名）

服务常量：`terax-ai`。除密钥链/Linux 密钥文件外，密钥绝不会接触磁盘，绝不会进入 `localStorage`，也绝不会出现在日志中。

## OSC 信任门控

终端会解析来自 PTY 字节流的 OSC 序列：

- **OSC 7** 更新标签页 cwd。
- **OSC 133 A/B/C/D** 标记提示符/命令边界。
- **OSC 777** 由 agent detector 用于发出 coding-agent 状态转换信号。

agent detector（`src-tauri/src/modules/pty/agent_detect.rs`）由 `OSC 133;C;<cmd>` 或 self-armed 标记激活，并发出 `terax:agent-signal` 事件。它**仅由 OSC 序列**驱动，绝不读取原始输出，因此重绘 TUI 不会导致状态抖动。

## 不变量

- `security.ts` 中的拒绝列表同时适用于读取和写入。绝不能绕过它。
- 新增的接触文件系统的命令必须遵守工作区授权注册表。
- 新增的面向网络的命令必须通过 `net.rs` 代理，或重新实现相同的分类和 DNS 固定机制。
- 新增的插件 API 必须添加到 `src-tauri/capabilities/default.json`。
- 密钥、令牌和凭据必须保留在密钥链 / Linux 密钥文件中。

## 另请参阅

- [`TERAX.md`](../../TERAX.md) - 架构事实来源
- [`docs/README.md`](../README.md) - 贡献者指南索引
- [双进程模型](two-process-model.md) - IPC 边界和命令目录
- [AI 子系统](ai-subsystem.md) - 工具、审批流程和提供商处理
