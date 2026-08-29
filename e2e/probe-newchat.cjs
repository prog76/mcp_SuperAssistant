#!/usr/bin/env node
/**
 * AI Studio newConversation 行为探查：造一条对话后，
 * 验证 `button[aria-label="New chat"]` 是否命中，点击后是否能把
 * 会话重置为新会话（TURN_USER -> 0），并探测可能出现的"保存会话"确认弹窗。
 *
 * 用法：
 *   node e2e/probe-newchat.cjs [--storage <storage.json>] [--ext <dist>] [--headless]
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

function sniffJs() {
  const turnCount = document.querySelectorAll('[data-turn-role]').length;
  const turnUserCount = document.querySelectorAll('[data-turn-role="User"]').length;
  const newChatBtn = document.querySelector('button[aria-label="New chat"], ms-better-new-chat-button, [aria-label="New chat"], [aria-label*="new chat" i]');
  // 收集可能带 New/新对话 语义的按钮 aria-label/title
  const candidates = Array.from(document.querySelectorAll('button, [role="button"]'))
    .map((b) => ({ aria: b.getAttribute('aria-label') || '', title: b.getAttribute('title') || '', tooltip: b.getAttribute('data-tooltip') || '', text: (b.textContent || '').trim().slice(0, 20) }))
    .filter((c) => /new.?chat|新对话|新建|开始新/i.test(`${c.aria}|${c.title}|${c.tooltip}|${c.text}`))
    .slice(0, 12);
  // 是否出现模态/弹窗（含保存会话语义）
  const modalTexts = Array.from(document.querySelectorAll('[role="dialog"], .mat-dialog-container, .cdk-overlay-container'))
    .map((d) => (d.textContent || '').trim().slice(0, 120).replace(/\s+/g, ' '))
    .filter(Boolean)
    .slice(0, 6);
  return { turnCount, turnUserCount, newChatBtnFound: !!newChatBtn, candidates, modalTexts };
}

async function insertAndSubmit(page, text) {
  await page.evaluate((t) => {
    const input = document.querySelector('textarea.textarea[aria-label="Enter a prompt"]');
    if (!input) return;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    if (setter) setter.call(input, t);
    else input.value = t;
    input.dispatchEvent(new InputEvent('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.focus();
  }, text);
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    const input = document.querySelector('textarea.textarea[aria-label="Enter a prompt"]');
    if (input) input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true, ctrlKey: true }));
    const run = document.querySelector('ms-run-button button');
    if (run && run.getAttribute('aria-disabled') === 'false') { try { run.click(); } catch {} }
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let context;
  let page;
  try {
    ({ context } = await buildContext({ extPath: args.ext, storageFile: args.storage, headless: args.headless }));
    page = context.pages()[0] || (await context.newPage());
    await page.goto('https://aistudio.google.com/prompts/new_chat', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(12000);

    // 造一条对话，产生 user+model turn
    await insertAndSubmit(page, '你好，这是一次新建会话行为测试。');
    await page.waitForTimeout(20000); // 等 turn 渲染与回复开始

    const before = await page.evaluate(sniffJs);
    console.log('BEFORE(对话中):', JSON.stringify(before, null, 2));

    // 尝试点击 New chat
    const clickInfo = await page.evaluate(() => {
      const btn = document.querySelector('button[aria-label="New chat"], [aria-label="New chat"]');
      if (!btn) return { clicked: false, reason: 'no button' };
      btn.click();
      return { clicked: true, tag: btn.tagName, aria: btn.getAttribute('aria-label'), cls: (btn.className || '').slice(0, 60) };
    });
    console.log('CLICK:', JSON.stringify(clickInfo));

    const marks = [];
    for (const delay of [1000, 2500, 5000]) {
      await page.waitForTimeout(delay - (marks[marks.length - 1]?.t || 0));
      const s = await page.evaluate(sniffJs);
      marks.push({ elapsedMs: delay, turnUser: s.turnUserCount, turnAll: s.turnCount, newChatBtnFound: s.newChatBtnFound, modalTexts: s.modalTexts });
    }
    console.log('AFTER CLICK:', JSON.stringify(marks, null, 2));

    const result = { url: page.url(), clickInfo, before, after: marks };
    const out = path.join(PROJECT_ROOT, 'e2e', 'artifacts', `probe-newchat-${Date.now()}.json`);
    fs.writeFileSync(out, JSON.stringify(result, null, 2), 'utf-8');
    console.log('JSON:', out);
  } catch (err) {
    console.error(`[probe-newchat] 失败: ${err.message}`);
    process.exit(1);
  } finally {
    if (context) await context.close().catch(() => {});
  }
}

main();