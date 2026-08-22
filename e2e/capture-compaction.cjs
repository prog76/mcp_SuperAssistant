#!/usr/bin/env node
/**
 * 真实压缩流程日志抓取：
 *   1) 加载 DEBUG 版扩展 + 登录态
 *   2) 捕获页面 console（含 content script 的 CompactionService/AIStudioAdapter 日志）
 *   3) 造一条长对话并等待模型回复（使 token 超过压缩阈值）
 *   4) 点击侧边栏「压缩当前对话」
 *   5) 等待压缩结束，导出全部日志与页面状态
 *
 * 用法：
 *   node e2e/capture-compaction.cjs [--storage <storage.json>] [--ext <dist>] [--headless]
 *
 * @author huquanzhi
 * @since 2026-08-22
 * @version 1.0
 */
const fs = require('fs');
const path = require('path');
const { buildContext, PROJECT_ROOT } = require('./lib/context.cjs');

function parseArgs(argv) {
  const args = {};
  const keys = new Set(['--storage', '--ext']);
  for (let i = 0; i < argv.length; i += 1) {
    if (keys.has(argv[i])) {
      args[argv[i].replace('--', '')] = argv[i + 1];
      i += 1;
    } else if (argv[i] === '--headless') {
      args.headless = true;
    }
  }
  return args;
}

const LONG_TEXT = [
  '我正在为一个内部团队搭建"代码审查自动化助手"服务，请你帮忙推进这个项目。以下是完整上下文。',
  '',
  '## 项目背景',
  '团队每周人工审查约 200 个 PR，耗时大且漏检多。目标是用 LLM + MCP 工具做半自动审查：',
  '分析 diff → 生成结构化问题清单 → 通过飞书机器人推送给作者。',
  '',
  '## 需求（已确认）',
  '1. 读取 GitHub PR 的 diff 与评论流（MCP 工具：github.get_pr_diff / github.list_comments）',
  '2. 按 正确性/安全/性能/风格 四类输出问题，每类给严重级别与修改建议',
  '3. 结果写成 Markdown 发到飞书群（MCP 工具：lark.send_message）',
  '4. 每天定时扫描一次，只对含 rust/src 的 PR 审查',
  '',
  '## 当前架构',
  'service/',
  '  ├─ gateway/          # FastAPI 入口 + 任务队列(RQ)',
  '  ├─ analyzer/         # LLM 审查编排（temperature=0.2）',
  '  └─ publisher/        # 飞书/邮件推送适配器',
  'service/analyzer/prompts/review.md     # 系统提示词（已定稿）',
  'service/tests/fixtures/pr-1842.diff   # 审查样例（含已知 3 类缺陷）',
  '',
  '## 已完成',
  '- gateway 的 PR 事件 webhook 已接通，能落库为 pending 队列',
  '- analyzer 能调用 github.get_pr_diff 拿全 diff',
  '- 本地跑过 1 个样例 fixture（pr-1842），正确性/安全各查出 1 个问题',
  '',
  '## 未完成 / 本次需要你做的',
  '- 把【性能】类模板补齐：大循环里的重复正则编译、无界缓存',
  '- publisher 对 2000 字以上的 Markdown 做分片再调 lark.send_message',
  '- 给扫描加"当日已处理过的 PR 跳过"的去重标记（避免重复推送）',
  '',
  '## 风险与注意',
  '- github 任务有并发上限，gateway 队列需限流（max 5/分钟）',
  '- 飞书消息有长度与水印限制，务必分片并带 \u2060[mcp:source] 前缀便于追溯',
  '',
  '请先给出整体技术方案（含上面的性能模板草稿与去重策略），再拆成可执行的步骤清单。',
].join('\n');

// 与 adapter 插入方式一致
async function insertAndSubmit(page, text) {
  return page.evaluate((t) => {
    const input = document.querySelector('textarea.textarea[aria-label="Enter a prompt"]');
    if (!input) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    if (setter) setter.call(input, t);
    else input.value = t;
    input.selectionStart = input.selectionEnd = t.length;
    try {
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: t }));
    } catch {
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.focus();
    return true;
  }, text);
}

// 判定模型是否在生成：Run 按钮 type=button + Stop
function generatingJs() {
  const run = document.querySelector('ms-run-button button');
  if (!run) return false;
  if (run.type === 'button') {
    return !!run.querySelector('.spin') || /stop/i.test(run.textContent || '');
  }
  return false;
}

// 侧边栏 shadow 内按钮状态/notice
function sidebarStateJs() {
  const host = document.getElementById('mcp-sidebar-shadow-host');
  if (!host || !host.shadowRoot) return { found: false };
  const btns = Array.from(host.shadowRoot.querySelectorAll('button'));
  const compactBtn = btns.find((b) => (b.textContent || '').includes('压缩'));
  // 收集面板可见文本，便于读取 notice/error
  const body = host.shadowRoot.querySelector('body');
  const text = (body ? body.innerText : host.shadowRoot.textContent) || '';
  return {
    found: true,
    compactButtonText: compactBtn ? (compactBtn.textContent || '').trim() : null,
    compactButtonDisabled: compactBtn ? compactBtn.disabled : null,
    panelTextPrefix: text.slice(0, 400),
  };
}

async function waitModelDone(page, timeoutMs) {
  const start = Date.now();
  let sawGeneration = false;
  while (Date.now() - start < timeoutMs) {
    const generating = await page.evaluate(generatingJs);
    if (generating) sawGeneration = true;
    if (sawGeneration && !generating) {
      await page.waitForTimeout(2000);
      const again = await page.evaluate(generatingJs);
      if (!again) return true;
    }
    await page.waitForTimeout(800);
  }
  return false;
}

async function clickCompact(page) {
  return page.evaluate(() => {
    const host = document.getElementById('mcp-sidebar-shadow-host');
    if (!host || !host.shadowRoot) return false;
    const btns = Array.from(host.shadowRoot.querySelectorAll('button'));
    const btn = btns.find((b) => (b.textContent || '').includes('压缩当前对话') && !b.disabled);
    if (!btn) return false;
    btn.click();
    return true;
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const logs = [];
  let context;
  let page;
  try {
    ({ context } = await buildContext({
      extPath: args.ext,
      storageFile: args.storage,
      headless: args.headless,
    }));
    page = context.pages()[0] || (await context.newPage());

    page.on('console', (msg) => {
      const t = msg.text();
      if (/Compaction|AIStudio|CompactionService|insert|新会话|摘要|压缩/i.test(t)) {
        logs.push({ ts: Date.now(), type: msg.type(), text: t });
      }
    });
    page.on('pageerror', (err) => logs.push({ ts: Date.now(), type: 'pageerror', text: String(err) }));

    const trace = [];
    const mark = (s) => {
      trace.push({ t: Date.now(), s });
      console.log(`[step] ${s}`);
    };

    const url = 'https://aistudio.google.com/prompts/new_chat';
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(12000);
    mark(`打开 ${page.url()}`);

    // 造长对话
    const inserted = await insertAndSubmit(page, LONG_TEXT);
    mark(`写入长文本=${inserted}`);
    await page.waitForTimeout(1000);
    // 提交（Ctrl+Enter + 点击 Run）
    await page.evaluate(() => {
      const chatInput = document.querySelector('textarea.textarea[aria-label="Enter a prompt"]');
      try {
        chatInput.focus();
        chatInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true, ctrlKey: true }));
        chatInput.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true, ctrlKey: true }));
      } catch {}
      const run = document.querySelector('ms-run-button button');
      if (run && run.getAttribute('aria-disabled') === 'false') {
        try { run.click(); } catch {}
      }
    });
    mark('已提交长文本');

    const done = await waitModelDone(page, 150000);
    mark(`模型回复完成=${done}`);

    const stateBefore = await page.evaluate(sidebarStateJs);
    mark(`压缩按钮状态=${JSON.stringify(stateBefore)}`);

    const clicked = await clickCompact(page);
    mark(`点击压缩=${clicked}`);
    logAll(page, logs, trace, stateBefore, 'clicked');
    if (!clicked) {
      // 按钮可能需滚动或位置；再做一次带 scrollIntoView 的点击
      const scrolled = await page.evaluate(() => {
        const host = document.getElementById('mcp-sidebar-shadow-host');
        if (!host || !host.shadowRoot) return false;
        const btn = Array.from(host.shadowRoot.querySelectorAll('button')).find((b) => (b.textContent || '').includes('压缩当前对话'));
        if (!btn) return false;
        btn.scrollIntoView({ block: 'center' });
        btn.click();
        return true;
      });
      mark(`滚动后重试点击=${scrolled}`);
      logAll(page, logs, trace, stateBefore, 'clicked-retry');
      if (!scrolled) {
        mark('无法点击压缩（按钮不存在或禁用），dump 日志');
        logAll(page, logs, trace, stateBefore, 'blocked');
        process.exit(0);
      }
    }

    // 等待压缩结束（最长 200s），观察 shadow 面板
    const start = Date.now();
    let finalText = '';
    while (Date.now() - start < 200000) {
      await page.waitForTimeout(4000);
      const s = await page.evaluate(sidebarStateJs);
      if (!s.found) continue;
      if (/压缩完成|已在新会话|失败|复制到剪贴板|已生成摘要/i.test(s.panelTextPrefix)) {
        finalText = s.panelTextPrefix;
        break;
      }
    }
    await page.waitForTimeout(4000);
    const stateAfter = await page.evaluate(sidebarStateJs);
    mark('压缩流程结束或超时');
    logAll(page, logs, trace, stateAfter, 'final');
  } catch (err) {
    console.error(`[capture-compaction] 异常: ${err.message}`);
    console.error(err.stack);
    await logAllSafe(page, logs);
    process.exit(1);
  } finally {
    if (context) await context.close().catch(() => {});
  }
}

async function logAll(page, logs, trace, state, tag) {
  const artifactsDir = path.join(PROJECT_ROOT, 'e2e', 'artifacts');
  fs.mkdirSync(artifactsDir, { recursive: true });
  const base = path.join(artifactsDir, `compaction-${tag}-${Date.now()}`);
  const result = {
    tag,
    trace,
    state,
    logs,
  };
  fs.writeFileSync(`${base}.json`, JSON.stringify(result, null, 2), 'utf-8');
  console.log('JSON:', `${base}.json`);
  console.log('--- 捕获的日志 ---');
  logs.forEach((l) => console.log(`${l.type}: ${l.text}`));
}

async function logAllSafe(page, logs) {
  try {
    await logAll(page, logs, [], null, 'error');
  } catch {}
}

main();