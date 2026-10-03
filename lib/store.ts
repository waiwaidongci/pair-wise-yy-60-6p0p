import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { commitOp as apiCommitOp, fetchEvidence } from './api';
import type { ChainOp, ChainOpType, CommitResponse, Finding } from './schema';
import {
  defaultChainVersion,
  defaultRecords,
  defaultFindings,
  defaultIssuanceChecks,
  seedChainLog
} from './seed';

export type { CarbonRecord, Finding, RecordStatus } from './schema';

export type NetworkMode = 'online' | 'flaky' | 'offline';

export type OutboxOp = {
  opId: string;
  type: ChainOpType;
  recordId?: string;
  findingId?: string;
  baseChainVersion: number;
  baseRevision?: number;
  payload: Record<string, unknown>;
  status: 'pending' | 'confirmed' | 'conflict';
  attempts: number;
  conflictCopy?: unknown;
  error?: string;
  createdAt: number;
};

export type ConflictNotice = {
  id: string;
  opId: string;
  recordId?: string;
  findingId?: string;
  type: ChainOpType;
  message: string;
  latestSummary: string;
  attemptedSummary: string;
};

export type ChainEvent = {
  version: number;
  actor: string;
  type: ChainOpType;
  detail: string;
};

const uuid = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

const opLabels: Record<ChainOpType, string> = {
  revise: '修订',
  verify: '核验',
  startCorrection: '复核',
  requestEvidence: '发起补证',
  closeFinding: '关闭发现项',
  toggleIssuance: '签发勾选',
  toggleSample: '抽样'
};

const opActors: Record<ChainOpType, string> = {
  revise: '现场补交',
  verify: '核验员',
  startCorrection: '核验员',
  requestEvidence: '核验员',
  closeFinding: '核验员',
  toggleIssuance: '核验员',
  toggleSample: '核验员'
};

const opDetails: Record<ChainOpType, string> = {
  revise: '修订活动数据并生成新版本',
  verify: '核验通过记录',
  startCorrection: '退回复核',
  requestEvidence: '发起补充证据',
  closeFinding: '关闭发现项',
  toggleIssuance: '切换签发准备门禁',
  toggleSample: '调整抽样任务'
};

type State = {
  chainVersion: number;
  records: import('./schema').CarbonRecord[];
  findings: Finding[];
  issuanceChecks: Record<string, boolean>;
  selectedRecordId: string;
  sampledIds: string[];
  outbox: OutboxOp[];
  conflicts: ConflictNotice[];
  chainLog: ChainEvent[];
  networkMode: NetworkMode;
  hydrated: boolean;

  hydrate: () => Promise<void>;
  selectRecord: (id: string) => void;
  setNetworkMode: (mode: NetworkMode) => void;
  toggleSample: (id: string) => void;

  reviseValue: (id: string, value: number, reason: string) => Promise<void>;
  verifyRecord: (id: string) => Promise<void>;
  startCorrection: (id: string) => Promise<void>;
  batchVerify: () => Promise<void>;
  requestEvidence: (findingId: string) => Promise<void>;
  closeFinding: (findingId: string) => Promise<void>;
  toggleIssuanceCheck: (id: string) => Promise<void>;

  retryPending: () => Promise<void>;
  dismissConflict: (id: string) => void;
  clearConfirmed: () => void;
};

/** 模拟网络：online 全成功；flaky 中途随机失败（部分记录已生效、部分未确认）；offline 全断。 */
function simulateNetwork(mode: NetworkMode): 'ok' | 'fail' {
  if (mode === 'offline') return 'fail';
  if (mode === 'flaky' && Math.random() < 0.45) return 'fail';
  return 'ok';
}

function makeConflictNotice(op: OutboxOp, res: CommitResponse): ConflictNotice {
  const latestRecord = op.recordId ? res.records.find((r) => r.id === op.recordId) : undefined;
  const latestFinding = op.findingId ? res.findings.find((f) => f.id === op.findingId) : undefined;
  const latestSummary = latestRecord
    ? `最新 ${latestRecord.id} · V${latestRecord.revision} · ${latestRecord.status}`
    : latestFinding
      ? `最新 ${latestFinding.id} · ${latestFinding.status}`
      : `最新链版本 V${res.chainVersion}`;
  const attemptedSummary = `${opLabels[op.type]}${op.recordId ? ` ${op.recordId}` : ''}${op.findingId ? ` ${op.findingId}` : ''}（打开时 V${op.baseChainVersion}${op.baseRevision ? ` / 记录 V${op.baseRevision}` : ''}）`;
  return {
    id: `C-${op.opId}`,
    opId: op.opId,
    recordId: op.recordId,
    findingId: op.findingId,
    type: op.type,
    message: `该记录已被他人抢先保存，${opLabels[op.type]}未生效，已保留冲突副本。`,
    latestSummary,
    attemptedSummary
  };
}

export const useCarbonStore = create<State>()(
  persist(
    (set, get) => {
      /** 写入统一走产箱：携带打开页面时的版本号，先到先得；未确认则留在产箱待重试。 */
      async function enqueue(partial: {
        type: ChainOpType;
        recordId?: string;
        findingId?: string;
        payload?: Record<string, unknown>;
      }) {
        const state = get();
        const record = partial.recordId ? state.records.find((r) => r.id === partial.recordId) : undefined;
        const finding = partial.findingId ? state.findings.find((f) => f.id === partial.findingId) : undefined;
        const op: OutboxOp = {
          opId: uuid(),
          type: partial.type,
          recordId: partial.recordId,
          findingId: partial.findingId,
          baseChainVersion: state.chainVersion,
          baseRevision: record?.revision ?? finding?.revision,
          payload: partial.payload ?? {},
          status: 'pending',
          attempts: 0,
          createdAt: Date.now()
        };
        set((s) => ({ outbox: [...s.outbox, op] }));
        await runOp(set, get, op);
      }

      return {
        chainVersion: defaultChainVersion,
        records: defaultRecords,
        findings: defaultFindings,
        issuanceChecks: { ...defaultIssuanceChecks },
        selectedRecordId: 'ACT-0318',
        sampledIds: ['ACT-0318', 'ACT-0337'],
        outbox: [],
        conflicts: [],
        chainLog: seedChainLog.map((event) => ({ ...event })),
        networkMode: 'online',
        hydrated: false,

        hydrate: async () => {
          try {
            const res = await fetchEvidence();
            set((state) => ({
              chainVersion: res.chainVersion ?? defaultChainVersion,
              records: res.records,
              findings: res.findings ?? defaultFindings,
              issuanceChecks: res.issuanceChecks ?? defaultIssuanceChecks,
              hydrated: true,
              // 产箱中已确认的写入不再回放；未确认的保留，等重试。
              outbox: state.outbox.filter((op) => op.status !== 'confirmed')
            }));
          } catch {
            set({ hydrated: true });
          }
        },

        selectRecord: (id) => set({ selectedRecordId: id }),
        setNetworkMode: (mode) => set({ networkMode: mode }),

        toggleSample: (id) => {
          set((state) => ({
            sampledIds: state.sampledIds.includes(id)
              ? state.sampledIds.filter((item) => item !== id)
              : [...state.sampledIds, id]
          }));
          void enqueue({ type: 'toggleSample', recordId: id, payload: { id } });
        },

        reviseValue: async (id, value, reason) => {
          await enqueue({ type: 'revise', recordId: id, payload: { value, reason } });
        },
        verifyRecord: async (id) => {
          await enqueue({ type: 'verify', recordId: id });
        },
        startCorrection: async (id) => {
          await enqueue({ type: 'startCorrection', recordId: id });
        },
        batchVerify: async () => {
          const state = get();
          const targets = state.records.filter(
            (record) => state.sampledIds.includes(record.id) && record.status !== '需补证'
          );
          await Promise.all(targets.map((record) => enqueue({ type: 'verify', recordId: record.id })));
        },
        requestEvidence: async (findingId) => {
          await enqueue({ type: 'requestEvidence', findingId });
        },
        closeFinding: async (findingId) => {
          await enqueue({ type: 'closeFinding', findingId });
        },
        toggleIssuanceCheck: async (id) => {
          await enqueue({ type: 'toggleIssuance', payload: { id } });
        },

        retryPending: async () => {
          const pending = get().outbox.filter((op) => op.status === 'pending');
          await Promise.all(pending.map((op) => runOp(set, get, op)));
        },

        dismissConflict: (id) =>
          set((state) => ({
            conflicts: state.conflicts.filter((notice) => notice.id !== id),
            outbox: state.outbox.filter((op) => op.opId !== id.replace(/^C-/, ''))
          })),

        clearConfirmed: () => set((state) => ({ outbox: state.outbox.filter((op) => op.status !== 'confirmed') }))
      };
    },
    {
      name: 'yy60-carbon-evidence-v2',
      partialize: (state) => ({
        chainVersion: state.chainVersion,
        records: state.records,
        findings: state.findings,
        issuanceChecks: state.issuanceChecks,
        selectedRecordId: state.selectedRecordId,
        sampledIds: state.sampledIds,
        outbox: state.outbox,
        conflicts: state.conflicts,
        chainLog: state.chainLog
      })
    }
  )
);

async function runOp(
  set: (partial: Partial<State> | ((s: State) => Partial<State>)) => void,
  get: () => State,
  op: OutboxOp
) {
  const state = get();
  if (simulateNetwork(state.networkMode) === 'fail') {
    set((s) => ({
      outbox: s.outbox.map((item) =>
        item.opId === op.opId
          ? { ...item, status: 'pending', attempts: item.attempts + 1, error: '断网：请求未到达服务端，版本未确认' }
          : item
      )
    }));
    return;
  }
  try {
    const res: CommitResponse = await apiCommitOp({
      opId: op.opId,
      type: op.type,
      recordId: op.recordId,
      findingId: op.findingId,
      baseChainVersion: op.baseChainVersion,
      baseRevision: op.baseRevision,
      payload: op.payload
    });
    // 先按服务端返回刷新链状态（冲突时返回的是他人已保存的最新值）。
    set((s) => ({
      chainVersion: res.chainVersion,
      records: res.records,
      findings: res.findings,
      issuanceChecks: res.issuanceChecks,
      outbox: s.outbox.map((item) =>
        item.opId === op.opId
          ? {
              ...item,
              status: res.accepted ? 'confirmed' : 'conflict',
              attempts: item.attempts + 1,
              error: undefined,
              conflictCopy: res.accepted ? undefined : res.conflictCopy
            }
          : item
      ),
      conflicts: res.accepted ? s.conflicts : [...s.conflicts, makeConflictNotice(op, res)],
      chainLog: res.accepted
        ? [
            {
              version: res.chainVersion,
              actor: opActors[op.type],
              type: op.type,
              detail: opDetails[op.type]
            },
            ...s.chainLog
          ].slice(0, 20)
        : s.chainLog
    }));
  } catch {
    set((s) => ({
      outbox: s.outbox.map((item) =>
        item.opId === op.opId
          ? { ...item, status: 'pending', attempts: item.attempts + 1, error: '网络错误：未收到服务端确认' }
          : item
      )
    }));
  }
}

// ---- 派生选择器：全部围绕同一条链版本 ----

export const openFindingsOf = (state: State) => state.findings.filter((finding) => finding.status !== '已关闭');

/** 活动数据一变，链上早于当前版本的核验结果即失效。 */
export const staleRecordIdsOf = (state: State) =>
  state.records
    .filter((record) => record.verifiedAtChain == null || record.verifiedAtChain < state.chainVersion)
    .map((record) => record.id);

export const sampledStatsOf = (state: State) => {
  const sampled = state.records.filter((record) => state.sampledIds.includes(record.id));
  const stale = sampled.filter((record) => record.verifiedAtChain == null || record.verifiedAtChain < state.chainVersion);
  return {
    sampled: sampled.length,
    verified: sampled.length - stale.length,
    stale: stale.length,
    staleIds: stale.map((record) => record.id)
  };
};

export const isRecordPendingOf = (state: State, recordId: string) =>
  state.outbox.some((op) => op.status === 'pending' && op.recordId === recordId);

export const isFindingPendingOf = (state: State, findingId: string) =>
  state.outbox.some((op) => op.status === 'pending' && op.findingId === findingId);

export const pendingOpsOf = (state: State) => state.outbox.filter((op) => op.status === 'pending');
export const conflictOpsOf = (state: State) => state.outbox.filter((op) => op.status === 'conflict');

export type IssuanceGap = { key: string; label: string; detail: string };

/** 签发门禁：任何未完成项都挡住提交，并逐项说明缺口。 */
export function issuanceGapsOf(state: State): IssuanceGap[] {
  const gaps: IssuanceGap[] = [];
  const open = openFindingsOf(state);
  if (open.length > 0) {
    gaps.push({
      key: 'findings',
      label: `开放发现项 ${open.length} 项`,
      detail: open.map((finding) => finding.title).join('；')
    });
  }
  const unchecked = Object.entries(state.issuanceChecks).filter(([, checked]) => !checked);
  if (unchecked.length > 0) {
    const titles: Record<string, string> = {
      evidence: '证据与计算链完整',
      calculation: '计算过程复核通过',
      revisions: '历史修订未覆盖原始数据',
      methodology: '方法学与监测计划匹配'
    };
    gaps.push({
      key: 'checks',
      label: `门禁未勾选 ${unchecked.length} 项`,
      detail: unchecked.map(([key]) => titles[key] ?? key).join('；')
    });
  }
  const stale = staleRecordIdsOf(state);
  if (stale.length > 0) {
    gaps.push({
      key: 'stale',
      label: `核验结果已失效 ${stale.length} 条`,
      detail: `活动数据变更后需重新核验：${stale.join('、')}`
    });
  }
  const stats = sampledStatsOf(state);
  if (stats.stale > 0) {
    gaps.push({
      key: 'sampling',
      label: `抽样统计待重算 ${stats.stale} 条`,
      detail: `抽样任务中有 ${stats.stale} 条记录的核验早于当前链版本 V${state.chainVersion}`
    });
  }
  return gaps;
}

export const allIssuanceReadyOf = (state: State) => issuanceGapsOf(state).length === 0;
