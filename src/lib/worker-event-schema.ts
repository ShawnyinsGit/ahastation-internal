import { z } from 'zod';

const reportSchema = z.object({
  status: z.enum(['completed', 'partial', 'blocked']),
  summary: z.string().trim().min(1).max(20_000),
  files: z.array(z.object({
    path: z.string().trim().min(1).max(4_096).refine((value) => !value.includes('\0')),
    action: z.enum(['created', 'modified', 'deleted']),
  }).strict()).max(1_000),
  tests: z.array(z.object({
    command: z.string().trim().min(1).max(4_000),
    status: z.enum(['passed', 'failed', 'not-run']),
    summary: z.string().trim().max(4_000).optional(),
  }).strict()).max(1_000),
  unresolved: z.array(z.object({
    code: z.string().trim().min(1).max(200),
    message: z.string().trim().min(1).max(4_000),
    blocking: z.boolean(),
  }).strict()).max(100),
}).strict();

const signalSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('progress'),
    message: z.string().trim().min(1).max(20_000),
    percent: z.number().min(0).max(100).optional(),
  }).strict(),
  z.object({
    kind: z.literal('tool'),
    toolName: z.string().trim().min(1).max(500),
    phase: z.enum(['started', 'completed', 'failed']),
    detail: z.string().max(4_000).optional(),
  }).strict(),
  z.object({ kind: z.literal('delivery'), report: reportSchema }).strict(),
  z.object({
    kind: z.literal('failed'),
    code: z.string().trim().min(1).max(200),
    message: z.string().trim().min(1).max(20_000),
    retryable: z.boolean(),
  }).strict(),
  z.object({
    kind: z.literal('ended'),
    reason: z.enum(['completed', 'interrupted', 'crashed']),
  }).strict(),
]);

/**
 * Runtime boundary for IPC input in the renderer. This mirror is parity-tested
 * against the main-process schema, and provider-native payloads never enter it.
 */
export const rendererWorkerEventSchema = z.object({
  schemaVersion: z.literal(2),
  eventId: z.string().uuid(),
  seq: z.number().int().positive(),
  timestamp: z.number().int().nonnegative(),
  meetingId: z.string().trim().min(1).max(500),
  taskId: z.string().trim().min(1).max(500),
  attempt: z.number().int().positive(),
  workerId: z.string().trim().min(1).max(500),
  backendId: z.string().trim().min(1).max(500),
  payload: signalSchema,
}).strict();
