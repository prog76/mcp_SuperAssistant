#!/usr/bin/env node
/**
 * autoExecute 下 Run 按钮偶发不可见复测：
 * 注入一个受控的假 mcpClient（callTool 可配置延迟 / 抛错），
 * 触发函数调用后在多个时间点观察 execute-button 的可见性状态演进。
 *
 * 用法：
 *   node e2e/probe-chatgpt-visible.cjs [--storage <storage>] [--ext <dist>]
 *                                     [--callDelay ms] [--fail]
 *
 * @author huquanzhi
 * @since 2026-08-22
 * @version 1.0
 */
const path = require('path');
const fs = require('fs');
const { buildContext, PROJECT_ROOT } = require('./lib/context.cjs');

function parseArgs(argv) {
  const args = { callDelay: 8000 };
  for (let i = 0; i < argv.length; i += 1) {
    const k = argv[i];
    if (k === '--storage' || k === '--ext' || k === '--callDelay') {
      args[k.replace('--', '')] = argv[i + 1];
      i += 1;
    } else if (k === '--fail') {
      args.fail = true;
    }
  }
  return args;
}

const SETUP_MOCK = ({ callDelayMs, fail }) => `
(function(){
  const ready = { connected: true };
  const m = {
    isReady: () => true,
    callTool: async (name, params) => {
      await new Promise(r => setTimeout(r, ${callDelayMs}));
      if (${fail}) throw new Error('Mock tool failed (intentional)');
      return 'mock-result-ok';
    }
  };
  window.mcpClient = m;
  const force = () => {
    window.__mcpAutomationState = { ...(window.__mcpAutomationState||{}), ready: true, autoExecute: true, autoInsert: false, autoSubmit: false };
  };
  force();
  clearInterval(window.__visIv);
  window.__visIv = setInterval(force, 400);
})();
`;

function snap() {
  const rows = [];
  document.querySelectorAll('.function-block').forEach(b => {
    const btn = b.querySelector('.execute-button');
    const spinner = b.querySelector('.execute-spinner');
    const text = btn?.querySelector('span');
    rows.push({
      id: b.getAttribute('data-block-id'),
      cls: b.className,
      complete: b.classList.contains('function-complete'),
      btnVisible: !!btn && getComputedStyle(btn).display !== 'none' && btn.offsetParent !== null,
      btnDisabled: btn ? btn.disabled : null,
      btnText: btn ? (btn.textContent || '').trim().slice(0, 24) : null,
      textDisplay: text ? text.style.display : null,
      hasSpinner: !!spinner,
      resultVisible: b.querySelector('.function-results-panel')?.style.display ?? 'n/a',
    });
  });
  return { url: location.href, rows, hasMcp: !!window.mcpClient };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const storageFile = args.storage || path.join(PROJECT_ROOT, 'e2e', 'fixtures', 'chatgpt-storage.json');
  const prompt = '请模拟一次工具调用，只输出如下 JSON（不要额外文字）：\n' +
    '{"type":"function_call_start","name":"get_weather","call_id":17009}\n' +
    '{"type":"parameter","key":"city","value":"Shanghai"}\n' +
    '{"type":"function_call_end","name":"get_weather","call_id":17009}';

  let context;
  let page;
  try {
    ({ context } = await buildContext({ extPath: args.ext, storageFile }));
    page = context.pages()[0] || (await context.newPage());
    await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.waitForTimeout(16000);
    await page.evaluate(() => document.querySelector('a[data-testid="create-new-chat-button"]')?.click());
    await page.waitForTimeout(3000);

    await page.evaluate(SETUP_MOCK, { callDelayMs: Number(args.callDelay), fail: !!args.fail });

    // 发送
    await page.evaluate((text) => {
      const input = document.querySelector('#prompt-textarea, .ProseMirror[contenteditable="true"], div[contenteditable="true"]');
      if (!input) return false;
      input.focus(); input.innerHTML = '';
      const p = document.createElement('p'); p.textContent = text; input.appendChild(p);
      const r = document.createRange(); r.setStartAfter(p.lastChild || p); r.collapse(true);
      const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    }, prompt);
    await page.evaluate(() => document.querySelector('button[data-testid="send-button"], button[aria-label*="Send"]')?.click());

    await page.waitForFunction(() => {
      const el = document.querySelector('[data-message-author-role="assistant"]');
      return el && el.textContent.trim().length > 0;
    }, { timeout: 60000 }).catch(() => console.warn('wait reply timeout'));

    // 密集采样按钮可见性（累计时间点）
    const samples = [];
    const T = [500, 1000, 2000, 3000, Number(args.callDelay) + 500, Number(args.callDelay) + 1500, Number(args.callDelay) + 2500];
    let prev = 0;
    for (const d of T) {
      await page.waitForTimeout(d - prev);
      prev = d;
      await page.evaluate(`(function(){window.__mcpAutomationState={...window.__mcpAutomationState,ready:true,autoExecute:true};})()`);
      samples.push({ atMs: d, snap: await page.evaluate(snap) });
    }

    const out = { at: new Date().toISOString(), args: { callDelay: args.callDelay, fail: !!args.fail }, url: page.url(), samples };
    const file = path.join(PROJECT_ROOT, 'e2e', 'artifacts', `probe-visible-${Date.now()}.json`);
    fs.writeFileSync(file, JSON.stringify(out, null, 2), 'utf-8');
    console.log(JSON.stringify(out, null, 2));
    console.log('JSON:', file);
  } catch (err) {
    console.error('[probe-visible]', err.message);
    process.exit(1);
  } finally {
    if (context) await context.close().catch(() => {});
  }
}

main();