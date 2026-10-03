import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  evidenceResponseSchema,
  commitOpSchema,
  batchCommitResponseSchema,
  commitResponseSchema,
  type CarbonRecord,
  type Finding,
  type ChainOp,
  type CommitResponse
} from '@/lib/schema';
import {
  seedProject,
  seedSummary,
  defaultChainVersion,
  defaultRecords,
  defaultFindings,
  defaultIssuanceChecks
} from '@/lib/seed';

/**
 * 服务端是监测期版本链的权威方。
 * - 每条记录 / 发现项有自己的 revision 作为乐观锁令牌；
 * - 全局 chainVersion 随任何已接纳写操作递增，用于失效重算；
 * - 先到先得：baseRevision 与服务端一致才接纳，否则回冲突副本；
 * - opId 幂等：断网重试不会重复生效、也不会覆盖他人刚保存的修订。
 */
type ServerState = {
  chainVersion: number;
  records: CarbonRecord[];
  findings: Finding[];
  issuanceChecks: Record<string, boolean>;
  appliedOpIds: Set<string>;
};

const state: ServerState = {
  chainVersion: defaultChainVersion,
  records: defaultRecords.map((record) => ({ ...record })),
  findings: defaultFindings.map((finding) => ({ ...finding })),
  issuanceChecks: { ...defaultIssuanceChecks },
  appliedOpIds: new Set()
};

function publicState() {
  return {
    chainVersion: state.chainVersion,
    records: state.records.map((record) => ({ ...record })),
    findings: state.findings.map((finding) => ({ ...finding })),
    issuanceChecks: { ...state.issuanceChecks }
  };
}

function conflict(op: ChainOp): CommitResponse {
  return {
    opId: op.opId,
    accepted: false,
    ...publicState(),
    conflictCopy: { type: op.type, recordId: op.recordId, findingId: op.findingId, payload: op.payload ?? null }
  };
}

function applyOp(op: ChainOp): CommitResponse {
  switch (op.type) {
    case 'revise': {
      const record = state.records.find((item) => item.id === op.recordId);
      if (!record || record.revision !== op.baseRevision) return conflict(op);
      const value = Number(op.payload?.value);
      if (!Number.isFinite(value)) return conflict(op);
      record.activity = value;
      record.revision += 1;
      record.status = '复核中';
      record.verifiedAtChain = null;
      // 活动数据一变：关联发现项退回处理，签发门禁重算。
      for (const finding of state.findings) {
        if (finding.recordId === record.id) {
          finding.status = '开放';
          finding.resolvedAtChain = null;
          finding.revision += 1;
        }
      }
      for (const key of Object.keys(state.issuanceChecks)) state.issuanceChecks[key] = false;
      break;
    }
    case 'verify': {
      const record = state.records.find((item) => item.id === op.recordId);
      if (!record || record.revision !== op.baseRevision) return conflict(op);
      record.status = '已核验';
      record.verifiedAtChain = state.chainVersion + 1;
      record.revision += 1;
      break;
    }
    case 'startCorrection': {
      const record = state.records.find((item) => item.id === op.recordId);
      if (!record || record.revision !== op.baseRevision) return conflict(op);
      record.status = '复核中';
      record.verifiedAtChain = null;
      record.revision += 1;
      break;
    }
    case 'requestEvidence': {
      const finding = state.findings.find((item) => item.id === op.findingId);
      if (!finding || finding.revision !== op.baseRevision) return conflict(op);
      finding.status = '补证中';
      finding.revision += 1;
      break;
    }
    case 'closeFinding': {
      const finding = state.findings.find((item) => item.id === op.findingId);
      if (!finding || finding.revision !== op.baseRevision) return conflict(op);
      finding.status = '已关闭';
      finding.resolvedAtChain = state.chainVersion + 1;
      finding.revision += 1;
      break;
    }
    case 'toggleIssuance': {
      if (state.chainVersion !== op.baseChainVersion) return conflict(op);
      const key = String(op.payload?.id ?? '');
      if (!(key in state.issuanceChecks)) return conflict(op);
      state.issuanceChecks[key] = !state.issuanceChecks[key];
      break;
    }
    case 'toggleSample': {
      // 抽样勾选是视图选择，不驱动链版本，直接幂等接纳。
      break;
    }
  }
  state.chainVersion += 1;
  return { opId: op.opId, accepted: true, ...publicState() };
}

export async function GET() {
  return NextResponse.json(evidenceResponseSchema.parse({ project: seedProject, summary: seedSummary, ...publicState() }));
}

export async function POST(request: Request) {
  const body = commitOpSchema.safeParse(await request.json());
  if (!body.success) {
    return NextResponse.json({ accepted: false, error: body.error.flatten() }, { status: 400 });
  }
  const op = body.data;
  // 幂等：已生效的 op 重试直接返回当前值，不重复应用、不覆盖他人修订。
  if (state.appliedOpIds.has(op.opId)) {
    return NextResponse.json(commitResponseSchema.parse({ opId: op.opId, accepted: true, ...publicState() }));
  }
  const result = applyOp(op);
  if (result.accepted) state.appliedOpIds.add(op.opId);
  return NextResponse.json(commitResponseSchema.parse(result));
}

/** 批量写入：逐条独立接纳，返回每条结果；客户端据此只重试未确认记录。 */
export async function PUT(request: Request) {
  const body = await request.json();
  const parsed = z.array(commitOpSchema).safeParse(body?.ops);
  if (!parsed.success) {
    return NextResponse.json({ accepted: false, error: parsed.error.flatten() }, { status: 400 });
  }
  const results: CommitResponse[] = parsed.data.map((op) => {
    if (state.appliedOpIds.has(op.opId)) {
      return commitResponseSchema.parse({ opId: op.opId, accepted: true, ...publicState() });
    }
    const result = applyOp(op);
    if (result.accepted) state.appliedOpIds.add(op.opId);
    return commitResponseSchema.parse(result);
  });
  return NextResponse.json(batchCommitResponseSchema.parse({ results }));
}
