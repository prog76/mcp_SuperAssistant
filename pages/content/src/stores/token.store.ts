/**
 * Live token usage store (zustand).
 * Written by TokenWatcherService polling; lets the compaction panel show the live token estimate,
 * threshold and over-limit state (with visual cues when near/over the threshold).
 */
import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import type { TokenEstimate } from '../utils/tokenizer';

export interface TokenState {
  currentTokens: number; // current conversation token estimate
  tokenEstimate: TokenEstimate | null; // full estimate breakdown
  autoCompactMaxTokens: number; // auto-compact threshold (progress bar basis)
  isOverThreshold: boolean; // at/over threshold
  lastSampledAt: number | null; // last successful sample time

  setCurrentEstimate: (est: TokenEstimate) => void;
  setCurrentTokens: (tokens: number) => void;
  setThreshold: (tokens: number) => void;
  reset: () => void;
}

export const useTokenStore = create<TokenState>()(
  devtools(
    (set, get) => ({
      currentTokens: 0,
      tokenEstimate: null,
      autoCompactMaxTokens: 512_000,
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

      setCurrentTokens: tokens => {
        const threshold = get().autoCompactMaxTokens;
        set({
          currentTokens: tokens,
          isOverThreshold: tokens >= threshold,
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