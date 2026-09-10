# CLI 控制平面

本指南是对 `TERAX.md` 的细化说明。若此处内容与 `TERAX.md` 存在冲突，以 `TERAX.md` 为准。

## 现状面

Terax 内置了一个小型的 Rust 客户端，内部命名为 `terax-cli`。原生终端窗格将其作为公开的 `terax` 命令暴露出来：

```text
terax <file> [--line <n>] [--no-focus] [--json]
terax open <file> [--line <n>] [--no-focus] [--json]
terax ping [--json]
terax capabilities [--json]
terax identify [--json]
```

应用必须已经在运行。在 Terax 窗格内启动的命令会定向到该窗格所属的 Space，即使另一个 Space 或标签页持有 UI 焦点。没有窗格上下文的外部客户端会回退到当前活动的 UI 上下文。

## 组件

- `src-tauri/crates/terax-control-protocol` 包含应用和 CLI 共用的、低依赖的请求、响应、错误、描述符和方法类型。
- `src-tauri/crates/terax-cli` 包含独立的控制台客户端。它有意避免使用 Clap、Tokio、reqwest 和 Tauri。
- `src-tauri/src/modules/control.rs` 负责端点发现、身份认证、消息上限、并发上限、超时、路径规范化（path canonicalization）和请求路由。
- `src/modules/control/` 将调用方窗格映射到其标签页和 Space，然后执行那一小批仅限 UI 的操作。
- `scripts/build-cli.mjs` 构建 Tauri 的 `externalBin` 打包器所期望的、针对特定目标的辅助程序。

`ping`、`capabilities`、身份认证和文件校验由 Rust 直接处理。必须变更 React 状态的动作会被发送到主 webview，并通过 `control_respond` 完成。这样，OS 侧的校验落在 Rust 中，同时无需在 React 之外重复维护标签页模型。

## 传输与身份认证

应用绑定一个临时的环回 TCP 端口，并将发现描述符写入用户缓存目录下的 `terax/control.json`。描述符包含协议版本、地址、进程 id、应用版本以及一个随机的 256 位令牌。

安全属性：

- 监听器仅绑定到 `127.0.0.1`。
- Unix 控制目录权限为 `0700`；描述符以 `0600` 权限原子替换。Windows 使用当前用户继承的配置文件 ACL。
- 每个请求都携带令牌，不匹配时使用常数时间比较（constant-time comparison）将其拒绝。
- 消息采用换行分隔的 JSON，大小上限为 64 KiB。
- 请求 id 有界限，且限定为可安全记录（log-safe）的 ASCII。
- 连接数和待处理 UI 请求数上限为 32，并设有有界的读写以及 UI 响应超时。
- CLI 在发送自己的令牌之前，会先验证缓存描述符所指向的仍是一个存活的 Terax 进程。
- 文件路径会被规范化，且要求引用授权工作区内某个常规文件，之后才会打开编辑器。
- 描述符仅在其仍属于正在退出的进程时才会被删除，因此旧实例无法删除新实例的端点。

令牌会连同 `TERAX_PANE_ID` 一起注入到 Terax 生成的本地 shell 中。子编码代理有意继承调用方上下文，这赋予它们与其启动终端相同的本地 UI 控制能力。令牌绝不能写入日志或添加到命令输出中。

## 在 PTY 内的命令发现

打包后的辅助程序命名为 `terax-cli`，因为 macOS 应用程序包会将 sidecar 放在 GUI 可执行文件（其本身已命名为 `terax`）旁边。在应用启动时，Terax 会为该打包的辅助程序创建一个用户私有的、按进程划分的 `bin/terax` 硬链接，在 Unix 上回退为符号链接，在 Windows 上则退化为复制。该目录会被前置到 PTY 的 `PATH` 中。

现有的 Bash、Zsh、Fish 和 PowerShell 集成还定义了一个交互式的 `terax` 函数，用于执行 `$TERAX_CLI`。真正的 PATH 条目仍然是必需的，因为非交互式子 shell 不能可靠地继承 shell 函数。

已退出进程的启动器目录会在下一次控制服务器启动时被清除。存活进程的 id 无论目录存在多久都会被保留。

## 打包与体积

`tauri.conf.json` 将 `binaries/terax-cli` 声明为外部二进制文件。Tauri 会选取带当前目标三元组后缀的文件，并将其与应用一同签名或打包。发布工作流会将其显式的 Rust 目标传给 `scripts/build-cli.mjs`，从而防止 x86_64 macOS 发布版本意外地打包来自宿主机的 arm64 辅助程序。

发布配置文件使用单个 codegen 单元、fat LTO、体积优化、panic 即中止（abort-on-panic）以及剥离。更改依赖后，务必测量实际的目标产物。

## 当前限制

- WSL 窗格目前还无法收到控制凭据或 CLI 启动器。Windows 路径转换和 WSL 网络必须一起实现并测试。
- Terax 目前尚未为外部 Terminal.app、PowerShell 或其他终端安装全局命令。打包后的辅助程序和缓存描述符已经为这一未来安装步骤做好了准备。
- CLI 目前还无法启动一个已停止的 Terax 应用。
- 拆分、标签页、代理、屏幕朗读（screen-read）和输入命令不属于协议版本 1 的一部分。

这些限制被明确列出，以便不受支持的路径以"不可用"的方式失败，而不是静默地定向到错误的窗格，或为一条无法连接的命令暴露凭据。

## 扩展协议

1. 在 `terax-control-protocol` 中添加方法常量和类型化参数。
2. 在 Rust 中验证身份认证、协议版本、界限以及面向 OS 的输入。
3. 当方法不依赖 React 状态时，在 Rust 中处理它。仅将 UI 相关的工作路由到前端。
4. 在回退到活动 UI 状态之前，先解析出显式的调用方窗格。
5. 返回结构化错误，并保持 `--json` 输出稳定。
6. 添加协议、解析器、路由、平台和体积检查。

## 参见

- [`TERAX.md`](../../TERAX.md) - 架构事实来源
- [双进程模型](two-process-model.md) - Tauri IPC 边界
- [PTY shell 集成](pty-shell-integration.md) - 环境注入与 shell 启动
- [安全模型](security-model.md) - 工作区与机密边界