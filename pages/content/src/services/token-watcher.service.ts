/**
 * 实时 Token 监视服务（轮询采样 + 自动压缩触发）。
 *
 * 职责：
 *  1. 周期性（interval）读取当前激活 adapter 的会话内容，复用 compaction.service
 *     相同的 transcript 拼接逻辑，交给 estimateTokens 估算；
 *  2. 把结果写入 useTokenStore，供 UI 实时展示 token 消耗；
 *  3. 当用户开启自动压缩且估算 token 达到阈值时，自动触发 compactionService.compact()。
 *
 * 性能与安全（对应设计第 5.5 节）：
 *  - estimateTokens 为纯字符级 O(n)，数毫秒级，可放心轮询；
 *  - 主要开销在 adapter.readConversation()（全量 DOM 遍历），因此：
 *      - 页面隐藏时跳过采样；
 *      - 无 conversation-read 能力 / 无激活 adapter 时直接复位；
 *      - 采样异常一律静默降级，绝不阻塞主流程。
 *  - 自动触发带冷却与重武装：触发后需对话 token 降回阈值一半以下才允许再次触发，
 *    并在压缩进行中（isCompacting）放弃触发，避免与手动压缩并发 / 无限循环。
 */
import { createLogger } from '@extension/shared/lib/logger';
import { estimateTokens } from '../utils/tokenizer';
import { useAdapterStore } from '../stores/adapter.store';
import { useUIStore } from '../stores/ui.store';
import { useTokenStore } from '../stores/token.store';
import { useCompactionStore } from '../stores/compaction.store';
import { compactionService } from './compaction.service';

const logger = createLogger('TokenWatcherService');

const POLL_INTERVAL_MS = 3_000; // 轮询周期
const AUTO_TRIGGER_COOLDOWN_MS = 120_000; // 自动触发后的冷却时间（防抖动/防环路）
const AUTO_TRIGGER_REARM_RATIO = 0.5; // 触发后须降回阈值该比例以下才重新武装

export class TokenWatcherService {
  private static instance: TokenWatcherService | null = null;

  private timer: ReturnType<typeof setInterval> | null = null;
  private armed = true; // 是否处于"可触发"状态（触发后需回落才重新武装）
  private lastAutoTriggerAt = 0;

  private constructor() {}

  public static getInstance(): TokenWatcherService {
    if (!TokenWatcherService.instance) {
      TokenWatcherService.instance = new TokenWatcherService();
    }
    return TokenWatcherService.instance;
  }

  /** 启动轮询（幂等）。须在 adapter 激活完成后调用。 */
  public start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.poll(), POLL_INTERVAL_MS);
    document.addEventListener('visibilitychange', this.handleVisibilityChange);
    void this.poll();
    logger.debug('[TokenWatcher] 已启动');
  }

  /** 停止轮询（幂等）。 */
  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    document.removeEventListener('visibilitychange', this.handleVisibilityChange);
    logger.debug('[TokenWatcher] 已停止');
  }

  private handleVisibilityChange = (): void => {
    // 重新可见时立即补一次采样，避免长时间隐藏后 UI 数据滞后
    if (!document.hidden) {
      void this.poll();
    }
  };

  private async poll(): Promise<void> {
    if (document.hidden) return;

    const active = useAdapterStore.getState().getActiveAdapter();
    const plugin = active?.plugin;
    if (!plugin || active?.status !== 'active') {
      useTokenStore.getState().reset();
      return;
    }

    // 阈值实时从偏好读取，避免与设置面板/持久化之间出现双源漂移
    const maxTokens = this.resolveMaxTokens();
    const store = useTokenStore.getState();
    store.setThreshold(maxTokens);

    // 1) 平台原生 token 优先，不依赖 readConversation：
    //    AI Studio 直接轮询 ms-token-count 元素，空会话也生效
    const native = await this.resolveNativeTokenCount(plugin);
    if (native !== null) {
      store.setCurrentTokens(native);
      await this.maybeTrigger(native, maxTokens);
      return;
    }

    // 2) 原生缺失 → 回落 readConversation + 字符估算
    if (!plugin.capabilities.includes('conversation-read') || !plugin.readConversation) {
      useTokenStore.getState().reset();
      return;
    }
    try {
      const messages = await plugin.readConversation();
      if (!messages || messages.length === 0) {
        useTokenStore.getState().reset();
        return;
      }
      const transcript = messages.map(m => `${m.role}: ${m.content}`).join('\n\n');
      const estimate = estimateTokens(transcript);
      store.setCurrentTokens(estimate.estimatedTokens);

      await this.maybeTrigger(estimate.estimatedTokens, maxTokens);
    } catch (error) {
      logger.warn('[TokenWatcher] 采样会话失败（已降级）:', error);
    }
  }

  /**
   * 读取用户偏好的自动压缩阈值；老用户持久化中缺失该字段时取默认值。
   */
  private resolveMaxTokens(): number {
    const raw = useUIStore.getState().preferences.autoCompactMaxTokens;
    const value = typeof raw === 'number' && Number.isFinite(raw) ? raw : 512_000;
    return Math.min(1_000_000, Math.max(2_000, value));
  }

  /**
   * 平台原生 token 数（如 AI Studio 的 ms-token-count）。实现不存在或
   * 读不到时返回 null，由上层回落字符估算。
   */
  private async resolveNativeTokenCount(plugin: any): Promise<number | null> {
    if (typeof plugin?.readNativeTokenCount === 'function') {
      try {
        const n = await plugin.readNativeTokenCount();
        return typeof n === 'number' && Number.isFinite(n) ? n : null;
      } catch (error) {
        logger.warn('[TokenWatcher] 读取平台原生 token 失败（回落估算）:', error);
        return null;
      }
    }
    return null;
  }

  private async maybeTrigger(tokens: number, maxTokens: number): Promise<void> {
    const { autoCompactEnabled } = useUIStore.getState().preferences;
    if (!autoCompactEnabled) return;
    if (useCompactionStore.getState().isCompacting) return; // 已有压缩进行中，防并发

    if (!this.armed) {
      // 未武装：需等对话被压缩清空、token 明显回落后才允许再次触发
      if (tokens < maxTokens * AUTO_TRIGGER_REARM_RATIO) {
        this.armed = true;
      }
      return;
    }

    if (tokens < maxTokens) return; // 未达阈值
    if (Date.now() - this.lastAutoTriggerAt < AUTO_TRIGGER_COOLDOWN_MS) return; // 冷却中

    this.armed = false;
    this.lastAutoTriggerAt = Date.now();
    logger.info(`[TokenWatcher] 触发自动压缩：约 ${tokens} tokens ≥ 阈值 ${maxTokens}`);

    compactionService
      .compact({})
      .then(result => {
        if (!result.success) {
          logger.warn(`[TokenWatcher] 自动压缩未成功（${result.reason ?? 'unknown'}）: ${result.error ?? ''}`);
        }
      })
      .catch(error => {
        logger.error('[TokenWatcher] 自动压缩调用异常:', error);
      });
  }
}

export const tokenWatcher = TokenWatcherService.getInstance();