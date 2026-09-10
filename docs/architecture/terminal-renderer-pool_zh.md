# Terminal renderer pool

本指南阐述了 `TERAX.md` 的内容。若此处与 `TERAX.md` 有任何冲突，以 `TERAX.md` 为准。

## 为什么需要池

Terminal 标签页在切换时会被保持挂载并隐藏，这样 PTY 和 dev server 就能在后台持续输出流。创建无上限数量的活动 xterm + WebGL renderer 实例会耗尽内存预算，因此 Terax 对 renderer 槽位进行池化。

该池位于 `src/modules/terminal/lib/rendererPool.ts`。

## 槽位生命周期

- `POOL_MAX_SIZE` 为 5（`rendererPool.ts:22`）。每个槽位拥有一个 xterm `Terminal`、`FitAddon`、`SearchAddon`、`SerializeAddon`，以及可选的 `WebglAddon`。
- 槽位按需创建，并在绑定时分配给一个 leaf。
- `releaseSlot` 将槽位从 leaf 上分离。如果该 leaf 处于空闲状态，槽位会以 `display:none` 停放，这样 xterm 停止渲染，但仍会解析 PTY 字节。
- 在宽限期之后，空闲槽位可能会被回收，以控制池的大小。

## 停放与释放

当 leaf 变为隐藏状态时：

1. `parkLeafSlot` 将宿主设置为 `display:none`。渲染暂停，但活动缓冲区仍持续接收字节。
2. 如果该 leaf 处于**忙碌**状态（前台命令、agent signal、alt-screen TUI，或 block-shell 运行模式），则它会无限期地保持槽位停放。
3. 如果该 leaf 处于**空闲**状态，则在 `HIDDEN_RELEASE_DELAY_MS` 后调用 `releaseSlot`。该槽位的 `currentLeafId` 被清空，并设置 `retainedLeafId`，以便缓冲区保持活动。

当 leaf 再次变为可见状态时，`acquireSlot` 会查找：

1. 已绑定到该 leaf 的槽位。
2. 该 leaf 的保留槽位（`retainedLeafId === leafId`）——快速路径，无需回放快照。
3. 一个干净的空闲槽位。
4. 如果池已达最大大小，则驱逐得分最低的槽位。驱逐时会在夺取槽位前，先通过 `SerializeAddon` 将保留缓冲区序列化为快照。

## DormantRing

`src/modules/terminal/lib/dormantRing.ts` 为没有任何槽位（被夺走或从未绑定）的 leaf 缓冲 PTY 字节。其上限为 1 MiB，溢出时丢弃最旧的块。排空时，它会从下一个行边界继续，而不是重置终端，这样行中部的转义序列就不会被从中段重新回放。

## 「命令中途绝不序列化」不变式

这是池中最重要的规则。处于命令执行中途的 leaf 必须**永不**被序列化。在过时快照上回放增量式的 TUI 重绘，正是曾经导致 Claude Code 损坏的原因。

代码通过在驱逐前检查 `isLeafBusy`，并在 `commandRunning`、`isAgentActivePty` 或 alt-screen 为真时保持槽位停放（而非释放），来强制实施这一规则。

## 快速路径与快照回放

如果 leaf 存在保留槽位，`bindSlot` 会跳过 `term.clear()` / `term.reset()`，直接将 DormantRing 排空到活动缓冲区中。这避免了重新渲染大型快照。

如果只存在快照，`bindSlot` 会清除终端、调整大小、写入快照，然后排空环形缓冲区。对于 alt-screen TUI，会跳过快照并发送一个 SIGWINCH kick，让 TUI 从头开始重绘。

## WebGL 生命周期

WebGL addon 在槽位变为可见时创建，并在停放后经宽限期被回收。该 addon 能在睡眠/唤醒或 GPU 重置导致上下文丢失时恢复。

## 不变式

- 绝不允许池无限增长；上限为 `POOL_MAX_SIZE`。
- 绝不序列化或驱逐处于命令中途或 alt-screen 状态的 leaf。
- 隐藏的忙碌 leaf 会将其活动网格以 `display:none` 停放。
- 隐藏的空闲 leaf 会释放其槽位，但缓冲区仍会继续解析字节。
- DormantRing 只缓冲没有任何槽位的 leaf 的字节。

## 参阅

- [`TERAX.md`](../../TERAX.md) - 架构的权威来源
- [`docs/README.md`](../README.md) - 贡献者指南索引
- [PTY shell integration](pty-shell-integration.md) - sessions、OSC sequences 和 ConPTY