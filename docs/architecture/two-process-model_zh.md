# 双进程模型与 IPC 命令参考

本指南对 `TERAX.md` 进行了详细说明。如果此处内容与 `TERAX.md` 冲突，以 `TERAX.md` 为准。

## 两个进程的划分

Terax 由两个进程组成：Rust 后端（`src-tauri/`）和 webview 前端（`src/`）。

- **Rust 负责所有操作系统访问**：PTY、文件系统、git、shell 启动、网络、机密信息、工作区授权。
- **webview 不会直接接触文件系统、进程或 shell**。所有主机操作都通过 `invoke()` 调用，转到在 `src-tauri/src/lib.rs` 中注册的命令。

这条边界是安全模型的根基。不可信输入（终端转义序列、文件内容、AI 工具结果）会在 Rust 中或经过严格限定的前端代码中进行解析和验证，绝不会由渲染器执行。

## 添加新的 IPC 命令

1. 在适当的 `src-tauri/src/modules/<area>/` 模块中编写 `#[tauri::command]` 异步函数。
2. 在 `src-tauri/src/lib.rs` 的 `tauri::generate_handler![...]` 代码块中注册它（`src-tauri/src/lib.rs:191`）。
3. 如果命令使用 Tauri 插件 API（窗口、剪贴板、对话框等），将插件权限添加到 `src-tauri/capabilities/default.json`。
4. 在匹配的 `src/modules/<area>/lib/` 目录中添加类型化的前端封装，并通过 Tauri 的 `invoke()` API 调用它。
5. 如果命令接触文件系统、网络或 shell，必须经过现有的防护机制（`security.ts` deny-list、工作区授权注册表、SSRF 防护、AI 工具审批）。

自定义命令不需要逐一列入 `default.json`；该能力覆盖窗口。插件权限则需要列出。

## 命令目录

在 `src-tauri/src/lib.rs` 中注册的命令按模块分组如下。名称是前端所见的 Rust 函数名称。

### PTY（`src-tauri/src/modules/pty/`）

长期运行的交互式终端会话。

- `pty_open` - 创建新的 PTY 会话
- `pty_write` - 发送输入字节（文本或控制序列）
- `pty_resize` - 调整 PTY 大小
- `pty_close` / `pty_close_all` - 销毁一个或全部会话
- `pty_has_foreground_process` / `pty_has_foreground_job` - 检测命令是否正在运行
- `pty_shell_name` / `pty_list_shells` - shell 检测与枚举

`pty_open` 的输出流通过 Tauri `Channel<PtyEvent>` 提供。

### 文件系统（`src-tauri/src/modules/fs/`）

#### 树

- `list_subdirs` - 列出子目录
- `fs_read_dir` - 读取目录

#### 文件

- `fs_read_file` - 读取文件内容
- `fs_write_file` - 写入文件内容
- `fs_stat` - 文件元数据
- `fs_canonicalize` - 规范化路径

#### 修改

- `fs_create_file` / `fs_create_dir`
- `fs_rename` / `fs_delete` / `fs_copy`

#### 监视

- `fs_watch_add` / `fs_watch_remove` - 文件系统变更通知

#### 搜索

- `fs_search` - 模糊文件查找器
- `fs_list_files` - 递归列出文件

#### Grep

- `fs_grep` - 内容搜索
- `fs_grep_interactive` - 交互式内容搜索
- `fs_glob` - glob 匹配

### Git（`src-tauri/src/modules/git/`）

所有 git 命令都通过工作区授权注册表进行门控。

- `git_resolve_repo` / `git_panel_snapshot`
- `git_status`
- `git_diff` / `git_diff_content`
- `git_stage` / `git_unstage` / `git_discard`
- `git_commit`
- `git_fetch` / `git_pull_ff_only` / `git_push`
- `git_log` / `git_show_commit` / `git_commit_files` / `git_commit_file_diff`
- `git_remote_url`
- `git_list_branches` / `git_checkout_branch`

### Shell（`src-tauri/src/modules/shell/`）

三个不同的使用界面：

- `shell_run_command` - 供 AI 工具使用的一次性子 shell 执行
- `shell_session_open` / `shell_session_run` / `shell_session_close` - 在多次调用之间保持状态的持久代理 shell
- `shell_bg_spawn` / `shell_bg_logs` / `shell_bg_kill` / `shell_bg_list` - 长期运行的后台进程，带有有界环形缓冲区日志捕获

### 工作区（`src-tauri/src/modules/workspace.rs`）

- `workspace_authorize` / `workspace_current_dir` - spawn/git/AI 当前工作目录授权注册表
- `wsl_list_distros` / `wsl_default_distro` / `wsl_home` - WSL 桥接

### 网络（`src-tauri/src/modules/net.rs`）

- `ai_http_request` / `ai_http_stream` - 带 SSRF 防护的 AI HTTP 代理
- `lm_ping` - 本地模型 ping

### 机密信息（`src-tauri/src/modules/secrets.rs`）

- `secrets_get` / `secrets_set` / `secrets_delete` / `secrets_get_all` - 操作系统钥匙串访问，服务为 `terax-ai`

### 代理钩子（`src-tauri/src/modules/agent.rs`）

- `agent_enable_hooks` / `agent_hooks_status` - 安装/查看终端编码代理钩子的状态（Claude Code、Codex、Gemini CLI）

### 历史记录（`src-tauri/src/modules/history/`）

- `history_suggest` / `history_commands` / `history_record` / `history_list` - shell 历史记录集成

### 设置窗口

- `get_launch_dir` - CLI 启动目录，首次读取时取出
- `open_settings_window` - 打开独立的设置 webview（可选的 `tab` 深层链接）

### CLI 控制平面

- `control_frontend_ready` - 标记恢复后的主 UI 已准备好接收路由的 CLI 操作
- `control_respond` - 完成一个待处理的、绑定 UI 的 CLI 请求

参见 [CLI 控制平面](cli-control.md)，了解本地协议和打包模型。

## 不变量

- 除了通过上述命令之外，webview 不得启动进程、读取文件或发起网络调用。
- 新命令必须在 `lib.rs` 中注册，并在边界处进行防护（工作区授权、deny-list、SSRF、审批流程）。
- 如果命令使用插件 API，必须将插件权限添加到 `src-tauri/capabilities/default.json`。

## 另请参阅

- [`TERAX.md`](../../TERAX.md) - 架构事实来源
- [`docs/README.md`](../README.md) - 贡献者指南索引
- [PTY shell 集成](pty-shell-integration.md) - 会话和 shell 集成的工作方式
- [安全模型](security-model.md) - 每个命令必须遵守的边界
