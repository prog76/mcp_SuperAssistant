#!/usr/bin/env node
/**
 * 深入检查 ChatGPT 上已渲染的 .function-block：类名、按钮、参数、以及
 * JSON 解析所需的原始段落是否完整。
 *
 * 用法：
 *   node e2e/probe-chatgpt-block.cjs --url <会话URL>
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
    if (argv[i] === '--url' || argv[i] === '--storage') {
      args[argv[i].replace('--', '')] = argv[i + 1];
      i += 1;
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const url = args.url;
  if (!url) {
    console.error('缺少 --url');
    process.exit(1);
  }
  const storageFile = args.storage || path.join(PROJECT_ROOT, 'e2e', 'fixtures', 'chatgpt-storage.json');
  let context;
  try {
    ({ context } = await buildContext({ storageFile }));
    const page = context.pages()[0] || (await context.newPage());
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.waitForTimeout(12000);

    const report = await page.evaluate(() => {
      const blocks = [];
      document.querySelectorAll('.function-block').forEach((b) => {
        blocks.push({
          dataBlockId: b.getAttribute('data-block-id'),
          cls: b.className,
          html: b.innerHTML.slice(0, 1500),
          executeButtons: b.querySelectorAll('.execute-button').length,
        });
      });

      // 找到被隐藏的原始段落（display:none 且含 function JSON）
      const hiddenParas = [];
      document.querySelectorAll('p').forEach((p) => {
        const t = (p.textContent || '').trim();
        const hidden = p.style.display === 'none' || p.getAttribute('style')?.includes('display: none');
        if (t.includes('function_call')) {
          hiddenParas.push({ hidden, display: p.style.display, text: t.slice(0, 400) });
        }
      });

      return {
        url: location.href,
        blockCount: document.querySelectorAll('.function-block').length,
        blocks,
        hiddenParas,
        windowState: {
          hasAutomation: !!document.querySelector('meta'),
        },
      };
    });

    const out = path.join(PROJECT_ROOT, 'e2e', 'artifacts', `probe-chatgpt-block-${Date.now()}.json`);
    fs.writeFileSync(out, JSON.stringify(report, null, 2), 'utf-8');
    console.log(JSON.stringify(report, null, 2));
    console.log('JSON:', out);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  } finally {
    if (context) await context.close().catch(() => {});
  }
}

main();