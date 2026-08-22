#!/usr/bin/env node
/**
 * 抓取脚本：加载扩展+登录态后导航目标站点，dump 关键 DOM（扩展注入节点、
 * shadow DOM、输入框状态），并保存截图，供 AI/agent 分析。
 *
 * 用法：
 *   node e2e/capture.cjs --url https://chat.deepseek.com
 *                        [--ext <dist路径>] [--storage <storageState.json>]
 *                        [--wait <ms注入等待=5000>] [--out <artifacts目录>]
 *                        [--headless]
 *
 * @author huquanzhi
 * @since 2026-08-22
 * @version 1.0
 */
const fs = require('fs');
const path = require('path');
const { buildContext, PROJECT_ROOT } = require('./lib/context.cjs');

const DEFAULT_ARTIFACTS = path.join(PROJECT_ROOT, 'e2e', 'artifacts');

function parseArgs(argv) {
  const args = {};
  const keys = new Set(['--url', '--ext', '--storage', '--wait', '--out']);
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

/** 在页面内探查扩展注入情况（运行于 content script 层） */
function inspectPage() {
  const result = { inputs: [], shadowHosts: [], mcpMentions: [], dataMarked: [] };

  // 输入框状态
  document.querySelectorAll('textarea').forEach((el, i) => {
    if (i < 5) result.inputs.push({ tag: 'textarea', cls: el.className || '', editable: !el.disabled });
  });
  document.querySelectorAll('[contenteditable="true"]').forEach((el, i) => {
    if (i < 5) result.inputs.push({ tag: el.tagName.toLowerCase(), cls: el.className || '', editable: true });
  });

  // shadow DOM hosts
  const all = document.querySelectorAll('*');
  all.forEach((el) => {
    if (el.shadowRoot) {
      result.shadowHosts.push({ tag: el.tagName.toLowerCase(), cls: el.className || '', id: el.id || '' });
    }
  });

  // 含 MCP/mcp 文本的叶子元素
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  const seen = new Set();
  while (node) {
    const t = (node.textContent || '').trim();
    if (t && /mcp/i.test(t) && !seen.has(t)) {
      seen.add(t);
      if (t.length < 120) result.mcpMentions.push(t.slice(0, 120));
    }
    node = walker.nextNode();
  }

  // 扩展标识的属性标记（常见约定，如 data-* / aria-label 含 MCP）
  all.forEach((el) => {
    if (!el.dataset) return;
    if (Object.keys(el.dataset).some((k) => /mcp/i.test(k))) {
      result.dataMarked.push({ tag: el.tagName.toLowerCase(), id: el.id || '', data: { ...el.dataset } });
    }
  });

  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.url) {
    console.error('缺少 --url 参数，指定目标站点 URL');
    process.exit(1);
  }

  const waitMs = Number(args.wait || 5000);
  const outDir = path.resolve(args.out || DEFAULT_ARTIFACTS);
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const host = new URL(args.url).hostname;

  let context;
  let page;
  try {
    ({ context } = await buildContext({
      extPath: args.ext,
      storageFile: args.storage,
      headless: args.headless,
    }));
    page = context.pages()[0] || (await context.newPage());
    await page.goto(args.url, { waitUntil: 'domcontentloaded', timeout: 60000 });

    // 等待扩展注入完成
    await page.waitForTimeout(waitMs);
    await page.waitForLoadState('networkidle').catch(() => {});

    const url = page.url();
    const title = await page.title();

    // 整页截图
    const screenshotPath = path.join(outDir, `${host}-${stamp}-full.png`);
    await page.screenshot({ path: screenshotPath, fullPage: true });

    const dom = await page.evaluate(inspectPage);

    const result = { at: new Date().toISOString(), url, title, screenshot: screenshotPath, dom };
    const jsonPath = path.join(outDir, `${host}-${stamp}.json`);
    fs.writeFileSync(jsonPath, JSON.stringify(result, null, 2), 'utf-8');

    console.log(`URL:      ${url}`);
    console.log(`Title:    ${title}`);
    console.log(`输入框:   ${dom.inputs.length} 个`);
    console.log(`Shadow:   ${dom.shadowHosts.length} 个 host`);
    console.log(`MCP 文本: ${dom.mcpMentions.length} 处`);
    console.log(`data 标记:${dom.dataMarked.length} 个`);
    console.log(`JSON: ${jsonPath}`);
    console.log(`截图: ${screenshotPath}`);
  } catch (err) {
    console.error(`[capture] 抓取失败: ${err.message}`);
    if (context) await context.close().catch(() => {});
    process.exit(1);
  } finally {
    if (page && !page.isClosed()) await context.close().catch(() => {});
  }
}

main();