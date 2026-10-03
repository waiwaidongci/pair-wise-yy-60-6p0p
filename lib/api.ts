import ky, { HTTPError } from 'ky';
import type { Mutation, MutationResult, PeriodState, Summary } from './domain';
import { evidenceResponseSchema } from './schema';

const client = ky.create({ timeout: 10_000, retry: { limit: 1 } });
// 变更请求不做透明重试：重试只能走 outbox，配合 clientId 幂等，避免静默重复写入
const mutationClient = ky.create({ timeout: 10_000, retry: { limit: 0 } });

export type EvidencePayload = { state: PeriodState; summary: Summary };

export async function fetchEvidence(): Promise<EvidencePayload> {
  const payload = await client.get('/api/evidence').json<unknown>();
  return evidenceResponseSchema.parse(payload);
}

export type MutationResponse = MutationResult & { summary?: EvidencePayload['summary'] };

export async function postMutation(clientId: string, actor: string, mutation: Mutation): Promise<MutationResponse> {
  try {
    return await mutationClient.post('/api/evidence', { json: { clientId, actor, mutation } }).json<MutationResponse>();
  } catch (error) {
    if (error instanceof HTTPError) {
      // 409 版本冲突 / 422 门禁拦截：响应体里带有最新状态，照常返回给调用方
      const body = (await error.response.json().catch(() => null)) as MutationResponse | null;
      if (body && typeof body === 'object' && 'accepted' in body) return body;
    }
    throw error;
  }
}
