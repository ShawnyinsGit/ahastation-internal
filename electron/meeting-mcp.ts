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
  submitDeliveryArgsSchema,
  requestDecisionArgsSchema,
  askHostArgsSchema,
  type PlanMeetingTask,
} from './meeting-tools.js';
import type { CreateDecisionPayload } from './decisions.js';
import type { MemoryCategory } from './memory.js';
import type { WorkerSpecialtyKind } from './orchestrator-types.js';
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

/** Result of asking the orchestrator to steer a worker mid-flight. The Talker
 *  needs to know whether the addendum actually landed so it can re-dispatch
 *  (instead of telling the user "got it" while the message vanished). */
export type SteerResult =
  | { ok: true; queued: boolean }
  | { ok: false; reason: 'unknown' | 'done' | 'failed' | 'no-session' };

/** Capabilities the MCP tool callbacks need from the Orchestrator. Each
 *  method maps to one tool's behaviour so the bridge stays narrow. */
export interface OrchestratorBridge {
  // Talker tools
  delegateSingleTask(description: string): { workerId: string; specialty: WorkerSpecialtyKind; reused: boolean };
  installPlan(tasks: PlanMeetingTask[]): Promise<{ ok: true } | { ok: false; error: string }>;
  proposePlan(tasks: PlanMeetingTask[]): Promise<{ ok: true } | { ok: false; error: string }>;
  steerWorker(workerId: string, addendum: string): SteerResult;
  hasWorker(workerId: string): boolean;
  activeWorkerIds(): string[];
  describeWorkers(workerId?: string): string;
  narrateAssistantLine(text: string): void;
  createDecision(payload: CreateDecisionPayload): Promise<DecisionCreationResult>;

  // Memory tool (exposed to both talker and workers)
  saveMemory(input: { category: MemoryCategory; content: string; tags: string[] }): Promise<SaveMemoryResult>;

  // Document tool (report mode — saves full response as a reviewable document)
  saveDocument(input: { title: string; content: string; spokenSummary: string }): Promise<{ ok: boolean; filename?: string; error?: string }>;
  sendHostMessage(fromHostId: string, toHostId: string, text: string): { ok: boolean; error?: string };
  getCoordinatorHostId(): string;

  // Worker tools
  markWorkerTaskDone(workerId: string, summary: string): void;
  submitWorkerDelivery(workerId: string, files: string[]): void;
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
    tools: [
      tool(
        MEETING_TOOLS.ASK_HOST,
        'Ask one expert host for an internal opinion. The expert reply is routed back to the coordinator and is not spoken directly to the user.',
        askHostArgsSchema,
        async ({ hostId: targetHostId, question }) => {
          if (!canCoordinate()) return denied();
          const result = bridge.sendHostMessage(hostId, targetHostId, `[expert request] ${question}`);
          return { content: [{ type: 'text', text: result.ok ? `question sent to ${targetHostId}` : `error: ${result.error}` }] };
        },
      ),
      tool(
        MEETING_TOOLS.REPLY_COORDINATOR,
        'Reply internally to the active coordinator. Use this after receiving an expert request; do not address the user directly.',
        { text: z.string().min(1).max(20_000) },
        async ({ text }) => {
          const result = bridge.sendHostMessage(hostId, bridge.getCoordinatorHostId(), `[expert reply from ${hostId}] ${text}`);
          return { content: [{ type: 'text', text: result.ok ? 'reply sent to coordinator' : `error: ${result.error}` }] };
        },
      ),
      tool(
        MEETING_TOOLS.DELEGATE,
        'Delegate a single task to a new worker agent. Use this whenever the user describes one thing they want built, fixed, refactored, or investigated. The worker spawns immediately and streams progress back to you.',
        { description: z.string().describe('Plain-language description of what the worker should do, in the user\'s words.') },
        async ({ description }) => {
          if (!canCoordinate()) return denied();
          const r = bridge.delegateSingleTask(description);
          const note = r.reused
            ? `delegated as ${r.workerId} (reused ${r.specialty} worker)`
            : `delegated as ${r.workerId} (${r.specialty})`;
          return { content: [{ type: 'text', text: note }] };
        },
      ),
      tool(
        MEETING_TOOLS.PLAN_MEETING,
        'Decompose the user request into multiple independent (or dependency-ordered) tasks and spawn a worker for each. Use this whenever the user mentions more than one piece of work. Independent tasks run in parallel; tasks listing deps wait until their deps complete.',
        planMeetingArgsSchema,
        async ({ tasks }) => {
          if (!canCoordinate()) return denied();
          const result = await bridge.proposePlan(tasks as PlanMeetingTask[]);
          if (!result.ok) {
            return { content: [{ type: 'text', text: `error: ${result.error}` }] };
          }
          const spawned = tasks.filter((t) => (t.deps ?? []).length === 0).length;
          const queued = tasks.length - spawned;
          return {
            content: [{
              type: 'text',
              text: `plan installed: ${tasks.length} workers (${spawned} spawned now, ${queued} waiting on deps)`,
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
            const r = bridge.steerWorker(id, addendum);
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
          const r = bridge.steerWorker(workerId, addendum);
          if (r.ok) {
            const where = r.queued ? `queued for ${workerId} (worker still acknowledging)` : `addendum sent to ${workerId}`;
            return { content: [{ type: 'text', text: where }] };
          }
          // B7: worker is gone — tell Talker explicitly so it can either
          // re-dispatch via delegate_task or surface the situation to the user
          // instead of silently swallowing the instruction.
          const why = {
            unknown: `unknown worker: ${workerId}`,
            done: `worker ${workerId} already completed — use delegate_task to spawn a follow-up for this addendum`,
            failed: `worker ${workerId} already failed — use delegate_task to spawn a new worker for this addendum`,
            'no-session': `worker ${workerId} has no live session — use delegate_task to spawn a new worker for this addendum`,
          }[r.reason];
          return { content: [{ type: 'text', text: why }] };
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
    ],
  });
}

export function buildWorkerMcp(bridge: OrchestratorBridge, workerId: string, cwd: string) {
  return createSdkMcpServer({
    name: 'meeting-worker',
    version: '0.2.0',
    tools: [
      tool(
        MEETING_TOOLS.TASK_DONE,
        'Signal that your assigned task is complete. Pass a one-line summary of what changed (no code, no file path dumps). The orchestrator releases any workers waiting on you.',
        taskDoneArgsSchema,
        async ({ summary }) => {
          bridge.markWorkerTaskDone(workerId, summary);
          return { content: [{ type: 'text', text: 'recorded' }] };
        },
      ),
      tool(
        MEETING_TOOLS.SUBMIT_DELIVERY,
        'Explicitly declare which files are the final deliverables for user acceptance. Use this when you have produced documents, code, or other artifacts that the user should review. Paths must be absolute. Call this before task_done if you want to override the automatic file tracking.',
        submitDeliveryArgsSchema,
        async ({ files }) => {
          bridge.submitWorkerDelivery(workerId, files);
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
