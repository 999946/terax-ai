# 统一 gutter Lane 重构方案

> 承接 [OpenIDEA 功能借鉴评估](openidea-review_zh.md) 的第 1 项最高价值借鉴点。本文是具体重构设计，不是既有现状说明。若与 `TERAX.md` 冲突，以 `TERAX.md` 为准。
> 英文版：`gutter-lane-design.md`。

## 1. 问题

编辑器左侧仪表区有三类互不统属的装饰：

- `modifiedLines.ts`：真实 gutter（`cm-ml-gutter`，3px 变更条）。
- `conflictLines.ts`：复用 `cm-ml-gutter` 的 marker（无独立 gutter），靠 `conflictTheme` 补全局 `.cm-ml-bar` 几何。
- `overviewRuler.ts`：裸 DOM（`cm-editor-overview` div），靠 `view.dom.appendChild` 挂在编辑器根上，不参与 CodeMirror 装饰体系。

三个问题：

1. **独立 gutter 会随功能扩张横向堆叠**。现在只有 1 个变更 gutter；将来覆盖率、书签、断点各加一个 `gutter()`，会在行号右侧叠出多个 3px 列，占宽且错位。桌面 IDE（openidea）用单条 lane 承载所有标记。
2. **裸 DOM 脱离 CodeMirror**。`overviewRuler` 手动 appendChild、手动绑 mousedown、手动清理，绕开了 CodeMirror 的 ViewPlugin / Facet 生命周期，测试难做，重挂载易泄漏。
3. **渲染与数据源分裂**。左侧 gutter 和右侧 overview 都读同一份 `modifiedField` 的 diff + `conflictField`，却各自实现一遍 `rulerMarks` / `changedLines` 的映射逻辑，同类代码重复。

## 2. 目标

把左侧变更标记、右侧概览条统一成一组 lane 扩展点，让所有"按行/按块着色"的装饰走同一条渲染管线，同时：

- 不改变现有视觉：3px 变更条颜色、删除楔形、概览条 6px 色块点击跳转全部保留。
- 不绕开 CodeMirror：全部基于 Facet + ViewPlugin / gutter。
- 保持纯函数可测：映射逻辑（变更行、冲突行、ruler 块）继续是无副作用纯函数，headless 可测。
- 保持工程现状复用：`EditorPane`、`GitDiffPane`、`AiDiffPane` 三者共用整套 lane，不新增 per-pane 特判。

## 3. 核心 API 设计

新增 `src/modules/editor/lib/lanes.ts`，导出三个扩展点：

### 3.1 `changeLaneMarkers`：左缘变更条 Facet

```ts
/** 每条 lane 标记：起点行 + 着色 + 渲染形态。 */
export type ChangeLaneMark = {
  line: number;              // 1-based B 文档行
  color: "added" | "modified" | "deleted" | "conflict";
  title?: string;            // hover 提示（可选）
};

/** 各功能把自己的标记集贡献进来；多个提供者按注册顺序分层叠加。 */
export const changeLaneMarkers = Facet.define<ChangeLaneMark[]>();
```

单条 lane gutter 由 `changeLane()` 在共享扩展中装配一次：

```ts
const changeLaneGutter = gutter({
  class: "cm-lane",
  markers: (view) => buildLaneMarkers(view.state.facet(changeLaneMarkers)),
  initialSpacer: () => new LaneSpacer(),
});
```

`buildLaneMarkers` 是一条 lane 内的归并函数：
- 同一行有多个提供者的标记时，冲突色优先，其次 added > modified > deleted。
- 输出 `RangeSet<GutterMarker>`，每个 marker 仍是绝对定位的 3px 色条。

```ts
export function buildLaneMarkers(marks: ChangeLaneMark[], doc: Text, docLines: number): RangeSet<GutterMarker>
```

`eq()` 校验比较 `color + title`，保证同值不重建 DOM。

### 3.2 `overviewMarks`：概览条 Facet

```ts
export type OverviewMark = {
  from: number;              // 0-based 偏移（文档坐标，随编辑自动映射）
  to?: number;               // 结束偏移（含）；缺省 == from
  color: "added" | "deleted";
  title?: string;
};

export const overviewMarks = Facet.define<OverviewMark[]>();
```

装配一次由 ViewPlugin 提供：

```ts
export function overviewLane(): Extension
```

它读取 facet，把每条 mark 映射成概览条上的一个绝对定位色块（沿用当前 `MIN_BAND_PERCENT`），点击命中附近 mark 则滚动到对应行。整体逻辑从现状 `overviewRuler.ts` 平移，但：

- 数据来源统一为 facet 而非自己读 `modifiedField`。
- 生命周期交给 ViewPlugin（`destroy` 自动清理）。
- 点击命中用纯函数 `nearestMark(marks, y)`，headless 可测。

### 3.3 提供者：纯函数把 diff / conflict 变成 lane 标记

保留既有纯函数，仅赋予新的"生产 lane 标记"角色：

```ts
// modifiedLines.ts
export function changeLaneFromChunks(chunks, conflict, doc): ChangeLaneMark[]
// overviewFromChunks(chunks, conflict, doc): OverviewMark[]  // 复用 rulerMarks 的归并语义
```

`modifiedField` 与 `conflictField` 保持不变（仍是效果注入 + 增量 Chunk 引擎的真相源）。各功能把 field 值 compute 进 Facet：

```ts
// modifiedLines.ts
export function modifiedLines(): Extension {
  return [
    modifiedField,
    changeLaneMarkers.compute([modifiedField, conflictField], (s) =>
      changeLaneFromChunks(s.field(modifiedField), s.field(conflictField), s.doc),
    ),
    overviewMarks.compute([modifiedField, conflictField], (s) =>
      overviewFromChunks(...),
    ),
  ];
}
```

`conflictLines.ts` 降级为只贡献 `conflictField`（不再有自己的 theme / gutter 声明）。

## 4. 装配变化

### 现状

```ts
// extensions.ts
lintGutter(),
blameBadge(),
modifiedLines(),      // 自带历史 gutter
conflictLines(),      // 自带 conflict theme
overviewRuler(),      // 裸 DOM
```

### 重构后

```ts
// extensions.ts
lintGutter(),
blameBadge(),
changeLane(),         // 单条 lane gutter，读 changeLaneMarkers facet
overviewLane(),       // ViewPlugin，读 overviewMarks facet
modifiedLines(),      // 只注入 modifiedField + compute 两个 facet
conflictLines(),      // 只注入 conflictField（markers 也由此提供者 compute）
```

三个 pane（`EditorPane`、`GitDiffPane`、`AiDiffPane`）都走 `buildSharedExtensions()`，因此自动获得同一套 lane，无需改各自装配。

### Git diff 的 hunk 勾选框

`hunkCheckGutter` 是 diff 面板专属交互 gutter（16px 宽，放 checkbox），与 3px 变更 lane 语义不同，**保持独立不并进 lane**。`GitDiffPane` 的 split/unified 视图仍按其现状注入。

## 5. 编辑映射细节

`changeLaneMarkers` / `overviewMarks` 若由 `Facet.define` 持有，facets 本身不随编辑自动映射行号。做法：**标记一律存 0-based 文档偏移**，由 `buildLaneMarkers`/`drawOverview` 在读取时 `doc.lineAt(offset)` 转行；偏移会随文档编辑由 CodeMirror 的 facet 重算自然跟随，无需手写 remap（与 `blameField` 的手动 remap 不同，blame 因从 git 输出而来才需要）。

## 6. 测试契约

纯函数保持/新增 headless 单测：

| 现测 | 保持 | 新增 |
|------|------|------|
| `changedLines` 各类变更行 | 原样 | - |
| `conflictRanges` 冲突区 | 原样 | - |
| `rulerMarks` 块归并/钳制 | 原样 | - |
| - | - | `buildLaneMarkers` 冲突优先级归并 |
| - | - | `nearestMark` 命中与边界 |
| - | - | `changeLaneFromChunks` / `overviewFromChunks` 到 lane 标记映射 |

落地必须通过：`pnpm lint`、`pnpm check-types`、`pnpm test`；如涉 merge 视图改动再加 `pnpm e2e`。

## 7. 迁移路径（阶段化）

1. **Phase 1（纯增量）**：新建 `lanes.ts`，产出 `changeLaneMarkers` 空 Facet + `changeLane()` gutter + `overviewLane()` ViewPlugin；在 `extensions.ts` 追加但不移除旧实现。视觉无变化。
2. **Phase 2（转移数据源）**：把 `modifiedLines()` / `conflictLines()` 的 field value compute 进两个 Facet；`changeLane()` 与旧 `modifiedGutter` 并存对比验证后，删除旧 gutter 与 `overviewRuler.ts`。
3. **Phase 3（折叠重复）**：确认三个 pane 视觉一致、测试全绿，清理 `conflictTheme` 等兜底样式，收尾。

## 8. 不做的事

- 不合并 `hunkCheckGutter`（交互 checkbox，语义不同）。
- 不合并 `lintGutter`（`@codemirror/lint` 自带，未来可评估但非本方案）。
- 不引入 IDE 级 `EditorContribution` 注册表（openidea 的做法）；Terax 目前 pane 少、扩展点固定，先做 lane API，避免过度架构。
- 不改 `blameBadge`（行尾 widget，不是 lane）。

## 9. 收益与成本

**收益**：左缘列宽恒定（任何新标记不再加列）；裸 DOM 概览条进入 CodeMirror 生命周期；同类映射逻辑合并；后续覆盖率 / 书签 / 断点成为"加一个 facet provider"，零结构改动。

**成本**：约 1 个文件新增 + 2 个文件重构 + 3 处装配微调 + 增量测试。无新增依赖，无运行时开销（多一层 facet 归并，代价可忽略）。

## 参考

- [OpenIDEA 功能借鉴评估](openidea-review_zh.md) - 第 1 项机制借鉴
- `src/modules/editor/lib/lanes.ts`（新）
- `src/modules/editor/lib/modifiedLines.ts`、`conflictLines.ts`、`overviewRuler.ts`（重构）
- `src/modules/editor/lib/extensions.ts`（装配）
