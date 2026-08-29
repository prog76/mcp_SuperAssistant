#!/usr/bin/env node
/**
 * 启动脚本：拉起真实 Chromium，加载本项目扩展，并可选注入登录态。
 * 浏览器会保持打开，供用户或 agent 手动继续操作/读取 DOM。
 *
 * 用法：
 *   node e2e/launch.cjs [--url https://chat.deepseek.com]
 *                       [--ext <dist路径>] [--user-data <目录>]
 *                       [--storage <storageState.json>] [--headless]
 *
 * @author huquanzhi
 * @since 2026-08-22
 * @version 1.0
 */
const { buildContext, PROJECT_ROOT } = require('./lib/context.cjs');

function parseArgs(argv) {
  const args = {};
  const keys = new Set(['--url', '--ext', '--user-data', '--storage']);
  for (let i = 0; i < argv.length; i += 1) {
    if (keys.has(argv[i])) {
      args[argv[i].replace('--', '')] = argv[i + 1];
      i += 1;
    } else if (argv[i] === '--headless') {
      args.headless = true;
    } else if (argv[i] === '--help') {
      args.help = true;
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('用法见脚本头部注释。');
    return;
  }

  let context;
  try {
    ({ context } = await buildContext({
      extPath: args.ext,
      userDataDir: args['user-data'],
      storageFile: args.storage,
      headless: args.headless,
    }));

    const url = args.url || 'https://chat.deepseek.com';
    const page = context.pages()[0] || (await context.newPage());
    page.on('console', (msg) => {
      if (msg.type() === 'error') console.log(`[page:error] ${msg.text()}`);
    });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    console.log(`已打开 ${url}（title: ${await page.title()}）`);
  } catch (err) {
    console.error(`[launch] 启动失败: ${err.message}`);
    if (context) await context.close().catch(() => {});
    process.exit(1);
  }

  console.log('='.repeat(60));
  console.log('浏览器已就绪（扩展已加载）。可继续手动操作；退出请按 Ctrl+C。');
  console.log('项目根目录:', PROJECT_ROOT);
  // keep alive，直到用户中断
  await new Promise(() => {});
}

main();