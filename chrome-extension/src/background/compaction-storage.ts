/**
 * 上下文压缩大文本存档（扩展 origin 的 IndexedDB）。
 *
 * content script 里的 IndexedDB 与页面同源（页面自身 JS 可读、随站点数据清除），
 * 因此全文存档必须经 chrome.runtime.sendMessage 路由到 background，
 * 在扩展自身 origin（service worker）下读写 IndexedDB。
 */
import { createLogger } from '@extension/shared/lib/logger';

const logger = createLogger('CompactionStorage');

const DB_NAME = 'mcp-compactions';
const DB_VERSION = 1;
const STORE_NAME = 'archives';

export interface ArchiveEntry {
  id: string; // 如 `transcript_${compactionId}` / `summary_${compactionId}`
  content: string;
  createdAt: number;
}

function openArchiveDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * 写入一条大文本存档（transcript / summary）。
 */
export async function archivePut(entry: ArchiveEntry): Promise<boolean> {
  try {
    const db = await openArchiveDb();
    return await new Promise<boolean>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(entry);
      tx.oncomplete = () => {
        db.close();
        resolve(true);
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error);
      };
    });
  } catch (error) {
    logger.error('archivePut failed:', error);
    return false;
  }
}

/**
 * 读取一条大文本存档；不存在返回 null。
 */
export async function archiveGet(id: string): Promise<string | null> {
  try {
    const db = await openArchiveDb();
    return await new Promise<string | null>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(id);
      req.onsuccess = () => {
        db.close();
        resolve(req.result?.content ?? null);
      };
      req.onerror = () => {
        db.close();
        reject(req.error);
      };
    });
  } catch (error) {
    logger.error('archiveGet failed:', error);
    return null;
  }
}
