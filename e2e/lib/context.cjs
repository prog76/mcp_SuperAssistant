/**
 * 共享环境构建：为 launch 与 capture 复用同一套"加载扩展 + 注入登录态"逻辑。
 *
 * @author huquanzhi
 * @since 2026-08-22
 * @version 1.0
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('@playwright/test');

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const DEFAULT_EXT_PATH = path.join(PROJECT_ROOT, 'dist');
const DEFAULT_USER_DATA = path.join(PROJECT_ROOT, 'e2e', '.user-data');
const DEFAULT_STATE = path.join(PROJECT_ROOT, 'e2e', 'fixtures', 'storageState.json');

/** 读取 storageState（cookies 数组）用于注入 */
function loadCookies(statePath) {
  if (!statePath || !fs.existsSync(statePath)) {
    return { cookies: [], statePath: null };
  }
  const parsed = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
  return { cookies: parsed.cookies || [], statePath };
}

/**
 * 构建一个加载了本项目扩展的 persistent context。
 * @param {object} opts
 * @param {boolean} [opts.headless=false]  MV3 扩展需 headful，默认 false
 * @returns {Promise<{context: import('@playwright/test').BrowserContext, extPath: string, statePath: string|null}>}
 */
async function buildContext(opts = {}) {
  const extPath = opts.extPath || DEFAULT_EXT_PATH;
  if (!fs.existsSync(path.join(extPath, 'manifest.json'))) {
    throw new Error(`扩展目录缺少 manifest.json，请先构建：pnpm build 或 pnpm base-build（当前: ${extPath}）`);
  }

  const userData = path.resolve(opts.userDataDir || DEFAULT_USER_DATA);
  fs.mkdirSync(userData, { recursive: true });

  const screenSize = '1920,1080';
  const context = await chromium.launchPersistentContext(userData, {
    headless: opts.headless === true,
    viewport: { width: 1920, height: 1080 },
    args: [
      `--disable-extensions-except=${extPath}`,
      `--load-extension=${extPath}`,
      `--window-size=${screenSize}`,
    ],
    // 注入前的稳定启动参数
    ignoreDefaultArgs: ['--disable-extensions'],
  });

  // 注入登录态 cookies（在导航前）
  const { cookies, statePath } = loadCookies(opts.storageFile);
  if (cookies.length > 0) {
    await context.addCookies(cookies);
    console.log(`已注入 ${cookies.length} 条 cookie（来源: ${statePath}）`);
  } else if (statePath) {
    console.warn('提示: 登录态文件存在但 cookies 为空，已回退匿名会话');
  } else if (opts.storageFile !== undefined) {
    console.warn(`提示: 未找到登录态文件 ${opts.storageFile}，已回退匿名会话`);
  } else {
    console.warn('提示: 未提供登录态文件，使用匿名会话（仍会加载扩展）');
  }

  return { context, extPath, statePath };
}

module.exports = {
  buildContext,
  PROJECT_ROOT,
  DEFAULT_EXT_PATH,
  DEFAULT_USER_DATA,
  DEFAULT_STATE,
  loadCookies,
};