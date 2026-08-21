# MCP-SuperAssistant 自动压缩阈值设置与实时 Token UI 设计

> 版本：1.0
> 日期：2026-08-21
> 状态：设计评审稿
> 关联文档：`docs/context-compaction-design.md`（压缩流程与 token 估算）

## 0. 现状核对

已确认：

- `pages/content/src/utils/tokenizer.ts` 已有 `estimateTokens(text)` 纯函数与 `truncateByTokens(text, targetTokens)`，可直接复用。
- `pages/content/src/services/compaction.service.ts` 已有：
  - `DEFAULT_TARGET_TOKENS = 1200`（摘要预算默认值）
  - `MIN_COMPACT_TOKENS = 500`（极短对话不压缩）
  - `clampTargetTokens()`（摘要预算 800~3000 夹取）
  - 但目前**没有自动触发逻辑**，只有手动按钮入口。
- `pages/content/src/components/sidebar/Compaction/Compaction.tsx`：
  - 只有压缩按钮、状态提示与历史记录列表。
  - 历史记录里显示 `约 {record.tokenEstimate.estimatedTokens} tokens → 摘要 {summaryTokens} tokens`，但**没有实时当前对话 token 消耗**。
- `pages/content/src/components/sidebar/Settings/Settings.tsx`：
  - 只有三个 Automation Delay 设置，**没有压缩相关设置**。
- `UserPreferences`（`pages/content/src/types/stores.ts`）：
  - 无 `autoCompactEnabled` / `autoCompactMaxTokens` 字段。
- `useUIStore` 的 `updatePreferences()` 是浅合并，且已通过 zustand `persist` 持久化到 localStorage，新增字段无需额外做持久化。

---

## 1. 需求

1. 新增「自动触发上下文压缩的最大 token 数」设置项，供用户自定义。
2. 新增「实时 token 消耗 UI」：实时展示当前对话估算 token 数，接近/超过阈值时给用户视觉提示。
3. 评估实时计算的资源消耗，并选定轮询或事件驱动方案。

---

## 2. 方案总览

| 改动模块 | 文件 | 内容 |
|---|---|---|
| 类型扩展 | `pages/content/src/types/stores.ts` | `UserPreferences` 新增自动压缩字段 |
| Store 默认值 | `pages/content/src/stores/ui.store.ts` | `initialUserPreferences` 补默认值 |
| 设置 UI | `pages/content/src/components/sidebar/Settings/Settings.tsx` | 新增开关 + 最大 token 数输入框 |
| Token 监视服务（新增） | `pages/content/src/services/token-watcher.service.ts` | 轮询采样 + 估算 + 自动触发判断 |
| Token Store（新增） | `pages/content/src/stores/token.store.ts` | 实时 token 状态，供 UI 订阅 |
| 压缩面板 UI | `pages/content/src/components/sidebar/Compaction/Compaction.tsx` | 顶部显示当前 token / 阈值 |

---

## 3. 自动触发阈值设置

### 3.1 新增偏好字段

在 `pages/content/src/types/stores.ts` 的 `UserPreferences` 中新增：

```typescript
export interface UserPreferences {
  // ...既有字段

  // 自动压缩：达到 maxTokens 时自动触发 compressionService.compact()
  autoCompactEnabled: boolean;
  autoCompactMaxTokens: number; // 默认 12000，允许 2000~60000
}
```

### 3.2 Store 默认值

在 `pages/content/src/stores/ui.store.ts` 的 `initialUserPreferences` 中补充：

```typescript
const initialUserPreferences: UserPreferences = {
  // ...既有默认值

  autoCompactEnabled: false, // 默认关闭，避免非预期自动打断
  autoCompactMaxTokens: 12_000, // 默认 12K，保守起点
};
```

> 注意：`updatePreferences` 是 `{ ...oldPrefs, ...prefs }` 浅合并，老用户 localStorage 里没有这两个 key 时会取 `undefined`。
> 必须在 `initialUserPreferences` 补默认值，同时建议在读到处做一次兜底：
>
> ```typescript
> const maxTokens = preferences.autoCompactMaxTokens ?? 12_000;
> ```

### 3.3 设置 UI

在 `Settings.tsx` 中，于现有 Delay 设置卡片下方新增「上下文压缩」卡片：

```tsx
const { preferences, updatePreferences } = useUserPreferences();

const handleAutoCompactToggle = (enabled: boolean) => {
  updatePreferences({ autoCompactEnabled: enabled });
};

const handleAutoCompactMaxTokens = (value: string) => {
  const parsed = parseInt(value, 10);
  if (Number.isNaN(parsed)) return;
  // 夹取 2000~60000，与 UI 输入范围一致
  updatePreferences({ autoCompactMaxTokens: Math.min(60_000, Math.max(2_000, parsed)) });
};
```

UI 结构：

```tsx
<Card>
  <CardContent className="p-4 space-y-3">
    <Typography variant="h4">上下文压缩</Typography>

    {/* 自动压缩开关 */}
    <label className="flex items-center justify-between">
      <span>自动压缩</span>
      <Toggle
        checked={preferences.autoCompactEnabled ?? false}
        onChange={handleAutoCompactToggle}
      />
    </label>

    {/* 最大 token 数 */}
    <div>
      <label htmlFor="auto-compact-max-tokens" className="block text-sm font-medium">
        自动触发最大 Token 数
      </label>
      <input
        id="auto-compact-max-tokens"
        type="number"
        min={2000}
        max={60000}
        value={preferences.autoCompactMaxTokens ?? 12000}
        onChange={(e) => handleAutoCompactMaxTokens(e.target.value)}
        disabled={!preferences.autoCompactEnabled}
      />
      <p className="mt-1 text-xs text-slate-500">
        当前对话估算 token 达到该值时自动触发压缩（默认 12000）
      </p>
    </div>
  </CardContent>
</Card>
```

---

## 4. 实时 Token 消耗 UI

### 4.1 Token Store（新增）

新建 `pages/content/src/stores/token.store.ts`：

```typescript
import { create } from 'zustand';

interface TokenState {
  currentTokens: number;      // 当前对话估算 token
  tokenEstimate: TokenEstimate | null; // 完整估算明细
  autoCompactMaxTokens: number;
  isOverThreshold: boolean;
  lastSampledAt: number | null;

  setCurrentEstimate: (est: TokenEstimate) => void;
  setThreshold: (tokens: number) => void;
  reset: () => void;
}

export const useTokenStore = create<TokenState>()((set, get) => ({
  currentTokens: 0,
  tokenEstimate: null,
  autoCompactMaxTokens: 12_000,
  isOverThreshold: false,
  lastSampledAt: null,

  setCurrentEstimate: (est) => {
    const threshold = get().autoCompactMaxTokens;
    set({
      currentTokens: est.estimatedTokens,
      tokenEstimate: est,
      isOverThreshold: est.estimatedTokens >= threshold,
      lastSampledAt: Date.now(),
    });
  },

  setThreshold: (tokens) => {
    const current = get().currentTokens;
    set({
      autoCompactMaxTokens: tokens,
      isOverThreshold: current >= tokens,
    });
  },

  reset: () => set({
    currentTokens: 0,
    tokenEstimate: null,
    isOverThreshold: false,
    lastSampledAt: null,
  }),
}));
```

### 4.2 UI 呈现

放在 `Compaction.tsx` 顶部卡片内，按钮上方：

```tsx
const { currentTokens, isOverThreshold } = useTokenStore();

<div className="flex items-center justify-between">
  <Typography variant="caption">当前对话约 {currentTokens.toLocaleString()} tokens</Typography>
  <span className={cn(
    'text-xs px-2 py-0.5 rounded-full',
    isOverThreshold
      ? 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300'
      : 'bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-300'
  )}>
    {isOverThreshold ? '已达阈值' : '正常'}
  </span>
</div>

{/* 可选：token 进度条 */}
<div className="h-1.5 w-full rounded-full bg-slate-100 dark:bg-slate-700 overflow-hidden">
  <div
    className={cn(
      'h-full transition-all',
      isOverThreshold ? 'bg-red-500' : 'bg-indigo-500'
    )}
    style={{ width: `${Math.min(100, (currentTokens / autoCompactMaxTokens) * 100)}%` }}
  />
</div>
```

### 4.3 轮询数据流

```
TokenWatcherService（setInterval 2~3s）
  ├─ 页面隐藏则跳过
  ├─ adapter.readConversation() → messages
  ├─ 拼接 transcript（同 compaction.service 的拼接逻辑）
  ├─ estimateTokens(transcript)
  ├─ useTokenStore.setCurrentEstimate(est)
  └─ 若 autoCompactEnabled 且 est.estimatedTokens >= autoCompactMaxTokens
       → 触发自动压缩（带冷却与去重，见第 6 节）
```

---

## 5. 性能与轮询评估

### 5.1 `estimateTokens` 开销

`estimateTokens` 是纯字符级遍历：

- 一次正则剥离代码块 + 一次 code point 遍历 + 几次除法；
- 复杂度 O(n)，n 为对话文本字符数；
- 长对话 10 万字符级别，单次仅数毫秒；
- **无 DOM 操作、无网络、无 AI 调用**，资源开销可忽略。

**结论：频繁调用 `estimateTokens` 本身几乎零成本，可以放心轮询。**

### 5.2 `readConversation` 开销

真正的开销在 adapter 的 `readConversation`：

- `document.querySelectorAll` 查询消息节点；
- 递归遍历 DOM 提取纯文本（`extractConversationText`）。

对 2~3 秒轮询来说，这部分开销仍然很小，但有两点要注意：

1. **DOM 虚拟化**：`readConversation` 只能读到当前已渲染的节点，长对话需要滚动加载。压缩服务里的既有设计已在处理滚动采集问题；实时监视服务可先只采当前已渲染内容，能拿到多少算多少，`estimateTokens` 的