#!/usr/bin/env node
/**
 * ChatGPT 工具调用渲染探查：
 * 使用持久化 profile（.user-data，含真实登录 cookie）+ 扩展产物，打开 chatgpt.com，
 * 检查页面中是否有 function_call / <invoke> 的 pre/code 块，以及是否已渲染 function-block / Run 按钮。
 *
 * 用法：
 *   node e2e/probe-chatgpt.cjs [--url https://chatgpt.com/c/xxx]
 *                              [--ext <dist路径>] [--wait <ms>]
 *
 * @author huquanzhi
 * @since 2026-08-22
 * @version 1.0
 */
const path = require('path');
const { buildContext, PROJECT_ROOT } = require('./lib/context.cjs');

const DEFAULT_EXT = path.join(PROJECT_ROOT, 'dist');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--url' || argv[i] === '--ext') {
      args[argv[i].replace('--', '')] = argv[++i];
    }
  }
  return args;
}

/** 在 content script 层检查渲染结果与潜在工具调用内容 */
function inspectTools() {
  const out = {
    url: location.href,
    loggedIn: !!document.querySelector('#prompt-textarea, [contenteditable="true"]'),
    functionBlocks: document.querySelectorAll('.function-block').length,
    executeButtons: document.querySelectorAll('.execute-button').length,
    rawToggles: document.querySelectorAll('.raw-toggle').length,
    candidates: [],
  };

  // 找出可能包含工具调用的 pre/code 元素
  document.querySelectorAll('pre, code').forEach((el, i) => {
    if (i > 200) return;
    const t = (el.textContent || '').trim();
    if (!t) return;
    const isFunc =
      t.includes('function_call') ||
      t.includes('<invoke') ||
      t.includes('<function_calls>') ||
      (/:\s*"type"\s*:\s*"function_call"/.test(t));
    if (isFunc) {
      out.candidates.push({
        tag: el.tagName.toLowerCase(),
        cls: el.className || '',
        parentCls: el.parentElement?.className || '',
        len: t.length,
        preview: t.slice(0, 200),
      });
    }
  });

  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const url = args.url || 'https://chatgpt.com';
  const extPath = args.ext || DEFAULT_EXT;

  let context;
  try {
    const storageFile = path.join(PROJECT_ROOT, 'e2e', 'fixtures', 'chatgpt-storage.json');
    ({ context } = await buildContext({ extPath, storageFile }));
    const page = context.pages()[0] || (await context.newPage());

    console.log(`导航到: ${url}`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.waitForTimeout(Number.isNaN(Number(args.wait)) ? 15000 : Number(args.wait));

    const url2 = page.url();
    const title = await page.title();

    // 先确认当前是否登录/可交互
    const cre = await page.evaluate(() => ({
      url: location.href,
      hasPrompt: !!document.querySelector('#prompt-textarea, [contenteditable="true"]'),
      bodyTextLen: (document.body.innerText || '').length,
    }));
    console.log('== 页面状态 ==');
    console.log(JSON.stringify(cre, null, 2));
    console.log('title:', title);

    // 若未登录则停止
    if (!cre.hasPrompt) {
      console.log('[!] 未检测到输入框，可能未登录 chatgpt.com。以下探查仅为 DOM 层面。');
    }

    // 抓取工具调用候选与渲染结果
    const dom = await page.evaluate(inspectTools);
    console.log('== 渲染结果 ==');
    console.log(JSON.stringify(dom, null, 2));

    await page.screenshot({ path: path.join(PROJECT_ROOT, 'e2e', 'artifacts', 'chatgpt-probe.png'), fullPage: false });
  } catch (err) {
    console.error('[probe-chatgpt] 失败:', err);
    process.exit(1);
  } finally {
    if (context) await context.close().catch(() => {});
  }
}

main();