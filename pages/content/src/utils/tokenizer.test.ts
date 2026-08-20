/**
 * tokenizer 纯函数单测。
 * 运行方式（Node >= 22.18，原生 TS 类型剥离）：
 *   pnpm exec node --test src/utils/tokenizer.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { estimateTokens, truncateByTokens } from './tokenizer.ts';

describe('estimateTokens', () => {
  it('空字符串估算为 0', () => {
    const est = estimateTokens('');
    assert.equal(est.estimatedTokens, 0);
    assert.equal(est.chars, 0);
  });

  it('纯英文约 4 字符/token（含 1.2 系数）', () => {
    const text = 'hello world this is a token estimate test';
    const est = estimateTokens(text);
    assert.equal(est.asciiChars, text.length);
    assert.equal(est.cjkChars, 0);
    assert.equal(est.estimatedTokens, Math.ceil((text.length / 4) * 1.2));
  });

  it('纯中文按 1 字符/token（含 1.2 系数）', () => {
    const text = '这是一段用于测试的中文文本内容';
    const est = estimateTokens(text);
    assert.equal(est.cjkChars, text.length);
    assert.equal(est.asciiChars, 0);
    assert.equal(est.estimatedTokens, Math.ceil(text.length * 1.2));
  });

  it('代码块单独统计并计入 codeBlockChars', () => {
    const text = '说明文字\n```python\nprint(1)\n```\n结尾';
    const est = estimateTokens(text);
    assert.ok(est.codeBlockChars > 0, '代码块字符应被单独统计');
    assert.ok(est.estimatedTokens > 0);
  });

  it('混合中英文估算大于各自独立下限', () => {
    const mixed = estimateTokens('hello 世界');
    const zhOnly = estimateTokens('世界');
    const enOnly = estimateTokens('hello');
    assert.ok(mixed.estimatedTokens >= zhOnly.estimatedTokens);
    assert.ok(mixed.estimatedTokens >= enOnly.estimatedTokens);
  });
});

describe('truncateByTokens', () => {
  it('预算足够时返回原文', () => {
    const text = 'short text';
    assert.equal(truncateByTokens(text, 1000), text);
  });

  it('预算不足时按比例截断且不超预算量级', () => {
    const text = '这是一段比较长的中文文本，用来测试截断功能是否按预算正常工作。';
    const truncated = truncateByTokens(text, 5);
    assert.ok(truncated.length < text.length);
    assert.ok(estimateTokens(truncated).estimatedTokens <= 5);
  });
});
