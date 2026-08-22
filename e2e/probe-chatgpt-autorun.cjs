#!/usr/bin/env node
/**
 * ChatGPT auto-run (autoExecute) 模式复测：
 * 强制设置 window.__mcpAutomationState.autoExecute=true，触发一次函数调用，
 * 观察函数块是否 reach complete、Run 按钮是否渲染、是否自动触发执行。
 *
 * 用法：
 *   node e2e/probe-chatgpt-autorun.cjs [--storage <storage>] [--ext <dist>] [--prompt <文本>]
 *
 * @author huquanzhi
 * @since 2026-08-22
 * @version 1.0
 */
const path = require('path');
const fs = require('fs');
const { buildContext, PROJECT_ROOT } = require('./lib/context.cjs');

function parseArgs(argv) {
  const args = {};
  const keys = new Set(['--storage', '--ext', '--prompt']);
  for (let i = 0; i < argv.length; i += 1) {
    if (keys.has(argv[i])) {
      args[argv[i].replace('--', '')] = argv[i + 1];
      i += 1;
    }
  }
  return args;
}

// 持续把 autoExecute 强制为 true（防止 AutomationService 设置成 false）
const FORCE_AUTORUN = `
  (function(){
    const set = () => {
      const cur = window.__mcpAutomationState || {};
      window.__mcpAutomationState = { ...cur, ready: true, autoExecute: true, autoInsert: false, autoSubmit: false };
    };
    set();
    const iv = window.__autorunIv;
    if (iv) clearInterval(iv);
    window.__autorunIv = setInterval(set, 400);
    window.__autorunStop = set;
  })();
`;

function inspect() {
  const blocks = [];
  document.querySelectorAll('.function-block').forEach((b) => {
    blocks.push({
      id: b.getAttribute('data-block-id'),
      cls: b.className,
      complete: b.classList.contains('function-complete'),
      loading: b.classList.contains('function-loading'),
      hasExecute: !!b.querySelector('.execute-button'),
      execDisabled: b.querySelector('.execute-button')?.disabled ?? null,
      execText: (b.querySelector('.execute-button')?.textContent || '').trim().slice(0, 30),
      hasSpinner: !!b.querySelector('.execute-spinner'),
      resultsVisible: b.querySelector('.function-results-panel')?.style.display ?? 'n/a',
      name: b.querySelector('.function-name-text')?.textContent ?? null,
    });
  });
  const autoState = window.__mcpAutomationState;
  return {
    url: location.href,
    blocks,
    autoState,
    hasMcpClient: !!window.mcpClient,
    mcpReady: window.mcpClient?.isReady ? window.mcpClient.isReady() : null,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const storageFile = args.storage || path.join(PROJECT_ROOT, 'e2e', 'fixtures', 'chatgpt-storage.json');
  const prompt = args.prompt ||
    '请模拟一次工具调用，只输出如下 JSON（不要额外文字），文件格式须为 function_call 事件序列：\n' +
    '{"type":"function_call_start","name":"get_weather","call_id":17002}\n' +
    '{"type":"parameter","key":"city","value":"Shanghai"}\n' +
    '{"type":"function_call_end","name":"get_weather","call_id":17002}';

  let context;
  let page;
  try {
    ({ context } = await buildContext({ extPath: args.ext, storageFile }));
    page = context.pages()[0] || (await context.newPage());

    await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.waitForTimeout(16000);

    // 打开新会话（避免旧会话干扰）
    await page.evaluate(() => {
      const btn = document.querySelector('a[data-testid="create-new-chat-button"]');
      btn?.click();
    });
    await page.waitForTimeout(3000);

    // 强制 auto-run
    await page.evaluate(FORCE_AUTORUN);

    // 输入并发送
    await page.evaluate((text) => {
      const input = document.querySelector('#prompt-textarea, .ProseMirror[contenteditable="true"], div[contenteditable="true"]');
      if (!input) return false;
      input.focus();
      input.innerHTML = '';
      const p = document.createElement('p');
      p.textContent = text;
      input.appendChild(p);
      const range = document.createRange();
      range.setStartAfter(p.lastChild || p);
      range.collapse(true);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true }));
      return true;
    }, prompt);

    const sendClicked = await page.evaluate(() => {
      const btn = document.querySelector('button[data-testid="send-button"], button[aria-label*="Send"], button[data-testid="fruitjuice-send-button"]');
      if (btn) { btn.click(); return true; }
      return false;
    });
    console.log('sendClicked:', sendClicked);

    // 保持 auto-run 强制轮询到回复出现
    await page.waitForFunction(() => {
      const el = document.querySelector('[data-message-author-role="assistant"]');
      return el && el.textContent.trim().length > 0;
    }, { timeout: 60000 }).catch(() => console.warn('等待回复超时'));

    // 多观察几个时间点
    const samples = [];
    for (const delay of [3000, 4000, 6000, 12000, 20000]) {
      await page.waitForTimeout(delay);
      await page.evaluate(FORCE_AUTORUN);
      samples.push({ totalMs: samples.reduce((a, s) => a + s.afterMs, 0) + delay, afterMs: delay, snap: await page.evaluate(inspect) });
    }

    const result = { at: new Date().toISOString(), url: page.url(), title: await page.title(), sendClicked, samples };
    const artifactsDir = path.join(PROJECT_ROOT, 'e2e', 'artifacts');
    fs.mkdirSync(artifactsDir, { recursive: true });
    const out = path.join(artifactsDir, `probe-chatgpt-autorun-${Date.now()}.json`);
    fs.writeFileSync(out, JSON.stringify(result, null, 2), 'utf-8');
    console.log(JSON.stringify(result, null, 2));
    console.log('JSON:', out);
  } catch (err) {
    console.error(`[probe-chatgpt-autorun] 失败: ${err.message}`);
    process.exit(1);
  } finally {
    if (context) await context.close().catch(() => {});
  }
}

main();