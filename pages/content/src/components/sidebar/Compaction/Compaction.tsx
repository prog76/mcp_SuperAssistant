/**
 * 上下文压缩面板（侧边栏触发入口）。
 * - 「压缩当前对话」按钮：触发 compactionService.compact()
 * - 状态展示：压缩中 / 错误提示
 * - 记录列表：历史压缩记录（状态 / token 估算 / 时间），可回看摘要与原文存档
 */
import React, { useEffect, useState } from 'react';
import { useCompactionStore } from '@src/stores/compaction.store';
import { useTokenStore } from '@src/stores/token.store';
import { compactionService } from '@src/services/compaction.service';
import { useCurrentAdapter } from '@src/hooks/useAdapter';
import { Card, CardContent } from '@src/components/ui/card';
import { Button, Icon, Typography } from '../ui';
import { cn } from '@src/lib/utils';
import { createLogger } from '@extension/shared/lib/logger';
import Toggle from '../components/Toggle';

const logger = createLogger('CompactionPanel');

const STATUS_META: Record<string, { text: string; className: string }> = {
  pending: {
    text: '待处理',
    className: 'bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-300',
  },
  summarizing: {
    text: '摘要中',
    className: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300',
  },
  done: {
    text: '已完成',
    className: 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300',
  },
  sent: {
    text: '已发送',
    className: 'bg-teal-100 text-teal-700 dark:bg-teal-900/40 dark:text-teal-300',
  },
  failed: {
    text: '失败',
    className: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',
  },
};

const formatTime = (ts: number): string => {
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

const Compaction: React.FC = () => {
  const { records, isCompacting, lastError, loadRecords, setError, autoSend, setAutoSend, loadAutoSend } =
    useCompactionStore();
  const { currentTokens, autoCompactMaxTokens, isOverThreshold } = useTokenStore();
  const currentAdapter = useCurrentAdapter();

  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<string>('');
  const [sendingId, setSendingId] = useState<string | null>(null); // 正在发送到新会话的记录

  const canCompact = currentAdapter.isReady && currentAdapter.hasCapability('conversation-read');

  useEffect(() => {
    loadRecords().catch(() => {
      logger.error('[CompactionPanel] 加载记录失败');
    });
    loadAutoSend().catch(() => {
      logger.error('[CompactionPanel] 加载自动发送设置失败');
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleCompact = async () => {
    if (isCompacting || busy) return;
    setBusy(true);
    setNotice(null);
    setError(null);
    try {
      const result = await compactionService.compact({});
      if (result.success) {
        setNotice(result.error || '压缩完成，已生成摘要。在下方记录点击「发送到新会话」继续');
      } else {
        setError(result.error || '压缩失败');
      }
      await loadRecords();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setError(message);
      logger.error('[CompactionPanel] 压缩异常:', error);
    } finally {
      setBusy(false);
    }
  };

  /** 第二步：把指定记录已生成的摘要发送到新会话 */
  const handleSend = async (id: string) => {
    if (sendingId) return;
    setSendingId(id);
    setNotice(null);
    setError(null);
    try {
      const result = await compactionService.sendContinuation(id);
      if (result.success) {
        setNotice('已发送到新会话');
      } else {
        setError(result.error || '发送失败');
      }
      await loadRecords();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setError(message);
      logger.error('[CompactionPanel] 发送续接异常:', error);
    } finally {
      setSendingId(null);
    }
  };

  const handleView = async (id: string) => {
    if (expandedId === id) {
      setExpandedId(null);
      setDetail('');
      return;
    }
    setExpandedId(id);
    setDetail('加载中…');
    const store = useCompactionStore.getState();
    const summary = await store.getSummary(id);
    const transcript = await store.getTranscript(id);
    const parts: string[] = [];
    parts.push(summary ? `【摘要】\n${summary}` : '（无摘要存档）');
    if (transcript) {
      parts.push(`\n【原文存档】（前 4000 字符）\n${transcript.slice(0, 4000)}${transcript.length > 4000 ? '\n…' : ''}`);
    }
    setDetail(parts.join('\n\n'));
  };

  const sortedRecords = [...records].sort((a, b) => b.createdAt - a.createdAt);

  return (
    <div className="space-y-4">
      {/* 触发入口 */}
      <Card className="border-slate-200 dark:border-slate-700 dark:bg-slate-800 rounded-lg shadow-sm overflow-hidden">
        <CardContent className="p-3 space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <Typography variant="subtitle" className="text-slate-700 dark:text-slate-300 font-medium">
                上下文压缩
              </Typography>
              <Typography variant="caption" className="text-slate-500 dark:text-slate-400">
                将当前对话压缩为摘要，在新会话中续接
              </Typography>
            </div>
            <Icon name="file-text" size="sm" className="text-indigo-600 dark:text-indigo-400" />
          </div>

          <div className="flex items-center justify-between">
            <Typography variant="caption" className="text-slate-500 dark:text-slate-400">
              当前对话约 {(currentTokens ?? 0).toLocaleString()} tokens
              {autoCompactMaxTokens > 0 ? ` / ${autoCompactMaxTokens.toLocaleString()}` : ''}
            </Typography>
            <span
              className={cn(
                'text-xs px-2 py-0.5 rounded-full whitespace-nowrap',
                isOverThreshold
                  ? 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300'
                  : currentTokens > autoCompactMaxTokens * 0.8
                    ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300'
                    : 'bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-300',
              )}>
              {isOverThreshold ? '已达阈值' : currentTokens > autoCompactMaxTokens * 0.8 ? '接近阈值' : '正常'}
            </span>
          </div>

          {/* token 消耗进度条 */}
          <div className="h-1.5 w-full rounded-full overflow-hidden bg-slate-100 dark:bg-slate-700">
            <div
              className={cn(
                'h-full transition-all duration-300',
                isOverThreshold
                  ? 'bg-red-500'
                  : currentTokens > autoCompactMaxTokens * 0.8
                    ? 'bg-amber-500'
                    : 'bg-indigo-500',
              )}
              style={{ width: `${Math.min(100, (currentTokens / (autoCompactMaxTokens || 1)) * 100)}%` }}
            />
          </div>

          <Button
            variant="default"
            size="sm"
            className="w-full"
            disabled={!canCompact || isCompacting || busy}
            onClick={handleCompact}>
            {isCompacting || busy ? (
              <>
                <Icon name="refresh" size="sm" className="mr-2 animate-spin" />
                压缩中…
              </>
            ) : (
              <>
                <Icon name="lightning" size="sm" className="mr-2" />
                压缩当前对话
              </>
            )}
          </Button>

          <div className="flex items-center justify-between">
            <Typography variant="caption" className="text-slate-500 dark:text-slate-400">
              压缩后自动发送到新会话
            </Typography>
            <Toggle enabled={autoSend} onChange={setAutoSend} />
          </div>

          {!canCompact && (
            <Typography variant="caption" className="text-amber-600 dark:text-amber-400 block">
              当前平台不支持读取对话，无法压缩
            </Typography>
          )}

          {isCompacting && (
            <Typography variant="caption" className="text-indigo-600 dark:text-indigo-400 block">
              正在生成摘要，请勿切换页面…（自动发送开启时随后会自动带到新会话）
            </Typography>
          )}

          {notice && (
            <div className="bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-md p-2 flex items-start justify-between">
              <Typography variant="caption" className="text-green-700 dark:text-green-300">
                {notice}
              </Typography>
              <button onClick={() => setNotice(null)} className="text-green-600 dark:text-green-400 hover:opacity-70 ml-2">
                <Icon name="x" size="xs" />
              </button>
            </div>
          )}

          {lastError && (
            <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-md p-2 flex items-start justify-between">
              <Typography variant="caption" className="text-red-700 dark:text-red-300">
                {lastError}
              </Typography>
              <button onClick={() => setError(null)} className="text-red-600 dark:text-red-400 hover:opacity-70 ml-2">
                <Icon name="x" size="xs" />
              </button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* 记录列表 */}
      <Card className="border-slate-200 dark:border-slate-700 dark:bg-slate-800 rounded-lg shadow-sm overflow-hidden">
        <CardContent className="p-3">
          <Typography variant="subtitle" className="text-slate-700 dark:text-slate-300 font-medium mb-2">
            压缩记录（{records.length}）
          </Typography>

          {sortedRecords.length === 0 ? (
            <Typography variant="caption" className="text-slate-500 dark:text-slate-400 block py-2">
              暂无压缩记录
            </Typography>
          ) : (
            <div className="space-y-2">
              {sortedRecords.map(record => {
                const status = STATUS_META[record.status] ?? STATUS_META.pending;
                return (
                  <div
                    key={record.compactionId}
                    className="border border-slate-200 dark:border-slate-700 rounded-md p-2 hover:bg-slate-50 dark:hover:bg-slate-700/40 transition-colors">
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <Typography variant="caption" className="text-slate-700 dark:text-slate-300 truncate block">
                          {record.sourceAdapter} · {formatTime(record.createdAt)}
                        </Typography>
                        <Typography variant="caption" className="text-slate-500 dark:text-slate-400 block">
                          约 {record.tokenEstimate.estimatedTokens} tokens
                          {record.summaryTokens ? ` → 摘要 ${record.summaryTokens} tokens` : ''}
                        </Typography>
                      </div>
                      <div className="flex items-center gap-2 flex-shrink-0">
                        <span className={cn('text-xs px-2 py-0.5 rounded-full', status.className)}>{status.text}</span>
                        {record.status === 'done' && (
                          <button
                            onClick={() => handleSend(record.compactionId)}
                            disabled={sendingId !== null}
                            className="text-teal-600 dark:text-teal-400 hover:opacity-70 disabled:opacity-40"
                            title="把续接消息发送到新会话">
                            {sendingId === record.compactionId ? '发送中…' : '发送到新会话'}
                          </button>
                        )}
                        {record.status === 'done' && (
                          <button
                            onClick={() => handleView(record.compactionId)}
                            className="text-indigo-600 dark:text-indigo-400 hover:opacity-70"
                            title="回看摘要/原文">
                            <Icon name={expandedId === record.compactionId ? 'chevron-up' : 'chevron-down'} size="xs" />
                          </button>
                        )}
                      </div>
                    </div>
                    {expandedId === record.compactionId && (
                      <pre className="mt-2 text-xs text-slate-600 dark:text-slate-300 bg-slate-50 dark:bg-slate-900 rounded p-2 whitespace-pre-wrap break-all max-h-60 overflow-y-auto">
                        {detail}
                      </pre>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
};

export default Compaction;
