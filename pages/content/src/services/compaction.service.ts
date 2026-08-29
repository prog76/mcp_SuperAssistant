/**
 * Context compaction service (core orchestration).
 *
 * Flow (see docs/context-compaction-design.md section 4):
 *   readConversation -> token estimate -> archive transcript -> send summarization prompt
 *   -> waitForResponse -> readLastResponse -> validate summary -> archive summary
 *   -> newConversation -> insertText(continuation instructions + <summary> + todos) -> submitForm
 *
 * Every step has a fallback (read unsupported / truncate empty summary / clipboard fallback).
 */
import { createLogger } from '@extension/shared/lib/logger';
import { estimateTokens, truncateByTokens } from '../utils/tokenizer';
import { useAdapterStore } from '../stores/adapter.store';
import { useCompactionStore } from '../stores/compaction.store';
import { saveArchive, type CompactionRecord } from '../utils/compaction-storage';
import { instructionsState } from '../utils/instructions-state';
import type { AdapterPlugin, ConversationMessage, ResponsePayload } from '../plugins/plugin-types';

const logger = createLogger('CompactionService');

const DEFAULT_TARGET_TOKENS = 1200; // default summary budget (configurable 800~3000 in the sidebar)
const MIN_COMPACT_TOKENS = 500; // do not compact very short conversations
const SUMMARY_WAIT_TIMEOUT_MS = 90_000; // wait for the summary to be generated
const INSERT_MAX_RETRIES = 3; // insertText retry count

export interface CompactionOptions {
  targetTokens?: number; // summary budget, default 1200
  todoContext?: string; // pending task state to carry over (todo context)
  carriedTodos?: string[]; // unfinished todo ids carried into the new conversation
  autoSend?: boolean; // auto-send the continuation message to the new chat after compaction (falls back to store setting)
}

export type CompactFailReason = 'unsupported' | 'too_short' | 'no_adapter' | 'timeout' | 'failed';

export interface CompactResult {
  success: boolean;
  reason?: CompactFailReason;
  error?: string;
  compactionId?: string;
  summaryTokens?: number;
  continuationMessage?: string; // full continuation message returned when falling back to clipboard
}

interface BoundAdapter {
  name: string;
  readConversation: () => Promise<ConversationMessage[] | null>;
  newConversation: () => Promise<boolean>;
  readLastResponse: () => Promise<ResponsePayload | null>;
  waitForResponse: (timeoutMs: number) => Promise<boolean>;
  insertText: (text: string) => Promise<boolean>;
  submitForm: () => Promise<boolean>;
  getConversationMode: () => Promise<string | null>;
  setConversationMode: (mode: string) => Promise<boolean>;
}

export class CompactionService {
  private static instance: CompactionService | null = null;

  public static getInstance(): CompactionService {
    if (!CompactionService.instance) {
      CompactionService.instance = new CompactionService();
    }
    return CompactionService.instance;
  }

  private isSending = false; // "send to new conversation" in-progress flag (concurrency guard)

  /**
   * Run one context compaction. Rejects concurrent invocations.
   */
  public async compact(options: CompactionOptions = {}): Promise<CompactResult> {
    const store = () => useCompactionStore.getState();
    const targetTokens = this.clampTargetTokens(options.targetTokens);

    if (store().isCompacting) {
      return { success: false, reason: 'failed', error: 'A compaction is already in progress' };
    }

    const adapter = this.getActiveAdapter();
    if (!adapter) {
      return { success: false, reason: 'no_adapter', error: 'No platform adapter available' };
    }

    store().setCompacting(true);
    store().setError(null);

    const compactionId = `comp_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    const record: CompactionRecord = {
      compactionId,
      createdAt: Date.now(),
      sourceAdapter: adapter.name,
      sourceUrl: window.location.href,
      transcriptPath: `transcript_${compactionId}`,
      summaryPath: `summary_${compactionId}`,
      tokenEstimate: { chars: 0, asciiChars: 0, cjkChars: 0, codeBlockChars: 0, estimatedTokens: 0 },
      summaryTokens: 0,
      carriedTodos: options.carriedTodos ?? [],
      status: 'pending',
    };

    try {
      // 1. Export the transcript
      const transcriptMessages = await adapter.readConversation();
      if (!transcriptMessages || transcriptMessages.length === 0) {
        return this.fail('unsupported', 'Current platform does not support reading conversations; cannot compact', compactionId);
      }
      const transcript = transcriptMessages.map(m => `${m.role}: ${m.content}`).join('\n\n');

      // 2. Token estimation
      const tokenEstimate = estimateTokens(transcript);
      record.tokenEstimate = tokenEstimate;

      // reject extremely short conversations
      if (tokenEstimate.estimatedTokens < MIN_COMPACT_TOKENS) {
        return this.fail(
          'too_short',
          `Conversation still short (~${tokenEstimate.estimatedTokens} tokens, below ${MIN_COMPACT_TOKENS}); nothing to compact`,
          compactionId,
        );
      }

      // 3. Archive the transcript
      await saveArchive(record.transcriptPath, transcript);
      record.status = 'summarizing';
      await store().addRecord(record);

      // 4. Send the summarization prompt
      const summaryPrompt = this.buildSummaryPrompt(targetTokens, options.todoContext);
      const promptSent = await this.insertWithRetry(adapter, summaryPrompt);
      if (!promptSent) return this.fail('failed', 'Failed to send summarization prompt', compactionId);
      const promptSubmitted = await adapter.submitForm();
      if (!promptSubmitted) return this.fail('failed', 'Failed to submit summarization prompt', compactionId);

      // 5. Wait for and read the summary
      const waited = await adapter.waitForResponse(SUMMARY_WAIT_TIMEOUT_MS);
      if (!waited) return this.fail('timeout', 'Timed out waiting for the summary', compactionId);
      const response = await adapter.readLastResponse();

      // 6. Validate summary (empty -> truncate original; over budget -> truncate summary)
      let summary: string;
      if (!response || !response.text || response.text.trim().length === 0) {
        logger.warn('[Compaction] Empty summary; falling back to truncated original');
        summary = truncateByTokens(transcript, targetTokens);
      } else {
        summary = this.validateSummary(response.text, targetTokens, transcript);
      }
      record.summaryTokens = estimateTokens(summary).estimatedTokens;

      // 7. Archive the summary
      await saveArchive(record.summaryPath, summary);
      record.status = 'done';
      await store().updateRecord(compactionId, { status: 'done', summaryTokens: record.summaryTokens });

      // Auto-send: if enabled, go straight to step two and send to the new conversation
      const autoSend = options.autoSend ?? store().autoSend;
      if (autoSend) {
        const sent = await this.sendContinuation(compactionId);
        if (!sent.success) {
          logger.warn('[Compaction] Auto-send failed (summary archived; you can send manually):', sent.error);
        }
        return sent;
      }

      logger.debug(`[Compaction] Compaction complete (summary archived, awaiting send): ${compactionId}`);
      return { success: true, compactionId, summaryTokens: record.summaryTokens };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('[Compaction] Compaction flow error:', error);
      await this.finish(compactionId, { success: false, reason: 'failed', error: message, compactionId });
      return { success: false, reason: 'failed', error: message, compactionId };
    } finally {
      store().setCompacting(false);
    }
  }

  /**
   * Step two: send the generated/archived summary to a new conversation (triggered by sidebar "Send to new chat").
   * Creating a conversation may need to wait for AI Studio save flows; timing is handled inside newConversation.
   */
  public async sendContinuation(compactionId: string): Promise<CompactResult> {
    const store = () => useCompactionStore.getState();
    if (this.isSending) {
      return { success: false, reason: 'failed', error: 'A continuation send is already in progress' };
    }
    const record = store().records.find(r => r.compactionId === compactionId);
    if (!record) {
      return { success: false, reason: 'failed', error: 'Compaction record not found' };
    }
    const summary = await store().getSummary(compactionId);
    if (!summary) {
      return { success: false, reason: 'failed', error: 'Summary archive missing; cannot send' };
    }
    const adapter = this.getActiveAdapter();
    if (!adapter) {
      return { success: false, reason: 'no_adapter', error: 'No platform adapter available' };
    }

    this.isSending = true;
    try {
      const systemInstructions = instructionsState.instructions.trim();
      const continuation = this.buildContinuationMessage(
        summary,
        record.carriedTodos,
        compactionId,
        systemInstructions || undefined,
      );

      const newChat = await adapter.newConversation();
      if (!newChat) {
        await this.copyToClipboard(continuation);
        await store().updateRecord(compactionId, { status: 'failed' });
        return { success: false, reason: 'failed', error: 'Failed to create new conversation; continuation message copied to clipboard — paste and send manually' };
      }

      await this.sleep(800); // wait for the input box after SPA navigation
      const inserted = await this.insertWithRetry(adapter, continuation);
      if (!inserted) {
        await this.copyToClipboard(continuation);
        await store().updateRecord(compactionId, { status: 'failed' });
        return { success: false, reason: 'failed', error: 'Continuation message copied to clipboard — paste and send manually' };
      }

      await adapter.submitForm();
      await store().updateRecord(compactionId, { status: 'sent', summaryTokens: record.summaryTokens });
      logger.debug(`[Compaction] Continuation message sent to new conversation: ${compactionId}`);
      return { success: true, compactionId, summaryTokens: record.summaryTokens };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('[Compaction] Continuation send error:', error);
      return { success: false, reason: 'failed', error: message, compactionId };
    } finally {
      this.isSending = false;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Internal tools                                                       */
  /* ------------------------------------------------------------------ */

  private clampTargetTokens(value?: number): number {
    if (!value) return DEFAULT_TARGET_TOKENS;
    return Math.min(3000, Math.max(800, value));
  }

  private getActiveAdapter(): BoundAdapter | null {
    const adapterState = useAdapterStore.getState();
    const registration = adapterState.getActiveAdapter();
    const plugin: AdapterPlugin | undefined = registration?.plugin;
    if (!plugin || !registration || registration.status !== 'active') return null;

    return {
      name: plugin.name,
      readConversation: plugin.readConversation ? plugin.readConversation.bind(plugin) : () => Promise.resolve(null),
      newConversation: plugin.newConversation ? plugin.newConversation.bind(plugin) : () => Promise.resolve(false),
      readLastResponse: plugin.readLastResponse ? plugin.readLastResponse.bind(plugin) : () => Promise.resolve(null),
      waitForResponse: plugin.waitForResponse ? plugin.waitForResponse.bind(plugin) : () => Promise.resolve(false),
      insertText: plugin.insertText ? plugin.insertText.bind(plugin) : () => Promise.resolve(false),
      submitForm: plugin.submitForm ? plugin.submitForm.bind(plugin) : () => Promise.resolve(false),
      getConversationMode: plugin.getConversationMode
        ? plugin.getConversationMode.bind(plugin)
        : () => Promise.resolve(null),
      setConversationMode: plugin.setConversationMode
        ? plugin.setConversationMode.bind(plugin)
        : () => Promise.resolve(false),
    };
  }

  private async insertWithRetry(adapter: BoundAdapter, text: string): Promise<boolean> {
    for (let attempt = 1; attempt <= INSERT_MAX_RETRIES; attempt++) {
      // Direct .value assignment does not sync React; the adapter already uses execCommand/InputEvent,
      // so we only retry on the overall result here.
      if (await adapter.insertText(text)) return true;
      logger.warn(`[Compaction] insertText attempt ${attempt} failed, retrying`);
      await this.sleep(300 * attempt);
    }
    return false;
  }

  /**
   * Summary validation: empty/too short -> fall back to truncated original; over 50% budget -> truncate summary.
   * See design doc section 7.
   */
  private validateSummary(raw: string, targetTokens: number, transcript: string): string {
    const est = estimateTokens(raw);
    const tooLong = est.estimatedTokens > targetTokens * 1.5;
    const tooShort = est.estimatedTokens < 50;

    if (tooShort || raw.trim().length === 0) {
      logger.warn('[Compaction] Summary empty/too short; falling back to truncated original');
      return truncateByTokens(transcript, targetTokens);
    }
    if (tooLong) {
      logger.warn(`[Compaction] Summary over budget (${est.estimatedTokens} > ${targetTokens * 1.5}); truncating`);
      return truncateByTokens(raw, targetTokens);
    }
    return raw;
  }

  /**
   * Summarization prompt (design doc section 6). Explicitly forbids tool calls so the AI does not invoke MCP.
   */
  private buildSummaryPrompt(targetTokens: number, todoContext?: string): string {
    const targetChars = Math.round(targetTokens * 0.9);
    return [
      'You are assisting with a "context compaction". Compress the current conversation into a structured summary for seamless continuation in a new chat.',
      '',
      '## Output requirements',
      `1. Keep the total length within ${targetTokens} tokens (about ${targetChars} words)`,
      '2. Use the following Markdown structure with all fields present:',
      '   - ## Task goal: what the original task set out to achieve',
      '   - ## Completed: finished steps and conclusions (keep key numbers/paths/commands)',
      '   - ## Key decisions: important trade-offs and their reasons',
      '   - ## Outstanding items: listed by priority, each with the next action',
      '   - ## Risks and caveats: pitfalls, constraints, platform-specific risks',
      '   - ## Key file paths: list of all involved paths',
      '3. In code blocks keep only the core snippets being modified; briefly describe what full files do',
      '4. No pleasantries — output only the summary body; do not wrap the whole output in ``` fences',
      '5. Strictly do NOT call any tools/functions (tool toggles may be active); produce a plain-text summary only',
      '',
      '## Pending task state',
      todoContext || '(none)',
    ].join('\n');
  }

  /**
   * Continuation first-message template (design doc section 9).
   * New-conversation first message = system prompt (Instructions, if any) + continuation instructions + summary + todos + archive index,
   * letting the new conversation take over the task automatically, with no manual copying.
   */
  private buildContinuationMessage(
    summary: string,
    carriedTodos: string[],
    compactionId: string,
    systemInstructions?: string,
  ): string {
    const todoJson = JSON.stringify({ carriedTodoIds: carriedTodos }, null, 2);
    const parts: string[] = [];

    if (systemInstructions) {
      parts.push('[System instructions (treat these as your operating rules)]', systemInstructions, '');
    }

    parts.push(
      '[Task continuation instructions]',
      'You are taking over a compacted historical task. Read the summary below and continue based on its "Outstanding items".',
      'Do not repeat work already listed as completed; if the summary is missing key information, point it out before acting.',
      '',
      '<summary>',
      summary,
      '</summary>',
      '',
      '<todo>',
      todoJson,
      '</todo>',
      '',
      '<archive>',
      `Original transcript archive: compactions/${compactionId}/transcript.md (consult it if you have filesystem tools; otherwise trust the summary)`,
      '</archive>',
    );

    return parts.join('\n');
  }

  /**
   * Mark a record as failed and sync to the store.
   */
  private fail(reason: CompactFailReason, error: string, compactionId: string): CompactResult {
    logger.warn(`[Compaction] failed(${reason}): ${error}`);
    useCompactionStore.getState().updateRecord(compactionId, { status: 'failed' });
    useCompactionStore.getState().setError(error);
    return { success: false, reason, error, compactionId };
  }

  /**
   * Update a record to done/failed (used by paths where compaction partially succeeded but needs fallback).
   */
  private async finish(compactionId: string, result: CompactResult): Promise<void> {
    const status = result.success ? 'done' : 'failed';
    await useCompactionStore.getState().updateRecord(compactionId, {
      status,
      summaryTokens: result.summaryTokens,
    });
    if (!result.success && result.error) {
      useCompactionStore.getState().setError(result.error);
    }
  }

  private async copyToClipboard(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      logger.debug('[Compaction] Copied to clipboard');
    } catch (error) {
      logger.error('[Compaction] Clipboard write failed:', error);
      // fallback: textarea + execCommand
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      try {
        document.execCommand('copy');
      } finally {
        textarea.remove();
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

export const compactionService = CompactionService.getInstance();
