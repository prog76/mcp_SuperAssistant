/**
 * Real-time token watcher service (polling sampler + auto-compaction trigger).
 *
 * Responsibilities:
 *  1. Periodically reads the active adapter conversation, reusing the same transcript
 *     joining logic as compaction.service, estimated via estimateTokens;
 *  2. Writes results to useTokenStore for live token usage in the UI;
 *  3. When auto-compact is enabled and estimated tokens reach the threshold, triggers compactionService.compact().
 *
 * Performance and safety (design doc section 5.5):
 *  - estimateTokens is pure character-level O(n), a few ms — safe to poll;
 *  - The main cost is adapter.readConversation() (full DOM traversal), therefore:
 *      - skip sampling when the page is hidden;
 *      - reset immediately when conversation-read capability / active adapter is missing;
 *      - silently degrade on sampling errors; never block the main flow.
 *  - Auto-trigger has cooldown + re-arm: after firing, tokens must fall below half the threshold to fire again,
 *    and triggers are suppressed while compacting (isCompacting) to avoid concurrency / infinite loops.
 */
import { createLogger } from '@extension/shared/lib/logger';
import { estimateTokens } from '../utils/tokenizer';
import { useAdapterStore } from '../stores/adapter.store';
import { useUIStore } from '../stores/ui.store';
import { useTokenStore } from '../stores/token.store';
import { useCompactionStore } from '../stores/compaction.store';
import { compactionService } from './compaction.service';

const logger = createLogger('TokenWatcherService');

const POLL_INTERVAL_MS = 3_000; // polling interval
const AUTO_TRIGGER_COOLDOWN_MS = 120_000; // cooldown after an auto-trigger (anti-flapping / anti-loop)
const AUTO_TRIGGER_REARM_RATIO = 0.5; // tokens must drop below this ratio of the threshold to re-arm

export class TokenWatcherService {
  private static instance: TokenWatcherService | null = null;

  private timer: ReturnType<typeof setInterval> | null = null;
  private armed = true; // whether a trigger is allowed (must fall back below threshold to re-arm)
  private lastAutoTriggerAt = 0;

  private constructor() {}

  public static getInstance(): TokenWatcherService {
    if (!TokenWatcherService.instance) {
      TokenWatcherService.instance = new TokenWatcherService();
    }
    return TokenWatcherService.instance;
  }

  /** Start polling (idempotent). Call after adapter activation completes. */
  public start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.poll(), POLL_INTERVAL_MS);
    document.addEventListener('visibilitychange', this.handleVisibilityChange);
    void this.poll();
    logger.debug('[TokenWatcher] started');
  }

  /** Stop polling (idempotent). */
  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    document.removeEventListener('visibilitychange', this.handleVisibilityChange);
    logger.debug('[TokenWatcher] stopped');
  }

  private handleVisibilityChange = (): void => {
    // sample immediately when visible again so the UI does not lag after long hidden periods
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

    // read the threshold live from preferences to avoid drift vs the settings panel / persistence
    const maxTokens = this.resolveMaxTokens();
    const store = useTokenStore.getState();
    store.setThreshold(maxTokens);

    // 1) Prefer platform-native token count, independent of readConversation:
    //    AI Studio: poll the ms-token-count element directly; works even on empty conversations
    const native = await this.resolveNativeTokenCount(plugin);
    if (native !== null) {
      store.setCurrentTokens(native);
      await this.maybeTrigger(native, maxTokens);
      return;
    }

    // 2) Native count missing -> fall back to readConversation + character estimation
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
      logger.warn('[TokenWatcher] Conversation sampling failed (degraded):', error);
    }
  }

  /**
   * Read the auto-compact threshold from preferences; fall back to default for older persisted state.
   */
  private resolveMaxTokens(): number {
    const raw = useUIStore.getState().preferences.autoCompactMaxTokens;
    const value = typeof raw === 'number' && Number.isFinite(raw) ? raw : 512_000;
    return Math.min(1_000_000, Math.max(2_000, value));
  }

  /**
   * Platform-native token count (e.g. AI Studio ms-token-count). Returns null when missing or
   * unreadable; the caller falls back to character estimation.
   */
  private async resolveNativeTokenCount(plugin: any): Promise<number | null> {
    if (typeof plugin?.readNativeTokenCount === 'function') {
      try {
        const n = await plugin.readNativeTokenCount();
        return typeof n === 'number' && Number.isFinite(n) ? n : null;
      } catch (error) {
        logger.warn('[TokenWatcher] Failed to read native token count (falling back to estimation):', error);
        return null;
      }
    }
    return null;
  }

  private async maybeTrigger(tokens: number, maxTokens: number): Promise<void> {
    const { autoCompactEnabled } = useUIStore.getState().preferences;
    if (!autoCompactEnabled) return;
    if (useCompactionStore.getState().isCompacting) return; // compaction already in progress — prevent concurrency

    if (!this.armed) {
      // Not armed: wait until the conversation is compacted/cleared and tokens drop before triggering again
      if (tokens < maxTokens * AUTO_TRIGGER_REARM_RATIO) {
        this.armed = true;
      }
      return;
    }

    if (tokens < maxTokens) return; // below threshold
    if (Date.now() - this.lastAutoTriggerAt < AUTO_TRIGGER_COOLDOWN_MS) return; // cooling down

    this.armed = false;
    this.lastAutoTriggerAt = Date.now();
    logger.info(`[TokenWatcher] Triggering auto-compaction: ~${tokens} tokens >= threshold ${maxTokens}`);

    compactionService
      .compact({})
      .then(result => {
        if (!result.success) {
          logger.warn(`[TokenWatcher] Auto-compaction unsuccessful (${result.reason ?? 'unknown'}): ${result.error ?? ''}`);
        }
      })
      .catch(error => {
        logger.error('[TokenWatcher] Auto-compaction call error:', error);
      });
  }
}

export const tokenWatcher = TokenWatcherService.getInstance();