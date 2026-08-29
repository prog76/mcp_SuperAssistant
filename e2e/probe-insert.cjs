#!/usr/bin/env node
/**
 * AI Studio 插入同步实测：模拟 insertTextToChatInput 的写入方式
 * （原生 value setter + InputEvent('input')），观察 Run 按钮是否从
 * disabled 变为可点击（即 Angular 是否同步表单模型），用于判断
 * 压缩后插入续接消息是否"写进去了但发送失败/被清空"。
 *
 * 用法：
 *   node e2e/probe-insert.cjs [--storage <storage.json>] [--ext <dist>] [--headless]
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

// 与 adapter 的 insertTextToChatInput 完全一致的写入方式
const MARKER = '__MCP_INSERT_SYNC_TEST_7F3A__';

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

    const snap = (label) =>
      page.evaluate((lbl) => {
        const run = document.querySelector('ms-run-button button');
        const input = document.querySelector('textarea.textarea[aria-label="Enter a prompt"]');
        return {
          label: lbl,
          run: run ? { type: run.type, ariaDisabled: run.getAttribute('aria-disabled'), disabled: run.disabled, text: (run.textContent || '').trim().slice(0, 16) } : null,
          inputValue: input ? (input.value || '').slice(-60) : null,
        };
      }, label);

    const before = await snap('before');

    const inserted = await page.evaluate((marker) => {
      const input = document.querySelector('textarea.textarea[aria-label="Enter a prompt"]');
      if (!input) return false;
      const text = `这是一段用于测试 Angular 是否同步插入值的文本，包含标记 ${marker}`;
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      if (setter) setter.call(input, text);
      else input.value = text;
      input.selectionStart = input.selectionEnd = text.length;
      try {
        input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      } catch {
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.focus();
      return true;
    }, MARKER);

    const rightAfter = await snap('rightAfter');
    await page.waitForTimeout(1500);
    const after1500 = await snap('after1500ms');

    const result = { url: page.url(), title: await page.title(), inserted, before, rightAfter, after1500 };
    const artifactsDir = path.join(PROJECT_ROOT, 'e2e', 'artifacts');
    fs.mkdirSync(artifactsDir, { recursive: true });
    const out = path.join(artifactsDir, `probe-insert-${Date.now()}.json`);
    fs.writeFileSync(out, JSON.stringify(result, null, 2), 'utf-8');
    console.log(JSON.stringify(result, null, 2));
    console.log('JSON:', out);
  } catch (err) {
    console.error(`[probe-insert] 失败: ${err.message}`);
    process.exit(1);
  } finally {
    if (context) await context.close().catch(() => {});
  }
}

main();