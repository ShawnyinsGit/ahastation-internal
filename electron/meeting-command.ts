import { z } from 'zod';
import {
  decisionOptionSchema,
  normalizePlanMeetingTask,
  planMeetingTaskInputSchema,
  planMeetingTaskSchema,
} from './meeting-tools.js';

const boundedText = z.string().trim().min(1).max(100_000);
const actorId = z.string().min(1).max(64).regex(/^[a-zA-Z0-9._-]+$/);
const messageId = z.string().trim().min(1).max(500);

export const planRevisionOperationSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('add-task'),
    task: planMeetingTaskSchema,
  }).strict(),
  z.object({
    kind: z.literal('cancel-pending-task'),
    taskId: actorId,
  }).strict(),
  z.object({
    kind: z.literal('steer-running-task'),
    taskId: actorId,
    addendum: boundedText,
  }).strict(),
  z.object({
    kind: z.literal('update-task'),
    taskId: actorId,
    deps: z.array(actorId).max(100).optional(),
    executionProfile: planMeetingTaskSchema.shape.executionProfile.optional(),
    contextSelection: planMeetingTaskSchema.shape.contextSelection.optional(),
    workspaceMode: planMeetingTaskSchema.shape.workspaceMode.optional(),
    authorityRequest: planMeetingTaskSchema.shape.authorityRequest.optional(),
  }).strict().refine((value) => (
    value.deps !== undefined
    || value.executionProfile !== undefined
    || value.contextSelection !== undefined
    || value.workspaceMode !== undefined
    || value.authorityRequest !== undefined
  ), 'update-task requires at least one field'),
]);

/** A user-owned final-delivery decision. It is intentionally not part of the
 * Coordinator command union: the Coordinator cannot reject its own accepted
 * work or mint replacement authority without an explicit renderer command. */
export const finalDeliveryReworkOperationSchema = z.object({
  kind: z.literal('add-rework-task'),
  taskId: actorId,
  supersedesTaskId: actorId,
  deliveryHash: z.string().regex(/^[0-9a-f]{64}$/),
  reason: z.string().trim().min(1).max(20_000),
}).strict();

export type FinalDeliveryReworkOperation = z.infer<typeof finalDeliveryReworkOperationSchema>;

export const meetingCommandSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('propose-plan'), tasks: z.array(planMeetingTaskSchema).min(1).max(100) }).strict(),
  z.object({
    kind: z.literal('revise-plan'),
    expectedPlanVersion: z.number().int().nonnegative(),
    operations: z.array(planRevisionOperationSchema).min(1).max(100),
    reason: z.string().trim().min(1).max(20_000),
  }).strict(),
  z.object({ kind: z.literal('ask-host'), hostId: actorId, question: boundedText }).strict(),
  z.object({ kind: z.literal('broadcast-hosts'), question: boundedText }).strict(),
  z.object({ kind: z.literal('steer-worker'), workerId: actorId, addendum: boundedText }).strict(),
  z.object({ kind: z.literal('send-task-message'), taskId: actorId, message: boundedText }).strict(),
  z.object({ kind: z.literal('follow-up-task'), taskId: actorId, message: boundedText }).strict(),
  z.object({ kind: z.literal('steer-task'), taskId: actorId, message: boundedText }).strict(),
  z.object({
    kind: z.literal('interrupt-task'),
    taskId: actorId,
    reason: z.string().trim().min(1).max(20_000).optional(),
  }).strict(),
  z.object({
    kind: z.literal('forward-task-message'),
    fromTaskId: actorId,
    toTaskId: actorId,
    messageId,
  }).strict(),
  z.object({
    kind: z.literal('request-decision'),
    question: boundedText,
    context: z.string().max(100_000).optional(),
    options: z.array(decisionOptionSchema).min(2).max(20),
    deadlineMs: z.number().int().positive(),
  }).strict(),
  z.object({
    kind: z.literal('save-memory'),
    category: z.enum(['point', 'decision', 'todo', 'fact']),
    content: boundedText,
    tags: z.array(z.string().trim().min(1).max(100)).max(50),
  }).strict(),
  z.object({ kind: z.literal('speak'), text: boundedText }).strict(),
]);

const planRevisionOperationInputSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('add-task'),
    task: planMeetingTaskInputSchema,
  }).strict(),
  ...planRevisionOperationSchema.options.slice(1),
]);

const meetingCommandInputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('propose-plan'), tasks: z.array(planMeetingTaskInputSchema).min(1).max(100) }).strict(),
  z.object({
    kind: z.literal('revise-plan'),
    expectedPlanVersion: z.number().int().nonnegative(),
    operations: z.array(planRevisionOperationInputSchema).min(1).max(100),
    reason: z.string().trim().min(1).max(20_000),
  }).strict(),
  ...meetingCommandSchema.options.slice(2),
]);

export type MeetingCommand = z.infer<typeof meetingCommandSchema>;
export type PlanRevisionOperation = z.infer<typeof planRevisionOperationSchema>;

export type MeetingCommandActor = {
  hostId: string;
  role: 'coordinator' | 'expert';
};

export type MeetingCommandResult =
  | { ok: true; value?: unknown }
  | { ok: false; code: 'invalid-command' | 'forbidden' | 'invalid-state' | 'execution-failed'; error: string };

/** The validation/authorization seam shared by native tools, SDK structured
 * output and future JSONL adapters. Models never call the Scheduler directly. */
export function authorizeMeetingCommand(
  raw: unknown,
  actor: MeetingCommandActor,
  options: { defaultBackendId?: string } = {},
): { ok: true; command: MeetingCommand } | { ok: false; code: 'invalid-command' | 'forbidden'; error: string } {
  const input = meetingCommandInputSchema.safeParse(raw);
  if (!input.success) {
    return { ok: false, code: 'invalid-command', error: input.error.issues[0]?.message ?? 'invalid command' };
  }
  const defaultBackendId = options.defaultBackendId ?? 'claude-code';
  let normalized: unknown = input.data;
  try {
    if (input.data.kind === 'propose-plan') {
      normalized = {
        ...input.data,
        tasks: input.data.tasks.map((task) => normalizePlanMeetingTask(task, defaultBackendId).task),
      };
    } else if (input.data.kind === 'revise-plan') {
      normalized = {
        ...input.data,
        operations: input.data.operations.map((operation) => operation.kind === 'add-task'
          ? { ...operation, task: normalizePlanMeetingTask(operation.task, defaultBackendId).task }
          : operation),
      };
    }
  } catch (error) {
    return {
      ok: false,
      code: 'invalid-command',
      error: error instanceof Error ? error.message : String(error),
    };
  }
  const parsed = meetingCommandSchema.safeParse(normalized);
  if (!parsed.success) {
    return { ok: false, code: 'invalid-command', error: parsed.error.issues[0]?.message ?? 'invalid command' };
  }
  const command = parsed.data;
  const coordinatorOnly = command.kind === 'propose-plan'
    || command.kind === 'revise-plan'
    || command.kind === 'steer-worker'
    || command.kind === 'send-task-message'
    || command.kind === 'follow-up-task'
    || command.kind === 'steer-task'
    || command.kind === 'interrupt-task'
    || command.kind === 'forward-task-message'
    || command.kind === 'request-decision'
    || command.kind === 'save-memory'
    || command.kind === 'speak';
  if (coordinatorOnly && actor.role !== 'coordinator') {
    return { ok: false, code: 'forbidden', error: `${command.kind} requires the coordinator role` };
  }
  return { ok: true, command };
}
