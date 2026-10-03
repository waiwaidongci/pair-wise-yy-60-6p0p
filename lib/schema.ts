import { z } from 'zod';

const verificationSchema = z.object({
  revision: z.number(),
  by: z.string(),
  at: z.string()
});

const recordSchema = z.object({
  id: z.string(),
  source: z.string(),
  activity: z.number(),
  unit: z.string(),
  factor: z.number(),
  factorUnit: z.string(),
  timeRange: z.string(),
  evidenceCount: z.number(),
  baseline: z.number(),
  anomaly: z.number(),
  owner: z.string(),
  status: z.enum(['待核验', '复核中', '已核验', '需补证']),
  revision: z.number(),
  verification: verificationSchema.nullable()
});

const findingSchema = z.object({
  id: z.string(),
  recordId: z.string(),
  type: z.enum(['缺失证据', '单位不一致', '时间范围', '异常波动']),
  title: z.string(),
  detail: z.string(),
  assignee: z.string(),
  due: z.string(),
  status: z.enum(['开放', '补证中', '已关闭']),
  note: z.string().optional()
});

const issuanceCheckSchema = z.object({
  id: z.string(),
  checked: z.boolean(),
  dataEpoch: z.number(),
  by: z.string().nullable(),
  at: z.string().nullable()
});

const chainEventSchema = z.object({
  seq: z.number(),
  at: z.string(),
  actor: z.string(),
  kind: z.enum(['数据修订', '记录核验', '发现项', '签发检查', '签发提交']),
  summary: z.string(),
  recordId: z.string().optional()
});

export const periodStateSchema = z.object({
  project: z.object({
    id: z.string(),
    name: z.string(),
    methodology: z.string(),
    vintage: z.string(),
    verifier: z.string()
  }),
  period: z.string(),
  dataEpoch: z.number(),
  chainSeq: z.number(),
  records: z.array(recordSchema),
  findings: z.array(findingSchema),
  issuanceChecks: z.array(issuanceCheckSchema),
  sampledIds: z.array(z.string()),
  chain: z.array(chainEventSchema),
  submittedAt: z.string().nullable()
});

export const evidenceResponseSchema = z.object({
  state: periodStateSchema,
  summary: z.object({
    period: z.string(),
    reduction: z.number(),
    evidenceRate: z.number(),
    openFindings: z.number(),
    sampled: z.number(),
    sampledVerified: z.number()
  })
});

export const mutationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('revise-data'), recordId: z.string(), baseRevision: z.number(), value: z.number(), reason: z.string() }),
  z.object({ kind: z.literal('verify'), recordId: z.string(), baseRevision: z.number() }),
  z.object({ kind: z.literal('start-review'), recordId: z.string(), baseRevision: z.number() }),
  z.object({ kind: z.literal('finding'), findingId: z.string(), action: z.enum(['request', 'close']) }),
  z.object({ kind: z.literal('issuance-check'), checkId: z.string(), checked: z.boolean() }),
  z.object({ kind: z.literal('sample'), recordId: z.string(), sampled: z.boolean() }),
  z.object({ kind: z.literal('sample-anomaly'), ids: z.array(z.string()) }),
  z.object({ kind: z.literal('submit-issuance') })
]);

export const mutationRequestSchema = z.object({
  clientId: z.string().min(1),
  actor: z.string().min(1),
  mutation: mutationSchema
});

export type EvidenceResponse = z.infer<typeof evidenceResponseSchema>;
export type MutationRequest = z.infer<typeof mutationRequestSchema>;
