/**
 * 上下文压缩存档存储。
 * - 索引（CompactionRecord）→ chrome.storage.local
 * - 大文本（transcript / summary）→ 经 background 路由到扩展 origin 的 IndexedDB
 *   （content script 的 IndexedDB 与页面同源，不能直接用于敏感全文存档）
 */
import { createLogger } from '@extension/shared/lib/logger';
import type { TokenEstimate } from './tokenizer';

const logger = createLogger('CompactionStorage');

const RECORDS_KEY = 'mcp_compactions';

/**
 * 压缩记录索引（见设计文档 8.1 节）。
 */
export interface CompactionRecord {
  compactionId: string; // `comp_${ts}_${rand}`
  createdAt: number;
  sourceAdapter: string;
  sourceUrl: string;
  transcriptPath: string; // IndexedDB key，如 `transcript_${compactionId}`
  summaryPath: string; // IndexedDB key
  tokenEstimate: TokenEstimate; // 压缩前对话的 token 估算
  summaryTokens: number; // 摘要 token 估算
  carriedTodos: string[]; // 未完成 todo id
  status: 'pending' | 'summarizing' | 'done' | 'failed';
}

/* ------------------------------------------------------------------ */
/* 索引：chrome.storage.local                                          */
/* ------------------------------------------------------------------ */

export async function listCompactionRecords(): Promise<CompactionRecord[]> {
  try {
    const result = await chrome.storage.local.get(RECORDS_KEY);
    const records = result?.[RECORDS_KEY];
    return Array.isArray(records) ? (records as CompactionRecord[]) : [];
  } catch (error) {
    logger.error('listCompactionRecords failed:', error);
    return [];
  }
}

export async function saveCompactionRecord(record: CompactionRecord): Promise<void> {
  try {
    const records = await listCompactionRecords();
    const existing = records.findIndex(r => r.compactionId === record.compactionId);
    if (existing >= 0) {
      records[existing] = record;
    } else {
      records.push(record);
    }
    await chrome.storage.local.set({ [RECORDS_KEY]: records });
  } catch (error) {
    logger.error('saveCompactionRecord failed:', error);
  }
}

export async function updateCompactionRecord(
  compactionId: string,
  patch: Partial<CompactionRecord>,
): Promise<void> {
  const records = await listCompactionRecords();
  const target = records.find(r => r.compactionId === compactionId);
  if (!target) {
    logger.warn(`updateCompactionRecord: record not found: ${compactionId}`);
    return;
  }
  await saveCompactionRecord({ ...target, ...patch });
}

export async function deleteCompactionRecord(compactionId: string): Promise<void> {
  try {
    const records = await listCompactionRecords();
    const filtered = records.filter(r => r.compactionId !== compactionId);
    await chrome.storage.local.set({ [RECORDS_KEY]: filtered });
  } catch (error) {
    logger.error('deleteCompactionRecord failed:', error);
  }
}

/* ------------------------------------------------------------------ */
/* 大文本存档：经 background → 扩展 origin IndexedDB                   */
/* ------------------------------------------------------------------ */

/**
 * 写入一条大文本存档。走 background 消息通道，失败返回 false。
 */
export async function saveArchive(id: string, content: string): Promise<boolean> {
  try {
    const resp = await chrome.runtime.sendMessage({
      type: 'compaction:archive-put',
      payload: { id, content },
    });
    return !!resp?.success;
  } catch (error) {
    logger.error('saveArchive failed:', error);
    return false;
  }
}

/**
 * 读取一条大文本存档；不存在返回 null。
 */
export async function loadArchive(id: string): Promise<string | null> {
  try {
    const resp = await chrome.runtime.sendMessage({
      type: 'compaction:archive-get',
      payload: { id },
    });
    return resp?.success ? (resp.data ?? null) : null;
  } catch (error) {
    logger.error('loadArchive failed:', error);
    return null;
  }
}
