# MCP-SuperAssistant 增强功能设计方案

> 版本：1.0
> 日期：2026-08-20
> 状态：设计评审稿

## 1. 背景与目标

MCP-SuperAssistant 是一个 Chrome 扩展（React 19 + TypeScript + pnpm monorepo），通过 content script 中的平台适配器（Adapter）体系，将 MCP 工具集成到 ChatGPT、DeepSeek、Gemini 等 AI 平台的网页对话中。

本方案针对以下四个增强功能进行可行性分析与详细设计：

1. **上下文压缩**：生成任务完成情况摘要，在新建对话中注入摘要以延续任务，达到压缩上下文的目的
2. **Todo 计划执行**：先规划后执行，逐项维护与推进任务，全部完成才算任务完成
3. **定时通知**：长时间运行的后台命令执行完成后，通过通知机制提醒用户
4. **多智能体协作**：主智能体下发任务到不同平台的子智能体（DeepSeek、Gemini、ChatGPT 等），最后由主智能体收集结果

## 2. 可行性结论

**四个功能全部可实现。**

架构选择上，核心结论是：**四个功能本体全部做在扩展内部（内部功能扩展），不做外挂 MCP Server；可选增加一个轻量本地 MCP Gateway 供 IDE Agent 调用。**

理由：

1. 四个功能全部依赖读写浏览器页面的 DOM——读对话内容、新建会话、往其他 AI 平台页面发送消息、检测回复是否生成完毕。MCP Server 运行在浏览器外部，无法访问 `chat.deepseek.com` 等页面内的任何内容
2. MCP 协议中没有"操作网页"的语义。若强行外挂 MCP，最终仍需要一个组件替它操作 DOM，即扩展本身，等于多绕一层
3. 项目已有完善的适配器插件体系（`pages/content/src/plugins/adapters/`），16 个平台适配器挂载于同一抽象基类，四个功能恰好可以在此体系上补齐能力

## 3. 目标架构

```
┌─────────────────────────────────────────────────────────┐
│ 宿主页面层（content script，现有 16 平台适配器所在层）       │
│   DeepSeek（主智能体）/ Gemini / ChatGPT / Kimi / Qwen…   │
└──────────────────┬──────────────────────────────────────┘
                   │ chrome.runtime.sendMessage 上下行
┌──────────────────▼──────────────────────────────────────┐
│ Adapter 能力层（本次新增 4 个抽象方法，各适配器按站实现）    │
│   readConversation() / newConversation()                 │
│   readLastResponse() / waitForResponse()                 │
└──────────────────┬──────────────────────────────────────┘
                   │ 路由到服务
┌──────────────────▼──────────────────────────────────────┐
│ Background 服务层（service worker）                       │
│   todo.service          功能 2：计划状态机 + 持久化         │
│   compaction.service    功能 1：摘要生成、存档、新会话注入  │
│   notify.service        功能 3：chrome.alarms + 通知      │
│   orchestrator.service  功能 4：AgentRegistry + 跨tab调度 │
└──────────────────┬──────────────────────────────────────┘
                   │ 工具注入 / 对外暴露
┌──────────────────▼──────────────────────────────────────┐
│ 能力暴露层                                                │
│   InternalToolProvider：内置工具直接注入网页 AI            │
│   MCP Gateway（可选）：WebSocket 桥给 IDE Agent            │
└─────────────────────────────────────────────────────────┘
```

关键文件落点：

| 模块 | 路径 |
|---|---|
| 适配器基类 | `pages/content/src/plugins/adapters/base.adapter.ts` |
| 适配器注册 | `pages/content/src/plugins/plugin-registry.ts` |
| 工具执行状态 | `pages/content/src/stores/tool.store.ts` |
| 状态存储 | `pages/content/src/stores/` |
| Background 入口 | `chrome-extension/src/background/index.ts` |
| 自动化服务 | `pages/content/src/services/automation.service.ts` |
| 侧边栏 | `pages/content/src/components/sidebar/Sidebar.tsx` |
| MCP 客户端 | `chrome-extension/src/mcpclient/core/McpClient.ts` |

## 4. Phase 0：Adapter 能力扩展（公共基座）

### 4.1 现状缺口

现有适配器只会"说"（`insertText` + `submitForm`），不会"听"（读取回复）、不会"开新会话"。四个功能中有三个半都依赖这两项缺失能力。

### 4.2 新增四个抽象方法

在 `base.adapter.ts` 的 `BaseAdapterPlugin` 中新增（全部可选实现，未实现时降级返回"不支持"）：

```typescript
// 读当前会话全部消息（user + assistant），按顺序返回
async readConversation(): Promise<ConversationMessage[] | null>;

// 点击平台"新建对话"按钮，或导航到站点的新会话 URL
async newConversation(): Promise<boolean>;

// 读最后一条 AI 回复（多模态：文本 + 代码块 + 文件链接）
async readLastResponse(): Promise<ResponsePayload | null>;

// 等待回复生成完毕（MutationObserver 监听流式输出停止 / 停止按钮消失）
async waitForResponse(timeoutMs: number): Promise<boolean>;
```

### 4.3 实现策略

- 每个平台 DOM 不同，16 个适配器需逐个实现选择器，无捷径
- **选择器集中到每个 adapter 对应的 `selectors.ts` 配置文件**，平台改版时只改配置不改逻辑（现有 `defaultConfigs/` 目录可扩展此用途）
- 每个适配器自带选择器自检（复用现有 `isSupported()`），失效时明确上报"选择器失效"而非静默返回 false

### 4.4 InternalToolProvider

扩展目前定位是"把外部 MCP Server 的工具注入网页 AI"，四个功能需要反向：**扩展自身也作为工具提供方**。

- 在 `chrome-extension/src/` 新增 `internal-tools/` 模块
- 实现一个进程内 MCP server 接口，工具列表与外部 MCP 工具合并后注入网页侧边栏
- 内置工具包括：`todo_read` / `todo_write` / `agent_dispatch` / `agent_collect` / `compact_context` / `notify_status` 等

## 5. 功能 1：上下文压缩

### 5.1 原理确认与修正

用户原始思路（摘要 → 新对话 → 初始化提示词带摘要路径）方向正确，修正两点：

1. **摘要全文直接注入首条提示词，而非仅给文件路径**。新对话中的 AI 没有"读本地文件"工具（除非连接了文件系统 MCP），只给路径读不到。正确做法：`<summary>...</summary>` 全文内联，路径仅作为存档索引供人工查看
2. **摘要由当前对话的 AI 生成**（压缩流程的最后一条消息），不引入新的 API 依赖

### 5.2 流程设计

```
触发（手动按钮 / AI 调 compact_context 工具 / 阈值）
  → readConversation() 导出全文
  → 存档：compactions/{ts}/transcript.md
  → 向当前对话发送总结指令 prompt
  → waitForResponse()，readLastResponse() 得到摘要
  → 存档：compactions/{ts}/summary.md
  → newConversation() 开新会话
  → insertText("[任务续接指令] + <summary>全文</summary> + 未完成事项 + 当前 todo 状态")
  → submitForm()
```

### 5.3 数据结构

```typescript
interface CompactionRecord {
  compactionId: string;
  createdAt: number;
  transcriptPath: string;   // 完整对话存档路径
  summaryPath: string;      // 摘要存档路径
  sourceAdapter: string;    // 来源平台
  carriedTodos: string[];   // 压缩时携带的未完成 todo id
}
```

存储：`chrome.storage.local`（索引）+ OPFS 或 IndexedDB（大文本存档）。

### 5.4 范围控制（务实建议）

- **v1 只做手动触发**：侧边栏按钮 + 内置工具 `compact_context`
- **v2 再考虑自动 token 阈值触发**：网页端拿不到精确 token 数，估算不可靠，不应在不可靠信号上建自动化

## 6. 功能 2：Todo 计划执行

### 6.1 设计

最简单的功能，建议最先落地：

- 新建 `pages/content/src/stores/todo.store.ts`（zustand，模式参考现有 `tool.store.ts`），`chrome.storage.local` 持久化
- 状态机：`pending → in_progress → done | failed`，支持 `dependsOn` 依赖链

```typescript
interface TodoTask {
  taskId: string;
  title: string;
  description?: string;
  status: 'pending' | 'in_progress' | 'done' | 'failed';
  dependsOn: string[];   // 依赖的其他任务 id
  createdAt: number;
  updatedAt: number;
}
```

### 6.2 UI 与工具暴露

- 侧边栏新增 Todo 面板（复用 `Sidebar.tsx` 的面板体系）
- 内置工具暴露给 AI：`todo_read()` / `todo_write(tasks)`
- 系统提示注入规约："先调用 todo_write 规划，逐项推进，全部 done 才算任务完成"

### 6.3 与功能 1 联动

压缩时 `carriedTodos` 自动带入新会话首条提示词——未完成任务不因上下文压缩而丢失，这是两个功能的咬合点。

## 7. 功能 3：定时通知

### 7.1 MV3 硬约束

**MV3 的 service worker 会被随时杀掉，禁止使用 `setTimeout` / `setInterval` 做长定时，必须使用 `chrome.alarms` API。** 现有 background 的每分钟连接检查（`chrome-extension/src/background/index.ts` L390-445）已采用此模式，照搬即可。

### 7.2 流程设计

```
工具执行 > N 秒（默认 30s，可配置）未返回
  → 标记为后台任务，写入 background 的 ExecutionRegistry
  → chrome.alarms.create(executionId, { delayInMinutes: 1 })
  → alarm 到点检查 tool.store 执行状态：
      完成 → chrome.notifications.create()
           + chrome.action.setBadgeText("✓")
           + 可选提示音
      未完成 → alarm 自动重复，badge 显示进行中数量
```

### 7.3 依赖与入口

- manifest 新增权限：`alarms`、`notifications`
- 完成信号入口现成：`automation.service.ts` 已监听 `mcp:tool-execution-complete` 事件（L195-220），接到 notify.service 即可

## 8. 功能 4：多智能体协作

### 8.1 架构

- **主智能体** = 当前活跃 tab 的 AI
- **子智能体** = 其他 tab 中已打开（或由 background 自动打开）的 AI 平台
- **background 是唯一调度中枢**

### 8.2 数据结构

```typescript
interface AgentRecord {
  agentId: string;
  tabId: number;
  adapterName: string;        // 'gemini' | 'chatgpt' | ...
  status: 'idle' | 'dispatched' | 'running' | 'done' | 'failed';
  task?: string;
  result?: ResponsePayload;
  dispatchedAt?: number;
  completedAt?: number;
}
```

### 8.3 内置工具

| 工具 | 作用 |
|---|---|
| `agent_list()` | 列出可用子智能体（哪些平台 tab 已打开） |
| `agent_dispatch(adapter, task, context?)` | 下发任务：background 经 `chrome.tabs.sendMessage` 路由到目标 tab，目标 adapter 执行 `insertText + submitForm` |
| `agent_collect(agentId, timeoutMs)` | 拉取结果：目标 tab 的 content script 调 `waitForResponse + readLastResponse` 回传 |

### 8.4 时序

```
DeepSeek(主) 调 agent_dispatch("gemini", "分析这段代码...")
  → background: AgentRegistry 更新 status=dispatched，路由到 gemini tab
  → gemini adapter: insertText → submitForm → waitForResponse → readLastResponse
  → 回传 background，status=done，result 存档
  → notify.service 完成通知
DeepSeek(主) 调 agent_collect("gemini")
  → 拿到结果 → 自行汇总
```

### 8.5 已知难点（无银弹，需正视）

1. **回复完成检测**是每个平台单独的逆向工程：Gemini 与 DeepSeek 的流式结束标志不同。`waitForResponse` 通用策略：MutationObserver 监听消息容器，N 秒无变更 + 停止按钮消失 + 发送按钮恢复可用，三条件取二
2. manifest 需补 `chrome.tabs` 权限和各平台 `host_permissions`
3. 子智能体 tab 未登录 / 被 Cloudflare 拦截时调度直接失败——`agent_dispatch` 须先做页面健康检查，失败快速报错，避免主智能体空等

## 9. MCP Gateway（可选增强，P5）

一个轻量本地 Node.js MCP Server（预计几百行代码）：

- 通过 WebSocket 与扩展 background 通信
- 将 `agent_dispatch` / `agent_collect` / `compact_context` / `todo_read` / `notify_status` 暴露为标准 MCP 工具
- 收益：Trae、Claude Code、Cursor 等 IDE 中的 Agent 也能作为"主智能体"，调度浏览器里的 DeepSeek / Gemini 作为子智能体

## 10. 实施顺序

| 阶段 | 内容 | 依赖 |
|---|---|---|
| P0 | Adapter 四方法 + 选择器配置化 + InternalToolProvider + 统一消息路由 | 无（基座） |
| P1 | Todo（store + 面板 + 内置工具） | P0 的工具暴露 |
| P2 | 定时通知（alarms + notifications + ExecutionRegistry） | 基本独立，可与 P1 并行 |
| P3 | 上下文压缩（compaction.service + 存档 + 新会话注入） | P0 的 readConversation / newConversation |
| P4 | 多智能体（AgentRegistry + 跨 tab 调度 + 健康检查） | P0 全部四方法 + P2 的通知 |
| P5 | MCP Gateway（可选） | P4 完成 |

建议 P0 从 DeepSeek 适配器开始试验（DOM 相对稳定，且是当前主战场）。

## 11. 风险清单

| 风险 | 说明 | 缓解措施 |
|---|---|---|
| DOM 脆弱性 | 平台改版即失效 | 选择器全部配置化；adapter 带自检；失败明确上报"选择器失效"而非静默 false |
| MV3 SW 生命周期 | service worker 随时被杀 | 跨时间状态全部落 `chrome.storage`；定时全部用 `chrome.alarms` |
| 平台风控 | 部分平台对脚本化输入有检测 | 沿用现有 `insertText` 多路径写入（原生 setter / execCommand / InputEvent，见 deepseek.adapter.ts L271-387） |
| 摘要质量 | 压缩后丢失上下文细节是必然 | 全文存档 + todo 携带兜底；新会话可按路径回查档案（若配了文件工具） |
| 子智能体不可用 | tab 未登录 / 被拦截 | dispatch 前健康检查，失败快速报错 |

## 12. 总结

本方案所有环节均生长在现有架构之上（adapter / store / background / sidebar 骨架），无需推翻任何既有设计。核心新增点收敛为三处：

1. `BaseAdapterPlugin` 的四个读写方法（Phase 0 基座）
2. Background 的四个服务模块（todo / compaction / notify / orchestrator）
3. InternalToolProvider（内置工具注入通道）

按 P0 → P5 顺序推进，每阶段可独立验收。
