/**
 * 实时 Token 消耗 Store（zustand）。
 * 由 TokenWatcherService 轮询采样后写入，供压缩面板实时展示当前对话估算 token 数、
 * 阈值与是否超限状态（接近/超过阈值时给用户视觉提示）。
 */
import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import type { TokenEstimate } from '../utils/tokenizer';

export interface TokenState {
  currentTokens: number; // 当前对话估算 token
  tokenEstimate: TokenEstimate | null; // 完整估算明细
  autoCompactMaxTokens: number; // 自动压缩阈值（进度条比例基准）
  isOverThreshold: boolean; // 是否达到/超过阈值
  lastSampledAt: number | null; // 最近一次成功采样时间

  setCurrentEstimate: (est: TokenEstimate) => void;
  setThreshold: (tokens: number) => void;
  reset: () => void;
}

export const useTokenStore = create<TokenState>()(
  devtools(
    (set, get) => ({
      currentTokens: 0,
      tokenEstimate: null,
      autoCompactMaxTokens: 12_000,
      isOverThreshold: false,
      lastSampledAt: null,

      setCurrentEstimate: est => {
        const threshold = get().autoCompactMaxTokens;
        set({
          currentTokens: est.estimatedTokens,
          tokenEstimate: est,
          isOverThreshold: est.estimatedTokens >= threshold,
          lastSampledAt: Date.now(),
        });
      },

      setThreshold: tokens => {
        const current = get().currentTokens;
        set({
          autoCompactMaxTokens: tokens,
          isOverThreshold: current >= tokens,
        });
      },

      reset: () =>
        set({
          currentTokens: 0,
          tokenEstimate: null,
          isOverThreshold: false,
          lastSampledAt: null,
        }),
    }),
    { name: 'TokenStore', store: 'token' },
  ),
);