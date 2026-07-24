import { z } from 'zod';

const relativeWorkspacePathSchema = z.string().trim().min(1).max(4_096)
  .refine((value) => !value.includes('\0'), 'path contains a NUL byte');

export const acceptanceCriterionSchema = z.object({
  id: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(4_000),
  verification: z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('command'),
      argv: z.array(z.string().max(4_000)).min(1).max(100),
      timeoutMs: z.number().int().min(1_000).max(600_000).optional(),
    }).strict(),
    z.object({ kind: z.literal('manual') }).strict(),
  ]),
}).strict();

export type AcceptanceCriterion = z.infer<typeof acceptanceCriterionSchema>;

export const workReportSchema = z.object({
  status: z.enum(['completed', 'partial', 'blocked']),
  summary: z.string().trim().min(1).max(20_000),
  files: z.array(z.object({
    path: relativeWorkspacePathSchema,
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

export type WorkReport = z.infer<typeof workReportSchema>;

export const workerAdapterSignalSchema = z.discriminatedUnion('kind', [
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
  z.object({
    kind: z.literal('delivery'),
    report: workReportSchema,
  }).strict(),
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

export type WorkerAdapterSignal = z.infer<typeof workerAdapterSignalSchema>;

export const workerEventSchema = z.object({
  schemaVersion: z.literal(2),
  eventId: z.string().uuid(),
  seq: z.number().int().positive(),
  timestamp: z.number().int().nonnegative(),
  meetingId: z.string().trim().min(1).max(500),
  taskId: z.string().trim().min(1).max(500),
  attempt: z.number().int().positive(),
  workerId: z.string().trim().min(1).max(500),
  backendId: z.string().trim().min(1).max(500),
  payload: workerAdapterSignalSchema,
}).strict();

export type WorkerEvent = z.infer<typeof workerEventSchema>;

export function parseWorkReport(value: unknown):
  | { ok: true; report: WorkReport }
  | { ok: false; error: string } {
  const parsed = workReportSchema.safeParse(value);
  return parsed.success
    ? { ok: true, report: parsed.data }
    : {
        ok: false,
        error: parsed.error.issues
          .map((issue) => `${issue.path.join('.') || 'report'}: ${issue.message}`)
          .join('; '),
      };
}

export function parseWorkerAdapterSignal(value: unknown):
  | { ok: true; signal: WorkerAdapterSignal }
  | { ok: false; error: string } {
  const parsed = workerAdapterSignalSchema.safeParse(value);
  return parsed.success
    ? { ok: true, signal: parsed.data }
    : {
        ok: false,
        error: parsed.error.issues
          .map((issue) => `${issue.path.join('.') || 'signal'}: ${issue.message}`)
          .join('; '),
      };
}

/**
 * Worker backends use one fenced frame because OpenCode SSE, Codex app-server
 * and Kimi ACP do not share an MCP transport. The frame is removed before
 * user-visible text is emitted and is parsed fail-closed.
 */
export function extractWorkReportFrame(text: string): {
  visibleText: string;
  report?: WorkReport;
  error?: string;
} {
  const pattern = /```work-report\s*([\s\S]*?)```/gi;
  const matches = [...text.matchAll(pattern)];
  const visibleText = text.replace(pattern, '').trim();
  if (matches.length === 0) return { visibleText };
  if (matches.length !== 1) {
    return { visibleText, error: 'multiple work-report frames' };
  }
  try {
    const parsed = parseWorkReport(JSON.parse(matches[0][1]));
    return parsed.ok
      ? { visibleText, report: parsed.report }
      : { visibleText, error: parsed.error };
  } catch (error) {
    return {
      visibleText,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
