#!/usr/bin/env node
/**
 * 针对 ChatgGPT 代码块选择器命中情况实测：
 * 对一组候选 selector，分别统计命中的元素及其可见性/父链，
 * 确定哪个 selector 只命中真实可见的 markdown 代码块、不命中 CodeMirror 副本。
 *
 *   node e2e/probe-chatgpt-sel.cjs --url <会话URL>
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

// 注意：这些选择器在真实结构里命中后，需要能关联到含 function JSON 的元素
const CANDIDATES = [
  '.markdown > pre.overflow-visible',
  '.markdown > div > pre.overflow-visible',
  '.markdown pre.overflow-visible',
  '.markdown p',
  '.markdown > p',
];

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

    const report = await page.evaluate((cands) => {
      // 先找所有含 function_call 的“叶子”元素，后续判断命中
      const leafTargets = [];
      const root = document.querySelector('main') || document.body;
      const all = root.querySelectorAll('*');
      for (const el of all) {
        const t = (el.textContent || '').trim();
        if (!t.includes('function_call')) continue;
        let hasChild = false;
        for (const c of el.children) {
          if ((c.textContent || '').includes('function_call')) { hasChild = true; break; }
        }
        if (hasChild) continue;
        leafTargets.push(el);
      }

      const results = {};
      for (const sel of cands) {
        const hit = document.querySelectorAll(sel);
        const fnHits = [];
        for (const h of hit) {
          const t = h.textContent.trim();
          if (!t.includes('function_call')) continue;
          const visible = h.offsetParent !== null;
          let parentChain = [];
          let p = h.parentElement;
          for (let d = 0; d < 5 && p; d += 1) {
            parentChain.push(p.tagName.toLowerCase() + (p.className ? '.' + String(p.className).slice(0, 24) : ''));
            p = p.parentElement;
          }
          fnHits.push({ tag: h.tagName.toLowerCase(), cls: String(h.className).slice(0, 40), visible, parent1: h.parentElement?.className?.slice(0, 40) || '', parents: parentChain, textLen: t.length });
        }
        results[sel] = { total: hit.length, functionContaining: fnHits.length, fnHits: fnHits.slice(0, 6) };
      }
      return { leafCount: leafTargets.length, results };
    }, CANDIDATES);

    const out = path.join(PROJECT_ROOT, 'e2e', 'artifacts', `probe-sel-${Date.now()}.json`);
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