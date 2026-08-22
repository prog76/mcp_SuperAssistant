#!/usr/bin/env node
/**
 * 抓取 ChatGPT 助手消息里 markdown / pre(code) / CodeMirror(cm-scroller)
 * 三种容器各自的原文，确认同一函数 JSON 是否被重复渲染到多个副本中。
 *
 *   node e2e/probe-chatgpt-dup.cjs --url <会话URL>
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
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--url' || argv[i] === '--storage') args[argv[i].replace('--', '')] = argv[i + 1];
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.url) { console.error('缺少 --url'); process.exit(1); }
  const storageFile = args.storage || path.join(PROJECT_ROOT, 'e2e', 'fixtures', 'chatgpt-storage.json');
  let context;
  try {
    ({ context } = await buildContext({ storageFile }));
    const page = context.pages()[0] || (await context.newPage());
    await page.goto(args.url, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.waitForTimeout(12000);

    const report = await page.evaluate(() => {
      const out = { containers: [], functionBlocks: [] };

      // 遍历所有有可能承载函数 JSON 的叶子/容器，记录它们的类与文本
      const selectors = ['pre', 'code[class*="language"]', '.cm-scroller', '.markdown > p', 'div[data-message-author-role="assistant"]'];
      const seen = new Set();
      document.querySelectorAll('[data-message-author-role="assistant"]').forEach((m, mi) => {
        // 该消息内所有文本包含 function_call 的元素（取最内层）
        const all = m.querySelectorAll('*');
        for (const el of all) {
          const t = (el.textContent || '').trim();
          if (!t.includes('function_call')) continue;
          // 只记录叶子（没有子元素再含 function_call 的）
          let hasChild = false;
          for (const c of el.children) {
            if ((c.textContent || '').includes('function_call')) { hasChild = true; break; }
          }
          if (hasChild) continue;
          const chain = [];
          let p = el;
          for (let d = 0; d < 6 && p; d += 1) {
            chain.push(p.tagName.toLowerCase() + (p.className ? '.' + String(p.className).slice(0, 30) : ''));
            p = p.parentElement;
          }
          const key = chain.join(' > ');
          if (seen.has(key)) continue;
          seen.add(key);
          const isBlock = !!el.closest('.function-block');
          out.containers.push({ msgIdx: mi, isInsideBlock: isBlock, chain, tag: el.tagName.toLowerCase(), textPreview: t.slice(0, 200), textLen: t.length });
        }
      });

      // 现有 function-block 简要
      document.querySelectorAll('.function-block[data-block-id^="block-"]').forEach(b => {
        out.functionBlocks.push({
          id: b.getAttribute('data-block-id'),
          name: b.querySelector('.function-name-text')?.textContent || '',
          callId: b.querySelector('.call-id')?.textContent || '',
          parent1: b.parentElement?.className?.slice(0, 40) || '',
          visible: b.offsetParent !== null,
        });
      });

      return out;
    });

    const out = path.join(PROJECT_ROOT, 'e2e', 'artifacts', `probe-dup-${Date.now()}.json`);
    fs.writeFileSync(out, JSON.stringify(report, null, 2), 'utf-8');
    console.log(JSON.stringify(report, null, 2));
    console.log('JSON:', out);
  } catch (err) {
    console.error(err.message); process.exit(1);
  } finally {
    if (context) await context.close().catch(() => {});
  }
}
main();