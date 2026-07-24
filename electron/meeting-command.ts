import { z } from 'zod';
import { decisionOptionSchema, planMeetingTaskSchema } from './meeting-tools.js';

const boundedText = z.string().trim().min(1).max(100_000);
const actorId = z.string().min(1).max(64).regex(/^[a-zA-Z0-9._-]+$/);

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
]);

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
): { ok: true; command: MeetingCommand } | { ok: false; code: 'invalid-command' | 'forbidden'; error: string } {
  const parsed = meetingCommandSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, code: 'invalid-command', error: parsed.error.issues[0]?.message ?? 'invalid command' };
  }
  const command = parsed.data;
  const coordinatorOnly = command.kind === 'propose-plan'
    || command.kind === 'revise-plan'
    || command.kind === 'steer-worker'
    || command.kind === 'request-decision'
    || command.kind === 'save-memory'
    || command.kind === 'speak';
  if (coordinatorOnly && actor.role !== 'coordinator') {
    return { ok: false, code: 'forbidden', error: `${command.kind} requires the coordinator role` };
  }
  return { ok: true, command };
}
