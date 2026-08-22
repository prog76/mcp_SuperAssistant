#!/usr/bin/env node
/**
 * 检查 ChatGPT 助手消息里函数调用到底渲染成几个 <p>，
 * 用于判断重复块是否源于"一个调用被拆成多个段落 + target 匹配每个 p"。
 *
 *   node e2e/probe-chatgpt-ps.cjs --url <会话URL>
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
      const out = { assistantPs: [], hiddenPs: [], source: [], blocksPerCallId: {} };

      // 所有 <p>，含被 display:none 隐藏的（原始函数 JSON 应在其内）
      document.querySelectorAll('p').forEach((p, i) => {
        if (i > 400) return;
        const t = (p.textContent || '').trim();
        if (!t) return;
        if (t.includes('function_call') || t.includes('@"type"')) {
          out.source.push({
            paraIdx: i,
            display: p.style.display,
            hasFunctionCall: t.includes('function_call'),
            preview: t.slice(0, 260),
            parents6: (() => { const a=[]; let el=p; for(let d=0;d<6&&el;d++){a.push(el.tagName.toLowerCase()+(el.className?'.'+String(el.className).slice(0,18):'')); el=el.parentElement;} return a; })(),
          });
          out.hiddenPs.push({ paraIdx: i, display: p.style.display, text: t });
        }
      });

      // 现有 function-block 分组
      document.querySelectorAll('.function-block[data-block-id^="block-"]').forEach(b => {
        const callId = b.querySelector('.call-id')?.textContent || '?';
        const name = b.querySelector('.function-name-text')?.textContent || '';
        (out.blocksPerCallId[`${name}#${callId}`] = out.blocksPerCallId[`${name}#${callId}`] || []).push({
          id: b.getAttribute('data-block-id'),
          parentCls: b.parentElement?.className?.slice(0, 60) || '',
          parents5: (() => { const a=[]; let el=b; for(let d=0;d<5&&el;d++){a.push(el.tagName.toLowerCase()+(el.className?'.'+String(el.className).slice(0,18):'')); el=el.parentElement;} return a; })(),
        });
      });

      return out;
    });

    const out = path.join(PROJECT_ROOT, 'e2e', 'artifacts', `probe-ps-${Date.now()}.json`);
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