// 服务端监测期状态：内存版"服务端版本"，通过 globalThis 在热更新间保持。
// 负责乐观并发判定与幂等重试——已生效的写入不会因为客户端重试而重复应用。
import { applyMutation, seedState, type Mutation, type MutationResult, type PeriodState } from './domain';

type ProcessedEntry = { result: MutationResult };

type ServerStore = {
  state: PeriodState;
  /** clientId → 首次成功应用的结果；断网重试时直接返回，不重复写入 */
  processed: Map<string, ProcessedEntry>;
};

const globalHolder = globalThis as unknown as { __yy60CarbonStore?: ServerStore };

function getStore(): ServerStore {
  if (!globalHolder.__yy60CarbonStore) {
    globalHolder.__yy60CarbonStore = { state: seedState(), processed: new Map() };
  }
  return globalHolder.__yy60CarbonStore;
}

export function getState(): PeriodState {
  return getStore().state;
}

export function applyClientMutation(clientId: string, mutation: Mutation, actor: string): MutationResult {
  const store = getStore();
  const seen = store.processed.get(clientId);
  if (seen) {
    // 同一 clientId 的重试：返回首次结果，服务端版本与已生效数据保持不变
    return { ...seen.result, alreadyApplied: true } as MutationResult;
  }
  const result = applyMutation(store.state, mutation, actor);
  if (result.accepted) {
    store.processed.set(clientId, { result });
    if (store.processed.size > 500) {
      const oldest = store.processed.keys().next().value;
      if (oldest) store.processed.delete(oldest);
    }
  }
  return result;
}
