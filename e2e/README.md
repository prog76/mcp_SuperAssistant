# Browser E2E Harness（浏览器模拟环境 + 扩展可观测）

在真实 Chromium 中加载本项目的扩展（`dist/`），并从登录态（cookie）文件恢复会话，
用于观察扩展在真实站点的实际表现（MCP 按钮、侧边栏、输入框、function result 等）。

## 前置准备

1. 先构建扩展产物：`pnpm base-build`（产物在 `dist/`）。已在根目录生成 `.env` 时也可用 `pnpm build`。
2. 已安装 Playwright 与 Chromium（首次环境运行一次）：

   ```bash
   pnpm exec playwright install chromium
   ```

## 命令

| 命令 | 作用 |
| --- | --- |
| `pnpm e2e:browser -- --url <site> [--storage <st.json>]` | 打开带扩展的浏览器，可手动操作 |
| `pnpm e2e:capture -- --url <site> [--storage <st.json>]` | 一次性抓取 DOM/截图并退出 |
| `node e2e/cookies/toStorageState.cjs --input <cookies.json> [--domain x]` | cookie JSON → storageState |

> 通过 `pnpm run <script> -- <参数>` 透传参数（pnpm 需 `--` 分隔）。

### 启动浏览器（手动/agent 操作）

```bash
pnpm e2e:browser -- --url https://chat.deepseek.com --storage e2e/fixtures/deepseek-storage.json
```

浏览器保持打开，完成注入登录态后停在目标页；退出按 `Ctrl+C`。
常用参数：`--headless`（无头，MV3 扩展支持有限，默认关闭）、`--ext <dist路径>`、`--user-data <目录>`、
`--storage <storageState.json>`。

### 抓取 DOM 证据（供 AI 分析）

```bash
pnpm e2e:capture -- --url https://chat.deepseek.com --storage e2e/fixtures/deepseek-storage.json
```

输出到 `e2e/artifacts/<host>-<时间戳>.json` 与 `...-full.png`。JSON 包含：

- `url` / `title`
- `inputs`：页面 textarea / contenteditable 输入框及可编辑状态
- `shadowHosts`：shadow DOM 宿主（扩展常用 shadow DOM 承载侧边栏/气泡）
- `mcpMentions`：含 `mcp` 文本的节点
- `dataMarked`：带 mcp 相关 `data-*` 属性的节点
- `screenshot`：整页截图路径

## Cookie 登录态（storageState）

- 用 Chrome 导出 cookie JSON（含 `name`/`domain`/`path`/`value`）直接转成 storageState：
  ```bash
  node e2e/cookies/toStorageState.cjs --input e2e/fixtures/deepseek-cookies.example.json --domain chat.deepseek.com --output e2e/fixtures/deepseek-storage.json
  ```
- 字段映射：`expirationDate`→`expires`；`sameSite`(strict/lax/no_restriction)→`Strict/Lax/None`；
  `null` 或非法留空；忽略 `hostOnly`/`session`/`storeId`。缺 `name`/`value`/`domain|url` 时报错并列出字段名。
- 也可直接提供 Playwright storageState JSON，无需转换。

## Agent 如何复用此环境

1. **自动化抓取证据**：直接跑 `pnpm e2e:capture`，读取返回的 JSON 与截图分析扩展注入情况。
2. **手动接管**：跑 `pnpm e2e:browser` 打开浏览器后用浏览器 skill（如 Playwright/模板浏览器工具）
   继续操作并读取 DOM（页面 URL、扩展注入的 shadow root、输入框实时状态）。
3. 扩展只在 `manifest.json` 的 matches 白名单站点注入；测试目标需在 host_permissions 内
   （`*://chat.deepseek.com/*` 等）。

## 目录结构

```
e2e/
  launch.cjs                 # 启动带扩展+登录态的浏览器（保持打开）
  capture.cjs                # 一次性抓取 DOM/截图
  cookies/toStorageState.cjs # cookie 转换适配器
  lib/context.cjs            # 共享：加载扩展 + 注入登录态
  fixtures/                  # cookie 样例 / 生成的 storageState
  artifacts/                 # 抓取产物（JSON + 截图）
  .user-data/                # 持久化浏览器 profile（登录态可复用）
```