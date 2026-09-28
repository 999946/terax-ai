#!/usr/bin/env node
// check-i18n.mjs — 校验 src/ 里 t() 用到的 i18n key 都存在于 en 语言包（唯一真源）。
// en↔zh 键集 parity 由 src/modules/i18n/locale.test.ts 保证，这里只管「代码用到的 key 不能缺」。
// 纯 Node + 正则，零依赖；有缺失则 exit(1)。已接入 pnpm lint。
// 附带反向死键报告：`pnpm check:i18n --dead` 会列出 en 里定义了、但 src 从未引用的 key，
// 用于清理残留词条（仅报告，不导致 exit 1)。
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(process.cwd());
const SRC = join(ROOT, "src");
const EN = join(SRC, "modules", "i18n", "messages", "en.ts");
const wantDead = process.argv.includes("--dead");

// ---- 变量键 t(expr)：表达式解析出的实际 key 全部校验 ∈ en。----
// 新增变量键调用时，把解析出的 key 加到这里，并把调用点签名加到 EXPECTED_VARIABLE_CALLS。
const DYNAMIC_KEYS = [
  // src/components/ai-elements/tool.tsx TOOL_META[].labelKey
  "ai.tool.meta.read", "ai.tool.meta.list", "ai.tool.meta.write",
  "ai.tool.meta.createDir", "ai.tool.meta.edit", "ai.tool.meta.run",
  "ai.tool.meta.spawn", "ai.tool.meta.logs", "ai.tool.meta.jobs",
  "ai.tool.meta.kill", "ai.tool.meta.search", "ai.tool.meta.glob",
  "ai.tool.meta.suggest", "ai.tool.meta.preview", "ai.tool.meta.subagent",
  "ai.tool.meta.todos",
  // src/components/ai-elements/tool.tsx STATUS_LABEL
  "ai.tool.status.approvalRequested", "ai.tool.status.approvalResponded",
  "ai.tool.status.preparing", "ai.tool.status.running", "ai.tool.status.done",
  "ai.tool.status.denied", "ai.tool.status.error",
  // src/modules/ai/components/AiToolApproval.tsx TOOL_META[].labelKey
  "ai.toolWriteFile", "ai.toolEditFile", "ai.toolEditFileBatch",
  "ai.toolCreateDirectory", "ai.toolRunShellCommand", "ai.toolSpawnBackground",
  // src/modules/agents/components/NotificationBell.tsx NOTIF_LABEL_KEY
  "agents.notif.kind.attention", "agents.notif.kind.finished",
  "agents.notif.kind.error",
  // src/modules/editor/AiDiffPane.tsx STATUS_KEY
  "editor.aiDiffPendingReview", "editor.aiDiffApplied", "editor.aiDiffRejected",
  // src/settings/sections/GeneralSection.tsx APPEARANCE[].label
  "settings.general.system", "settings.general.light", "settings.general.dark",
  // src/settings/sections/ModelsSection.tsx meta.modelHintKey
  "settings.models.local.lmstudio.hint", "settings.models.local.mlx.hint",
  "settings.models.local.ollama.hint", "settings.models.local.openrouter.hint",
  // src/modules/markdown/MarkdownViewToggle.tsx MODES[].i18nKey
  "markdown.viewRendered", "markdown.viewSplit", "markdown.viewRaw",
  // src/settings/SettingsApp.tsx TABS[].labelKey
  "settings.tabs.general", "settings.tabs.editor", "settings.tabs.themes",
  "settings.tabs.shortcuts", "settings.tabs.models", "settings.tabs.agents",
  "settings.tabs.plugin", "settings.tabs.about",
];

// 已知变量键调用点签名（相对 src 的路径 + 首参表达式）。若扫描到未登记的新变量键调用，
// 会报错要求登记，避免新动态 key 静默漏检。
const EXPECTED_VARIABLE_CALLS = new Set([
  "components/ai-elements/tool.tsx:meta.labelKey",
  "components/ai-elements/tool.tsx:STATUS_LABEL[state]",
  "modules/ai/components/AiToolApproval.tsx:meta.labelKey",
  "modules/agents/components/NotificationBell.tsx:NOTIF_LABEL_KEY[n.kind]",
  "modules/editor/AiDiffPane.tsx:STATUS_KEY[status]",
  "settings/sections/GeneralSection.tsx:o.label",
  "settings/sections/ModelsSection.tsx:meta.modelHintKey",
  "modules/markdown/MarkdownViewToggle.tsx:i18nKey",
  // labelKey 字段驱动的变量键调用（统一 t 后，key 一律以 labelKey 字面量挂载在数据上）
  "settings/SettingsApp.tsx:tab.labelKey",
  "modules/ai/components/ChipsRow.tsx:cmd.labelKey",
  "modules/ai/components/SnippetPicker.tsx:c.labelKey",
  "modules/command-palette/CommandPalette.tsx:group.labelKey",
  "modules/command-palette/CommandPalette.tsx:item.labelKey",
  "settings/sections/ShortcutsSection.tsx:s.labelKey",
  "settings/sections/ShortcutsSection.tsx:group.labelKey",
]);

// 只匹配「独立 t( 函数调用」，避免误中 fetchWithTimeout 等里的 "t("。
const T_FN = "t";
// 字面量：直接 t("key", …) / t('key') ；也覆盖三元 t(a ? "k1" : "k2") 里的两侧。
const LITERAL_RE = new RegExp(
  `(?<![A-Za-z_$])${T_FN}\\(\\s*['"]([^'"]+)['"]\\s*(?:,|\\))`,
  "g",
);
// 三元：t(cond ? "k1" : "k2") 里的字面量分支。
const TERNARY_RE = new RegExp(
  `(?<![A-Za-z_$])${T_FN}\\([^)]+?\\?\\s*['"]([^'"]+)['"]\\s*:\\s*['"]([^'"]+)['"]`,
  "g",
);
// labelKey 字面量字段：数据对象里 `labelKey: "…"` 的字面量 key（统一 t 的落点）。
const LABELKEY_RE = /labelKey:\s*["']([^"']+)["']/g;
// 禁止模板字符串 key：t(`prefix.${x}`) 无法被静态校验，统一改为 labelKey 字面量。
const TEMPLATE_T_RE = /(?<![A-Za-z_$])t\(\s*`/g;
const VAR_RE = new RegExp(`(?<![A-Za-z_$])${T_FN}\\(\\s*([^,)]+)`, "g");

/** 读取 en.ts 的扁平 key 集合。 */
function readEnKeys(path) {
  const src = readFileSync(path, "utf8");
  const keys = new Set();
  for (const m of src.matchAll(/^\s*"([^"]+)"\s*:/gm)) keys.add(m[1]);
  return keys;
}

/** 递归收集 src 下待扫描的 .ts/.tsx（跳过测试文件与语言包本身）。 */
function walkFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walkFiles(p, out);
    else if (
      /\.(ts|tsx)$/.test(name) &&
      !/\.test\./.test(name) &&
      name !== "en.ts" &&
      name !== "zh-CN.ts"
    ) {
      out.push(p);
    }
  }
  return out;
}

function lineAt(src, index) {
  return src.slice(0, index).split("\n").length;
}

const enKeys = readEnKeys(EN);

/** 缺失的字面量 key → 出现位置列表。 */
const missingLiterals = new Map();
/** 缺失的 labelKey 字面量 → 位置。 */
const missingLabelKeys = new Map();
/** 未登记的新变量键调用 → 位置。 */
const uncoveredVars = new Map();
/** 违规的模板字符串 key 调用 → 位置。 */
const badTemplates = [];

const distinctLiterals = new Set();
/** 所有被引用到的 key（字面量 + 三元 + labelKey + DYNAMIC_KEYS），反向死键用。 */
const usedKeys = new Set(DYNAMIC_KEYS);

const files = walkFiles(SRC);
const referentialText = files.map((p) => readFileSync(p, "utf8")).join("\n");

for (const file of files) {
  const src = readFileSync(file, "utf8");
  const rel = file.replace(SRC + "/", "");

  // 模板字符串 key 是红线：统一到 labelKey 字面量后不再允许。
  for (const m of src.matchAll(TEMPLATE_T_RE)) {
    badTemplates.push(`${rel}:${lineAt(src, m.index)}`);
  }

  for (const m of src.matchAll(LITERAL_RE)) {
    const key = m[1];
    distinctLiterals.add(key);
    usedKeys.add(key);
    if (!enKeys.has(key)) {
      if (!missingLiterals.has(key)) missingLiterals.set(key, []);
      missingLiterals.get(key).push(`${rel}:${lineAt(src, m.index)}`);
    }
  }

  for (const m of src.matchAll(TERNARY_RE)) {
    // t(a ? "k1" : "k2")：两侧都是 key，都须存在。
    const present = [m[1], m[2]].filter((k) => !k.startsWith("$"));
    for (const key of present) {
      distinctLiterals.add(key);
      usedKeys.add(key);
      if (!enKeys.has(key)) {
        if (!missingLiterals.has(key)) missingLiterals.set(key, []);
        missingLiterals.get(key).push(`${rel}:${lineAt(src, m.index)}`);
      }
    }
  }

  // labelKey 字段：数据对象里挂着的字面量 i18n key，必须 ∈ en。
  for (const m of src.matchAll(LABELKEY_RE)) {
    const key = m[1];
    usedKeys.add(key);
    if (!enKeys.has(key)) {
      if (!missingLabelKeys.has(key)) missingLabelKeys.set(key, []);
      missingLabelKeys.get(key).push(`${rel}:${lineAt(src, m.index)}`);
    }
  }

  for (const m of src.matchAll(VAR_RE)) {
    const arg = m[1].trim();
    // 只有「简单 key 表达式」才算变量键调用：裸标识符 / a.b / IDENT[key]。
    // 三元/比较/对象等非 key 首参（如 t(cond ? "a" : "b")、t(count === 1 ? …)）
    // 的真 key 是字面量，已被 LITERAL_RE/TERNARY_RE 抓到，这里直接跳过。
    const SIMPLE = /^[A-Za-z_$][\w$]*(?:\.[\w$]+)*(?:\[[^\]]+\])?$/;
    if (!SIMPLE.test(arg)) continue;
    const sig = `${rel}:${arg}`;
    if (!EXPECTED_VARIABLE_CALLS.has(sig)) {
      if (!uncoveredVars.has(sig)) uncoveredVars.set(sig, []);
      uncoveredVars.get(sig).push(`${rel}:${lineAt(src, m.index)}`);
    }
  }
}

// 反向死键：en.ts 定义了、但 src 里从未以该字面量引用。
function isTrulyDead(key) {
  if (usedKeys.has(key)) return false;
  return !referentialText.includes(`"${key}"`) &&
    !referentialText.includes(`'${key}'`) &&
    !referentialText.includes("`" + key + "`");
}
const deadKeys = [...enKeys].filter(isTrulyDead).sort();

// 校验 DYNAMIC_KEYS（变量键解析出的 key）也在 en 里。
const missingDynamic = DYNAMIC_KEYS.filter((k) => !enKeys.has(k));

const bad =
  missingLiterals.size + missingLabelKeys.size + uncoveredVars.size +
  missingDynamic.length + badTemplates.length;

// 反向死键报告（--dead）在任何 exit 之前打印，便于清理残留词条。
if (wantDead) {
  if (deadKeys.length === 0) {
    console.log(`check-i18n --dead: en.ts 无死键（全部被代码引用）。`);
  } else {
    console.log(`check-i18n --dead: en.ts 有 ${deadKeys.length} 个死键（定义了但源码无引用）：`);
    for (const k of deadKeys) console.log(`  - ${k}`);
  }
}

if (bad === 0) {
  const labelKeySet = new Set();
  for (const file of files) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(LABELKEY_RE)) labelKeySet.add(m[1]);
  }
  console.log(
    `✓ check-i18n: ${distinctLiterals.size} 个字面量 key、${labelKeySet.size} 个 labelKey 字段、` +
      `${DYNAMIC_KEYS.length} 个手动登记动态 key 全部存在于 en.ts，无缺失、无模板字符串 key。`,
  );
  process.exit(0);
}

console.error(`✗ check-i18n: 发现 ${bad} 处问题（en.ts 缺失或未登记）：\n`);
for (const [key, locs] of missingLiterals) {
  console.error(`  缺字面量 key  "${key}"`);
  for (const l of locs) console.error(`      └ 用在 ${l}`);
}
for (const [key, locs] of missingLabelKeys) {
  console.error(`  缺 labelKey 字面量  "${key}"`);
  for (const l of locs) console.error(`      └ 用在 ${l}`);
}
for (const k of missingDynamic) {
  console.error(`  缺动态 key  "${k}"（DYNAMIC_KEYS 里登记，但 en.ts 没有）`);
}
for (const sig of uncoveredVars) {
  console.error(`  未登记的变量键调用 ${sig}`);
  for (const l of uncoveredVars.get(sig)) console.error(`      └ 用在 ${l}`);
}
for (const loc of badTemplates) {
  console.error(`  禁止的模板字符串 key t(\`…\`)  →  ${loc}  （请改为数据上的 labelKey 字面量）`);
}
console.error(
  "\n  修复：缺的 key 补到 src/modules/i18n/messages/{en,zh-CN}.ts；" +
    "新变量键调用把解析出的 key 加进 DYNAMIC_KEYS、签名加进 EXPECTED_VARIABLE_CALLS。",
);
process.exit(1);