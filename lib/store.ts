import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { CarbonRecord, Mutation, PeriodState, Summary } from './domain';
import { fetchEvidence, postMutation } from './api';

export type OutboxStatus = 'pending' | 'saving' | 'confirmed' | 'conflict' | 'failed';

export type OutboxItem = {
  /** 幂等键：断网重试时服务端凭它识别"已生效"的写入，不会重复应用 */
  clientId: string;
  label: string;
  mutation: Mutation;
  status: OutboxStatus;
  error?: string;
  /** 版本冲突时服务端返回的最新记录 */
  conflictLatest?: CarbonRecord;
  /** 门禁拦截时的缺口说明 */
  gaps?: string[];
};

type State = {
  snapshot: PeriodState | null;
  summary: Summary | null;
  actor: string;
  /** 模拟断网：批次写入中途失败、只重试未确认记录的演示开关 */
  online: boolean;
  outbox: OutboxItem[];
  processing: boolean;
  selectedRecordId: string;
  loadedAt: number;
  load: () => Promise<void>;
  refreshSilent: () => Promise<void>;
  setActor: (actor: string) => void;
  toggleOnline: () => void;
  selectRecord: (id: string) => void;
  enqueue: (label: string, mutation: Mutation) => void;
  processOutbox: () => Promise<void>;
  retryUnconfirmed: () => void;
  rebaseConflict: (clientId: string) => void;
  discardItem: (clientId: string) => void;
  clearConfirmed: () => void;
};

const newClientId = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);

export const useCarbonStore = create<State>()(
  persist(
    (set, get) => ({
      snapshot: null,
      summary: null,
      actor: '复核端 · 沈楠',
      online: true,
      outbox: [],
      processing: false,
      selectedRecordId: 'ACT-0318',
      loadedAt: 0,

      load: async () => {
        const payload = await fetchEvidence();
        set({ snapshot: payload.state, summary: payload.summary, loadedAt: Date.now() });
      },

      // 轮询同步另一端（现场/复核）的最新保存；有未确认写入时暂停，避免覆盖本地进行中状态
      refreshSilent: async () => {
        const { outbox, processing } = get();
        if (processing || outbox.some((item) => item.status === 'pending' || item.status === 'saving')) return;
        try {
          const payload = await fetchEvidence();
          set({ snapshot: payload.state, summary: payload.summary, loadedAt: Date.now() });
        } catch {
          /* 网络抖动时保持现有快照 */
        }
      },

      setActor: (actor) => set({ actor }),
      toggleOnline: () => set((state) => ({ online: !state.online })),
      selectRecord: (id) => set({ selectedRecordId: id }),

      enqueue: (label, mutation) => {
        set((state) => ({ outbox: [...state.outbox, { clientId: newClientId(), label, mutation, status: 'pending' }] }));
        void get().processOutbox();
      },

      processOutbox: async () => {
        if (get().processing) return;
        set({ processing: true });
        try {
          for (;;) {
            const next = get().outbox.find((item) => item.status === 'pending');
            if (!next) break;
            if (!get().online) {
              // 模拟断网：整批停止，未确认记录留在队列里等待重试
              set((state) => ({
                outbox: state.outbox.map((item) =>
                  item.status === 'pending' ? { ...item, status: 'failed', error: '网络中断，写入未确认' } : item
                )
              }));
              break;
            }
            set((state) => ({ outbox: state.outbox.map((item) => (item.clientId === next.clientId ? { ...item, status: 'saving' } : item)) }));
            try {
              const result = await postMutation(next.clientId, get().actor, next.mutation);
              if (result.accepted) {
                set((state) => ({
                  snapshot: result.state,
                  summary: result.summary ?? state.summary,
                  outbox: state.outbox.map((item) =>
                    item.clientId === next.clientId
                      ? { ...item, status: 'confirmed', error: result.alreadyApplied ? '服务端已生效，未重复写入' : undefined }
                      : item
                  )
                }));
              } else if (result.reason === 'revision-conflict') {
                // 后到者：接纳服务端最新值，本地保留冲突副本等待处理
                set((state) => ({
                  snapshot: result.state,
                  summary: result.summary ?? state.summary,
                  outbox: state.outbox.map((item) =>
                    item.clientId === next.clientId ? { ...item, status: 'conflict', conflictLatest: result.latest } : item
                  )
                }));
              } else if (result.reason === 'gate-blocked') {
                set((state) => ({
                  snapshot: result.state,
                  summary: result.summary ?? state.summary,
                  outbox: state.outbox.map((item) =>
                    item.clientId === next.clientId ? { ...item, status: 'failed', error: '签发门禁未通过', gaps: result.gaps } : item
                  )
                }));
              } else {
                set((state) => ({
                  snapshot: result.state,
                  summary: result.summary ?? state.summary,
                  outbox: state.outbox.map((item) =>
                    item.clientId === next.clientId ? { ...item, status: 'failed', error: result.message } : item
                  )
                }));
              }
            } catch {
              // 网络中断：本条标记失败，后续记录保持未确认，整批停止
              set((state) => ({
                outbox: state.outbox.map((item) =>
                  item.clientId === next.clientId
                    ? { ...item, status: 'failed', error: '网络中断，写入未确认' }
                    : item.status === 'pending'
                      ? { ...item, status: 'failed', error: '批次中断，等待重试' }
                      : item
                )
              }));
              break;
            }
          }
        } finally {
          set({ processing: false });
        }
      },

      // 断网恢复后只重试未确认记录；已确认的不重发，服务端版本与他人的修订都不会被覆盖
      retryUnconfirmed: () => {
        set((state) => ({
          outbox: state.outbox.map((item) => (item.status === 'failed' ? { ...item, status: 'pending', error: undefined } : item))
        }));
        void get().processOutbox();
      },

      // 基于服务端最新版本重新提交冲突副本（新的 clientId = 新的写入意图）
      rebaseConflict: (clientId) => {
        const item = get().outbox.find((entry) => entry.clientId === clientId);
        if (!item || item.status !== 'conflict' || !item.conflictLatest) return;
        const latest = item.conflictLatest;
        const mutation = item.mutation;
        let rebased: Mutation | null = null;
        if (mutation.kind === 'revise-data') rebased = { ...mutation, baseRevision: latest.revision };
        if (mutation.kind === 'verify') rebased = { ...mutation, baseRevision: latest.revision };
        if (mutation.kind === 'start-review') rebased = { ...mutation, baseRevision: latest.revision };
        set((state) => ({ outbox: state.outbox.filter((entry) => entry.clientId !== clientId) }));
        if (rebased) get().enqueue(`${item.label}（基于 V${latest.revision} 重提）`, rebased);
      },

      discardItem: (clientId) => set((state) => ({ outbox: state.outbox.filter((item) => item.clientId !== clientId) })),
      clearConfirmed: () => set((state) => ({ outbox: state.outbox.filter((item) => item.status !== 'confirmed') }))
    }),
    {
      name: 'yy60-carbon-evidence',
      // 只持久化操作端身份；业务状态以服务端版本链为准，避免旧快照复活
      partialize: (state) => ({ actor: state.actor, online: state.online, selectedRecordId: state.selectedRecordId })
    }
  )
);
