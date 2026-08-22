#!/usr/bin/env node
/**
 * ChatGPT 工具调用渲染观测：
 * 打开新会话，输入一段指令让模型输出 SuperAssistant 函数调用 JSON，发送后
 * 抓取助手消息 DOM（pre/code 结构）与渲染结果，判断 Run 按钮为何未出现。
 *
 * 用法：
 *   node e2e/probe-chatgpt-tool.cjs [--storage <storage>] [--ext <dist>] [--prompt <文本>]
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
  const keys = new Set(['--storage', '--ext', '--prompt']);
  for (let i = 0; i < argv.length; i += 1) {
    if (keys.has(argv[i])) {
      args[argv[i].replace('--', '')] = argv[i + 1];
      i += 1;
    }
  }
  return args;
}

function dumpFunctionRelated() {
  const out = {
    url: location.href,
    functionBlocks: document.querySelectorAll('.function-block').length,
    executeButtons: document.querySelectorAll('.execute-button').length,
    preCount: document.querySelectorAll('pre').length,
    codeCount: document.querySelectorAll('code').length,
    candidates: [],
    preSamples: [],
    assistantBlocks: [],
  };

  // 抓所有助手消息的文本与是否含 JSON
  document.querySelectorAll('[data-message-author-role="assistant"]').forEach((el, i) => {
    const t = (el.innerText || el.textContent || '').trim();
    out.assistantBlocks.push({
      index: i,
      textLen: t.length,
      textPreview: t.slice(0, 500),
      hasFunctionCall: t.includes('function_call'),
    });
    // 打印外层HTML中的pre标记情况
  });

  // 抓取含 function 文本的任何元素
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
  let node = walker.nextNode();
  let checked = 0;
  while (node && checked < 3000) {
    checked += 1;
    const t = (node.textContent || '').trim();
    if (t.includes('function_call')) {
      const els = node.querySelectorAll && node.querySelectorAll('pre, code, div, span');
      out.candidates.push({
        tag: node.tagName.toLowerCase(),
        cls: node.className || '',
        len: t.length,
        hasPre: els ? els.length : null,
        preview: t.slice(0, 300),
      });
    }
    node = walker.nextNode();
  }

  // 采样所有 pre 结构
  document.querySelectorAll('pre').forEach((el, i) => {
    if (i >= 6) return;
    const t = (el.textContent || '').trim();
    let parentChain = [];
    let p = el.parentElement;
    for (let d = 0; d < 5 && p; d += 1) {
      parentChain.push(`${p.tagName.toLowerCase()}${p.className ? '.' + String(p.className).slice(0, 30) : ''}`);
      p = p.parentElement;
    }
    out.preSamples.push({ cls: el.className || '', textLen: t.length, textPreview: t.slice(0, 120), parents: parentChain });
  });

  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const storageFile = args.storage || path.join(PROJECT_ROOT, 'e2e', 'fixtures', 'chatgpt-storage.json');
  const prompt = args.prompt ||
    '请模拟一次工具调用，只输出如下 JSON（不要额外文字），文件格式须为 function_call 事件序列：\n' +
    '{"type":"function_call_start","name":"get_weather","call_id":17001}\n' +
    '{"type":"parameter","key":"city","value":"Shanghai"}\n' +
    '{"type":"function_call_end","name":"get_weather","call_id":17001}';

  let context;
  let page;
  try {
    ({ context } = await buildContext({ extPath: args.ext, storageFile }));
    page = context.pages()[0] || (await context.newPage());

    await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.waitForTimeout(16000);
    if (!(await page.locator('#prompt-textarea, [contenteditable="true"]').count())) {
      console.log('[!] 未登录/无输入框');
      process.exit(1);
    }

    // 输入并发送
    await page.evaluate((text) => {
      const input = document.querySelector('#prompt-textarea, .ProseMirror[contenteditable="true"], div[contenteditable="true"]');
      if (!input) return false;
      input.focus();
      // 清空
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

    // 点击发送按钮
    const sendClicked = await page.evaluate(() => {
      const btn = document.querySelector('button[data-testid="send-button"], button[data-testid="fruitjuice-send-button"], button[aria-label*="Send"]');
      if (btn) { btn.click(); return true; }
      return false;
    });
    console.log('sendClicked:', sendClicked);

    // 等待回复（最多 60s，轮询助手消息出现）
    await page.waitForFunction(() => {
      const el = document.querySelector('[data-message-author-role="assistant"]');
      return el && el.textContent.trim().length > 0;
    }, { timeout: 60000 }).catch(() => console.warn('等待回复超时'));

    await page.waitForTimeout(6000);

    // 抓取当前消息区的完整结构（含所有 pre）
    const dom = await page.evaluate(dumpFunctionRelated);

    const result = {
      at: new Date().toISOString(),
      url: page.url(),
      title: await page.title(),
      sendClicked,
      dom,
    };
    const artifactsDir = path.join(PROJECT_ROOT, 'e2e', 'artifacts');
    fs.mkdirSync(artifactsDir, { recursive: true });
    const out = path.join(artifactsDir, `probe-chatgpt-tool-${Date.now()}.json`);
    fs.writeFileSync(out, JSON.stringify(result, null, 2), 'utf-8');
    console.log(JSON.stringify(result, null, 2));
    console.log('JSON:', out);
  } catch (err) {
    console.error(`[probe-chatgpt-tool] 失败: ${err.message}`);
    process.exit(1);
  } finally {
    if (context) await context.close().catch(() => {});
  }
}

main();