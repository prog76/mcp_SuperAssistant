/**
 * Context compaction large-text archive (extension-origin IndexedDB).
 *
 * The content-script IndexedDB shares the page origin (page JS can read it; it is cleared with site data),
 * so full-text archives must be routed via chrome.runtime.sendMessage to the background,
 * which reads/writes IndexedDB under the extension origin (service worker).
 */
import { createLogger } from '@extension/shared/lib/logger';

const logger = createLogger('CompactionStorage');

const DB_NAME = 'mcp-compactions';
const DB_VERSION = 1;
const STORE_NAME = 'archives';

export interface ArchiveEntry {
  id: string; // e.g. `transcript_${compactionId}` / `summary_${compactionId}`
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
 * Write one large-text archive entry (transcript / summary).
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
 * Read one large-text archive entry; returns null when missing.
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
