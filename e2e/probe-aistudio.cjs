#!/usr/bin/env node
/**
 * AI Studio DOM 探查：在真实页面执行 aistudio.adapter.ts 用到的各 selector，
 * 验证新建会话页输入框 / New chat 按钮 / Run / turn 结构是否仍能命中，
 * 用于定位"压缩后新建会话插入失败"是否因 selector 失配。
 *
 * 用法：
 *   node e2e/probe-aistudio.cjs [--storage <storage.json>] [--ext <dist>] [--headless]
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

const PROBE_JS = () => {
  const count = (sel) => {
    try {
      return document.querySelectorAll(sel).length;
    } catch {
      return -1; // selector 语法错误
    }
  };

  // 与 aistudio.adapter.ts 的 findChatInputElement 候选一致
  const chatInputCandidates = [
    'textarea.textarea[placeholder="Start typing a prompt"]',
    'textarea.textarea[aria-label="Enter a prompt"]',
    '.prompt-box-container textarea.textarea',
    'textarea.textarea[placeholder="Type something"]',
    'textarea.textarea[aria-label="Type something or pick one from prompt gallery"]',
    'textarea[placeholder="Ask follow-up"]',
    "textarea.textarea[aria-label='Type something or tab to choose an example prompt']",
  ];

  const textareas = Array.from(document.querySelectorAll('textarea')).map((el) => ({
    cls: (el.className || '').slice(0, 80),
    placeholder: el.placeholder || '',
    ariaLabel: el.getAttribute('aria-label') || '',
  }));

  const newChatBtn = document.querySelector('button[aria-label="New chat"]');
  const newChatAlt = document.querySelector('button.new-chat, button[jslog*="New chat"], [aria-label*="New chat"], [tooltip="New chat"]');

  const runBtn = document.querySelector('ms-run-button button');
  const turnCount = count('[data-turn-role]');
  const turnUserCount = count('[data-turn-role="User"]');

  const sidebarHost = document.getElementById('mcp-sidebar-shadow-host');
  const sidebar = sidebarHost && sidebarHost.shadowRoot
    ? { tag: sidebarHost.tagName, id: sidebarHost.id, shadowChildren: sidebarHost.shadowRoot.childElementCount }
    : null;

  return {
    chatInputCandidates: chatInputCandidates.map((sel) => ({ sel, count: count(sel) })),
    textareas,
    newChat: { byAria: !!newChatBtn, byFallback: !!newChatAlt },
    runButton: runBtn ? { exists: true, type: runBtn.type, text: (runBtn.textContent || '').trim().slice(0, 20), ariaDisabled: runBtn.getAttribute('aria-disabled') } : { exists: false },
    turns: { any: turnCount, user: turnUserCount },
    sidebar,
  };
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let context;
  let page;
  try {
    ({ context } = await buildContext({
      extPath: args.ext,
      storageFile: args.storage,
      headless: args.headless,
    }));
    page = context.pages()[0] || (await context.newPage());
    const url = 'https://aistudio.google.com/prompts/new_chat';
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(15000);
    await page.waitForLoadState('networkidle').catch(() => {});

    const result = await page.evaluate(PROBE_JS);
    result.url = page.url();
    result.title = await page.title();

    fs.mkdirSync(path.join(e2eRoot(), 'artifacts'), { recursive: true });
    const out = path.join(e2eRoot(), 'artifacts', `probe-aistudio-${Date.now()}.json`);
    fs.writeFileSync(out, JSON.stringify(result, null, 2), 'utf-8');
    console.log(JSON.stringify(result, null, 2));
    console.log('JSON:', out);
  } catch (err) {
    console.error(`[probe] 失败: ${err.message}`);
    process.exit(1);
  } finally {
    if (context) await context.close().catch(() => {});
  }
}

function e2eRoot() {
  return path.join(PROJECT_ROOT, 'e2e');
}

main();