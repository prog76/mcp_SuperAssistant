/**
 * Unit tests for the pure tokenizer functions.
 * Run with (Node >= 22.18, native TS type stripping):
 *   pnpm exec node --test src/utils/tokenizer.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { estimateTokens, truncateByTokens } from './tokenizer.ts';

describe('estimateTokens', () => {
  it('estimates empty string as 0', () => {
    const est = estimateTokens('');
    assert.equal(est.estimatedTokens, 0);
    assert.equal(est.chars, 0);
  });

  it('pure English ~4 chars/token (with 1.2 factor)', () => {
    const text = 'hello world this is a token estimate test';
    const est = estimateTokens(text);
    assert.equal(est.asciiChars, text.length);
    assert.equal(est.cjkChars, 0);
    assert.equal(est.estimatedTokens, Math.ceil((text.length / 4) * 1.2));
  });

  it('pure CJK ~1 char/token (with 1.2 factor)', () => {
    const text = '这是一段用于测试的中文文本内容';
    const est = estimateTokens(text);
    assert.equal(est.cjkChars, text.length);
    assert.equal(est.asciiChars, 0);
    assert.equal(est.estimatedTokens, Math.ceil(text.length * 1.2));
  });

  it('counts code blocks separately in codeBlockChars', () => {
    const text = '说明文字\n```python\nprint(1)\n```\n结尾';
    const est = estimateTokens(text);
    assert.ok(est.codeBlockChars > 0, 'code block characters should be counted separately');
    assert.ok(est.estimatedTokens > 0);
  });

  it('mixed CJK+English estimate exceeds each individual lower bound', () => {
    const mixed = estimateTokens('hello 世界');
    const zhOnly = estimateTokens('世界');
    const enOnly = estimateTokens('hello');
    assert.ok(mixed.estimatedTokens >= zhOnly.estimatedTokens);
    assert.ok(mixed.estimatedTokens >= enOnly.estimatedTokens);
  });
});

describe('truncateByTokens', () => {
  it('returns original when budget is sufficient', () => {
    const text = 'short text';
    assert.equal(truncateByTokens(text, 1000), text);
  });

  it('truncates proportionally when over budget, staying within budget magnitude', () => {
    const text = '这是一段比较长的中文文本，用来测试截断功能是否按预算正常工作。';
    const truncated = truncateByTokens(text, 5);
    assert.ok(truncated.length < text.length);
    assert.ok(estimateTokens(truncated).estimatedTokens <= 5);
  });
});
