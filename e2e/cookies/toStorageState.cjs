#!/usr/bin/env node
/**
 * Cookie 登录态适配器：把各种 cookie JSON（当前为 Chrome 导出格式）转成
 * Playwright storageState，便于注入目标站点保持登录态。
 *
 * 字段映射约定：
 *  - domain/name/path/value/secure/httpOnly -> 直接映射
 *  - expirationDate(秒) -> expires；session:true 或缺失时不设置 expires
 *  - sameSite: strict|lax|no_restriction -> Strict|Lax|None；null/非法留空
 *  - 忽略 hostOnly/session/storeId 等无关字段
 *
 * 用法：
 *   node e2e/cookies/toStorageState.cjs --input <cookies.json> [--domain chat.deepseek.com] [--output storage.json]
 *
 * @author huquanzhi
 * @since 2026-08-22
 * @version 1.0
 */
const fs = require('fs');
const path = require('path');

/** sameSite 归一化：Chrome 值 -> Playwright Cookie 枚举 */
function toSameSite(value) {
  if (value === 'strict') return 'Strict';
  if (value === 'lax') return 'Lax';
  if (value === 'no_restriction') return 'None';
  return undefined; // null / 非法 -> 浏览器默认
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === '--input' || key === '--domain' || key === '--output') {
      args[key.replace('--', '')] = argv[i + 1];
      i += 1;
    } else if (key === '--help' || key === '-h') {
      args.help = true;
    }
  }
  return args;
}

/**
 * 将单条 Chrome cookie 记录转为 Playwright storageState cookie。
 * 缺必需字段时抛错并列出字段名。
 */
function convertCookie(raw, { domainFilter } = {}) {
  const name = raw.name;
  const value = raw.value;
  const domain = raw.url
    ? new URL(raw.url).hostname
    : raw.domain;

  if (name === undefined || value === undefined || domain === undefined) {
    const missing = [];
    if (name === undefined) missing.push('name');
    if (value === undefined) missing.push('value');
    if (domain === undefined) missing.push('domain/url');
    throw new Error(`cookie 缺少必需字段: [${missing.join(', ')}]`);
  }

  if (domainFilter && !domain.endsWith(domainFilter)) {
    return null; // 不属于目标域，过滤掉
  }

  const cookie = {
    name,
    value,
    domain,
    path: raw.path || '/',
  };

  if (raw.expirationDate && !raw.session) {
    cookie.expires = Math.round(raw.expirationDate);
  }
  if (raw.httpOnly === true) cookie.httpOnly = true;
  if (raw.secure === true) cookie.secure = true;
  const sameSite = toSameSite(raw.sameSite);
  if (sameSite) cookie.sameSite = sameSite;

  return cookie;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('用法: node e2e/cookies/toStorageState.cjs --input <cookies.json> '
      + '[--domain chat.deepseek.com] [--output storage.json]');
    return;
  }
  if (!args.input) {
    console.error('缺少 --input 参数，指定 cookie JSON 输入文件');
    process.exit(1);
  }

  const inputPath = path.resolve(process.cwd(), args.input);
  const rawList = JSON.parse(fs.readFileSync(inputPath, 'utf-8'));
  if (!Array.isArray(rawList)) {
    console.error('输入文件需为 cookie 数组 JSON');
    process.exit(1);
  }

  const converted = [];
  const errors = [];
  rawList.forEach((raw, idx) => {
    try {
      const cookie = convertCookie(raw, { domainFilter: args.domain });
      if (cookie) converted.push(cookie);
    } catch (err) {
      errors.push(`[#${idx}] ${err.message}`);
    }
  });

  if (errors.length > 0) {
    console.error('以下 cookie 转换失败（未写入输出，请检查后重试）：');
    errors.forEach((e) => console.error(`  - ${e}`));
    process.exit(1);
  }

  const storageState = { cookies: converted, origins: [] };
  const output = args.output
    ? path.resolve(process.cwd(), args.output)
    : path.join(path.dirname(inputPath), 'storageState.json');
  fs.writeFileSync(output, JSON.stringify(storageState, null, 2), 'utf-8');
  console.log(`已转换 ${converted.length} 条 cookie -> ${output}`);
}

main();