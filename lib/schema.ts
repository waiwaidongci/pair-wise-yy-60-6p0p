import { z } from 'zod';

export const recordStatusSchema = z.enum(['待核验', '复核中', '已核验', '需补证']);
export type RecordStatus = z.infer<typeof recordStatusSchema>;

export const findingStatusSchema = z.enum(['开放', '补证中', '已关闭']);
export type FindingStatus = z.infer<typeof findingStatusSchema>;

export const findingTypeSchema = z.enum(['缺失证据', '单位不一致', '时间范围', '异常波动']);

/** 监测期版本链上的聚合：记录、发现项、签发门禁都挂在同一条链上。 */
export const carbonRecordSchema = z.object({
  id: z.string(),
  source: z.string(),
  activity: z.number(),
  unit: z.string(),
  factor: z.number(),
  factorUnit: z.string(),
  timeRange: z.string(),
  evidenceCount: z.number(),
  anomaly: z.number(),
  owner: z.string(),
  status: recordStatusSchema,
  /** 记录自身数据版本，作为记录级乐观锁令牌。 */
  revision: z.number(),
  /** 该记录核验结果对哪个链版本有效；null 表示核验已失效、需重算。 */
  verifiedAtChain: z.number().nullable().optional()
});
export type CarbonRecord = z.infer<typeof carbonRecordSchema>;

export const findingSchema = z.object({
  id: z.string(),
  recordId: z.string(),
  type: findingTypeSchema,
  title: z.string(),
  detail: z.string(),
  assignee: z.string(),
  due: z.string(),
  status: findingStatusSchema,
  /** 发现项自身版本，作为发现项级乐观锁令牌。 */
  revision: z.number(),
  /** 处理结果对哪个链版本有效；null 表示已被退回、需重新处理。 */
  resolvedAtChain: z.number().nullable().optional()
});
export type Finding = z.infer<typeof findingSchema>;

export const chainOpTypeSchema = z.enum([
  'revise',
  'verify',
  'startCorrection',
  'requestEvidence',
  'closeFinding',
  'toggleIssuance',
  'toggleSample'
]);
export type ChainOpType = z.infer<typeof chainOpTypeSchema>;

export const projectSchema = z.object({
  id: z.string(),
  name: z.string(),
  methodology: z.string(),
  vintage: z.string(),
  verifier: z.string()
});

export const summarySchema = z.object({
  period: z.string(),
  reduction: z.number(),
  evidenceRate: z.number(),
  openFindings: z.number(),
  sampled: z.number()
});

export const chainStateSchema = z.object({
  /** 监测期版本链全局版本号，任何已接纳的写操作都使它 +1。 */
  chainVersion: z.number(),
  records: z.array(carbonRecordSchema),
  findings: z.array(findingSchema),
  issuanceChecks: z.record(z.string(), z.boolean())
});
export type ChainState = z.infer<typeof chainStateSchema>;

export const evidenceResponseSchema = z.object({
  project: projectSchema,
  summary: summarySchema,
  chainVersion: z.number().optional(),
  records: z.array(carbonRecordSchema),
  findings: z.array(findingSchema).optional(),
  issuanceChecks: z.record(z.string(), z.boolean()).optional()
});
export type EvidenceResponse = z.infer<typeof evidenceResponseSchema>;

/** 提交写入时携带打开页面时的版本号，服务端据此先到先得。 */
export const commitOpSchema = z.object({
  opId: z.string(),
  type: chainOpTypeSchema,
  recordId: z.string().optional(),
  findingId: z.string().optional(),
  baseChainVersion: z.number(),
  baseRevision: z.number().optional(),
  payload: z.record(z.string(), z.unknown()).optional()
});
export type ChainOp = z.infer<typeof commitOpSchema>;

export const commitResponseSchema = chainStateSchema.extend({
  opId: z.string(),
  accepted: z.boolean(),
  /** 冲突时回显客户端尝试写入的副本。 */
  conflictCopy: z.unknown().optional()
});
export type CommitResponse = z.infer<typeof commitResponseSchema>;

export const batchCommitResponseSchema = z.object({
  results: z.array(commitResponseSchema)
});
export type BatchCommitResponse = z.infer<typeof batchCommitResponseSchema>;
