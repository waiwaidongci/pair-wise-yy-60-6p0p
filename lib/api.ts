import ky from 'ky';
import {
  evidenceResponseSchema,
  commitResponseSchema,
  batchCommitResponseSchema,
  type EvidenceResponse,
  type ChainOp,
  type CommitResponse,
  type ChainState
} from './schema';

// 关闭 ky 自带重试：未确认记录由本地产箱只重试一次，避免覆盖他人刚保存的修订。
const client = ky.create({ timeout: 10_000, retry: { limit: 0 } });

export async function fetchEvidence(): Promise<EvidenceResponse> {
  const payload = await client.get('/api/evidence').json<unknown>();
  return evidenceResponseSchema.parse(payload);
}

/** 提交单条写入（记录核验 / 发现项处理 / 签发勾选），服务端按版本号先到先得。 */
export async function commitOp(op: ChainOp): Promise<CommitResponse> {
  const payload = await client.post('/api/evidence', { json: op }).json<unknown>();
  return commitResponseSchema.parse(payload);
}

/** 批量写入，逐条返回结果；断网时整批可能失败，由产箱只重试未确认记录。 */
export async function commitBatch(ops: ChainOp[]): Promise<CommitResponse[]> {
  const payload = await client.put('/api/evidence', { json: { ops } }).json<unknown>();
  return batchCommitResponseSchema.parse(payload).results;
}

export type { ChainState };
