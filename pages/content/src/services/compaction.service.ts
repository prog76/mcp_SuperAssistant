/**
 * 上下文压缩服务（核心编排）。
 *
 * 流程（见 docs/context-compaction-design.md 第 4 节）：
 *   readConversation → token 估算 → 存档 transcript → 发送总结指令
 *   → waitForResponse → readLastResponse → 校验摘要 → 存档 summary
 *   → newConversation → insertText(续接指令 + <summary> + todo) → submitForm
 *
 * 每步失败都有降级策略（不支持读取 / 空摘要截断 / 剪贴板兜底）。
 */
import { createLogger } from '@extension/shared/lib/logger';
import { estimateTokens, truncateByTokens } from '../utils/tokenizer';
import { useAdapterStore } from '../stores/adapter.store';
import { useCompactionStore } from '../stores/compaction.store';
import { saveArchive, type CompactionRecord } from '../utils/compaction-storage';
import { instructionsState } from '../utils/instructions-state';
import type { AdapterPlugin, ConversationMessage, ResponsePayload } from '../plugins/plugin-types';

const logger = createLogger('CompactionService');

const DEFAULT_TARGET_TOKENS = 1200; // 摘要预算默认值（侧边栏可配 800~3000）
const MIN_COMPACT_TOKENS = 500; // 对话极短不压缩
const SUMMARY_WAIT_TIMEOUT_MS = 90_000; // 等待摘要生成
const INSERT_MAX_RETRIES = 3; // insertText 重试次数

export interface CompactionOptions {
  targetTokens?: number; // 摘要预算，默认 1200
  todoContext?: string; // 待续接任务状态（功能 2 的 todo 上下文）
  carriedTodos?: string[]; // 压缩时携带的未完成 todo id
}

export type CompactFailReason = 'unsupported' | 'too_short' | 'no_adapter' | 'timeout' | 'failed';

export interface CompactResult {
  success: boolean;
  reason?: CompactFailReason;
  error?: string;
  compactionId?: string;
  summaryTokens?: number;
  continuationMessage?: string; // 剪贴板兜底时返回完整续接消息
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

  /**
   * 执行一次上下文压缩。已在压缩中时拒绝并发。
   */
  public async compact(options: CompactionOptions = {}): Promise<CompactResult> {
    const store = () => useCompactionStore.getState();
    const targetTokens = this.clampTargetTokens(options.targetTokens);

    if (store().isCompacting) {
      return { success: false, reason: 'failed', error: '已有压缩任务进行中' };
    }

    const adapter = this.getActiveAdapter();
    if (!adapter) {
      return { success: false, reason: 'no_adapter', error: '未找到可用的平台适配器' };
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
      // 捕获旧会话模式与系统提示词（新会话需保持模式一致、并携带系统提示词）
      const conversationMode = await adapter.getConversationMode();
      const systemInstructions = instructionsState.instructions.trim();

      // 1. 导出全文
      const transcriptMessages = await adapter.readConversation();
      if (!transcriptMessages || transcriptMessages.length === 0) {
        return this.fail('unsupported', '当前平台不支持读取对话，无法压缩', compactionId);
      }
      const transcript = transcriptMessages.map(m => `${m.role}: ${m.content}`).join('\n\n');

      // 2. token 估算
      const tokenEstimate = estimateTokens(transcript);
      record.tokenEstimate = tokenEstimate;

      // 极短对话拒绝
      if (tokenEstimate.estimatedTokens < MIN_COMPACT_TOKENS) {
        return this.fail(
          'too_short',
          `上下文尚短（约 ${tokenEstimate.estimatedTokens} tokens，低于 ${MIN_COMPACT_TOKENS}），无需压缩`,
          compactionId,
        );
      }

      // 3. 存档 transcript
      await saveArchive(record.transcriptPath, transcript);
      record.status = 'summarizing';
      await store().addRecord(record);

      // 4. 发送总结指令
      const summaryPrompt = this.buildSummaryPrompt(targetTokens, options.todoContext);
      const promptSent = await this.insertWithRetry(adapter, summaryPrompt);
      if (!promptSent) return this.fail('failed', '总结指令发送失败', compactionId);
      const promptSubmitted = await adapter.submitForm();
      if (!promptSubmitted) return this.fail('failed', '总结指令提交失败', compactionId);

      // 5. 等待并读取摘要
      const waited = await adapter.waitForResponse(SUMMARY_WAIT_TIMEOUT_MS);
      if (!waited) return this.fail('timeout', '等待摘要生成超时', compactionId);
      const response = await adapter.readLastResponse();

      // 6. 校验摘要（空 → 截断原文；超长 → 截断摘要）
      let summary: string;
      if (!response || !response.text || response.text.trim().length === 0) {
        logger.warn('[Compaction] 摘要生成为空，使用原文截断兜底');
        summary = truncateByTokens(transcript, targetTokens);
      } else {
        summary = this.validateSummary(response.text, targetTokens, transcript);
      }
      record.summaryTokens = estimateTokens(summary).estimatedTokens;

      // 7. 存档 summary
      await saveArchive(record.summaryPath, summary);

      // 8. 开新会话并注入续接消息
      const continuation = this.buildContinuationMessage(
        summary,
        options.carriedTodos ?? [],
        compactionId,
        systemInstructions || undefined,
      );
      const newChat = await adapter.newConversation();

      if (!newChat) {
        // newConversation 失败：剪贴板兜底
        await this.copyToClipboard(continuation);
        await this.finish(compactionId, {
          success: true,
          compactionId,
          summaryTokens: record.summaryTokens,
          continuationMessage: continuation,
          error: '已生成摘要并复制到剪贴板，请手动新建会话后粘贴续接消息',
        });
        return {
          success: true,
          compactionId,
          summaryTokens: record.summaryTokens,
          continuationMessage: continuation,
          error: '已生成摘要并复制到剪贴板，请手动新建会话后粘贴续接消息',
        };
      }

      // 9. 注入续接消息（带重试；失败剪贴板兜底）
      await this.sleep(800); // 等待 SPA 切换后输入框就绪

      // 恢复旧会话模式（快速/专家/识图），确保新会话保持一致
      if (conversationMode) {
        await adapter.setConversationMode(conversationMode);
        await this.sleep(400);
      }

      const inserted = await this.insertWithRetry(adapter, continuation);
      if (!inserted) {
        await this.copyToClipboard(continuation);
        await this.finish(compactionId, {
          success: true,
          compactionId,
          summaryTokens: record.summaryTokens,
          continuationMessage: continuation,
          error: '续接消息已复制到剪贴板，请手动粘贴发送',
        });
        return {
          success: true,
          compactionId,
          summaryTokens: record.summaryTokens,
          continuationMessage: continuation,
          error: '续接消息已复制到剪贴板，请手动粘贴发送',
        };
      }

      // 10. 提交
      await adapter.submitForm();

      await this.finish(compactionId, {
        success: true,
        compactionId,
        summaryTokens: record.summaryTokens,
      });
      return { success: true, compactionId, summaryTokens: record.summaryTokens };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('[Compaction] 压缩流程异常:', error);
      await this.finish(compactionId, { success: false, reason: 'failed', error: message, compactionId });
      return { success: false, reason: 'failed', error: message, compactionId };
    } finally {
      store().setCompacting(false);
    }
  }

  /* ------------------------------------------------------------------ */
  /* 内部工具                                                            */
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
      // 直接 .value 赋值不同步 React，adapter 内部已用 execCommand/InputEvent；
      // 此处仅对整体结果做重试。
      if (await adapter.insertText(text)) return true;
      logger.warn(`[Compaction] insertText 第 ${attempt} 次失败，重试`);
      await this.sleep(300 * attempt);
    }
    return false;
  }

  /**
   * 摘要校验：空/过短 → 截断原文兜底；超 50% 预算 → 截断摘要。
   * 见设计文档第 7 节。
   */
  private validateSummary(raw: string, targetTokens: number, transcript: string): string {
    const est = estimateTokens(raw);
    const tooLong = est.estimatedTokens > targetTokens * 1.5;
    const tooShort = est.estimatedTokens < 50;

    if (tooShort || raw.trim().length === 0) {
      logger.warn('[Compaction] 摘要为空/过短，使用原文截断兜底');
      return truncateByTokens(transcript, targetTokens);
    }
    if (tooLong) {
      logger.warn(`[Compaction] 摘要超预算（${est.estimatedTokens} > ${targetTokens * 1.5}），截断`);
      return truncateByTokens(raw, targetTokens);
    }
    return raw;
  }

  /**
   * 总结指令（设计文档第 6 节）。明确禁止调用工具，避免 AI 跑去调 MCP。
   */
  private buildSummaryPrompt(targetTokens: number, todoContext?: string): string {
    const targetChars = Math.round(targetTokens * 0.9);
    return [
      '你正在协助完成一次"上下文压缩"。请把当前对话压缩为一份结构化摘要，供新会话无缝接续。',
      '',
      '## 输出要求',
      `1. 总长度控制在 ${targetTokens} tokens 以内（约 ${targetChars} 个中文字符）`,
      '2. 使用以下 Markdown 结构，字段必须齐全：',
      '   - ## 任务目标：原始任务要达成什么',
      '   - ## 已完成：已完成的步骤与结论（保留关键数字/路径/命令）',
      '   - ## 关键决策：重要取舍与原因',
      '   - ## 未完成事项：按优先级列出，含下一步动作',
      '   - ## 风险与注意事项：坑点、约束、平台风控点',
      '   - ## 关键文件路径：涉及的所有路径清单',
      '3. 代码块只保留"正在修改的核心片段"，完整代码请概述其作用即可',
      '4. 不要客套，直接输出摘要正文，不要用 ``` 包裹整个输出',
      '5. 严禁调用任何工具/函数（当前工具开关可能处于激活状态），只做纯文本总结',
      '',
      '## 待续接任务状态',
      todoContext || '（无）',
    ].join('\n');
  }

  /**
   * 续接首条消息模板（设计文档第 9 节）。
   * 新会话首条消息 = 系统提示词（Instructions，如有）+ 续接指令 + 摘要 + todo + 存档索引，
   * 使新会话自动化接管任务，无需手动复制。
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
      parts.push('[系统提示词（请作为你的设定遵循）]', systemInstructions, '');
    }

    parts.push(
      '[任务续接指令]',
      '你正在接手一个已压缩的历史任务。请先阅读下方摘要，基于其中"未完成事项"继续执行。',
      '不要重复摘要中"已完成"的工作；如摘要缺失关键信息，请先指出再行动。',
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
      `原文存档：compactions/${compactionId}/transcript.md（若你连接了文件系统工具可回查，否则以摘要为准）`,
      '</archive>',
    );

    return parts.join('\n');
  }

  /**
   * 更新记录为失败，并同步到 store。
   */
  private fail(reason: CompactFailReason, error: string, compactionId: string): CompactResult {
    logger.warn(`[Compaction] 失败(${reason}): ${error}`);
    useCompactionStore.getState().updateRecord(compactionId, { status: 'failed' });
    useCompactionStore.getState().setError(error);
    return { success: false, reason, error, compactionId };
  }

  /**
   * 更新记录为完成/失败状态（供压缩中途成功但需要兜底的路径使用）。
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
      logger.debug('[Compaction] 已复制到剪贴板');
    } catch (error) {
      logger.error('[Compaction] 剪贴板写入失败:', error);
      // 兜底：textarea + execCommand
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
