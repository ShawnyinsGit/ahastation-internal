# Multi-Backend Worker Protocol and Delivery Loop Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task.

**Goal:** Make Claude, OpenCode, Codex, and Kimi satisfy one Worker completion contract, publish one durable event protocol, and pass every completed task through verification, review, acceptance or rework.

**Architecture:** Keep the existing Coordinator, global `WorkerScheduler`, meeting UI, and recovery journal. Add a provider-neutral `WorkReport` plus canonical `WorkerEvent` at the Adapter/Scheduler seam; keep MCP as a Claude-compatible fast path, not the authoritative completion protocol. The Scheduler remains execution owner, while `DeliveryHarness` gains an external-report entry point and remains the only owner of verification, review, acceptance, and integration state.

**Tech Stack:** TypeScript 5.7, Zod 4, Electron main/preload IPC, React renderer store, Node test runner, OpenCode SSE SDK, Codex app-server, Kimi ACP, append-only JSONL journal.

---

## Scope and guardrails

In scope:

- Adapter contracts and capability gates.
- Provider-neutral `WorkReport` and canonical `WorkerEvent`.
- Scheduler consumption of reports and delivery state feedback.
- OpenCode, Codex, and Kimi Worker paths.
- `DeliveryHarness` external execution mode.
- Durable delivery decisions through IPC and `events.jsonl`.
- Structured Scheduler-to-Coordinator briefing.
- Host/Worker capacity notification.
- Contract tests, one-backend vertical slices, multi-backend smoke tests, and release gates.

Out of scope:

- Replacing the Coordinator or `HostGroup`.
- Rewriting plan confirmation, meeting UI layout, journal recovery, or the global Scheduler.
- Sending provider-native OpenCode SSE, Codex JSON-RPC, Kimi ACP, or Claude SDK objects to the renderer.
- Enabling a backend merely because it can start a session. `executeTasks` is true only after its Worker contract test and real vertical smoke pass.

Repository note:

- The worktree already contains unrelated user changes in `package.json`, `tests/codex-adapter.test.mjs`, and `scripts/copy-preloads.mjs`.
- Every commit below must stage only the paths listed for that task.
- Do not clean, revert, or include the unrelated files.

## Architecture decisions

### ADR-001: WorkReport is authoritative; MCP is optional

**Decision:** A task succeeds only after the Adapter emits a schema-valid `WorkReport`. Claude's `task_done` MCP is translated into the same report path. Transport `ended`, OpenCode `session.idle`, Codex `turn/completed`, and Kimi `session/prompt` completion never directly mark a task done.

**Why:** OpenCode cannot consume the current in-process Claude SDK MCP object directly, while Codex and Kimi already have reliable turn-completion signals. One report path avoids four completion protocols.

**Failure rule:** If a turn ends without a valid report, emit `failed` with code `missing-work-report`. Do not infer success from natural-language text.

### ADR-002: Scheduler owns execution; DeliveryHarness owns delivery state

**Decision:** The Scheduler continues to prepare workspaces, start sessions, interrupt turns, and enforce DAG dependencies. `DeliveryHarness` receives a report through `submitExternalReport()` and owns `verifying → reviewing → awaiting-delivery-acceptance → accepted/reworking/failed`.

**Why:** The current Harness starts `runtime.execute()` itself. Calling that from an already-running Scheduler would create two execution owners.

### ADR-003: Canonical events are durable envelopes

**Decision:** Main-process events use one versioned envelope containing `eventId`, `seq`, `meetingId`, `taskId`, `attempt`, `workerId`, `backendId`, and `timestamp`. Adapters never choose journal sequence numbers; the Scheduler creates the envelope.

**Why:** Adapter-native identifiers are inconsistent and may be replayed after reconnect. Scheduler-owned sequencing gives UI and journal the same deduplication key.

### ADR-004: Plan approval approves the delivery specification

**Decision:** `PlanMeetingTask` gains required `acceptanceCriteria` for executable delivery tasks. Approving the plan also approves delivery spec version 1. A rework request creates a new attempt without silently replaying the old one.

**Why:** The verifier cannot validate a prompt alone, and a second spec-approval dialog for every task would make a parallel DAG unusable.

### ADR-005: Dependency release happens after machine gates, integration after user acceptance

**Decision:** For the initial one-task slice, the node remains non-terminal until user acceptance. Before enabling a multi-task DAG, add a plan-level `dependencyGate` policy:

- `reviewed`: dependents may start after verification and review.
- `accepted`: dependents wait for explicit user acceptance.

Default to `accepted` for side-effecting or integration tasks and `reviewed` for isolated analysis tasks.

## Canonical protocol

Create this provider-neutral shape in `electron/worker-protocol.ts`:

```ts
import { z } from 'zod';

export const workReportSchema = z.object({
  schemaVersion: z.literal(1),
  outcome: z.enum(['completed', 'partial', 'blocked', 'failed']),
  summary: z.string().trim().min(1).max(20_000),
  changes: z.array(z.object({
    path: z.string().min(1),
    purpose: z.string().trim().min(1).max(2_000),
  }).strict()).max(1_000),
  tests: z.array(z.object({
    name: z.string().trim().min(1).max(500),
    status: z.enum(['passed', 'failed', 'skipped']),
    evidenceRef: z.string().min(1).max(4_000).optional(),
  }).strict()).max(1_000),
  artifacts: z.array(z.object({
    id: z.string().min(1).max(500).optional(),
    path: z.string().min(1).optional(),
  }).strict().refine((value) => value.id || value.path, {
    message: 'artifact requires id or path',
  })).max(1_000),
  risks: z.array(z.string().trim().min(1).max(2_000)).max(100),
  unresolved: z.array(z.string().trim().min(1).max(2_000)).max(100),
}).strict();

export type WorkReport = z.infer<typeof workReportSchema>;

const workerEnvelopeSchema = z.object({
  schemaVersion: z.literal(1),
  eventId: z.string().uuid(),
  seq: z.number().int().positive(),
  timestamp: z.number().int().nonnegative(),
  meetingId: z.string().min(1),
  taskId: z.string().min(1),
  attempt: z.number().int().positive(),
  workerId: z.string().min(1),
  backendId: z.string().min(1),
});

export const workerEventSchema = z.discriminatedUnion('kind', [
  workerEnvelopeSchema.extend({
    kind: z.literal('progress'),
    message: z.string().trim().min(1).max(20_000),
  }),
  workerEnvelopeSchema.extend({
    kind: z.literal('tool'),
    phase: z.enum(['started', 'progress', 'finished']),
    toolName: z.string().min(1).max(500),
    toolUseId: z.string().min(1).max(500).optional(),
    summary: z.string().max(4_000).optional(),
  }),
  workerEnvelopeSchema.extend({
    kind: z.literal('delivery'),
    report: workReportSchema,
  }),
  workerEnvelopeSchema.extend({
    kind: z.literal('failed'),
    code: z.string().min(1).max(200),
    error: z.string().min(1).max(20_000),
    retriable: z.boolean(),
  }),
  workerEnvelopeSchema.extend({
    kind: z.literal('ended'),
    reason: z.enum(['completed', 'interrupted', 'transport-closed', 'failed']),
  }),
]);

export type WorkerEvent = z.infer<typeof workerEventSchema>;
```

Adapter-to-Scheduler completion signal:

```ts
export type BackendSessionEvent =
  | ExistingBackendSessionEvents
  | { kind: 'work-report'; report: WorkReport };
```

The Adapter emits only the validated report. The Scheduler adds the durable envelope.

## Test command convention

Run Electron compilation first:

```powershell
npm run build:electron
```

Run one Node test file:

```powershell
node --import "data:text/javascript,import { register } from 'node:module'; import { pathToFileURL } from 'node:url'; register('./tests/electron-stub.mjs', pathToFileURL('./'));" --test tests/worker-protocol.test.mjs
```

At every batch boundary run:

```powershell
npm run typecheck:renderer
npm run typecheck:electron
npm test
```

Expected result: both typechecks exit silently and the full test command reports zero failures.

---

### Task 1: Add the versioned Worker protocol

**Files:**

- Create: `electron/worker-protocol.ts`
- Create: `tests/worker-protocol.test.mjs`
- Modify: `electron/delivery-harness.ts`

**Step 1: Write failing schema tests**

Test:

- A complete report parses.
- Missing `schemaVersion` fails.
- Unknown keys fail.
- Empty summary fails.
- Artifact without `id` or `path` fails.
- Oversized lists fail.
- All five Worker event kinds parse.
- Event without task/attempt/backend identity fails.

Use this base fixture:

```js
const report = {
  schemaVersion: 1,
  outcome: 'completed',
  summary: 'Implemented the requested change.',
  changes: [{ path: 'src/a.ts', purpose: 'Add feature' }],
  tests: [{ name: 'renderer typecheck', status: 'passed', evidenceRef: 'log:1' }],
  artifacts: [{ path: 'src/a.ts' }],
  risks: [],
  unresolved: [],
};
```

**Step 2: Build and run the test**

Expected: FAIL because `worker-protocol.js` does not exist.

**Step 3: Implement the schemas**

Add the canonical code from the “Canonical protocol” section. Export `parseWorkReport(value)` returning a discriminated result:

```ts
export function parseWorkReport(value: unknown):
  | { ok: true; report: WorkReport }
  | { ok: false; error: string } {
  const parsed = workReportSchema.safeParse(value);
  return parsed.success
    ? { ok: true, report: parsed.data }
    : { ok: false, error: parsed.error.issues.map((issue) => issue.message).join('; ') };
}
```

**Step 4: Move shared WorkReport typing**

Remove the duplicate `WorkReport` interface from `delivery-harness.ts` and import the type from `worker-protocol.ts`. Preserve the public export:

```ts
export type { WorkReport } from './worker-protocol.js';
```

**Step 5: Run targeted and full tests**

Expected: schema tests and existing `delivery-harness.test.mjs` pass.

**Step 6: Commit**

```powershell
git add electron/worker-protocol.ts electron/delivery-harness.ts tests/worker-protocol.test.mjs
git commit -m "feat: define versioned worker protocol"
```

---

### Task 2: Add a provider-neutral report frame to Worker prompts

**Files:**

- Modify: `electron/orchestrator-prompts.ts`
- Modify: `electron/worker-protocol.ts`
- Modify: `tests/worker-protocol.test.mjs`

**Step 1: Write failing parser tests**

Test `extractWorkReportFrame(text)` for:

- Exactly one fenced `work-report` JSON object.
- Visible assistant text before the frame.
- Invalid JSON.
- Multiple report frames.
- Schema-invalid report.
- A normal Markdown code fence that must remain untouched.

Frame format:

````markdown
```work-report
{"schemaVersion":1,"outcome":"completed",...}
```
````

**Step 2: Run the test**

Expected: FAIL because `extractWorkReportFrame` is missing.

**Step 3: Implement a fail-closed parser**

```ts
export function extractWorkReportFrame(text: string): {
  visibleText: string;
  report?: WorkReport;
  error?: string;
} {
  const matches = [...text.matchAll(/```work-report\s*([\s\S]*?)```/gi)];
  if (matches.length === 0) return { visibleText: text.trim() };
  if (matches.length !== 1) {
    return { visibleText: text.replace(/```work-report[\s\S]*?```/gi, '').trim(), error: 'multiple work-report frames' };
  }
  try {
    const parsed = parseWorkReport(JSON.parse(matches[0][1]));
    return parsed.ok
      ? { visibleText: text.replace(matches[0][0], '').trim(), report: parsed.report }
      : { visibleText: text.replace(matches[0][0], '').trim(), error: parsed.error };
  } catch (error) {
    return {
      visibleText: text.replace(matches[0][0], '').trim(),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
```

**Step 4: Make `WORKER_PROMPT` backend-neutral**

Remove requirements that every backend has `~/.claude/agents`, `~/.claude/skills`, or `task_done`. Retain them in a Claude-specific suffix.

The common suffix must state:

```text
At the end of every assigned task, emit exactly one fenced work-report JSON object.
The report is the only completion signal. Do not claim completion without it.
If blocked or partial, report that outcome truthfully and list unresolved items.
```

Claude additionally receives:

```text
You may call task_done as a convenience, but its summary must agree with the WorkReport.
```

**Step 5: Run targeted and full tests**

Expected: report parser tests pass and existing prompt consumers typecheck.

**Step 6: Commit**

```powershell
git add electron/orchestrator-prompts.ts electron/worker-protocol.ts tests/worker-protocol.test.mjs
git commit -m "feat: require provider neutral work reports"
```

---

### Task 3: Teach the Scheduler to consume reports exactly once

**Files:**

- Modify: `electron/backends/cli-backend.ts`
- Modify: `electron/claude-session.ts`
- Modify: `electron/orchestrator-types.ts`
- Modify: `electron/worker-scheduler.ts`
- Create: `tests/worker-scheduler-report.test.mjs`

**Step 1: Write failing Scheduler tests**

Use an injected fake `BackendSession` and capture emitted Orchestrator events.

Test:

- First valid report emits one canonical `worker-event` with kind `delivery`.
- Duplicate reports for the same attempt are ignored and logged.
- `ended` before a report fails with `missing-work-report`.
- `ended` after a report does not create a second failure.
- A reported task enters the non-success `reported` holding state; it is not yet `done`.
- A partial/blocked/failed report does not release dependents.
- Interrupt produces canonical `ended: interrupted`.
- `eventId`, `seq`, `taskId`, `attempt`, `workerId`, and `backendId` are populated.

**Step 2: Run the test**

Expected: FAIL because `work-report` is not a session event and Worker handles do not track terminal reports.

**Step 3: Extend the event union**

Add:

```ts
| { kind: 'work-report'; report: WorkReport }
```

to both session event types temporarily. Add a comment that `claude-session.ts` keeps the structural union compatible until the direct-Claude factory is migrated through `ClaudeCodeBackend`.

**Step 4: Extend WorkerHandle**

Add:

```ts
backendId: string;
attempt: number;
eventSeq: number;
report: WorkReport | null;
transportEnded: boolean;
```

Populate `backendId` from `executorBackendId` or the Scheduler's default backend.
Temporarily add `reported` to `WorkerStatusKind`. This state means the Adapter
has supplied a valid report, but no verification or review has run. It must not
release dependents. Task 9 replaces this holding state with the real Harness
states.

**Step 5: Add one event factory**

In `worker-scheduler.ts`:

```ts
private createWorkerEvent(
  handle: WorkerHandle,
  event: Omit<WorkerEvent, keyof WorkerEventEnvelope>,
): WorkerEvent {
  return {
    schemaVersion: 1,
    eventId: randomUUID(),
    seq: ++handle.eventSeq,
    timestamp: Date.now(),
    meetingId: this.opts.meetingId,
    taskId: handle.currentTaskId,
    attempt: handle.attempt,
    workerId: handle.id,
    backendId: handle.backendId,
    ...event,
  } as WorkerEvent;
}
```

Add `meetingId` and `defaultBackendId` to `WorkerSchedulerOpts`.

**Step 6: Consume report events**

Rules:

- Validate again at the Scheduler trust boundary.
- Record only the first report for an attempt.
- Emit the canonical event through `opts.emit`, so `safeEmit` journals and forwards the same payload.
- Move the handle to `reported`; do not call legacy `markTaskDone()` and do not release dependencies.
- Suppress `missing-work-report` when the transport later ends for a `reported` handle.
- During the transition, Claude `task_done` must synthesize a minimal report with `tests: []` and a visible risk noting that only the MCP summary was supplied.

**Step 7: Run tests**

Expected: Scheduler report tests pass; legacy cleanup tests remain green.

**Step 8: Commit**

```powershell
git add electron/backends/cli-backend.ts electron/claude-session.ts electron/orchestrator-types.ts electron/worker-scheduler.ts tests/worker-scheduler-report.test.mjs
git commit -m "feat: consume worker reports in scheduler"
```

---

### Task 4: Emit OpenCode WorkReports at the Adapter boundary

**Files:**

- Modify: `electron/backends/opencode-adapter.ts`
- Modify: `electron/backends/opencode-events.ts`
- Modify: `tests/opencode-event-pipeline.test.mjs`
- Modify: `tests/backend-capability-gates.test.mjs`

**Step 1: Set the capability gate to false**

Before implementation:

```ts
executeTasks: false
```

Update the capability test so a plan selecting OpenCode is rejected until the contract is enabled.

**Step 2: Write failing report extraction tests**

Test a pure OpenCode turn accumulator:

- Text parts for one assistant message are joined deterministically.
- Replayed SSE parts do not duplicate text.
- `session.idle` parses and emits one report.
- Invalid report emits Adapter `error` and no `work-report`.
- A second `session.idle` without a new prompt emits nothing.
- Tool and diff information remains available for progress and report cross-checking.

**Step 3: Implement per-turn state**

Track:

```ts
private turnGeneration = 0;
private reportedGeneration = 0;
private finalAssistantText = '';
```

Increment generation when `sendUserText()` submits a prompt. Accumulate the final assistant text from deduplicated parts. On `session.idle`, parse the report frame and emit:

```ts
this.emit({ kind: 'work-report', report });
```

Keep visible text flowing as a normal `NormalizedMessage`, but never expose the report JSON to the renderer transcript.

**Step 4: Do not pretend current MCP objects are compatible**

Document in the Adapter:

- `BackendSessionConfig.mcpServers` currently contains in-process Claude SDK server objects.
- OpenCode `mcp.add` accepts local/remote process configuration.
- The OpenCode Worker slice uses WorkReport as its completion path.
- A future MCP bridge may translate these objects into a loopback/stdio server, but it is not required for Worker completion.

**Step 5: Enable the capability after tests pass**

Restore:

```ts
executeTasks: true
```

Only after the targeted Adapter and Scheduler tests are green.

**Step 6: Commit**

```powershell
git add electron/backends/opencode-adapter.ts electron/backends/opencode-events.ts tests/opencode-event-pipeline.test.mjs tests/backend-capability-gates.test.mjs
git commit -m "feat: complete opencode worker reports"
```

---

### Task 5: Prove the OpenCode event and journal vertical slice

**Files:**

- Create: `tests/opencode-worker-vertical.test.mjs`
- Create: `docs/manual-tests/opencode-worker.md`
- Modify: `scripts/e2e-opencode-smoke.mjs`

**Step 1: Write a fake-provider integration test**

Drive:

```text
propose plan
→ approve plan
→ spawn OpenCode fake session
→ progress/tool events
→ work-report
→ ended
```

Assert:

- The emitted canonical Worker event and persisted `events.jsonl` payload have the same `eventId`.
- The report frame never appears in renderer-visible assistant text.
- The plan does not mark success from `session.idle` alone.
- Recovery reads the terminal report but does not restart the Worker.

**Step 2: Add the real manual script**

The script must:

- Require an authenticated OpenCode runtime.
- Create a temporary fixture repository.
- Start one Meeting with Claude Coordinator and `executorBackendId=opencode`.
- Ask the Worker to create one deterministic file and run one deterministic test.
- Print the meeting id and event journal path.
- Exit non-zero if no valid report arrives.

**Step 3: Write manual verification**

Checklist:

1. Open Meeting with Coordinator=Claude.
2. Propose one task with `executorBackendId=opencode`.
3. Confirm the plan.
4. Observe progress and tool events in the Worker tile.
5. Confirm exactly one canonical delivery event.
6. Compare its `eventId` with the line in `events.jsonl`.
7. End and recover the Meeting.
8. Confirm no Worker is automatically replayed.

**Step 4: Run the real slice**

Expected: one valid WorkReport, identical UI/journal event identity, and no automatic replay.

**Step 5: Commit**

```powershell
git add tests/opencode-worker-vertical.test.mjs docs/manual-tests/opencode-worker.md scripts/e2e-opencode-smoke.mjs
git commit -m "test: cover opencode worker vertical slice"
```

---

### Task 6: Add acceptance criteria to executable plans

**Files:**

- Modify: `electron/meeting-tools.ts`
- Modify: `electron/meeting-command.ts`
- Modify: `electron/orchestrator-prompts.ts`
- Modify: `src/types.ts`
- Modify: `src/lib/meeting-store.ts`
- Modify: `tests/meeting-command.test.mjs`

**Step 1: Write failing plan-schema tests**

Test:

- Executable tasks require at least one criterion.
- Manual and command criteria parse.
- Command verification uses `argv`, never a shell string.
- More than 50 criteria fail.
- `dependencyGate` defaults to `accepted`.

Schema:

```ts
const acceptanceCriterionSchema = z.object({
  id: z.string().min(1).max(100),
  description: z.string().min(1).max(2_000),
  verification: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('manual') }),
    z.object({
      kind: z.literal('command'),
      argv: z.array(z.string().max(4_000)).min(1).max(100),
      timeoutMs: z.number().int().min(1_000).max(600_000).default(120_000),
    }),
  ]),
}).strict();
```

**Step 2: Implement the schema**

Extend `planMeetingTaskSchema`:

```ts
acceptanceCriteria: z.array(acceptanceCriterionSchema).min(1).max(50),
dependencyGate: z.enum(['reviewed', 'accepted']).default('accepted'),
```

**Step 3: Update Coordinator instructions**

Require objective criteria such as the repository's documented renderer/electron typechecks. Do not permit arbitrary shell pipelines or secrets in argv.

**Step 4: Update renderer plan summary**

Display criterion count and dependency gate in the confirmation dialog without changing the meeting layout.

**Step 5: Run tests and commit**

```powershell
git add electron/meeting-tools.ts electron/meeting-command.ts electron/orchestrator-prompts.ts src/types.ts src/lib/meeting-store.ts tests/meeting-command.test.mjs
git commit -m "feat: require verifiable meeting tasks"
```

---

### Task 7: Add external-report mode to DeliveryHarness

**Files:**

- Modify: `electron/delivery-harness.ts`
- Modify: `tests/delivery-harness.test.mjs`

**Step 1: Write failing tests**

Test:

- `approve-spec` enters `executing` without calling a runtime when `executionMode='external'`.
- `submitExternalReport()` is accepted only in `executing` or `reworking`.
- Duplicate report submission is rejected.
- Verification and review run exactly once.
- Failed verification creates no candidate.
- Accepted delivery cannot receive another report.
- Rework increments attempt and returns to external execution.

**Step 2: Refactor report evaluation**

Extract:

```ts
private async evaluateReport(
  record: DeliveryRecord,
  order: WorkOrder,
  report: WorkReport,
): Promise<void>
```

Both the existing internal runtime and new external submission call this method.

**Step 3: Add external execution mode**

```ts
export interface DeliveryHarnessDependencies {
  executionMode?: 'internal' | 'external';
  runtime?: {
    execute(order: WorkOrder, signal: AbortSignal): Promise<WorkReport>;
  };
  // verifier, reviewer, integrator unchanged
}
```

Add:

```ts
async submitExternalReport(id: string, value: unknown): Promise<DeliveryView>
```

Validate through `workReportSchema` before any state transition.

**Step 4: Preserve existing internal tests**

Default `executionMode` to `internal` so existing callers remain compatible.

**Step 5: Commit**

```powershell
git add electron/delivery-harness.ts tests/delivery-harness.test.mjs
git commit -m "feat: accept external worker reports in delivery harness"
```

---

### Task 8: Add safe verification and deterministic review implementations

**Files:**

- Create: `electron/delivery-verifier.ts`
- Create: `electron/delivery-reviewer.ts`
- Create: `tests/delivery-verifier.test.mjs`
- Create: `tests/delivery-reviewer.test.mjs`

**Step 1: Write verifier security tests**

Test:

- `argv` executes through `spawn`/`execFile`, never `shell: true`.
- Working directory is the task workspace.
- Timeout kills the child.
- Output is capped and secrets are redacted.
- Manual criteria remain pending rather than silently passing.
- One failed command fails verification.
- Symlink/path escapes in reported changes and artifacts fail verification.

**Step 2: Implement CommandDeliveryVerifier**

Use direct argv:

```ts
spawn(argv[0], argv.slice(1), {
  cwd: order.workspace,
  env: isolatedSubprocessEnv(),
  shell: false,
  stdio: ['ignore', 'pipe', 'pipe'],
});
```

Do not execute any command supplied only by the Worker report. Commands come from the user-approved plan criteria.

**Step 3: Write reviewer tests**

Fail review when:

- Outcome is not completed.
- A reported test failed.
- A required test was skipped without explanation.
- `unresolved` is non-empty.
- A changed/artifact path is outside the workspace.
- A report claims no change and no artifact for a task that requires output.

**Step 4: Implement deterministic reviewer**

Return structured findings with severity and criterion id. Keep the interface replaceable by an independent review Worker later.

**Step 5: Commit**

```powershell
git add electron/delivery-verifier.ts electron/delivery-reviewer.ts tests/delivery-verifier.test.mjs tests/delivery-reviewer.test.mjs
git commit -m "feat: verify and review worker reports safely"
```

---

### Task 9: Wire Scheduler reports into DeliveryHarness

**Files:**

- Modify: `electron/orchestrator.ts`
- Modify: `electron/host-group.ts`
- Modify: `electron/worker-scheduler.ts`
- Modify: `electron/orchestrator-types.ts`
- Create: `tests/scheduler-delivery-loop.test.mjs`

**Step 1: Write failing state-loop tests**

Assert:

```text
pending
→ running
→ verifying
→ reviewing
→ awaiting-delivery-acceptance
→ accepted
```

and:

```text
awaiting-delivery-acceptance
→ reworking
→ running with attempt+1
```

Also assert that `worker-ended: done` is not emitted before the Harness reaches the configured dependency gate.

**Step 2: Create one Harness per Meeting**

Instantiate it in `Orchestrator`, not in each Adapter. Use `executionMode: 'external'`, `CommandDeliveryVerifier`, deterministic reviewer, and a workspace integrator from Task 11.

**Step 3: Create one Delivery record per plan task**

After `workspaceManager.prepare()` returns inside `spawnWorker()`, but before the
Backend session starts:

- Build a proposal from task objective and criteria.
- Use the prepared task workspace and source revision.
- Approve spec version 1 immediately because the containing Meeting plan was
  already approved by the user.
- Store `deliveryId` on `WorkerHandle`.

Do not prepare all workspaces during plan installation; retain the Scheduler's
current lazy workspace and path-lock behavior.

**Step 4: Submit reports**

On canonical delivery event:

```ts
await harness.submitExternalReport(handle.deliveryId, report);
```

Observe Harness events and translate them to canonical Orchestrator delivery events. Send every event through `safeEmit`.
Snapshot delivered files relative to `handle.workspace.cwd`, not the Meeting
base cwd, and persist only workspace-confined relative paths plus immutable
snapshot references.

**Step 5: Update Scheduler status vocabulary**

Add:

```ts
'verifying' | 'reviewing' | 'awaiting-acceptance' | 'reworking' | 'accepted'
```

Keep compatibility mapping in the renderer until Task 10.

**Step 6: Commit**

```powershell
git add electron/orchestrator.ts electron/host-group.ts electron/worker-scheduler.ts electron/orchestrator-types.ts tests/scheduler-delivery-loop.test.mjs
git commit -m "feat: connect scheduler to delivery harness"
```

---

### Task 10: Make delivery acceptance and rework durable through IPC

**Files:**

- Modify: `electron/ipc/session.ts`
- Modify: `electron/preload.cjs`
- Modify: `src/types.ts`
- Modify: `src/lib/meeting-store.ts`
- Modify: `src/components/DeliveryViewer.tsx`
- Create: `tests/delivery-ipc-state.test.mjs`

**Step 1: Write failing IPC/state tests**

Test:

- Renderer acceptance calls main with meeting, delivery, and candidate ids.
- Main rejects stale candidate ids.
- Main appends the accepted event before acknowledging IPC success.
- Rework feedback creates a new Harness attempt.
- Renderer no longer marks acceptance locally before main confirms it.
- Recovery restores awaiting-acceptance, accepted, and reworking states.

**Step 2: Add IPC methods**

```ts
acceptDelivery(
  sessionId: string,
  deliveryId: string,
  candidateId: string,
): Promise<Result>

returnDelivery(
  sessionId: string,
  deliveryId: string,
  candidateId: string,
  feedback: string,
): Promise<Result>
```

Validate payloads with strict Zod schemas and the existing sender policy.

**Step 3: Replace renderer-local acceptance**

`meeting-store.acceptDelivery()` must await IPC success. On failure, preserve the candidate and show the error.

**Step 4: Journal and snapshot**

Every Harness status event goes through `safeEmit`. Snapshot on:

- awaiting acceptance
- accepted
- reworking
- failed

For acceptance/rework IPC, await `repository.flush()` after queuing the
authoritative event and before returning success to the renderer. This makes
the decision durable before the UI removes or replaces its candidate.

**Step 5: Commit**

```powershell
git add electron/ipc/session.ts electron/preload.cjs src/types.ts src/lib/meeting-store.ts src/components/DeliveryViewer.tsx tests/delivery-ipc-state.test.mjs
git commit -m "feat: persist delivery acceptance and rework"
```

---

### Task 11: Integrate accepted task workspaces

**Files:**

- Modify: `electron/task-workspace.ts`
- Create: `electron/delivery-integrator.ts`
- Modify: `electron/orchestrator.ts`
- Create: `tests/delivery-integrator.test.mjs`
- Modify: `tests/task-workspace.test.mjs`

**Step 1: Write failing integration tests**

For Git worktrees:

- Record the source revision at workspace creation.
- Refuse integration if the base moved incompatibly.
- Produce a deterministic commit or fast-forward result.
- Keep the worktree after conflict for manual recovery.
- Remove the worktree only after successful integration.

For shared-locked workspaces:

- Release path locks only after acceptance or terminal failure.
- Return a no-copy integration record because changes already live in the base workspace.

**Step 2: Add source revision to TaskWorkspace**

```ts
sourceRevision: string;
```

Resolve with:

```text
git rev-parse HEAD
```

when preparing the worktree.

**Step 3: Implement WorkspaceDeliveryIntegrator**

Do not use shell strings. Use `execFile` with explicit git argv. Return:

```ts
{
  kind: 'git-worktree' | 'shared-locked',
  sourceRevision: string,
  resultRevision?: string,
  branch?: string,
}
```

**Step 4: Keep failures recoverable**

Never force-delete a worktree after verification, review, or integration failure. Journal its path and branch.

**Step 5: Commit**

```powershell
git add electron/task-workspace.ts electron/delivery-integrator.ts electron/orchestrator.ts tests/delivery-integrator.test.mjs tests/task-workspace.test.mjs
git commit -m "feat: integrate accepted task workspaces"
```

---

### Task 12: Add Codex Worker completion

**Files:**

- Modify: `electron/backends/codex-adapter.ts`
- Modify: `tests/codex-adapter.test.mjs`
- Create: `tests/codex-worker-vertical.test.mjs`
- Create: `docs/manual-tests/codex-worker.md`

**Step 1: Preserve the capability gate**

Keep `executeTasks: false` while writing tests.

**Step 2: Add official-shape fixtures**

Test the locked app-server notification order:

```text
item/completed agentMessage containing work-report
→ turn/completed
```

Also test:

- `turn/completed` before a valid report fails.
- Interrupt does not synthesize success.
- Command/file/test items enrich progress but do not become the completion signal.
- A command-only host meeting frame remains separate from Worker report parsing.

**Step 3: Parse the report in the Adapter**

At `agentMessage`, remove the report frame from visible text and emit `work-report`. At `turn/completed`, emit a result/progress signal only; the Scheduler enforces missing report failure.

**Step 4: Enable the capability**

Set `executeTasks: true` only after Adapter, Scheduler, and real smoke tests pass.

**Step 5: Run manual slice**

Coordinator may be Claude or Codex; Worker must be Codex. Confirm verify/review/acceptance and journal identity.

**Step 6: Commit**

Stage this file carefully because it already contains unrelated user edits:

```powershell
git diff -- tests/codex-adapter.test.mjs
git add -p tests/codex-adapter.test.mjs
git add electron/backends/codex-adapter.ts tests/codex-worker-vertical.test.mjs docs/manual-tests/codex-worker.md
git commit -m "feat: enable codex delivery workers"
```

---

### Task 13: Add Kimi ACP Worker completion behind an experiment gate

**Files:**

- Modify: `electron/backends/kimi-adapter.ts`
- Modify: `electron/backends/kimi-acp-transport.ts`
- Modify: `electron/store.ts`
- Modify: `tests/kimi-adapter.test.mjs`
- Modify: `tests/kimi-acp-transport.test.mjs`
- Create: `tests/kimi-worker-vertical.test.mjs`
- Create: `docs/manual-tests/kimi-worker.md`

**Step 1: Keep public capability false**

Add an experiment setting:

```ts
kimiWorkerExperimental: boolean
```

Effective `executeTasks` remains false unless the runtime version, platform, auth, ACP handshake, write mode, and experiment gate all pass.

**Step 2: Write failing ACP Worker tests**

Test:

- Worker sessions pass `cwd` and translated MCP descriptors when available.
- Worker sessions select `default` or approved execution mode, never `plan`.
- Expert sessions remain read-only plan mode.
- `fs/write_text_file` is confined to the task workspace and rejects symlink escapes.
- `session/prompt` result without a report fails.
- Valid report frame emits one `work-report`.
- Interrupt produces no success report.

**Step 3: Implement role-aware ACP mode**

Use `config.executionRole`:

```ts
const mode = config.executionRole === 'worker' ? 'default' : 'plan';
```

Keep native permission requests enabled and workspace-confined.

**Step 4: Test on a supported OS**

Windows cannot satisfy the real Kimi CLI smoke. Run the manual slice on macOS or Linux with the locked runtime version.

**Step 5: Enable only the experiment**

Do not advertise Kimi Worker generally until the two-hour multi-backend soak passes.

**Step 6: Commit**

```powershell
git add electron/backends/kimi-adapter.ts electron/backends/kimi-acp-transport.ts electron/store.ts tests/kimi-adapter.test.mjs tests/kimi-acp-transport.test.mjs tests/kimi-worker-vertical.test.mjs docs/manual-tests/kimi-worker.md
git commit -m "feat: add experimental kimi acp worker"
```

---

### Task 14: Complete the portable Coordinator command plane

**Files:**

- Modify: `electron/meeting-command.ts`
- Modify: `electron/orchestrator.ts`
- Modify: `electron/orchestrator-prompts.ts`
- Modify: `electron/backends/codex-adapter.ts`
- Modify: `tests/meeting-command.test.mjs`
- Create: `tests/meeting-command-execution.test.mjs`

**Step 1: Write authorization tests**

Add:

- `revise-plan`: Coordinator only.
- `request-decision`: Coordinator only.
- `save-memory`: Coordinator or Expert, with existing session quota.
- Oversized feedback/content is rejected.
- Plan revision cannot mutate accepted or integrating tasks.

**Step 2: Define revision operations explicitly**

Do not accept an ambiguous full plan replacement. Use:

```ts
{
  kind: 'revise-plan',
  expectedPlanVersion: number,
  operations: [
    { kind: 'add-task', task: PlanMeetingTask },
    { kind: 'cancel-pending-task', taskId: string },
    { kind: 'steer-running-task', taskId: string, addendum: string },
  ],
}
```

Reject stale versions and invalid DAGs atomically.

**Step 3: Route existing behavior**

- `request-decision` calls the existing decision creation path.
- `save-memory` calls the existing quota-limited memory path.
- `revise-plan` calls a new atomic Scheduler revision method.

**Step 4: Update Codex instructions**

List the new commands in the app-server protocol prompt and keep all authorization in `MeetingCommandGateway`.

**Step 5: Commit**

```powershell
git add electron/meeting-command.ts electron/orchestrator.ts electron/orchestrator-prompts.ts electron/backends/codex-adapter.ts tests/meeting-command.test.mjs tests/meeting-command-execution.test.mjs
git commit -m "feat: complete portable meeting commands"
```

---

### Task 15: Add structured Coordinator briefing and capacity feedback

**Files:**

- Modify: `electron/worker-scheduler.ts`
- Modify: `electron/orchestrator.ts`
- Modify: `electron/orchestrator-types.ts`
- Modify: `electron/orchestrator-prompts.ts`
- Create: `tests/coordinator-briefing.test.mjs`
- Create: `tests/orchestrator-capacity.test.mjs`

**Step 1: Write briefing tests**

Briefing must contain:

```ts
{
  taskId,
  workerId,
  backendId,
  outcome,
  summary,
  files,
  tests,
  risks,
  unresolved,
  deliveryStatus,
}
```

It must not contain raw provider logs, secrets, full command output, or report JSON fences.

**Step 2: Send one briefing per terminal attempt**

Use the Coordinator's high/normal input path after report evaluation. Do not feed the briefing back as a user-visible assistant message automatically.

**Step 3: Add capacity policy**

- Keep global Worker maximum at 4.
- Add Meeting Host maximum at 3.
- When full, leave new tasks pending and send one structured capacity event/briefing.
- Do not repeatedly notify for the same blocked queue state.

**Step 4: Add failed/stalled control feedback**

Coordinator may choose:

- `steer-worker`
- `revise-plan`
- wait
- abandon

Do not automatically retry side-effecting tasks.

**Step 5: Commit**

```powershell
git add electron/worker-scheduler.ts electron/orchestrator.ts electron/orchestrator-types.ts electron/orchestrator-prompts.ts tests/coordinator-briefing.test.mjs tests/orchestrator-capacity.test.mjs
git commit -m "feat: brief coordinator on worker outcomes"
```

---

### Task 16: Run the multi-backend DAG and release gates

**Files:**

- Create: `docs/manual-tests/multi-backend-worker-matrix.md`
- Create: `scripts/e2e-multi-backend-workers.mjs`
- Modify: `docs/e2e-phase2-checklist.md`
- Modify: `docs/orchestrator-v2-progress.md`

**Step 1: Define the matrix**

Required combinations:

| Coordinator | Worker | Required |
|---|---|---|
| Claude | Claude | yes |
| Claude | OpenCode | yes |
| Claude | Codex | yes |
| Codex | Claude | yes |
| Codex | OpenCode | yes |
| Codex | Codex | yes |
| Claude/Codex | Kimi | experimental |

Every row covers progress, tool, interrupt, report, verification, review, acceptance, journal, recovery, and no automatic replay.

**Step 2: Add a 2–3 task DAG**

Use independent write paths and at least two Worker backends. Verify:

- Maximum four Workers.
- Dependencies obey `dependencyGate`.
- File collisions produce warnings.
- One failure does not silently mark dependents done.
- Rework creates attempt 2 with a new event sequence.

**Step 3: Run a two-hour soak**

Configuration:

- 2 Hosts.
- 4 Workers.
- Mixed OpenCode/Codex/Claude, plus Kimi only on supported OS.
- Periodic interrupt and one forced provider exit.

Record memory, subprocess count, journal size, duplicate event count, stalled tasks, and leaked worktrees.

**Step 4: Run release verification**

```powershell
npm run typecheck:renderer
npm run typecheck:electron
npm test
```

On the macOS signing machine:

```bash
npm run dist:dmg
```

Expected:

- Developer ID Application signature.
- TeamIdentifier present.
- Audio-input entitlement present.
- Notarization succeeds.
- Installed application repeats the Claude/OpenCode/Codex smoke.

**Step 5: Update progress documentation**

Mark a backend Worker complete only when its real manual matrix row is signed off. If Kimi remains experimental, update the architecture diagram to label it `Expert / Experimental Worker`.

**Step 6: Commit**

```powershell
git add docs/manual-tests/multi-backend-worker-matrix.md scripts/e2e-multi-backend-workers.mjs docs/e2e-phase2-checklist.md docs/orchestrator-v2-progress.md
git commit -m "test: add multi backend worker release gates"
```

---

## Batch boundaries and exit criteria

### Batch A: Protocol and OpenCode

Tasks 1–5.

Exit only when:

- OpenCode emits a valid report without relying on Claude MCP.
- Scheduler accepts exactly one report per attempt.
- UI and `events.jsonl` carry the same canonical event id.
- Turn completion without a report fails.
- Recovery never automatically replays the task.

### Batch B: Delivery closure

Tasks 6–11.

Exit only when:

- A plan contains explicit acceptance criteria.
- Report passes verification and review before it is shown for acceptance.
- Accept/rework is authoritative in main and durable in journal/snapshot.
- Accepted Git worktree changes are actually integrated.
- Integration conflict remains recoverable.

### Batch C: Codex

Task 12.

Exit only when:

- Codex app-server produces the same WorkReport and WorkerEvent shapes.
- Interrupt and missing-report behavior match OpenCode.
- Real Claude/Codex Coordinator-to-Worker smoke passes.

### Batch D: Kimi

Task 13.

Exit only when:

- ACP Worker can write only inside its task workspace.
- Real supported-OS smoke passes.
- Capability remains experimental until soak completion.

### Batch E: Product feedback and release

Tasks 14–16.

Exit only when:

- Portable commands work from every Coordinator-capable backend.
- Coordinator receives structured briefings and capacity notifications.
- Multi-backend DAG and soak pass.
- Signed/notarized installed build repeats the core smoke.

## First implementation slice

Begin with Tasks 1–5 only.

The first demonstrable Meeting is:

```text
Coordinator=Claude
→ one approved task with executorBackendId=opencode
→ OpenCode progress/tool events
→ one schema-valid WorkReport
→ one canonical delivery event
→ identical eventId in UI and events.jsonl
→ Meeting recovery with no automatic replay
```

Do not start Codex, Kimi, Coordinator command expansion, or release work until Batch A exits cleanly.
