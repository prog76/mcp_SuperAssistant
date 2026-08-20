/**
 * 上下文压缩 Store（zustand）。
 * 维护压缩记录列表、当前进行中的压缩状态与错误信息，供侧边栏/压缩面板消费。
 */
import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import { createLogger } from '@extension/shared/lib/logger';
import {
  listCompactionRecords,
  saveCompactionRecord,
  updateCompactionRecord,
  deleteCompactionRecord,
  loadArchive,
  type CompactionRecord,
} from '../utils/compaction-storage';

const logger = createLogger('useCompactionStore');

export interface CompactionState {
  records: CompactionRecord[];
  activeCompactionId: string | null;
  isCompacting: boolean;
  lastError: string | null;

  loadRecords: () => Promise<void>;
  addRecord: (record: CompactionRecord) => Promise<void>;
  updateRecord: (id: string, patch: Partial<CompactionRecord>) => Promise<void>;
  removeRecord: (id: string) => Promise<void>;
  setActive: (id: string | null) => void;
  setCompacting: (value: boolean) => void;
  setError: (error: string | null) => void;
  getTranscript: (id: string) => Promise<string | null>;
  getSummary: (id: string) => Promise<string | null>;
}

export const useCompactionStore = create<CompactionState>()(
  devtools(
    (set, get) => ({
      records: [],
      activeCompactionId: null,
      isCompacting: false,
      lastError: null,

      loadRecords: async () => {
        const records = await listCompactionRecords();
        set({ records });
        logger.debug(`[CompactionStore] Loaded ${records.length} records`);
      },

      addRecord: async (record) => {
        await saveCompactionRecord(record);
        set(state => ({ records: [...state.records, record] }));
        logger.debug('[CompactionStore] Record added:', record.compactionId);
      },

      updateRecord: async (id, patch) => {
        await updateCompactionRecord(id, patch);
        set(state => ({
          records: state.records.map(r => (r.compactionId === id ? { ...r, ...patch } : r)),
        }));
      },

      removeRecord: async (id) => {
        await deleteCompactionRecord(id);
        set(state => ({
          records: state.records.filter(r => r.compactionId !== id),
          activeCompactionId: state.activeCompactionId === id ? null : state.activeCompactionId,
        }));
      },

      setActive: (id) => set({ activeCompactionId: id }),
      setCompacting: (value) => set({ isCompacting: value }),
      setError: (error) => set({ lastError: error }),

      getTranscript: async (id) => {
        const record = get().records.find(r => r.compactionId === id);
        return record ? loadArchive(record.transcriptPath) : null;
      },

      getSummary: async (id) => {
        const record = get().records.find(r => r.compactionId === id);
        return record ? loadArchive(record.summaryPath) : null;
      },
    }),
  ),
);
