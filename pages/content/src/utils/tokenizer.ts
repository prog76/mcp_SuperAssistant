/**
 * Pure token-estimation functions (zero-dependency; runs directly in content script / background).
 *
 * The web page cannot get the server-exact token count, so this module provides a segmented-weight character-level estimate
 * shown to the user and stored in archive metadata; auto-trigger uses it with a conservative safety margin.
 *
 * Density assumptions (biased high rather than low, so underestimation does not delay auto-trigger):
 * - English/digits/symbols: ~4 chars per token (Claude convention)
 * - CJK: ~1 char per token (mainstream BPE tokenizers use about 1 token per common Chinese character)
 * - Code blocks: ~3 chars per token (many symbols/spaces; density between natural language and CJK)
 * - Overall ESTIMATE_SAFETY_FACTOR = 1.2 absorbs residual error (English density, rare characters, etc.)
 */

// Safety factor: underestimating tokens would delay auto-trigger (unsafe),
// so a 1.2 multiplier absorbs residual error (English density, rare characters, etc.).
const ESTIMATE_SAFETY_FACTOR = 1.2;

export interface TokenEstimate {
  chars: number;
  asciiChars: number;
  cjkChars: number;
  codeBlockChars: number;
  estimatedTokens: number;
}

/**
 * Estimate the token count of a text.
 * @param text input text
 */
export function estimateTokens(text: string): TokenEstimate {
  let asciiChars = 0;
  let cjkChars = 0;
  let codeBlockChars = 0;

  // 1. Strip code blocks first and count them separately (code density is usually higher than prose)
  const codeBlockRegex = /```[\s\S]*?```/g;
  const codeBlocks = text.match(codeBlockRegex) ?? [];
  for (const block of codeBlocks) {
    codeBlockChars += block.length;
  }
  const noCode = text.replace(codeBlockRegex, '');

  // 2. Count by character class (code-point iteration handles emoji/rare characters correctly)
  for (const ch of noCode) {
    const cp = ch.codePointAt(0)!;
    if (isCjk(cp)) cjkChars++;
    else asciiChars++;
  }

  // 3. Estimate (see density assumptions in the file header)
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
 * Truncate text to a token budget (fallback path for summary validation: keep first N tokens of the original).
 * Simple implementation: linearly accumulate characters by estimate ratio.
 * @param text text to truncate
 * @param targetTokens target token budget
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
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK Unified Ideographs
    (cp >= 0x3400 && cp <= 0x4dbf) || // Extension A
    (cp >= 0x3000 && cp <= 0x303f) || // CJK punctuation
    (cp >= 0xff00 && cp <= 0xffef) || // fullwidth characters
    (cp >= 0x3040 && cp <= 0x30ff) || // Japanese kana
    (cp >= 0xac00 && cp <= 0xd7af) // Hangul syllables
  );
}
