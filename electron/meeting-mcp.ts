// meeting-mcp.ts — MCP server builders for the Talker and each Worker.
//
// These factories used to live inside Orchestrator as 200+ line methods. The
// tool callbacks reach into many orchestrator internals; the OrchestratorBridge
// interface below names exactly which capabilities each tool needs, so the
// MCP shape can evolve without dragging the orchestrator class into the diff.

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import {
  MEETING_TOOLS,
  planMeetingArgsSchema,
  delegateToArgsSchema,
  taskDoneArgsSchema,
  submitWorkReportArgsSchema,
  submitDeliveryArgsSchema,
  requestDecisionArgsSchema,
  askHostArgsSchema,
  taskMessageArgsSchema,
  interruptTaskArgsSchema,
  forwardTaskMessageArgsSchema,
  inspectDeliveryReviewArgsSchema,
  getDeliveryReviewChunkArgsSchema,
  submitDeliveryChunkReviewArgsSchema,
  completeDeliveryReviewArgsSchema,
  requestDeliveryReworkArgsSchema,
  type AppliedTaskDefaults,
  type MeetingPlanBriefInput,
  type PlanMeetingTaskInput,
  type PlanMeetingTask,
} from './meeting-tools.js';
import type { WorkReport } from './worker-protocol.js';
import type { CreateDecisionPayload } from './decisions.js';
import type { MemoryCategory } from './memory.js';
import type { WorkerSpecialtyKind } from './orchestrator-types.js';
import type { CoordinatorReviewFinding } from './coordinator-review.js';
import { listAssets } from './attachments/assets.js';

export interface DecisionCreationResult {
  id: string;
  path: string;
  recommendedTitle: string;
  calendarOk: boolean;
  remindersOk: boolean;
  sideChannelNote: string;
}

export interface SaveMemoryResult {
  ok: boolean;
  preview?: string;
  error?: string;
}

/** Pending Coordinator review that currently narrows the Coordinator tool surface. */
export interface ActiveReviewGate {
  reviewId: string;
  deliveryId: string;
  uncoveredChunkIds: string[];
  remainingChunks: number;
}

/** Result of asking the orchestrator to steer a worker mid-flight. The Talker
 *  needs to know whether the addendum actually landed so it can re-dispatch
 *  (instead of telling the user "got it" while the message vanished). */
export type SteerResult =
  | { ok: true; queued: boolean }
  | {
      ok: false;
      reason: 'unknown' | 'done' | 'failed' | 'no-session' | 'invalid-message';
      availableTaskIds?: string[];
    };

/** Capabilities the MCP tool callbacks need from the Orchestrator. Each
 *  method maps to one tool's behaviour so the bridge stays narrow. */
export interface OrchestratorBridge {
  // Talker tools
  delegateSingleTask(input: string | {
    description: string;
    writePaths?: string[];
    workspaceMode?: PlanMeetingTaskInput['workspaceMode'];
    commands?: string[][];
    networkHosts?: string[];
    toolKinds?: string[];
  }): Promise<
    | {
        ok: true;
        workerId: string;
        specialty: WorkerSpecialtyKind;
        reused: boolean;
        status: 'spawned' | 'proposed' | 'installed';
        /** Authority the runtime filled in, so the Talker can say it out loud. */
        appliedDefaults?: string[];
      }
    | { ok: false; error: string }
  >;
  installPlan(tasks: PlanMeetingTask[]): Promise<{ ok: true } | { ok: false; error: string }>;
  proposePlan(
    tasks: PlanMeetingTaskInput[],
    brief?: MeetingPlanBriefInput,
  ): Promise<
    | { ok: true; appliedDefaults?: AppliedTaskDefaults[] }
    | { ok: false; error: string }
  >;
  steerWorker(workerId: string, addendum: string): Promise<SteerResult>;
  sendTaskMessage(taskId: string, message: string): Promise<{ id: string; status: string }>;
  queueTaskFollowUp(taskId: string, message: string): Promise<{ id: string; status: string }>;
  interruptWorker(workerId: string, reason?: string): Promise<{ ok: true } | { ok: false; error: string }>;
  forwardTaskMessage(fromTaskId: string, toTaskId: string, messageId: string): Promise<{ id: string; status: string }>;
  inspectDeliveryReview(reviewId: string): unknown;
  getDeliveryReviewChunk(reviewId: string, chunkId?: string): unknown;
  submitDeliveryChunkReview(
    reviewId: string,
    input: {
      chunkId: string;
      chunkHash: string;
      verdict: 'passed' | 'blocking';
      findings: CoordinatorReviewFinding[];
    },
  ): Promise<unknown>;
  completeDeliveryReview(reviewId: string): Promise<unknown>;
  requestDeliveryRework(
    reviewId: string,
    findings: CoordinatorReviewFinding[],
  ): Promise<unknown>;
  activeReviewGate(): ActiveReviewGate | null;
  hasWorker(workerId: string): boolean;
  activeWorkerIds(): string[];
  describeWorkers(workerId?: string): string;
  narrateAssistantLine(text: string): void;
  createDecision(payload: CreateDecisionPayload): Promise<DecisionCreationResult>;

  // Memory tool (exposed to both talker and workers)
  saveMemory(input: { category: MemoryCategory; content: string; tags: string[] }): Promise<SaveMemoryResult>;

  // Document tool (report mode — saves full response as a reviewable document)
  saveDocument(input: { title: string; content: string; spokenSummary: string }): Promise<{ ok: boolean; filename?: string; error?: string }>;
  sendHostMessage(fromHostId: string, toHostId: string, text: string): { ok: boolean; error?: string; truncated?: boolean };
  getCoordinatorHostId(): string;

  // Worker tools
  markWorkerTaskDone(workerId: string, summary: string, sourceAttempt?: number): void;
  submitWorkerReport(workerId: string, report: WorkReport, sourceAttempt?: number): void;
  submitWorkerDelivery(workerId: string, files: string[], sourceAttempt?: number): void;
  askCoordinator(
    workerId: string,
    question: string,
    sourceAttempt?: number,
  ): Promise<{ id: string; status: string }>;
}

const REVIEW_MODE_TOOLS: ReadonlySet<string> = new Set<string>([
  MEETING_TOOLS.INSPECT_DELIVERY_REVIEW,
  MEETING_TOOLS.GET_DELIVERY_REVIEW_CHUNK,
  MEETING_TOOLS.SUBMIT_DELIVERY_CHUNK_REVIEW,
  MEETING_TOOLS.COMPLETE_DELIVERY_REVIEW,
  MEETING_TOOLS.REQUEST_DELIVERY_REWORK,
]);

type ToolHandler = (...args: never[]) => Promise<unknown>;

/**
 * A frozen candidate waiting on the Coordinator must not compete with new
 * planning, delegation or steering turns. While a review is active every
 * non-review tool is refused with the pending reviewId and the chunk ids still
 * owed a verdict, so the model is told exactly how to unblock itself instead of
 * silently wandering off and stalling the delivery.
 */
export function gateDuringCoordinatorReview<T extends { name: string; handler: ToolHandler }>(
  bridge: OrchestratorBridge,
  tools: T[],
): T[] {
  return tools.map((definition) => {
    if (REVIEW_MODE_TOOLS.has(definition.name)) return definition;
    const inner = definition.handler as (...args: unknown[]) => Promise<unknown>;
    return {
      ...definition,
      handler: async (...args: unknown[]) => {
        const gate = bridge.activeReviewGate();
        if (!gate) return inner(...args);
        return {
          content: [{
            type: 'text' as const,
            text: `error: ${definition.name} is unavailable while Coordinator review ${gate.reviewId} is open. ${gate.remainingChunks} chunk(s) still need a hash-bound verdict: ${gate.uncoveredChunkIds.join(', ') || 'none'}. Finish the review with get_delivery_review_chunk / submit_delivery_chunk_review / complete_delivery_review (or request_delivery_rework) first.`,
          }],
          isError: true,
        };
      },
    } as unknown as T;
  });
}

export function buildTalkerMcp(
  bridge: OrchestratorBridge,
  canCoordinate: () => boolean = () => true,
  hostId = 'default',
) {
  const denied = () => ({ content: [{ type: 'text' as const, text: 'error: this host is an expert; only the active coordinator may schedule or speak for the meeting' }] });
  return createSdkMcpServer({
    name: 'meeting',
    version: '0.2.0',
    tools: gateDuringCoordinatorReview(bridge, [
      tool(
        MEETING_TOOLS.ASK_HOST,
        'Ask one expert host for an internal opinion. The expert reply is routed back to the coordinator and is not spoken directly to the user.',
        askHostArgsSchema,
        async ({ hostId: targetHostId, question }) => {
          if (!canCoordinate()) return denied();
          const result = bridge.sendHostMessage(hostId, targetHostId, `[expert request] ${question}`);
          if (!result.ok) return { content: [{ type: 'text', text: `error: ${result.error}` }] };
          const note = result.truncated ? ' (truncated to fit the host bus)' : '';
          return { content: [{ type: 'text', text: `question sent to ${targetHostId}${note}` }] };
        },
      ),
      tool(
        MEETING_TOOLS.REPLY_COORDINATOR,
        'Reply internally to the active coordinator. Use this after receiving an expert request; do not address the user directly.',
        { text: z.string().min(1).max(20_000) },
        async ({ text }) => {
          const result = bridge.sendHostMessage(hostId, bridge.getCoordinatorHostId(), `[expert reply from ${hostId}] ${text}`);
          if (!result.ok) return { content: [{ type: 'text', text: `error: ${result.error}` }] };
          const note = result.truncated ? ' (truncated to fit the host bus)' : '';
          return { content: [{ type: 'text', text: `reply sent to coordinator${note}` }] };
        },
      ),
      tool(
        MEETING_TOOLS.DELEGATE,
        'Delegate a single task. description is enough for most asks — runtime fills a safe sandbox write path, workspace mode, and common test commands when omitted. Pass writePaths/commands only to override.',
        {
          description: z.string().describe('Plain-language description of what the worker should do, in the user\'s words.'),
          writePaths: z.array(z.string().min(1)).max(100).optional()
            .describe('Optional workspace-relative write paths. Omit to use .vibe-assets/tasks/<id>/ when the ask implies writing.'),
          workspaceMode: z.enum(['read-only', 'git-worktree', 'shared-locked']).optional()
            .describe('Optional. Omit to let runtime pick git-worktree or shared-locked from the workspace baseline.'),
          commands: z.array(z.array(z.string().min(1)).min(1)).max(100).optional()
            .describe('Optional argv allowlist. Omit to auto-detect npm test / pytest / go test from cwd when the ask implies testing.'),
          networkHosts: z.array(z.string().min(1)).max(100).optional()
            .describe('Allowed network hosts when the task needs fetch/web tools.'),
        },
        async ({ description, writePaths, workspaceMode, commands, networkHosts }) => {
          if (!canCoordinate()) return denied();
          const r = await bridge.delegateSingleTask({
            description,
            writePaths,
            workspaceMode,
            commands,
            networkHosts,
          });
          if (!r.ok) {
            return { content: [{ type: 'text', text: `error: ${r.error}` }] };
          }
          // Auto-filled authority is stated back so the Talker can tell the
          // user what the runtime decided for them in one sentence.
          const auto = r.appliedDefaults?.length
            ? ` — auto-authority: ${r.appliedDefaults.join('; ')}`
            : '';
          if (r.status === 'proposed') {
            return {
              content: [{
                type: 'text',
                text: `plan proposed as ${r.workerId} (${r.specialty}) — waiting for user approval${auto}`,
              }],
            };
          }
          const note = r.reused
            ? `delegated as ${r.workerId} (reused ${r.specialty} worker)`
            : `delegated as ${r.workerId} (${r.specialty})`;
          return { content: [{ type: 'text', text: `${note}${auto}` }] };
        },
      ),
      tool(
        MEETING_TOOLS.PLAN_MEETING,
        'Propose a detailed execution plan (goal, approach, steps, risks) plus a worker DAG. '
        + 'Write a Cursor-style plan the host can read before approving — not a bare task list. '
        + 'Each task needs id/title and a full worker prompt; writePaths/workspaceMode/commands '
        + 'are optional (runtime fills safe defaults). Dispatch via the tool; do not ask which test framework to use.',
        planMeetingArgsSchema,
        async ({ tasks, goal, approach, steps, risks, openQuestions }) => {
          if (!canCoordinate()) return denied();
          const result = await bridge.proposePlan(tasks as PlanMeetingTaskInput[], {
            goal,
            approach,
            steps,
            risks,
            openQuestions,
          });
          if (!result.ok) {
            return { content: [{ type: 'text', text: `error: ${result.error}` }] };
          }
          const spawned = tasks.filter((t) => (t.deps ?? []).length === 0).length;
          const queued = tasks.length - spawned;
          const auto = result.appliedDefaults?.length
            ? ` — auto-authority: ${result.appliedDefaults
                .map((entry) => `${entry.taskId}: ${entry.notes.join('; ')}`)
                .join(' | ')}`
            : '';
          return {
            content: [{
              type: 'text',
              text: `plan proposed: ${goal ? `"${goal}" · ` : ''}${tasks.length} workers `
                + `(${spawned} can start now, ${queued} wait on deps) — waiting for host approval${auto}`,
            }],
          };
        },
      ),
      tool(
        MEETING_TOOLS.UPDATE,
        'Interrupt all running workers and broadcast a course-correction. Use when the user changes their mind about the whole engagement or adds a constraint that applies to every active worker.',
        { addendum: z.string().describe('Additional or revised instructions for every active worker.') },
        async ({ addendum }) => {
          if (!canCoordinate()) return denied();
          const ids = bridge.activeWorkerIds();
          let sent = 0;
          let queued = 0;
          const dropped: string[] = [];
          for (const id of ids) {
            const r = await bridge.steerWorker(id, addendum);
            if (r.ok) {
              if (r.queued) queued += 1; else sent += 1;
            } else {
              dropped.push(`${id}(${r.reason})`);
            }
          }
          const parts = [`broadcast: ${sent} sent, ${queued} queued`];
          if (dropped.length > 0) parts.push(`dropped ${dropped.length}: ${dropped.join(', ')}`);
          return { content: [{ type: 'text', text: parts.join(' / ') }] };
        },
      ),
      tool(
        MEETING_TOOLS.DELEGATE_TO,
        'Steer ONE specific worker with a mid-flight addendum. Use when the user wants to refine just one of the running workers, not all of them. If the addendum is dropped (worker already done/failed), call delegate_task to spawn a new worker for the follow-up.',
        delegateToArgsSchema,
        async ({ workerId, addendum }) => {
          if (!canCoordinate()) return denied();
          const r = await bridge.steerWorker(workerId, addendum);
          if (r.ok) {
            const where = r.queued ? `queued for ${workerId} (worker still acknowledging)` : `addendum sent to ${workerId}`;
            return { content: [{ type: 'text', text: where }] };
          }
          // B7: worker is gone — tell Talker explicitly so it can either
          // re-dispatch via delegate_task or surface the situation to the user
          // instead of silently swallowing the instruction.
          const available = r.availableTaskIds?.length
            ? ` available tasks: ${r.availableTaskIds.join(', ')}`
            : '';
          const why = {
            unknown: `unknown worker: ${workerId}.${available}`,
            done: `worker ${workerId} already completed — use delegate_task to spawn a follow-up for this addendum`,
            failed: `worker ${workerId} already failed — use delegate_task to spawn a new worker for this addendum`,
            'no-session': `worker ${workerId} has no live session — use delegate_task to spawn a new worker for this addendum`,
            'invalid-message': 'the steering instruction is empty or exceeds the allowed size',
          }[r.reason];
          return { content: [{ type: 'text', text: why }] };
        },
      ),
      tool(
        MEETING_TOOLS.SEND_TASK_MESSAGE,
        'Durably queue a Coordinator instruction for one task. Success means queued, not acknowledged.',
        taskMessageArgsSchema,
        async ({ taskId, message }) => {
          if (!canCoordinate()) return denied();
          try {
            const queued = await bridge.sendTaskMessage(taskId, message);
            return { content: [{ type: 'text', text: `queued ${queued.id} for ${taskId}; acknowledgement pending` }] };
          } catch (error) {
            return {
              content: [{
                type: 'text',
                text: `error: ${error instanceof Error ? error.message : String(error)}`,
              }],
            };
          }
        },
      ),
      tool(
        MEETING_TOOLS.FOLLOW_UP_TASK,
        'Durably queue a FIFO follow-up. It waits for the current Worker turn boundary and does not interrupt tools.',
        taskMessageArgsSchema,
        async ({ taskId, message }) => {
          if (!canCoordinate()) return denied();
          try {
            const queued = await bridge.queueTaskFollowUp(taskId, message);
            return { content: [{ type: 'text', text: `follow-up ${queued.id} queued for ${taskId}` }] };
          } catch (error) {
            return {
              content: [{
                type: 'text',
                text: `error: ${error instanceof Error ? error.message : String(error)}`,
              }],
            };
          }
        },
      ),
      tool(
        MEETING_TOOLS.STEER_TASK,
        'Durably queue an urgent steering instruction, then interrupt only the current model turn at a safe boundary.',
        taskMessageArgsSchema,
        async ({ taskId, message }) => {
          if (!canCoordinate()) return denied();
          const result = await bridge.steerWorker(taskId, message);
          if (!result.ok) {
            const available = result.availableTaskIds?.length
              ? `; available tasks: ${result.availableTaskIds.join(', ')}`
              : '';
            return { content: [{ type: 'text', text: `error: ${result.reason}${available}` }] };
          }
          return { content: [{ type: 'text', text: result.queued ? 'steering queued; acknowledgement pending' : 'steering delivered; acknowledgement pending' }] };
        },
      ),
      tool(
        MEETING_TOOLS.INTERRUPT_TASK,
        'Durably request a task interruption while preserving its workspace and resumable Backend checkpoint.',
        interruptTaskArgsSchema,
        async ({ taskId, reason }) => {
          if (!canCoordinate()) return denied();
          const result = await bridge.interruptWorker(taskId, reason);
          return { content: [{ type: 'text', text: result.ok ? `interrupt accepted for ${taskId}` : `error: ${result.error}` }] };
        },
      ),
      tool(
        MEETING_TOOLS.FORWARD_TASK_MESSAGE,
        'Forward one durable Worker question to another task through the Coordinator. Workers never communicate directly.',
        forwardTaskMessageArgsSchema,
        async ({ fromTaskId, toTaskId, messageId }) => {
          if (!canCoordinate()) return denied();
          const forwarded = await bridge.forwardTaskMessage(fromTaskId, toTaskId, messageId);
          return { content: [{ type: 'text', text: `forwarded as ${forwarded.id}; target acknowledgement pending` }] };
        },
      ),
      tool(
        MEETING_TOOLS.INSPECT_DELIVERY_REVIEW,
        'Inspect one durable Coordinator review session. Returns bounded metadata and coverage, never arbitrary workspace files.',
        inspectDeliveryReviewArgsSchema,
        async ({ reviewId }) => {
          if (!canCoordinate()) return denied();
          return {
            content: [{
              type: 'text',
              text: JSON.stringify(bridge.inspectDeliveryReview(reviewId)),
            }],
          };
        },
      ),
      tool(
        MEETING_TOOLS.GET_DELIVERY_REVIEW_CHUNK,
        'Read one bounded, hash-bound diff chunk from the frozen candidate. Secret, binary and oversized evidence stays withheld for user confirmation.',
        getDeliveryReviewChunkArgsSchema,
        async ({ reviewId, chunkId }) => {
          if (!canCoordinate()) return denied();
          const chunk = bridge.getDeliveryReviewChunk(reviewId, chunkId);
          return {
            content: [{
              type: 'text',
              text: chunk ? JSON.stringify(chunk) : 'review coverage is complete',
            }],
          };
        },
      ),
      tool(
        MEETING_TOOLS.SUBMIT_DELIVERY_CHUNK_REVIEW,
        'Submit a verdict bound to the exact chunk hash. Blocking findings create a structured rework request.',
        submitDeliveryChunkReviewArgsSchema,
        async ({ reviewId, chunkId, chunkHash, verdict, findings }) => {
          if (!canCoordinate()) return denied();
          const session = await bridge.submitDeliveryChunkReview(reviewId, {
            chunkId,
            chunkHash,
            verdict,
            findings,
          });
          return { content: [{ type: 'text', text: JSON.stringify(session) }] };
        },
      ),
      tool(
        MEETING_TOOLS.COMPLETE_DELIVERY_REVIEW,
        'Complete review only after every frozen chunk has hash-bound Coordinator coverage or explicit user confirmation.',
        completeDeliveryReviewArgsSchema,
        async ({ reviewId }) => {
          if (!canCoordinate()) return denied();
          const session = await bridge.completeDeliveryReview(reviewId);
          return { content: [{ type: 'text', text: JSON.stringify(session) }] };
        },
      ),
      tool(
        MEETING_TOOLS.REQUEST_DELIVERY_REWORK,
        'Request another Worker attempt with bounded blocking findings. This never edits files from the Coordinator.',
        requestDeliveryReworkArgsSchema,
        async ({ reviewId, findings }) => {
          if (!canCoordinate()) return denied();
          const session = await bridge.requestDeliveryRework(reviewId, findings);
          return { content: [{ type: 'text', text: JSON.stringify(session) }] };
        },
      ),
      tool(
        MEETING_TOOLS.STATUS,
        'Get current state of one worker (pass workerId) or all workers (no args). Returns busy flag, current tool, and last spoken thought per worker. Use when the user asks "what are you doing?" or you need a status update unprompted.',
        { workerId: z.string().optional().describe('Optional worker id to query; omit to get all.') },
        async ({ workerId }) => ({
          content: [{ type: 'text', text: bridge.describeWorkers(workerId) }],
        }),
      ),
      tool(
        'save_memory',
        'Persist a memorable item across meetings. Use for business context, decisions, user preferences, mentioned-but-undone TODOs, or facts about people/projects. Categories: point=key point, decision=resolved choice, todo=outstanding action, fact=factual info worth remembering.',
        {
          category: z.enum(['point', 'decision', 'todo', 'fact']),
          content: z.string().min(1).max(500),
          tags: z.array(z.string()).max(10).default([]),
        },
        async (args) => {
          const r = await bridge.saveMemory(args);
          if (!r.ok) return { content: [{ type: 'text', text: `save_memory rejected: ${r.error}` }] };
          return { content: [{ type: 'text', text: `saved ${args.category}: ${r.preview ?? ''}` }] };
        },
      ),
      tool(
        MEETING_TOOLS.NARRATE,
        'Speak directly to the user with a short conversational line. Use sparingly — only for unprompted progress updates ("改好了，要看看吗？"). The user already hears your normal assistant replies; this is for proactive nudges.',
        { text: z.string().describe('One or two sentences to say to the user.') },
        async ({ text }) => {
          if (!canCoordinate()) return denied();
          bridge.narrateAssistantLine(text);
          return { content: [{ type: 'text', text: 'spoken' }] };
        },
      ),
      tool(
        MEETING_TOOLS.REQUEST_DECISION,
        'Ask the user to weigh in on a decision while you keep working. Use this when there is a non-trivial fork (e.g. multiple valid approaches, ambiguous requirements, irreversible tradeoffs) and you do NOT want to block on the user. Behavior: writes a markdown doc to ~/Documents/AhaStation/decisions, schedules a Calendar event + Reminder at the deadline, and immediately returns the option you should proceed with. The user can later edit the doc; if they pick something different, you will receive a system message and should adjust course. Do NOT use for trivial yes/no — just ask in chat.',
        requestDecisionArgsSchema,
        async ({ question, context, options, deadlineMs }) => {
          if (!canCoordinate()) return denied();
          try {
            const created = await bridge.createDecision({ question, context, options, deadline: deadlineMs });
            return {
              content: [{
                type: 'text',
                text: `Decision logged at ${created.path}. Proceed with: ${created.recommendedTitle || 'option 1'}. (${created.sideChannelNote}) Watch for a "(decision update)" system message later if the user picks differently.`,
              }],
            };
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return {
              content: [{ type: 'text', text: `request_user_decision failed: ${msg}` }],
              isError: true,
            };
          }
        },
      ),
      tool(
        'save_document',
        'Save a detailed document for the user to review on screen. Use this when your response is long (3+ paragraphs, analysis, plans, comparisons) — save the full content as a document and reply with ONLY the short spoken summary (2-3 sentences). The user sees the document and hears your summary.',
        {
          title: z.string().min(1).max(200).describe('Document title shown to the user.'),
          content: z.string().min(1).describe('Full document content in Markdown.'),
          spokenSummary: z.string().min(1).max(300).describe('2-3 sentence conversational summary for TTS. Speak this as your assistant reply after calling save_document.'),
        },
        async ({ title, content, spokenSummary }) => {
          const r = await bridge.saveDocument({ title, content, spokenSummary });
          if (!r.ok) {
            return { content: [{ type: 'text', text: `save_document failed: ${r.error}` }], isError: true };
          }
          return { content: [{ type: 'text', text: `Document "${title}" saved (${r.filename}). Now reply with your spoken summary: ${spokenSummary}` }] };
        },
      ),
    ]),
  });
}

export function buildWorkerMcp(
  bridge: OrchestratorBridge,
  workerId: string,
  cwd: string,
  sourceAttempt?: number,
) {
  return createSdkMcpServer({
    name: 'meeting-worker',
    version: '0.2.0',
    tools: [
      tool(
        MEETING_TOOLS.ASK_COORDINATOR,
        'Ask the Coordinator a task question. The message is durable and never sent directly to another Worker.',
        { question: z.string().trim().min(1).max(100_000) },
        async ({ question }) => {
          const message = await bridge.askCoordinator(workerId, question, sourceAttempt);
          return {
            content: [{
              type: 'text',
              text: `question ${message.id} queued for the Coordinator; acknowledgement pending`,
            }],
          };
        },
      ),
      tool(
        MEETING_TOOLS.TASK_DONE,
        'Deprecated compatibility hint. This does not complete the task or release dependencies. Submit a full WorkReport with submit_work_report.',
        taskDoneArgsSchema,
        async ({ summary }) => {
          bridge.markWorkerTaskDone(workerId, summary, sourceAttempt);
          return { content: [{ type: 'text', text: 'summary recorded; submit_work_report is still required' }] };
        },
      ),
      tool(
        MEETING_TOOLS.SUBMIT_WORK_REPORT,
        'Submit the authoritative WorkReport. The task will then be verified and reviewed; dependencies release only after user acceptance.',
        submitWorkReportArgsSchema,
        async ({ report }) => {
          bridge.submitWorkerReport(workerId, report, sourceAttempt);
          return { content: [{ type: 'text', text: 'work report submitted for verification' }] };
        },
      ),
      tool(
        MEETING_TOOLS.SUBMIT_DELIVERY,
        'Explicitly declare which files are the final deliverables for user acceptance. Use this when you have produced documents, code, or other artifacts that the user should review. Paths must be absolute. Call this before task_done if you want to override the automatic file tracking.',
        submitDeliveryArgsSchema,
        async ({ files }) => {
          bridge.submitWorkerDelivery(workerId, files, sourceAttempt);
          return { content: [{ type: 'text', text: `submitted ${files.length} file(s) for delivery` }] };
        },
      ),
      tool(
        'save_memory',
        'Persist a memorable item across meetings. Use for business context, decisions, user preferences, mentioned-but-undone TODOs, or facts about people/projects. Categories: point=key point, decision=resolved choice, todo=outstanding action, fact=factual info worth remembering.',
        {
          category: z.enum(['point', 'decision', 'todo', 'fact']),
          content: z.string().min(1).max(500),
          tags: z.array(z.string()).max(10).default([]),
        },
        async (args) => {
          const r = await bridge.saveMemory(args);
          if (!r.ok) return { content: [{ type: 'text', text: `save_memory rejected: ${r.error}` }] };
          return { content: [{ type: 'text', text: `saved ${args.category}: ${r.preview ?? ''}` }] };
        },
      ),
      tool(
        'list_assets',
        'List files in the .vibe-assets/ directory — images and documents the user shared during meetings. Returns [{name, sizeBytes}]. Use Read tool on <cwd>/.vibe-assets/<name> to access file contents.',
        {},
        async () => {
          const entries = await listAssets(cwd);
          if (entries.length === 0) {
            return { content: [{ type: 'text', text: 'No assets found in .vibe-assets/' }] };
          }
          const lines = entries.map((e) => `${e.name} (${e.sizeBytes} bytes)`);
          return { content: [{ type: 'text', text: lines.join('\n') }] };
        },
      ),
    ],
  });
}
