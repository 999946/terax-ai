# Terax 插件事件处理器

## 概述

Terax 插件是用户级的 Node.js 程序，用于处理选定的 Terax 事件。

插件既不是 Space，也不属于某个 Space，更不会被定义为后台服务。Terax 决定插件处理器何时运行。插件作者编写面向具体事件的业务逻辑。

第一个内置插件是 `space-info`。它演示了插件如何将 Space 生命周期事件转换为供 UI 使用的结构化 Space 信息。

## 插件作者需要编写的内容

插件是一个带有默认导出的 Node.js 模块。默认导出的对象，其键为受支持的事件名称，值为异步处理器。

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

当插件不需要某个事件时，可以省略对应的处理器。Terax 不会调用缺失的处理器。

插件作者无需编写：

- `manifest.json`
- JSON-RPC
- JSONL 帧定界
- stdin/stdout 读取器
- 进程启动代码
- 进程关闭代码
- 终端事件处理器

这些都属于由 Terax 负责的运行时关注点。

## 受支持的事件

第一组事件规模刻意保持精简，并与 Terax 真实的生命周期节点相关联：

| 事件 | Terax 何时触发 | 典型用途 |
| --- | --- | --- |
| `app.started` | 应用初始化已完成 | 初始化插件状态 |
| `spaces.loaded` | 完整的 Space 列表可用 | 批量加载外部 Space 信息 |
| `spaces.changed` | 有 Space 被新增、移除或更新 | 同步外部数据 |
| `space.activated` | 某个 Space 变为激活状态 | 刷新当前激活的 Space |
| `space.deactivated` | 某个 Space 停止激活 | 释放临时状态或保留最后一份快照 |
| `file.saved` | 文件已成功保存 | 执行保存后的处理 |

终端事件刻意地不属于本插件契约的范围。

## TypeScript 契约

规范的声明端定义位于：

```text
src/modules/plugin/events.ts
```

通用的事件上下文为：

```ts
export type PluginEventContext = {
  eventId: string;
  eventType: PluginEventType;
  eventVersion: 1;
  emittedAt: string;
};
```

Space 数据被刻意地加以限制：

```ts
export type SpaceContext = {
  id: string;
  name: string;
  root: string;
};
```

文件事件携带的是元数据而非文件内容：

```ts
export type FileContext = {
  path: string;
  language: string | null;
  byteLength: number | null;
  isNew: boolean;
};
```

各事件专属的输入结构为：

```ts
export type AppStartedInput = {
  context: PluginEventContext;
};

export type SpacesLoadedInput = {
  spaces: SpaceContext[];
  context: PluginEventContext;
};

export type SpacesChangedInput = {
  spaces: SpaceContext[];
  added: string[];
  removed: string[];
  updated: string[];
  context: PluginEventContext;
};

export type SpaceActivatedInput = {
  space: SpaceContext;
  previousSpaceId: string | null;
  context: PluginEventContext;
};

export type SpaceDeactivatedInput = {
  space: SpaceContext;
  nextSpaceId: string | null;
  context: PluginEventContext;
};

export type FileSavedInput = {
  space: SpaceContext;
  file: FileContext;
  source: "editor" | "external" | "unknown";
  context: PluginEventContext;
};
```

默认情况下，插件不会收到凭据、控制令牌、进程 ID 或文件内容。

## 处理器结果

处理器返回一个小而规范的结果联合类型：

```ts
export type PluginEventResult =
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

Space 信息定义为：

```ts
export type SpaceInfo = {
  summary: string;
  status: "online" | "offline" | "degraded" | "unknown";
  onlineAt: string | null;
  lastTestedAt: string | null;
};
```

`onlineAt` 与 `lastTestedAt` 是远程的业务时间戳。Terax 必须按插件返回的原样进行显示，绝不能根据本地进程时间、文件修改时间、刷新时间或 Space 活动来推断它们。

因此，内置的 `space-info` 插件返回：

```js
{
  summary: space.name,
  status: "unknown",
  onlineAt: null,
  lastTestedAt: null,
}
```

## 运行时行为

Rust 侧是插件的边界。对于每个事件，它会：

1. 选择已启用的插件。
2. 将配置好的 Node 源码写入受管入口文件。
3. 加载模块的默认导出。
4. 根据事件名称查找处理器。
5. 以带类型的载荷调用该处理器。
6. 校验返回的结果。
7. 将结果发送给相关的 Terax 存储或 UI。

JSONL 可能被内部用于 Rust 与受管 Node 包装器之间。该传输不属于作者侧 API 的一部分，可在无需改动插件源码的情况下发生变化。

缺失的处理器不返回业务结果。被抛出的错误、无效的结果、超时、格式错误的模块或崩溃的进程都会被报告为插件失败。

插件失败是相互隔离的。它们不得阻塞：

- Space 的激活或停用
- Space 列表的渲染
- Tab 的创建
- 文件保存
- 终端启动

## 事件生命周期

预期的分发顺序为：

```text
Application ready
  -> app.started
  -> spaces.loaded

Space changes
  -> spaces.changed

Active Space changes
  -> space.deactivated(previous)
  -> space.activated(next)

File successfully saved
  -> file.saved
```

`spaces.loaded` 是内置插件的批量入口点。`space.activated` 会异步刷新当前激活的 Space。`space.deactivated` 不需要发起新的远程请求；插件可以用它来清理临时状态。

## 配置与存储

插件配置存储于：

```text
{data}/terax/plugins.json
```

配置结构为：

```ts
export type Plugin = {
  id: string;
  name: string;
  content: string;
  enabled: boolean;
  schemaVersion: 1;
};
```

每个源码文件都由 Terax 管理，位于：

```text
{data}/terax/plugins/{pluginId}.mjs
```

用户可以维护多个插件，但同一时间只能启用一个。启用一个插件会原子地停用其他插件。插件从不绑定到某个具体的 Space。

## 设置行为

“插件”(Plugins)设置页起初是一个列表。每一行提供：

- 插件名称
- 编辑
- 删除
- 启用或停用

编辑会在原地展开所选行，并且只暴露：

- 名称
- Node 脚本
- 保存
- 取消

同一时间只能展开一行。如果某次编辑处于未保存状态，而用户又选中了另一行或开始“添加插件”，Terax 会提供：

- 保存并切换
- 放弃更改
- 取消

## 安全边界

插件是用户自行运行的本地 Node.js 代码，不受 Terax 的 OS 级沙箱约束。用户应只启用自己信任的代码。

Terax 仍会保护自身的边界：

- Node 以不拼接 shell 命令的方式启动。
- 入口路径由经过校验的插件 ID 推导得出。
- Webview 不能直接读取或写入插件文件。
- 凭据和控制令牌不会传给插件。
- 事件载荷只包含事件契约所定义的字段。
- 处理器输出在更新 Terax 状态之前会先经过校验。

## 测试预期

插件变更应覆盖测试：

- 事件的输入与输出 TypeScript 契约。
- 默认导出的加载与处理器选择。
- 缺失的处理器以及被抛出的处理器错误。
- 无效结果、超时与进程退出。
- `spaces.loaded` 批量结果。
- `space.activated` 单个 Space 的结果。
- 内置 `space-info` 的默认源码。
- 仅启用单个插件的表现。
- 设置的编辑、保存、取消以及未保存切换保护。