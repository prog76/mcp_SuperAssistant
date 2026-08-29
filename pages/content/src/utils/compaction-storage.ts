/**
 * Context compaction archive storage.
 * - Index (CompactionRecord) -> chrome.storage.local
 * - Large text (transcript / summary) -> routed via background to extension-origin IndexedDB
 *   (the content script IndexedDB shares the page origin and must not hold sensitive full-text archives)
 */
import { createLogger } from '@extension/shared/lib/logger';
import type { TokenEstimate } from './tokenizer';

const logger = createLogger('CompactionStorage');

const RECORDS_KEY = 'mcp_compactions';

/**
 * Compaction record index (see design doc section 8.1).
 */
export interface CompactionRecord {
  compactionId: string; // `comp_${ts}_${rand}`
  createdAt: number;
  sourceAdapter: string;
  sourceUrl: string;
  transcriptPath: string; // IndexedDB key, e.g. `transcript_${compactionId}`
  summaryPath: string; // IndexedDB key
  tokenEstimate: TokenEstimate; // token estimate of the conversation before compaction
  summaryTokens: number; // token estimate of the summary
  carriedTodos: string[]; // ids of unfinished todos
  status: 'pending' | 'summarizing' | 'done' | 'failed' | 'sent'; // done=summary generated awaiting send; sent=delivered to new conversation
}

/* ------------------------------------------------------------------ */
/* Index: chrome.storage.local                                         */
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
/* Large-text archive: background -> extension-origin IndexedDB        */
/* ------------------------------------------------------------------ */

/**
 * Write one large-text archive entry. Goes through the background message channel; returns false on failure.
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
 * Read one large-text archive entry; returns null when missing.
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
