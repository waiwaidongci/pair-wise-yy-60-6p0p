// 监测期版本链领域模型：记录核验、发现项处理、签发准备共用同一条链。
// 该文件同时被服务端路由与前端 store 引用，保持纯函数、无副作用。

export type RecordStatus = '待核验' | '复核中' | '已核验' | '需补证';

/** 核验结果：绑定到具体的数据版本（revision）。数据一变即失效。 */
export type Verification = {
  revision: number;
  by: string;
  at: string;
};

export type CarbonRecord = {
  id: string;
  source: string;
  activity: number;
  unit: string;
  factor: number;
  factorUnit: string;
  timeRange: string;
  evidenceCount: number;
  /** 上一监测期活动数据，用于重算异常波动 */
  baseline: number;
  anomaly: number;
  owner: string;
  status: RecordStatus;
  /** 数据版本号：活动数据每修订一次 +1，也是乐观并发的比较基准 */
  revision: number;
  /** 最近一次的核验结果；verification.revision !== revision 时视为已失效 */
  verification: Verification | null;
};

export type Finding = {
  id: string;
  recordId: string;
  type: '缺失证据' | '单位不一致' | '时间范围' | '异常波动';
  title: string;
  detail: string;
  assignee: string;
  due: string;
  status: '开放' | '补证中' | '已关闭';
  /** 退回/重开原因等备注 */
  note?: string;
};

/** 签发准备检查项：勾选时绑定当时的数据纪元（dataEpoch） */
export type IssuanceCheck = {
  id: string;
  checked: boolean;
  dataEpoch: number;
  by: string | null;
  at: string | null;
};

export type ChainEvent = {
  seq: number;
  at: string;
  actor: string;
  kind: '数据修订' | '记录核验' | '发现项' | '签发检查' | '签发提交';
  summary: string;
  recordId?: string;
};

export type PeriodState = {
  project: {
    id: string;
    name: string;
    methodology: string;
    vintage: string;
    verifier: string;
  };
  period: string;
  /** 数据纪元：任何活动数据修订都会 +1，签发检查按此判定是否失效 */
  dataEpoch: number;
  /** 版本链头序号 */
  chainSeq: number;
  records: CarbonRecord[];
  findings: Finding[];
  issuanceChecks: IssuanceCheck[];
  sampledIds: string[];
  chain: ChainEvent[];
  submittedAt: string | null;
};

export type Mutation =
  | { kind: 'revise-data'; recordId: string; baseRevision: number; value: number; reason: string }
  | { kind: 'verify'; recordId: string; baseRevision: number }
  | { kind: 'start-review'; recordId: string; baseRevision: number }
  | { kind: 'finding'; findingId: string; action: 'request' | 'close' }
  | { kind: 'issuance-check'; checkId: string; checked: boolean }
  | { kind: 'sample'; recordId: string; sampled: boolean }
  | { kind: 'sample-anomaly'; ids: string[] }
  | { kind: 'submit-issuance' };

export type MutationResult =
  | { accepted: true; state: PeriodState; event: ChainEvent | null; alreadyApplied?: boolean }
  | { accepted: false; reason: 'revision-conflict'; recordId: string; serverRevision: number; latest: CarbonRecord; state: PeriodState }
  | { accepted: false; reason: 'gate-blocked'; gaps: string[]; state: PeriodState }
  | { accepted: false; reason: 'invalid'; message: string; state: PeriodState };

export const ISSUANCE_CHECK_DEFS = [
  { id: 'evidence', title: '证据与计算链完整', detail: '活动数据、排放因子、来源证据与修订说明可追溯。' },
  { id: 'calculation', title: '计算过程复核通过', detail: '单位和换算系数一致，关键公式由核验员确认。' },
  { id: 'revisions', title: '历史修订未覆盖原始数据', detail: '所有数据均有版本号和修订原因。' },
  { id: 'methodology', title: '方法学与监测计划匹配', detail: '项目采用当前备案方法学。' }
] as const;

const round1 = (value: number) => Math.round(value * 10) / 10;

/** 核验结果是否对当前数据版本有效 */
export function isVerificationCurrent(record: CarbonRecord): boolean {
  return record.verification !== null && record.verification.revision === record.revision;
}

/** 签发检查是否对当前数据纪元有效 */
export function isCheckCurrent(check: IssuanceCheck, state: PeriodState): boolean {
  return check.checked && check.dataEpoch === state.dataEpoch;
}

/** 抽样统计：随记录与核验状态派生，数据一变即重算 */
export function samplingStats(state: PeriodState) {
  const sampled = state.records.filter((record) => state.sampledIds.includes(record.id));
  const verified = sampled.filter(isVerificationCurrent);
  const stale = sampled.filter((record) => record.verification !== null && !isVerificationCurrent(record));
  return {
    total: sampled.length,
    verified: verified.length,
    stale: stale.length,
    pending: sampled.length - verified.length,
    highAnomalyIds: state.records.filter((record) => Math.abs(record.anomaly) > 5).map((record) => record.id)
  };
}

export type IssuanceGate = { ready: boolean; gaps: string[]; readiness: number };

/** 签发准备门禁：任一项未完成时给出缺口说明 */
export function computeIssuanceGate(state: PeriodState): IssuanceGate {
  const gaps: string[] = [];
  for (const def of ISSUANCE_CHECK_DEFS) {
    const check = state.issuanceChecks.find((item) => item.id === def.id);
    if (!check || !check.checked) {
      gaps.push(`签发检查「${def.title}」未确认`);
    } else if (check.dataEpoch !== state.dataEpoch) {
      gaps.push(`签发检查「${def.title}」基于旧数据版本，已失效需重新确认`);
    }
  }
  for (const finding of state.findings.filter((item) => item.status !== '已关闭')) {
    gaps.push(`发现项 ${finding.id}（${finding.title}）未关闭`);
  }
  for (const record of state.records) {
    if (!isVerificationCurrent(record)) {
      gaps.push(
        record.verification
          ? `记录 ${record.id} 的核验基于 V${record.verification.revision}，当前数据为 V${record.revision}，需重新核验`
          : `记录 ${record.id} 尚未核验通过`
      );
    }
  }
  const validChecks = state.issuanceChecks.filter((check) => isCheckCurrent(check, state)).length;
  const openFindings = state.findings.filter((item) => item.status !== '已关闭').length;
  const allVerified = state.records.every(isVerificationCurrent);
  const readiness = Math.round((validChecks / ISSUANCE_CHECK_DEFS.length) * 70 + (openFindings === 0 ? 15 : 0) + (allVerified ? 15 : 0));
  return { ready: gaps.length === 0, gaps, readiness };
}

function pushChain(state: PeriodState, actor: string, kind: ChainEvent['kind'], summary: string, recordId?: string): ChainEvent {
  const event: ChainEvent = { seq: state.chainSeq + 1, at: new Date().toISOString(), actor, kind, summary, recordId };
  state.chainSeq = event.seq;
  state.chain = [...state.chain, event];
  return event;
}

function findRecord(state: PeriodState, recordId: string): CarbonRecord | undefined {
  return state.records.find((record) => record.id === recordId);
}

function conflict(state: PeriodState, record: CarbonRecord): MutationResult {
  return { accepted: false, reason: 'revision-conflict', recordId: record.id, serverRevision: record.revision, latest: { ...record }, state };
}

/**
 * 应用一条变更。记录级变更携带 baseRevision（打开页面时的版本号）：
 * 与服务端版本一致才接纳（先到者得），否则返回最新值，由调用方保留冲突副本。
 */
export function applyMutation(state: PeriodState, mutation: Mutation, actor: string): MutationResult {
  switch (mutation.kind) {
    case 'revise-data': {
      const record = findRecord(state, mutation.recordId);
      if (!record) return { accepted: false, reason: 'invalid', message: `记录 ${mutation.recordId} 不存在`, state };
      if (record.revision !== mutation.baseRevision) return conflict(state, record);
      if (!Number.isFinite(mutation.value) || mutation.value <= 0) return { accepted: false, reason: 'invalid', message: '修订值必须为正数', state };
      if (!mutation.reason.trim()) return { accepted: false, reason: 'invalid', message: '必须填写修订原因', state };

      record.activity = mutation.value;
      record.revision += 1;
      record.anomaly = round1(((mutation.value - record.baseline) / record.baseline) * 100);
      // 级联一：旧核验结果失效（保留在 verification 中供审计），状态退回复核
      if (record.status === '已核验') record.status = '复核中';
      // 级联二：关联发现项退回处理
      const reopened: string[] = [];
      for (const finding of state.findings) {
        if (finding.recordId === record.id && finding.status !== '开放') {
          finding.status = '开放';
          finding.note = `数据修订至 V${record.revision}，原处理结论作废，退回重新处理`;
          reopened.push(finding.id);
        }
      }
      // 级联三：数据纪元 +1，签发准备门禁随之重算（旧勾选全部失效）
      state.dataEpoch += 1;
      state.submittedAt = null;
      const event = pushChain(
        state,
        actor,
        '数据修订',
        `${record.id} 活动数据修订为 ${mutation.value.toLocaleString()} ${record.unit}（V${record.revision}）：${mutation.reason.trim()}。` +
          `核验结果与抽样统计失效重算${reopened.length ? `，发现项 ${reopened.join('、')} 退回处理` : ''}，签发门禁按新版本重算。`,
        record.id
      );
      return { accepted: true, state, event };
    }
    case 'verify': {
      const record = findRecord(state, mutation.recordId);
      if (!record) return { accepted: false, reason: 'invalid', message: `记录 ${mutation.recordId} 不存在`, state };
      if (record.revision !== mutation.baseRevision) return conflict(state, record);
      if (record.status === '需补证') return { accepted: false, reason: 'invalid', message: `记录 ${record.id} 处于需补证状态，不能通过核验`, state };
      record.verification = { revision: record.revision, by: actor, at: new Date().toISOString() };
      record.status = '已核验';
      const event = pushChain(state, actor, '记录核验', `${record.id} 核验通过，绑定数据版本 V${record.revision}`, record.id);
      return { accepted: true, state, event };
    }
    case 'start-review': {
      const record = findRecord(state, mutation.recordId);
      if (!record) return { accepted: false, reason: 'invalid', message: `记录 ${mutation.recordId} 不存在`, state };
      if (record.revision !== mutation.baseRevision) return conflict(state, record);
      record.status = '复核中';
      const event = pushChain(state, actor, '记录核验', `${record.id} 退回复核中`, record.id);
      return { accepted: true, state, event };
    }
    case 'finding': {
      const finding = state.findings.find((item) => item.id === mutation.findingId);
      if (!finding) return { accepted: false, reason: 'invalid', message: `发现项 ${mutation.findingId} 不存在`, state };
      const record = findRecord(state, finding.recordId);
      if (mutation.action === 'request') {
        finding.status = '补证中';
        if (record) record.status = '需补证';
        const event = pushChain(state, actor, '发现项', `${finding.id} 发起补证，记录 ${finding.recordId} 标记为需补证`, finding.recordId);
        return { accepted: true, state, event };
      }
      finding.status = '已关闭';
      finding.note = undefined;
      if (record && record.status === '需补证' && !state.findings.some((item) => item.recordId === record.id && item.status !== '已关闭')) {
        record.status = '复核中';
      }
      const event = pushChain(state, actor, '发现项', `${finding.id} 已关闭`, finding.recordId);
      return { accepted: true, state, event };
    }
    case 'issuance-check': {
      const check = state.issuanceChecks.find((item) => item.id === mutation.checkId);
      if (!check) return { accepted: false, reason: 'invalid', message: `检查项 ${mutation.checkId} 不存在`, state };
      check.checked = mutation.checked;
      check.dataEpoch = state.dataEpoch;
      check.by = actor;
      check.at = new Date().toISOString();
      const def = ISSUANCE_CHECK_DEFS.find((item) => item.id === check.id);
      const event = pushChain(state, actor, '签发检查', `「${def?.title ?? check.id}」${mutation.checked ? '确认' : '取消确认'}，绑定数据纪元 #${state.dataEpoch}`);
      return { accepted: true, state, event };
    }
    case 'sample': {
      state.sampledIds = mutation.sampled
        ? Array.from(new Set([...state.sampledIds, mutation.recordId]))
        : state.sampledIds.filter((id) => id !== mutation.recordId);
      return { accepted: true, state, event: null };
    }
    case 'sample-anomaly': {
      state.sampledIds = Array.from(new Set(mutation.ids));
      return { accepted: true, state, event: null };
    }
    case 'submit-issuance': {
      const gate = computeIssuanceGate(state);
      if (!gate.ready) return { accepted: false, reason: 'gate-blocked', gaps: gate.gaps, state };
      state.submittedAt = new Date().toISOString();
      const event = pushChain(state, actor, '签发提交', `签发准备提交，门禁 ${ISSUANCE_CHECK_DEFS.length} 项全部通过，数据纪元 #${state.dataEpoch}`);
      return { accepted: true, state, event };
    }
  }
}

export function seedState(): PeriodState {
  return {
    project: {
      id: 'CN-ER-2026-041',
      name: '临港工业园区能效提升项目',
      methodology: 'CMS-052-V01',
      vintage: '2026 监测年度',
      verifier: '华碳认证 · 核验组 B'
    },
    period: '2026 年第三监测期',
    dataEpoch: 0,
    chainSeq: 4,
    records: [
      { id: 'ACT-0318', source: '电表 E-17 / 四号压缩机组', activity: 428650, unit: 'kWh', factor: 0.5568, factorUnit: 'tCO2/MWh', timeRange: '2026-07-01 至 07-31', evidenceCount: 4, baseline: 419012, anomaly: 2.3, owner: '项目现场 O2', status: '复核中', revision: 3, verification: null },
      { id: 'ACT-0321', source: '蒸汽流量计 ST-04', activity: 2038.4, unit: 'GJ', factor: 0.1100, factorUnit: 'tCO2/GJ', timeRange: '2026-07-01 至 07-31', evidenceCount: 3, baseline: 2038.4, anomaly: 0, owner: '能源中心', status: '已核验', revision: 2, verification: { revision: 2, by: '沈楠', at: '2026-09-28T02:30:00.000Z' } },
      { id: 'ACT-0325', source: '柴油消耗台账 / 应急泵', activity: 1846, unit: 'L', factor: 2.6800, factorUnit: 'kgCO2/L', timeRange: '2026-07-01 至 07-31', evidenceCount: 2, baseline: 1700, anomaly: 8.6, owner: '设备保障部', status: '需补证', revision: 4, verification: null },
      { id: 'ACT-0331', source: '光伏逆变器阵列 PV-2', activity: 182460, unit: 'kWh', factor: 0.5568, factorUnit: 'tCO2/MWh', timeRange: '2026-07-01 至 07-31', evidenceCount: 5, baseline: 184676, anomaly: -1.2, owner: '新能源运维', status: '已核验', revision: 1, verification: { revision: 1, by: '沈楠', at: '2026-09-27T08:10:00.000Z' } },
      { id: 'ACT-0337', source: '天然气流量计 NG-02', activity: 62.8, unit: 'kNm3', factor: 2.1622, factorUnit: 'tCO2/kNm3', timeRange: '2026-07-01 至 07-31', evidenceCount: 1, baseline: 55.87, anomaly: 12.4, owner: '热力站', status: '待核验', revision: 1, verification: null }
    ],
    findings: [
      { id: 'F-104', recordId: 'ACT-0337', type: '缺失证据', title: '缺少天然气流量计校验证书', detail: '计量记录已提交，但校准有效期证明不足。', assignee: '热力站 · 韩跃', due: '09-30', status: '开放' },
      { id: 'F-105', recordId: 'ACT-0325', type: '异常波动', title: '柴油消耗较上期上升 18.6%', detail: '项目方尚未说明测试运行时长变化。', assignee: '设备保障部 · 姜婷', due: '10-02', status: '补证中' },
      { id: 'F-106', recordId: 'ACT-0318', type: '单位不一致', title: '原始表单位为 MWh，台账记录为 kWh', detail: '需补充单位换算链并保留原始记录。', assignee: '项目现场 · 徐璐', due: '09-30', status: '开放' }
    ],
    issuanceChecks: [
      { id: 'evidence', checked: false, dataEpoch: 0, by: null, at: null },
      { id: 'calculation', checked: true, dataEpoch: 0, by: '沈楠', at: '2026-09-28T06:00:00.000Z' },
      { id: 'revisions', checked: true, dataEpoch: 0, by: '沈楠', at: '2026-09-28T06:00:00.000Z' },
      { id: 'methodology', checked: false, dataEpoch: 0, by: null, at: null }
    ],
    sampledIds: ['ACT-0318', 'ACT-0337'],
    chain: [
      { seq: 1, at: '2026-09-25T09:12:00.000Z', actor: '徐璐', kind: '数据修订', summary: 'ACT-0318 统一电量单位为 kWh 并附原始记录（V2）', recordId: 'ACT-0318' },
      { seq: 2, at: '2026-09-26T03:40:00.000Z', actor: '沈楠', kind: '发现项', summary: 'F-104 发起：缺少天然气流量计校验证书', recordId: 'ACT-0337' },
      { seq: 3, at: '2026-09-27T07:05:00.000Z', actor: '韩跃', kind: '数据修订', summary: 'ACT-0325 修订柴油活动数据并补充测试运行说明（V4）', recordId: 'ACT-0325' },
      { seq: 4, at: '2026-09-28T02:30:00.000Z', actor: '沈楠', kind: '记录核验', summary: 'ACT-0321 核验通过，绑定数据版本 V2', recordId: 'ACT-0321' }
    ],
    submittedAt: null
  };
}

export type Summary = {
  period: string;
  reduction: number;
  evidenceRate: number;
  openFindings: number;
  sampled: number;
  sampledVerified: number;
};

/** 汇总指标：全部由记录派生，数据修订后自动重算 */
export function summarize(state: PeriodState): Summary {
  const reduction = state.records.reduce(
    (total, record) => total + (record.activity * record.factor) / (record.unit === 'kWh' || record.unit === 'L' ? 1000 : 1),
    0
  );
  const stats = samplingStats(state);
  return {
    period: state.period,
    reduction: Math.round(reduction),
    evidenceRate: Math.round((state.records.filter((record) => record.evidenceCount >= 3).length / state.records.length) * 100),
    openFindings: state.findings.filter((item) => item.status !== '已关闭').length,
    sampled: stats.total,
    sampledVerified: stats.verified
  };
}
