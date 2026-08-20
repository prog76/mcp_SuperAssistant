# MCP-SuperAssistant 上下文压缩详细设计

> 版本：1.0
> 日期：2026-08-20
> 状态：设计评审稿
> 关联文档：`docs/design-proposal.md`（功能 1 的详细展开）

## 0. 现状核对（与设计文档的结论一致）

已确认：

- `BaseAdapterPlugin`（`pages/content/src/plugins/adapters/base.adapter.ts`）目前只有 `insertText` / `submitForm` / `attachFile`，**没有** `readConversation` / `newConversation` / `readLastResponse` / `waitForResponse`。Phase 0 的“只会说、不会听”判断成立。
- `AdapterPlugin` 接口（`plugins/plugin-types.ts`）需要同步扩展 4 个方法，并新增 `AdapterCapability`（如 `'conversation-read'`、`'conversation-create'`）。
- `automation.service.ts` 已封装了“取当前 adapter → bind 方法 → 执行”的模式，压缩服务可复用同一套 adapter 绑定方式。
- 存储层现有 `chrome.storage.local`（偏好/tool 开关/skills 缓存）与 `localStorage`（tool 权限）。**全文存档需要新增 IndexedDB 层**，`chrome.storage.local` 存索引，IndexedDB 存大文本 —— **IndexedDB 必须归属扩展 origin**（见 8.2 关键约束）。

---

## 1. 设计目标

1. 把长对话压缩为“结构化摘要 + 未完成任务 + 当前 Todo 状态”，注入新会话首条消息。
2. 在网页端拿不到精确 token 数的前提下，提供**可用的 token 估算 + 压缩预算**，支撑 v2 的自动触发。
3. 摘要由当前对话 AI 生成（不引入新 API），压缩后完整原文可回查。

---

## 2. 模块落点

| 模块 | 路径 | 职责 |
|---|---|---|
| 类型扩展 | `pages/content/src/plugins/plugin-types.ts` | 新增 4 个适配器方法与 capability |
| 适配器基类 | `pages/content/src/plugins/adapters/base.adapter.ts` | 新增 4 个方法的默认降级实现 |
| DeepSeek 实现 | `pages/content/src/plugins/adapters/deepseek.adapter.ts` | 先落地读/开新会话/等待回复 |
| 压缩服务 | `pages/content/src/services/compaction.service.ts` | 核心编排 |
| token 工具 | `pages/content/src/utils/tokenizer.ts` | token 估算纯函数 |
| 存档存储 | `pages/content/src/utils/compaction-storage.ts` | 大文本存档（IndexedDB，**走 background/扩展 origin**）+ `chrome.storage.local` 索引 |
| 压缩 Store | `pages/content/src/stores/compaction.store.ts` | zustand 状态 |

---

## 3. Adapter 能力扩展（Phase 0 补充）

### 3.1 新增类型

```typescript
// plugin-types.ts
export type AdapterCapability =
  | 'text-insertion'
  | 'form-submission'
  | 'file-attachment'
  | 'url-navigation'
  | 'element-selection'
  | 'screenshot-capture'
  | 'dom-manipulation'
  | 'conversation-read'      // 新增
  | 'conversation-create';   // 新增

export interface ConversationMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;           // 纯文本（HTML 已剥离）
  timestamp?: number;
  messageId?: string;        // 平台原生消息 id，用于去重/续读
}

export interface ResponsePayload {
  text: string;
  codeBlocks?: { lang: string; code: string }[];
  fileLinks?: string[];
  rawHtml?: string;
}
```

### 3.2 基类默认实现

```typescript
async readConversation(): Promise<ConversationMessage[] | null> { return null; }
async newConversation(): Promise<boolean> { return false; }
async readLastResponse(): Promise<ResponsePayload | null> { return null; }
async waitForResponse(timeoutMs: number): Promise<boolean> { return false; }
```

### 3.3 DeepSeek 落地要点

- `readConversation()`：**复用 `render_prescript/src/core/config.ts` 中已验证的 DeepSeek 消息选择器**，不要另起炉灶：用户消息 `div._9663006`、助手消息 `.ds-markdown.ds-assistant-message-main-content`，并排除思考链 `.ds-think-content`（压缩时不应携带思考内容）。`data-message-author-role` 是 ChatGPT 的属性，**不适用于 DeepSeek**。
  - 注意：DOM 拿到的是**渲染后的 HTML**，需要一套 HTML→Markdown 反向解析（代码块/行内代码/列表/链接/表格），且必然有损 —— 这是全流程里工作量最被低估的一环，需单独立项评估。
  - 长对话注意 DOM 虚拟化：若平台只渲染可视区消息，`readConversation()` 需先滚动加载完整会话（滚动过程中增量采集），否则导出的“全文”不完整。
- `waitForResponse()`：复用现有 `isStopButton()` 的停止按钮检测思路 —— MutationObserver 监听消息区，**N 秒无新增子节点 + 发送按钮恢复可用 + 停止图标消失**，三条件取二（与设计文档 8.5 节一致）。
- `newConversation()`：优先点击侧边栏“新建对话”按钮（SPA 无刷新）。**避免整页导航** —— 导航到 `https://chat.deepseek.com/` 根路径若触发整页 reload，content script 会重建、压缩流程的 promise 链会断开。若必须导航，压缩服务需在页面加载后等待输入框就绪再续跑注入（复用 `waitForPageReady()`），并依靠 `CompactionRecord.status` 支持中断恢复。

---

## 4. 压缩流程（详细版）

```
触发：侧边栏按钮 | 内置工具 compact_context | v2 自动阈值
  │
  ├─ 1. adapter.readConversation() 导出全文
  ├─ 2. token 估算（第 5 节）
  ├─ 3. 存档 transcript.md → IndexedDB
  ├─ 4. 向当前会话发送总结指令（第 6 节 prompt）
  ├─ 5. waitForResponse() → readLastResponse() 得摘要
  ├─ 6. 校验摘要：非空、长度在预算范围内（第 7 节）
  ├─ 7. 存档 summary.md → IndexedDB
  ├─ 8. newConversation() 开新会话
  ├─ 9. insertText(续接指令 + <summary>全文</summary> + 未完成 todo + 当前 todo 状态)
  └─ 10. submitForm()
```

每步失败时降级策略：

| 失败点 | 降级 |
|---|---|
| readConversation 为 null | 提示用户“当前平台不支持读取对话”，中止 |
| 摘要生成为空 | 用原文截断前 N token 作为临时摘要 |
| newConversation 失败 | 提示用户手动开新会话，只把续接提示词放入剪贴板 |
| insertText 失败 | 同上，复制到剪贴板兜底 |

---

## 5. Token 计算（重点）

### 5.1 原则

网页端**拿不到服务端精确 token 数**，且本方案不强制引入服务端 API。因此：

- v1 只用于**展示给用户的估算值**与**存档元数据**，不参与决策。
- v2 自动触发基于估算值，但必须设置**保守安全边际**（见 5.5）。

### 5.2 估算公式（无 tokenizer 依赖，默认方案）

采用“分段加权”估算，纯字符级，零依赖、可在 content script 内直接运行：

```typescript
// utils/tokenizer.ts
// 估算安全系数：token 估算偏低会导致 v2 自动触发偏晚（不安全），
// 叠加 1.2 系数吸收英文密度、生僻字等剩余误差。
const ESTIMATE_SAFETY_FACTOR = 1.2;

export interface TokenEstimate {
  chars: number;
  asciiChars: number;
  cjkChars: number;
  codeBlockChars: number;
  estimatedTokens: number;
}

export function estimateTokens(text: string): TokenEstimate {
  let asciiChars = 0;
  let cjkChars = 0;
  let codeBlockChars = 0;

  // 1. 先剥离代码块，单独统计（代码 token 密度通常高于自然语言）
  const codeBlockRegex = /```[\s\S]*?```/g;
  const codeBlocks = text.match(codeBlockRegex) ?? [];
  for (const block of codeBlocks) {
    codeBlockChars += block.length;
  }
  const noCode = text.replace(codeBlockRegex, '');

  // 2. 按字符类别统计（用 code point 遍历，正确处理 emoji/生僻字）
  for (const ch of noCode) {
    const cp = ch.codePointAt(0)!;
    if (isCjk(cp)) cjkChars++;
    else asciiChars++;
  }

  // 3. 估算：
  //    - 英文/数字/符号：~4 字符/token（Claude 官方惯例）
  //    - CJK：~1 字符/token（主流 BPE tokenizer 对常用中文约 1 token/字。
  //      注意：原先取 1.5 字符/token 是低估约 33%，会导致估算 token 偏少、
  //      自动触发压缩偏晚 —— 这是“不安全”方向，必须按 1 字符/token 估算）
  //    - 代码块：~3 字符/token（代码符号多、空格多，密度介于中英文之间）
  //    - 整体叠加 1.2 保守系数（ESTIMATE_SAFETY_FACTOR），进一步吸收剩余估算误差
  const asciiTokens = asciiChars / 4;
  const cjkTokens = cjkChars / 1;
  const codeTokens = codeBlockChars / 3;

  const estimatedTokens = Math.ceil((asciiTokens + cjkTokens + codeTokens) * ESTIMATE_SAFETY_FACTOR);

  return {
    chars: text.length,
    asciiChars,
    cjkChars,
    codeBlockChars,
    estimatedTokens,
  };
}

function isCjk(cp: number): boolean {
  return (
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK 统一表意文字
    (cp >= 0x3400 && cp <= 0x4dbf) || // 扩展 A
    (cp >= 0x3000 && cp <= 0x303f) || // CJK 标点
    (cp >= 0xff00 && cp <= 0xffef) || // 全角字符
    (cp >= 0x3040 && cp <= 0x30ff) || // 日文假名
    (cp >= 0xac00 && cp <= 0xd7af)    // 韩文音节
  );
}
```

### 5.3 精确 token 计算（可选增强，v2.5）

若希望更接近真实值，可在 background 按需懒加载一个轻量 BPE tokenizer：

- 方案 A：`js-tiktoken`（约 50KB gzip 后 ~15KB），支持 `cl100k_base`（GPT-4/Claude 近似）。
- 方案 B：`gpt-tokenizer`，API 更简单，体积更小。

**推荐：v1 不上 tokenizer**。理由：

1. content script 注入体积敏感，懒加载 tokenizer 仍需额外下载。
2. 估算误差 10~20% 对“何时触发压缩”影响有限，安全边际可覆盖。
3. 设计文档已明确 v1 手动触发，v2 才考虑自动阈值 —— 自动阈值才是精确 token 的真正需求场景。

```typescript
// v2.5 精确模式（懒加载）
export async function exactTokens(text: string): Promise<number> {
  const { encode } = await import('gpt-tokenizer'); // 动态 import，按需加载
  return encode(text).length;
}
```

### 5.4 平台上下文窗口表（v2 阈值用，配置化）

```typescript
// defaultConfigs/context-windows.config.ts
export const CONTEXT_WINDOWS: Record<string, number> = {
  deepseek: 64_000,
  chatgpt: 128_000,
  gemini: 1_000_000,
  kimi: 128_000,
  qwen: 128_000,
  // ...按 adapter name 扩展
};

export const TOKEN_OVERHEAD_RESERVE = 4_000;  // 系统提示 + 工具 schema
export const OUTPUT_RESERVE = 8_000;          // 留给模型输出
export const TRIGGER_RATIO = 0.75;            // 用到可用预算 75% 时触发
```

### 5.5 压缩预算计算

```
可用工作预算 = 平台上下文窗口 - TOKEN_OVERHEAD_RESERVE - OUTPUT_RESERVE
触发阈值     = 可用工作预算 × TRIGGER_RATIO
```

例：DeepSeek 64K

```
可用工作预算 = 64000 - 4000 - 8000 = 52000
触发阈值     = 52000 × 0.75 = 39000 tokens
即：估算对话达到约 39K tokens 时触发压缩（安全边际 25%）
```

**为什么用 75% 而非更高**：估算误差 + 摘要生成本身要消耗上下文 + 注入续接消息后还会继续增长，必须留足余量。同时 5.2 节估算公式已按 CJK 1 字符/token 并叠加 1.2 保守系数，**估算值只可能偏高、不会偏低** —— 75% 阈值与 1.2 系数共同构成双层安全边际，避免在不可靠信号上晚触发。

---

## 6. 摘要生成 Prompt 设计

发送给当前 AI 的总结指令：

````markdown
你正在协助完成一次“上下文压缩”。请把当前对话压缩为一份结构化摘要，供新会话无缝接续。

## 输出要求
1. 总长度控制在 {targetTokens} tokens 以内（约 {targetChars} 个中文字符）
2. 使用以下 Markdown 结构，字段必须齐全：
   - ## 任务目标：原始任务要达成什么
   - ## 已完成：已完成的步骤与结论（保留关键数字/路径/命令）
   - ## 关键决策：重要取舍与原因
   - ## 未完成事项：按优先级列出，含下一步动作
   - ## 风险与注意事项：坑点、约束、平台风控点
   - ## 关键文件路径：涉及的所有路径清单
3. 代码块只保留“正在修改的核心片段”，完整代码请概述其作用即可
4. 不要客套，直接输出摘要正文，不要用 ``` 包裹整个输出
5. 严禁调用任何工具/函数（当前工具开关可能处于激活状态），只做纯文本总结

## 待续接任务状态
{todoContext}
````

`{targetTokens}` 默认 1200，用户可在侧边栏配置（800~3000）。

---

## 7. 摘要校验与预算约束

```typescript
// compaction.service.ts 核心校验逻辑（伪代码）
function validateSummary(raw: string, targetTokens: number): SummaryValidation {
  const est = estimateTokens(raw);
  const tooLong = est.estimatedTokens > targetTokens * 1.5; // 超 50% 视为不合格
  const tooShort = est.estimatedTokens < 50;                // 空话/失败

  if (tooShort || raw.trim().length === 0) {
    return { ok: false, reason: 'empty', fallback: truncateByTokens(transcript, targetTokens) };
  }
  if (tooLong) {
    return { ok: false, reason: 'too_long', fallback: truncateByTokens(raw, targetTokens) };
  }
  return { ok: true, summary: raw };
}
```

---

## 8. 数据结构与存储

### 8.1 索引（`chrome.storage.local`）

```typescript
interface CompactionRecord {
  compactionId: string;        // `comp_${ts}_${rand}`
  createdAt: number;
  sourceAdapter: string;
  sourceUrl: string;
  transcriptPath: string;      // IndexedDB key，如 `transcript_${compactionId}`
  summaryPath: string;         // IndexedDB key
  tokenEstimate: TokenEstimate; // 压缩前对话的 token 估算
  summaryTokens: number;       // 摘要 token 估算
  carriedTodos: string[];      // 未完成 todo id
  status: 'pending' | 'summarizing' | 'done' | 'failed';
}
```

### 8.2 大文本存档（IndexedDB）

- DB：`mcp-compactions`
- ObjectStore：`archives`（keyPath: `id`）
- 每条：`{ id, content, createdAt }`
- `transcript.md` 与 `summary.md` 都是纯文本 UTF-8，分别存一条。

> ⚠️ **关键约束：IndexedDB 必须归属扩展 origin。** content script 里的 IndexedDB 与页面同源（如 `chat.deepseek.com`）：页面自身 JS 可读取完整对话存档（隐私风险），且随站点数据清理/登出而丢失。因此大文本存档必须经 `chrome.runtime.sendMessage` 路由到 background，在**扩展自身 origin** 下建 IndexedDB（或直接 `chrome.storage.local` + `unlimitedStorage` 权限），索引仍放 `chrome.storage.local`。这也与项目「所有数据通信必须过 background」的既有硬约束一致。

---

## 9. 续接首条消息模板

```
[任务续接指令]
你正在接手一个已压缩的历史任务。请先阅读下方摘要，基于其中“未完成事项”继续执行。
不要重复摘要中“已完成”的工作；如摘要缺失关键信息，请先指出再行动。

<summary>
{summary 全文}
</summary>

<todo>
{carriedTodos + 当前 todo 状态 JSON}
</todo>

<archive>
原文存档：compactions/{compactionId}/transcript.md（若你连接了文件系统工具可回查，否则以摘要为准）
</archive>
```

> 注入注意事项：
> - 续接消息可能较长（续接指令 + `<summary>` 全文 + todo 状态），`insertText` 后必须**校验输入框实际内容**（复用 `automation.service` 的「插入后校验、失败重试」模式，避免 `.value` 直接赋值不同步 React 的坑），失败则重试。
> - 若摘要超长（> 2000 tokens），建议把 `<summary>` 拆成多条消息依次发送、最后一条再携带续接指令，降低输入框长度限制风险。
> - 摘要 prompt 已约定输出为 Markdown 正文（第 6 节第 5 条禁止调用工具），此处注入时保留 `<summary>`/`<todo>` 围栏结构以便新会话 AI 解析。

---

## 10. v2 自动触发策略（估算驱动的务实做法）

```typescript
// 在每次 readConversation 成功后（或工具执行完成后）采样
function shouldAutoCompact(adapterName: string, text: string): boolean {
  if (!autoCompactEnabled) return false;
  const window = CONTEXT_WINDOWS[adapterName];
  if (!window) return false; // 未知平台不做自动触发

  const budget = (window - TOKEN_OVERHEAD_RESERVE - OUTPUT_RESERVE) * TRIGGER_RATIO;
  const est = estimateTokens(text).estimatedTokens;
  return est >= budget;
}
```

**防抖**：达到阈值后，等当前回复生成完毕（`waitForResponse` 返回 true）再触发，避免在流式输出中途打断。

**采样时机**：`readConversation` 是全量 DOM 爬取，成本高，不要每次工具执行后都采样。仅在 `waitForResponse` 完成后的空闲期（或用户打开压缩面板时）采样一次即可。

---

## 11. 边界情况与处理

| 场景 | 处理 |
|---|---|
| 对话极短（< 500 tokens）触发压缩 | 拒绝并提示“上下文尚短，无需压缩” |
| 摘要中丢失关键命令/路径 | 存档兜底；续接消息中标注 archive 路径 |
| 当前平台不支持 readConversation | 明确报错“该平台暂不支持压缩”，不做静默失败 |
| 新会话注入后续接 AI 跑偏 | 在摘要 prompt 中强化“未完成事项优先级”字段 |
| 多次压缩叠加 | 每次压缩都基于**当前会话全文**，天然包含历史摘要，不产生递归问题 |

---

## 12. 实施顺序（与设计文档 P0-P3 对齐）

1. **P0**：`plugin-types.ts` 扩展 + `base.adapter.ts` 默认方法 + DeepSeek 四方法实现
   - 同步更新 `plugin-registry.ts`：DeepSeek factory 的 `capabilities` 数组与 `features` 映射补 `conversation-read` / `conversation-create`
2. **P1**：`tokenizer.ts` 纯函数 + 单测（用已知文本校验估算量级，重点校验 CJK 按 1 字符/token 估算）
3. **P2**：`compaction-storage.ts`（**IndexedDB 必须走 background/扩展 origin**，见 8.2 关键约束）+ `compaction.store.ts`
4. **P3**：`compaction.service.ts` 完整编排 + 侧边栏按钮 + `compact_context` 内置工具
   - 前置依赖：**`InternalToolProvider`**（design-proposal P0）——`compact_context` 内置工具需要它才能暴露给网页 AI，当前代码中尚不存在，必须先落地
5. **P3.5**：v2 自动阈值（基于估算 + 1.2 保守系数 + 75% 安全边际 + 空闲期采样）

---

## 总结

上下文压缩的核心难点不在“存摘要”，而在**网页端 token 不可得**。本方案用「字符分段加权估算」作为默认路径（零依赖、可立即落地，**CJK 按 1 字符/token 并叠加 1.2 保守系数，估算只高不低**），把精确 tokenizer 作为 v2.5 的可选懒加载增强；触发阈值保守设在 75%，并叠加防抖与空闲期采样，从而在不可靠信号上建立**足够安全的**自动化。这与设计文档“不应在不可靠信号上建自动化”的精神一致 —— 我们的做法是“让信号可靠到可建自动化”。落地时需牢记三个硬约束：**DeepSeek 选择器复用 `render_prescript` 既有配置**、**IndexedDB 必须归属扩展 origin**、**`compact_context` 内置工具依赖 InternalToolProvider 先行落地**。
