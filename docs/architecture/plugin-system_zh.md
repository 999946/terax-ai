# 插件系统

## 目的

Terax 插件是用户级别的 Node.js 事件处理器。插件不属于某个 Space，也不存储在项目目录中。插件接收选定的 Terax 生命周期和文件事件，并返回结构化结果。它们不处理终端事件。

内置插件名为 `space-info`。它是一个普通的事件处理插件，不是插件系统的名称。

## 配置模型

持久化的插件配置如下：

```ts
type Plugin = {
  id: string;
  name: string;
  content: string;
  enabled: boolean;
  schemaVersion: 1;
};
```

Terax 负责执行细节：

- 运行时为 Node.js。
- 用户在设置中仅编辑 Node 脚本内容。
- 脚本存储于：

  ```text
  {data}/terax/plugins/{pluginId}.mjs
  ```

- Terax 创建并负责入口路径。
- 用户不配置 Node 路径、入口路径、清单或进程参数。
- 插件配置存储于：

  ```text
  {data}/terax/plugins.json
  ```

Rust 进程负责配置持久化、Node 执行和入口文件读写。webview 从不直接读写这些文件。

## 插件源码格式

插件导出一个默认对象，其键为事件名称，值为异步处理器：

```js
function toSpaceInfo(space) {
  return {
    summary: space.name,
    status: "unknown",
    onlineAt: null,
    lastTestedAt: null,
  };
}

export default {
  "spaces.loaded": async ({ spaces }) => ({
    type: "spaces.info.updated",
    spaces: Object.fromEntries(
      spaces.map((space) => [space.id, toSpaceInfo(space)]),
    ),
  }),

  "space.activated": async ({ space }) => ({
    type: "space.info.updated",
    spaceId: space.id,
    info: toSpaceInfo(space),
  }),
};
```

用户不编写 JSONL、JSON-RPC、stdin/stdout 分帧、启动代码或进程管理。Terax 加载默认导出项，选择与事件匹配的处理器，调用它，验证结果，并隔离失败。

## 事件与 TypeScript 契约

支持的事件名称如下：

```ts
type PluginEventType =
  | "app.started"
  | "spaces.loaded"
  | "spaces.changed"
  | "space.activated"
  | "space.deactivated"
  | "file.saved";
```

每个事件都有带版本号的上下文：

```ts
type PluginEventContext = {
  eventId: string;
  eventType: PluginEventType;
  eventVersion: 1;
  emittedAt: string;
};
```

事件载荷定义于 `src/modules/plugin/events.ts`，包括：

- `spaces.loaded`：Space 上下文的完整列表。
- `spaces.changed`：当前列表以及新增、移除和更新的 ID。
- `space.activated`：当前激活的 Space 和前一个 Space ID。
- `space.deactivated`：停用的 Space 和下一个 Space ID。
- `file.saved`：Space 上下文、文件元数据和保存来源。

Space 上下文仅包含 `id`、`name` 和 `root`。文件事件包含诸如路径、语言、字节长度以及文件是否为新建等元数据。文件内容、凭据、控制令牌和进程标识符默认不传入。

处理器结果是结构化值：

```ts
type PluginEventResult =
  | { type: "handled" }
  | {
      type: "space.info.updated";
      spaceId: string;
      info: SpaceInfo;
    }
  | {
      type: "spaces.info.updated";
      spaces: Record<string, SpaceInfo>;
    };
```

`SpaceInfo` 包含 `summary`、`status`、`onlineAt` 和 `lastTestedAt`。远程时间戳必须来自远程系统。Terax 不得根据进程启动时间、文件修改时间、刷新时间或 Space 活动来推断它们。

## 内置插件

`space-info` 被植入 `plugins.json`，并且在加载配置时其内容始终被替换为当前内置事件处理器的源码。内置处理器涵盖应用启动、Spaces 的加载与变化、Space 的激活与停用，以及文件保存。

内置插件不会捏造远程业务数据。它返回 Space 名称作为摘要、`unknown` 状态以及空的时间戳。

## 设置交互

插件设置页面默认是一个列表。每一行显示插件名称、编辑操作、删除操作和启用开关。

点击"编辑"会在该行展开表单。该表单用于编辑插件名称和 Node 脚本内容。同一时间最多只能展开一行。

如果当前表单有未保存的更改，且用户选择了其他行或"添加插件"，Terax 会询问如何处理：

- 保存并切换
- 放弃更改
- 取消

取消会关闭当前表单而不写入更改。保存会验证名称、持久化配置并写入受管理的入口文件。同一时间只能启用一个插件。启用一个插件会原子地禁用其他插件。

## 内部执行

JSONL 传输是 Rust 与受管理的 Node 调用包装器之间的内部实现细节。它不是面向用户的插件 API 的一部分。包装器加载用户的默认导出项，调用匹配的事件处理器，并向 Rust 返回处理器结果或结构化错误。

没有对应处理器的事件被视为已处理且无结果。处理器异常、无效结果、超时或进程失败均被报告为插件错误。非阻塞事件失败不会阻塞 Space 切换、文件保存、标签页创建或终端启动。

## 事件生命周期

Terax 在以下节点派发事件：

1. 在应用和 Spaces 完成加载后，派发 `app.started` 和 `spaces.loaded`。
2. 当 Space 集合发生变化时，派发 `spaces.changed`。
3. 当激活的 Space 发生变化时，派发 `space.deactivated`，随后派发 `space.activated`。
4. 在文件成功保存后，派发 `file.saved`。

事件派发器是异步的。Space 界面更新会消费 `space.info.updated` 和 `spaces.info.updated` 结果。失败或缓慢的插件不会阻碍触发它们的 Terax 操作。

## Rust 边界与安全

Rust 是唯一的进程、文件系统和操作系统边界。它必须：

- 以结构化的可执行文件和参数启动 Node，绝不使用 shell 命令字符串。
- 创建受管理的插件目录和入口文件。
- 在将插件标识符用于路径之前进行验证。
- 将入口读写限制在受管理的入口文件内。
- 限制 JSON 行大小、响应大小、stderr 存储和处理器超时。
- 检测进程退出并清理子进程。
- 避免向插件传递凭据、控制令牌或进程标识符。

插件是明确由用户运行的本地代码。Terax 不声称提供操作系统沙箱。用户应仅启用他们信任的脚本。

## 测试要求

对插件系统的更改应覆盖以下方面：

- 最新配置加载、持久化、内置替换、重复标识符以及单一启用插件的行为。
- 受管理入口路径的生成以及读写行为。
- 事件封装验证、处理器选择、无效结果、超时和子进程清理。
- 针对 `spaces.loaded` 和 `space.activated` 的内置事件处理器冒烟测试。
- 前端列表、编辑、保存、取消、删除、启用、未保存更改确认、派发和结果处理。

从项目目录运行前端检查：

```bash
pnpm check-types
pnpm test --run
```

从 `src-tauri` 运行 Rust 检查：

```bash
cargo check
cargo test --lib
```