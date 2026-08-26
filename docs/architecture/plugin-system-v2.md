# Plugin System v2

## 设计目标

插件系统不仅仅服务于 Space 信息展示，而是成为 Terax 的可扩展能力平台。

当前 plugin 只是插件的一个具体用例——"提供 Space 上下文信息"。但 Terax 作为终端/IDE 工具，未来插件可以做的事情很多：CI 状态监控、构建通知、代码质量检查、自定义文件操作、AI 扩展、通知推送、自定义终端装饰等。

v2 设计的核心思路是：**插件是提供能力的后台服务，而不是一个简单的脚本**。

---

## 1. 核心理念

### 插件 = 后台服务

每个插件是一个长期运行的独立进程，提供一组能力（Capability）。消费者（Terax 内部模块或其他插件）通过能力名字来使用插件提供的功能，不关心背后是哪个插件。

### 能力注册

插件启动时向 Terax 注册自己提供的能力。Terax 维护一个能力路由表，将请求路由到注册了该能力的插件。

### 多运行时

插件不限于 Node.js。Terax 定义标准协议，适配器负责将不同运行时接入系统。

---

## 2. 插件清单

每个插件有一个 `manifest.json`，放在插件目录下：

```json
{
  "id": "com.example.health-check",
  "name": "Health Check",
  "version": "1.0.0",
  "description": "Monitor service health for each space",
  "author": "Example",
  "runtime": "node",
  "entry": "index.mjs",
  "capabilities": [
    {
      "id": "space:health",
      "description": "Health status for spaces",
      "type": "request-response",
      "config": {
        "properties": {
          "interval": { "type": "number", "default": 60 }
        }
      }
    }
  ],
  "permissions": ["network:http"],
  "lifecycle": {
    "persistent": true,
    "restart": "always"
  }
}
```

这是用户可查看的元信息，而不是运行时配置。用户不需要手动编辑它，Terax 在安装时读取。

### 清单字段

| 字段 | 说明 |
|------|------|
| `id` | 全局唯一标识 |
| `name` | 用户看到的名称 |
| `version` | 语义版本号 |
| `description` | 简短说明 |
| `author` | 作者信息 |
| `runtime` | 运行环境：`node` / `python` / `deno` / `shell` |
| `entry` | 入口文件，相对于插件目录 |
| `capabilities` | 提供的能力列表 |
| `permissions` | 声明的权限 |
| `lifecycle` | 生命周期策略 |

---

## 3. 运行时抽象

不同运行时的插件使用相同的通信协议，但由不同的适配器执行：

```
           ┌─────────────────────────────────────────┐
           │            Plugin Manager                │
           └──────┬──────┬──────┬──────┬──────────────┘
                  │      │      │      │
           ┌──────┴┐ ┌───┴───┐ ┌┴───┐ ┌┴──────────┐
           │ Node  │ │Python │ │Deno│ │ Shell      │
           │Adapter│ │Adapter│ │Adpt│ │ Adapter    │
           └───────┘ └───────┘ └────┘ └────────────┘
```

每个适配器：

- 验证运行时可执行文件是否存在
- 使用标准协议启动和管理插件进程
- 处理进程退出和重启
- 收集 stderr 日志

对于 Node 适配器，Terax 可以自动安装好标准的 Terax 插件 SDK（`@terax/plugin-sdk`），让插件开发更简单。

---

## 4. 能力系统

能力是插件的核心抽象。每个插件声明自己能提供什么能力，消费者通过能力名访问。

### 能力类型

| 类型 | 说明 | 示例 |
|------|------|------|
| `request-response` | 请求-响应 | `space:health` |
| `stream` | 持续数据流 | `build:status` |
| `event-emitter` | 事件推送 | `notify:alert` |
| `action` | 触发式操作 | `file:transform` |

### 能力路由

```
Consumer (Space UI)
     │
     │  invoke("space:health", { spaceId: "abc" })
     ▼
Plugin Manager ──── 路由表 ────
     │                        │
     │  space:health        build:status
     │  └─ health-check     └─ ci-monitor
     │     (Node)              (Python)
```

### 能力冲突

如果两个插件声明了同一个能力：

1. 默认使用后安装的插件
2. 用户可以在设置中手工指定优先插件
3. 用户可以完全禁用某个插件的能力

---

## 5. 协议

### 标准协议

保持与当前一致的 JSONL 协议，但扩展到支持能力路由：

**请求：**

```json
{"jsonrpc":"2.0","id":1,"method":"capability.invoke","params":{"capability":"space:health","args":{"spaceId":"abc"}}}
```

**响应：**

```json
{"jsonrpc":"2.0","id":1,"result":{"status":"online","onlineAt":"2026-08-26T10:00:00Z"}}
```

**事件推送：**

插件可以在没有请求的情况下主动推送事件：

```json
{"jsonrpc":"2.0","method":"event","params":{"type":"build:status:changed","data":{"spaceId":"abc","status":"failed"}}}
```

Terax 收到事件后，会分发给订阅了该事件类型的内部模块。

### 插件 SDK

为了让插件开发者更容易，提供一个 `@terax/plugin-sdk` 包（Node.js）：

```typescript
import { Plugin } from "@terax/plugin-sdk";

const plugin = new Plugin({
  id: "com.example.health-check",
  name: "Health Check",
});

// 注册能力
plugin.register("space:health", async (args) => {
  const { spaceId } = args;
  const result = await fetch(`https://api.example.com/health/${spaceId}`);
  return result.json();
});

// 发送事件
plugin.emit("notify:alert", {
  title: "Service down",
  spaceId: "abc",
});

plugin.start();
```

---

## 6. 多插件架构

### 同时运行多个插件

v2 允许同时启用多个插件，每个插件作为独立进程运行：

```
Plugin Manager
  │
  ├─ health-check (Node)     ── capability: space:health
  │     PID: 12345
  │
  ├─ ci-monitor (Python)     ── capability: build:status
  │     PID: 12346
  │
  └─ notify-service (Node)   ── capability: notify:alert
        PID: 12347
```

### 资源管理

- 每个插件有独立的进程资源限制
- 启动时有一个默认的并发插件数上限
- 超出限制的插件显示为"已安装但禁用"，提示用户选择启用哪些
- 进程异常退出可根据配置自动重启

### 能力聚合

一个插件可以提供多个能力，一个能力也可以被多个插件提供（由用户选择优先）。

---

## 7. 生命周期

```
                    ┌──────────┐
                    │ 已发现    │
                    └────┬─────┘
                         │ 用户安装
                    ┌────▼─────┐
                    │ 已安装    │
                    └────┬─────┘
                         │ 用户启用
                    ┌────▼─────┐     ┌──────────┐
                    │ 运行中    │────>│ 已停止    │
                    └────┬─────┘     └──────────┘
                         │ 异常退出        │
                    ┌────▼─────┐         │ 用户禁用
                    │ 自动重启  │         │
                    └──────────┘         │
                    ┌────▼──────────┐    │
                    │ 已禁用 (保留配置) │<──┘
                    └────┬──────────┘
                         │ 用户卸载
                    ┌────▼──────────┐
                    │ 已卸载 (删除配置) │
                    └───────────────┘
```

### 生命周期策略

在插件清单中声明：

```json
{
  "lifecycle": {
    "persistent": true,
    "restart": "always",
    "maxRestarts": 5,
    "restartDelay": 5000
  }
}
```

- `persistent: true`：启动时自动启动，持续运行直到被禁用或卸载
- `persistent: false`：按需启动，请求时启动，空闲后停止
- `restart: "always"`：异常退出后自动重启
- `restart: "never"`：异常退出后不自动重启，等待用户干预

---

## 8. 安全模型

### 权限声明

插件在 manifest 中声明需要哪些权限，Terax 在安装时展示给用户：

```json
{
  "permissions": [
    "network:http",
    "network:fetch",
    "fs:read-temp",
    "fs:read-space-root"
  ]
}
```

### 权限分级

| 级别 | 说明 | 示例 |
|------|------|------|
| `safe` | 不需要额外权限 | 本地计算、时间处理 |
| `network` | 网络访问 | `network:http` |
| `fs-read` | 文件读取 | `fs:read-space-root` |
| `fs-write` | 文件写入 | `fs:write-logs` |
| `process` | 进程管理 | `process:spawn` |
| `env` | 环境变量 | `env:read` |
| `dangerous` | 高风险操作 | 需要用户确认 |

### 沙箱边界

- 插件进程无法访问 Terax 内部状态
- 插件只能通过协议通道与 Terax 通信
- 插件不接收 Terax 的 API 密钥、控制 token 或内部凭据
- 插件的文件访问限于已声明的路径
- 插件不共享进程空间，每个插件独立运行

---

## 9. 安装与分发

### 安装来源

| 来源 | 说明 |
|------|------|
| 本地目录 | 用户指定插件目录 |
| 远程 URL | 下载 zip/tar 包 |
| 内置插件 | Terax 自带的插件 |
| 本地文件 | 选择 .zip 包导入 |

### 插件目录结构

```
{data}/terax/
  plugins/
    com.example.health-check/
      manifest.json
      index.mjs
      node_modules/    (可选，由 Terax 管理)
    com.example.ci-monitor/
      manifest.json
      main.py
      requirements.txt
```

### 内置插件

内置插件仍然是硬编码的，但以同样的格式呈现。内置插件在 `src-tauri/plugins/` 下，编译时嵌入。

---

## 10. 事件总线

### 系统事件

Terax 内置事件总线，插件可以订阅系统事件：

| 事件 | 说明 |
|------|------|
| `space:activated` | Space 切换 |
| `space:deactivated` | Space 离开 |
| `space:created` | Space 创建 |
| `space:deleted` | Space 删除 |
| `file:opened` | 文件打开 |
| `file:saved` | 文件保存 |
| `terminal:command` | 终端命令执行 |
| `app:focus` | 应用获得焦点 |
| `app:blur` | 应用失去焦点 |

### 插件事件

插件也可以定义自己的事件类型，通过 `capability.invoke` 注册后在事件总线上广播。

### 事件订阅

```json
// 插件 manifest 中声明
{
  "capabilities": [
    {
      "id": "notify:alert",
      "type": "event-emitter"
    }
  ],
  "subscriptions": ["space:activated", "build:status:changed"]
}
```

---

## 11. 与现有架构的兼容

### 当前 plugin 用例

当前 plugin 在 v2 中对应一个能力：

```json
{
  "capabilities": [
    {
      "id": "space:info",
      "description": "Provide space summary and status",
      "type": "request-response"
    }
  ]
}
```

消费者调用：

```typescript
const info = await pluginManager.invoke("space:info", {
  spaceId: "abc",
  spaceName: "API",
  root: "/work/api",
});
```

### 迁移路径

1. 当前 `plugin.json` 配置自动迁移为 v2 格式
2. 当前 `plugin_*` Tauri commands 封装为对新系统的调用，保持向后兼容
3. 内置 `space-info` 插件使用新的 manifest 格式
4. 用户创建的自定义脚本自动生成 manifest

---

## 12. 未来扩展方向

| 方向 | 说明 |
|------|------|
| 插件市场 | 远程仓库浏览和安装 |
| 插件依赖 | 插件 A 依赖插件 B 的能力 |
| 插件更新 | 检查版本更新并自动升级 |
| 插件分组 | 按项目/场景组织插件配置文件 |
| 插件调试 | 查看插件日志、重启、测试调用 |
| 性能监控 | 每个插件的 CPU/内存/响应时间 |
| 离线安装 | 从 .zip 包导入插件 |
| 插件模板 | `terax plugin init` 脚手架 |

---

## 13. 总结

v2 设计的核心变化：

| 当前 v1 | v2 |
|---------|-----|
| 只支持 plugin 场景 | 通用能力系统，支持任意场景 |
| 只支持 Node 脚本 | 多运行时（Node、Python、Deno、Shell） |
| 只允许一个插件启用 | 允许多个插件同时运行 |
| 无能力概念 | 能力路由，按能力名调用 |
| 无事件系统 | 事件总线，支持事件推送 |
| 无安全模型 | 权限声明和分级 |
| 无清单 | 结构化 manifest.json |
| 无生命周期管理 | 完善的生命周期策略 |
| 无版本管理 | 语义版本号，支持更新 |
| 协议固定 | 标准协议，运行时不可知 |