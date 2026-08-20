/**
 * Token 估算纯函数（零依赖，可在 content script / background 内直接运行）。
 *
 * 网页端拿不到服务端精确 token 数，本模块提供「分段加权」字符级估算，
 * 用于展示给用户与存档元数据；v2 自动触发基于估算值并叠加保守安全边际。
 *
 * 密度假设（方向为「宁高勿低」，避免估算偏低导致自动触发偏晚）：
 * - 英文/数字/符号：~4 字符/token（Claude 官方惯例）
 * - CJK：~1 字符/token（主流 BPE tokenizer 对常用中文约 1 token/字）
 * - 代码块：~3 字符/token（代码符号多、空格多，密度介于中英文之间）
 * - 整体叠加 ESTIMATE_SAFETY_FACTOR = 1.2，吸收英文密度、生僻字等剩余误差
 */

// 估算安全系数：token 估算偏低会导致 v2 自动触发偏晚（不安全），
// 叠加 1.2 系数吸收英文密度、生僻字等剩余误差。
const ESTIMATE_SAFETY_FACTOR = 1.2;

export interface TokenEstimate {
  chars: number;
  asciiChars: number;
  cjkChars: number;
  codeBlockChars: number;
  estimatedTokens: number;
}

/**
 * 估算一段文本的 token 数。
 * @param text 待估算文本
 */
export function estimateTokens(text: string): TokenEstimate {
  let asciiChars = 0;
  let cjkChars = 0;
  let codeBlockChars = 0;

  // 1. 先剥离代码块，单独统计（代码 token 密度通常高于自然语言）
  const codeBlockRegex = /```[\s\S]*?```/g;
  const codeBlocks = text.match(codeBlockRegex) ?? [];
  for (const block of codeBlocks) {
    codeBlockChars += block.length;
  }
  const noCode = text.replace(codeBlockRegex, '');

  // 2. 按字符类别统计（用 code point 遍历，正确处理 emoji/生僻字）
  for (const ch of noCode) {
    const cp = ch.codePointAt(0)!;
    if (isCjk(cp)) cjkChars++;
    else asciiChars++;
  }

  // 3. 估算（见文件头注释的密度假设）
  const asciiTokens = asciiChars / 4;
  const cjkTokens = cjkChars / 1;
  const codeTokens = codeBlockChars / 3;

  const estimatedTokens = Math.ceil((asciiTokens + cjkTokens + codeTokens) * ESTIMATE_SAFETY_FACTOR);

  return {
    chars: text.length,
    asciiChars,
    cjkChars,
    codeBlockChars,
    estimatedTokens,
  };
}

/**
 * 按 token 预算截断文本（用于摘要校验的降级路径：截断原文前 N token）。
 * 简单实现：按估算占比线性累加字符数。
 * @param text 待截断文本
 * @param targetTokens 目标 token 预算
 */
export function truncateByTokens(text: string, targetTokens: number): string {
  const est = estimateTokens(text);
  if (est.estimatedTokens <= targetTokens) return text;
  const ratio = targetTokens / est.estimatedTokens;
  const targetChars = Math.floor(text.length * ratio);
  return text.slice(0, targetChars);
}

function isCjk(cp: number): boolean {
  return (
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK 统一表意文字
    (cp >= 0x3400 && cp <= 0x4dbf) || // 扩展 A
    (cp >= 0x3000 && cp <= 0x303f) || // CJK 标点
    (cp >= 0xff00 && cp <= 0xffef) || // 全角字符
    (cp >= 0x3040 && cp <= 0x30ff) || // 日文假名
    (cp >= 0xac00 && cp <= 0xd7af) // 韩文音节
  );
}
