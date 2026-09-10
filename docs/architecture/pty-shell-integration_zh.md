# PTY shell 集成

本指南详细说明 `TERAX.md`。如果本文档与 `TERAX.md` 有任何冲突，以 `TERAX.md` 为准。

## 会话模型

一个终端标签页对应一个 PTY 会话。会话存储在 `PtyState`（`src-tauri/src/modules/pty/mod.rs:20`）中：

```rust
pub struct PtyState {
    sessions: RwLock<HashMap<u32, Arc<Session>>>,
    next_id: AtomicU32,
}
```

ID 从 1 开始并单调递增；它们永不复用，因此前端可以将 `0` 视为未设置。

`pty_open`（`mod.rs:44`）在阻塞线程上生成会话，将其插入映射并返回 ID。输出通过 `Channel<Response>` 流式传输；退出代码通过独立的 `Channel<i32>` 流式传输。`pty_write`（`mod.rs:100`）接受带有 `x-pty-id` header 的原始字节，以避免每次按键都进行 JSON 序列化。

## Reader / flusher / waiter 线程

`session::spawn`（`session.rs:102`）为每个会话启动三个线程：

1. **Reader** - 从 PTY 主端读取字节，运行 DA 过滤器和 agent 检测器，并将过滤后的字节推入待处理缓冲区。
2. **Flusher** - 合并输出，并通过数据通道将其发送到前端。
3. **Waiter** - 等待子进程退出，刷新末尾数据，并发出退出代码。

待处理缓冲区上限为 4 MiB；溢出时会丢弃缓冲区，并替换为 SGR 重置提示，以免切分的 CSI 序列破坏 xterm 状态。

## Shell 启动

`shell_init::build_command`（`shell_init.rs:53`）构建用于生成 shell 的 `CommandBuilder`。路径和参数取决于平台以及选定的工作区环境（Local 或 WSL 发行版）。

### Unix

集成脚本位于 `src-tauri/src/modules/pty/scripts/`：

- zsh 使用 `zshenv.zsh`、`zprofile.zsh`、`zlogin.zsh`、`zshrc.zsh`
- bash 使用 `bashrc.bash`
- fish 使用 `init.fish`，安装到 `~/.config/fish/conf.d/terax.fish`

Zsh 启动时将 `ZDOTDIR` 指向一个临时目录，该目录会加载我们的脚本，然后加载用户实际的配置。Bash 使用 `--rcfile` 和一个包装器，在 Terax 的配置之后加载用户的 `~/.bashrc`。Fish 使用 `conf.d`，因此不会替换用户文件。

所有已集成的 shell 都会发出 **OSC 7**（cwd）和 **OSC 133 A/B/C/D**（提示符边界和退出代码），这样 Terax 无需解析用户的提示符即可跟踪 cwd 并检测命令边界。

### Windows

在 Windows 上，shell 的优先级如下：

1. `pwsh.exe`（PowerShell 7+）
2. `powershell.exe`（Windows PowerShell 5.1）
3. `cmd.exe`（无集成）

PowerShell 通过以下方式加载 `profile.ps1`：

```text
pwsh -NoLogo -NoExit -ExecutionPolicy Bypass -File <profile.ps1>
```

该配置文件会包装用户现有的 `prompt` 函数，在 `$PROFILE` 运行后发出 OSC 7 + OSC 133 A/B/D。传递给 ConPTY 前，cwd 会被规范化为反斜杠，因为 `CreateProcessW` 对正斜杠的处理存在问题。

### Fish 4.0+

Fish 4.0 会写入自己的 OSC 133 提示符标记。为避免重复，Terax 设置 `fish_features=no-mark-prompt`，并在 `config.fish` 运行后通过 `-C` 重新声明自己的提示符。

## Windows 上的并发与进程生命周期

### `CONPTY_LIFECYCLE_LOCK`

`openpty + spawn_command` 及相应的关闭操作由 `session.rs:71` 中的静态互斥锁串行化。并发的 ConPTY 生命周期调用会破坏新控制台，导致其 shell 无法处理输出。

### Job Object

每个 ConPTY 子进程都会被分配到一个带有 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`（`job.rs:34`）的 Windows Job Object。当 Job HANDLE 被释放时——无论是正常关闭、panic，还是 Terax 进程被 SIGKILL——内核都会终止 shell 的所有后代进程。没有这一机制，`TerminateProcess` 只会终止直接子进程，而在 pwsh 中启动的 `npm run dev` 会成为孤儿进程。

在 macOS 和 Linux 上，`Drop for Session` 会调用 `killer.kill()`。开发环境中执行 `cargo run` 时按下 `Ctrl-C` 仍可能留下孤儿进程，因为析构函数不一定会运行；这仅对开发环境可接受。

## 输入与转义序列处理

### DA 过滤器

PowerShell / PSReadLine 会在启动时发送光标位置查询（`ESC[6n`），并阻塞等待响应。`DaFilter`（`da_filter.rs`）会拦截该查询并通过 PTY 输入端回复，因此 shell 不会挂起。

### Agent 检测

Reader 线程会对字节流运行 `AgentDetector`（`agent_detect.rs`）。它由 `OSC 133;C;<cmd>` 或自行启用的 `OSC 777` 标记激活，并发出 `terax:agent-signal` 状态转换（`started`、`working`、`attention`、`finished`、`exited`）。检测仅由 OSC 序列驱动，绝不依赖原始输出，因此重绘 TUI 不会导致状态抖动。

### Enter 键

终端输入发送的是 `\r`（CR），而不是 `\n`（LF）。Windows 上的 PowerShell 要求使用 CR。

## 不变量

- 在先验证快速连续创建标签页时第一个标签页的稳定性之前，不要移除 `CONPTY_LIFECYCLE_LOCK`。
- 不要在 Windows 上禁用 Job Object，除非有替代的孤儿进程防护机制。
- 将平台特定的 shell 逻辑保留在 `shell_init.rs` 中相应的 `#[cfg(unix)]` 或 `#[cfg(windows)]` 分支内。
- 传递给 ConPTY 的 cwd 必须使用反斜杠；到达前端的 OSC 7 cwd 则采用正斜杠规范形式。

## 另请参阅

- [`TERAX.md`](../../TERAX.md) - 架构事实标准
- [`docs/README.md`](../README.md) - 贡献者指南索引
- [双进程模型](two-process-model.md) - IPC 边界和命令目录
- [终端渲染器池](terminal-renderer-pool.md) - 槽位池化和 DormantRing
