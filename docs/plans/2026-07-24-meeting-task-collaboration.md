# Meeting Task Collaboration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add Meeting-owned visible tasks with durable mailboxes, per-Backend execution profiles, bounded Coordinator authority, complete Coordinator diff review, and serialized exact-commit integration.

**Architecture:** Extend the existing Meeting `WorkerScheduler`, append-only journal, Backend adapters, worktree manager, Delivery Harness, and Task Rail. Claude Code remains the only first-release Coordinator; it never edits files. Workers execute isolated attempts, the Coordinator reviews frozen diff chunks, and one Integration Queue cherry-picks accepted commits before dependencies are released.

**Tech Stack:** TypeScript 5.7, Zod 4, Electron main/preload IPC, React 18, Node test runner, Git worktrees, append-only JSONL journal, Claude Agent SDK, Codex app-server, OpenCode SDK, Kimi ACP.

---

## Preconditions and command convention

Implementation starts from commit `e4fb1f5` or a later commit containing:

- `electron/worker-protocol.ts`
- `electron/backends/worker-runtime-contract.ts`
- `electron/delivery-harness.ts`
- `electron/delivery-integrator.ts`
- `electron/worker-scheduler.ts`
- `src/components/TaskRail.tsx`
- `docs/plans/2026-07-24-worker-protocol-delivery-loop.md`

Before each task:

```powershell
git status --short
git rev-parse --short HEAD
```

Stop if unrelated uncommitted changes overlap the task's owned files.

Build Electron before importing files from `dist-electron`:

```powershell
npm run build:electron
```

Run one Node test:

```powershell
node --import "data:text/javascript,import { register } from 'node:module'; import { pathToFileURL } from 'node:url'; register('./tests/electron-stub.mjs', pathToFileURL('./'));" --test tests/<file>.test.mjs
```

At every milestone boundary:

```powershell
npm run typecheck:renderer
npm run typecheck:electron
npm test
git diff --check
```

Do not enable automatic Coordinator acceptance until Tasks 1-10 all pass.

## Milestone 1: Typed collaboration contracts

### Task 1: Define task collaboration schemas

**Files:**

- Create: `electron/task-collaboration.ts`
- Create: `tests/task-collaboration.test.mjs`
- Modify: `electron/orchestrator-types.ts:18-186`
- Modify: `src/types.ts:130-310`
- Modify: `tests/worker-event-schema-parity.test.mjs`

**Step 1: Write failing strict-schema tests**

Cover:

- requested execution profile;
- effective Backend profile;
- context package;
- authority grant;
- task message;
- task attempt;
- task record;
- every new task status;
- unknown-key rejection;
- hidden reasoning and credential-shaped context rejection;
- empty or invalid hashes;
- invalid mailbox sequence and attempt identity.

Use this minimum fixture:

```js
const requestedProfile = {
  schemaVersion: 1,
  backendId: 'codex',
  workMode: 'balanced',
  contextMode: 'meeting-summary',
  timeoutMs: 1_800_000,
  maxTokenBudget: 200_000,
};
```

Run the test and confirm it fails because
`dist-electron/task-collaboration.js` does not exist.

**Step 2: Implement strict Zod contracts**

Use these public shapes:

```ts
export const taskExecutionProfileSchema = z.object({
  schemaVersion: z.literal(1),
  backendId: z.string().trim().min(1).max(100),
  modelPreference: z.string().trim().min(1).max(200).optional(),
  workMode: z.enum(['fast', 'balanced', 'deep']),
  contextMode: z.enum([
    'minimal',
    'meeting-summary',
    'selected-history',
    'full-visible-history',
  ]),
  timeoutMs: z.number().int().min(30_000).max(7_200_000),
  maxTokenBudget: z.number().int().min(1_000).max(10_000_000),
}).strict();

export const backendEffectiveProfileSchema = z.object({
  schemaVersion: z.literal(1),
  backendId: z.string().trim().min(1).max(100),
  runtimeVersion: z.string().trim().min(1).max(100),
  model: z.string().trim().min(1).max(200),
  nativeReasoning: z.record(z.string(), z.unknown()).optional(),
  unsupported: z.array(z.string().trim().min(1).max(200)).max(100),
  downgraded: z.array(z.string().trim().min(1).max(200)).max(100),
  capabilityHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
```

Define `ContextPackage`, `TaskAuthorityGrant`, `TaskMessage`,
`TaskAttemptRecord`, and `MeetingTaskRecord` exactly as accepted in the design.
Use a recursive forbidden-key check for:

```text
reasoning
chain_of_thought
hidden_reasoning
api_key
access_token
authorization
credential
```

The check rejects keys, not innocent user prose containing those words.

**Step 3: Add shared task statuses**

Replace duplicated status unions with the full set:

```ts
export type WorkerStatusKind =
  | 'draft'
  | 'pending'
  | 'running'
  | 'verifying'
  | 'coordinator-reviewing'
  | 'integration-queued'
  | 'integrating'
  | 'accepted'
  | 'blocked'
  | 'reworking'
  | 'integration-conflict'
  | 'budget-paused'
  | 'interrupted'
  | 'failed'
  | 'cancelled';
```

Keep renderer and Electron types in parity. Do not add status translation in
components yet.

**Step 4: Run targeted tests**

```powershell
npm run build:electron
node --import "data:text/javascript,import { register } from 'node:module'; import { pathToFileURL } from 'node:url'; register('./tests/electron-stub.mjs', pathToFileURL('./'));" --test tests/task-collaboration.test.mjs tests/worker-event-schema-parity.test.mjs
```

Expected: all tests pass.

**Step 5: Commit**

```powershell
git add electron/task-collaboration.ts electron/orchestrator-types.ts src/types.ts tests/task-collaboration.test.mjs tests/worker-event-schema-parity.test.mjs
git commit -m "feat(collaboration): define meeting task contracts"
```

### Task 2: Extend plan tasks and the approval UI

**Files:**

- Modify: `electron/meeting-tools.ts:29-113`
- Modify: `electron/meeting-command.ts:1-45`
- Modify: `electron/worker-scheduler.ts:470-604`
- Modify: `electron/orchestrator-types.ts`
- Modify: `src/types.ts:905-940`
- Modify: `src/lib/plan-validation.ts`
- Modify: `src/components/PlanMeetingModal.tsx`
- Modify: `tests/meeting-command.test.mjs`
- Modify: `tests/plan-revision.test.mjs`
- Modify: `tests/renderer-plan-validation.test.mjs`
- Create: `tests/plan-task-profile.test.mjs`

**Step 1: Write failing plan-contract tests**

Test that:

- every executable plan task has `executionProfile`;
- `backendId` agrees with `executorBackendId` during the compatibility window;
- write tasks declare `workspaceMode`;
- plan revision cannot mutate a running task's frozen profile, grant request,
  context package, or workspace mode;
- a revision may add a task, cancel a pending task, change pending-task
  dependencies, or steer a running task;
- stale `expectedPlanVersion` remains rejected.

**Step 2: Extend `planMeetingTaskSchema`**

Add:

```ts
executionProfile: taskExecutionProfileSchema,
contextSelection: z.object({
  mode: taskExecutionProfileSchema.shape.contextMode,
  messageIds: z.array(z.string().min(1)).max(500).default([]),
  dependencyTaskIds: z.array(z.string().min(1)).max(100).default([]),
  attachmentIds: z.array(z.string().min(1)).max(100).default([]),
}).strict(),
workspaceMode: z.enum(['read-only', 'git-worktree', 'shared-locked']),
authorityRequest: z.object({
  writePaths: z.array(z.string().min(1)).max(100),
  toolKinds: z.array(z.string().min(1)).max(100),
  commands: z.array(z.array(z.string().max(4_000)).min(1).max(100)).max(100),
  networkHosts: z.array(z.string().min(1).max(253)).max(100),
}).strict(),
```

Keep old `executorBackendId` and `writePaths` only as read compatibility fields.
Normalize them into the new shape at the command boundary.

**Step 3: Update plan revision invariants**

Capture the task status before applying each revision operation. Reject
in-place changes to immutable running-attempt fields with:

```text
running task execution boundaries require a new attempt
```

**Step 4: Update `PlanMeetingModal`**

Add controls for:

- Backend;
- work mode;
- context mode;
- workspace mode;
- write paths;
- commands;
- network hosts;
- timeout and token budget.

Show a compact authority summary before the user confirms. High-risk actions
must not appear as auto-approved options.

**Step 5: Run tests and typechecks**

```powershell
npm run build:electron
node --import "data:text/javascript,import { register } from 'node:module'; import { pathToFileURL } from 'node:url'; register('./tests/electron-stub.mjs', pathToFileURL('./'));" --test tests/plan-task-profile.test.mjs tests/meeting-command.test.mjs tests/plan-revision.test.mjs tests/renderer-plan-validation.test.mjs
npm run typecheck:renderer
```

**Step 6: Commit**

```powershell
git add electron/meeting-tools.ts electron/meeting-command.ts electron/worker-scheduler.ts electron/orchestrator-types.ts src/types.ts src/lib/plan-validation.ts src/components/PlanMeetingModal.tsx tests/meeting-command.test.mjs tests/plan-revision.test.mjs tests/renderer-plan-validation.test.mjs tests/plan-task-profile.test.mjs
git commit -m "feat(collaboration): add task execution profiles to plans"
```

### Task 3: Compile execution intent per Backend

**Files:**

- Create: `electron/backends/task-profile.ts`
- Create: `tests/backend-task-profile.test.mjs`
- Modify: `electron/backends/cli-backend.ts:115-215`
- Modify: `electron/backends/claude-code-adapter.ts`
- Modify: `electron/backends/codex-adapter.ts`
- Modify: `electron/backends/opencode-adapter.ts`
- Modify: `electron/backends/kimi-adapter.ts`
- Modify: `electron/backends/registry.ts`
- Modify: `electron/worker-scheduler.ts:1180-1425`

**Step 1: Write failing compiler tests**

Test:

- Codex `deep` maps to the locked runtime's native high reasoning effort;
- Claude maps only settings supported by the pinned SDK;
- OpenCode compilation is provider/model-specific;
- Kimi never claims unsupported reasoning controls;
- unsupported mode is explicitly downgraded;
- requested and effective profiles remain distinct;
- capability hash is stable and secret-free;
- a Backend that cannot report its runtime version fails closed.

**Step 2: Extend the Adapter contract**

```ts
export interface BackendAdapter {
  // existing members...
  compileTaskProfile?(
    requested: TaskExecutionProfile,
    runtime: BackendRuntime,
  ): BackendEffectiveProfile;
}
```

If the existing registry exposes instances rather than this interface, add the
method to the registered Backend definition instead. Do not let the Scheduler
contain provider-specific `if` chains.

**Step 3: Implement pure compilers**

The compiler must not spawn a CLI, access the network, or read credentials.
Runtime probing remains in the existing runtime gate.

Use `stableStringify` plus SHA-256 for `capabilityHash`. Redact raw environment
and configuration secrets before hashing.

**Step 4: Bind before workspace creation**

In `spawnWorker()`, compile and persist the effective profile before creating
the worktree or session. If compilation fails, leave the task pending/blocked
with a diagnostic and do not create side effects.

Pass the compiled native options through `BackendSessionConfig`; never mutate
global Backend settings for one task.

**Step 5: Run tests**

```powershell
npm run build:electron
node --import "data:text/javascript,import { register } from 'node:module'; import { pathToFileURL } from 'node:url'; register('./tests/electron-stub.mjs', pathToFileURL('./'));" --test tests/backend-task-profile.test.mjs tests/backend-capability-gates.test.mjs tests/codex-adapter.test.mjs tests/claude-adapter-config.test.mjs
```

**Step 6: Commit**

```powershell
git add electron/backends/task-profile.ts electron/backends/cli-backend.ts electron/backends/claude-code-adapter.ts electron/backends/codex-adapter.ts electron/backends/opencode-adapter.ts electron/backends/kimi-adapter.ts electron/backends/registry.ts electron/worker-scheduler.ts tests/backend-task-profile.test.mjs
git commit -m "feat(collaboration): compile task profiles per backend"
```

## Milestone 2: Authority and workspace safety

### Task 4: Compile bounded authority grants

**Files:**

- Create: `electron/task-authority.ts`
- Create: `tests/task-authority.test.mjs`
- Modify: `electron/permission-broker.ts`
- Modify: `electron/orchestrator.ts:950-1020`
- Modify: `electron/worker-scheduler.ts`
- Modify: `electron/orchestrator-types.ts`
- Modify: `tests/permission-broker.test.mjs`

**Step 1: Write failing authority tests**

Cover:

- plan approval produces a deterministic grant;
- Coordinator auto-approves an in-grant source write and approved test argv;
- path escape, undeclared command, and undeclared network host deny;
- deletion, destructive Git, credential access, admin privilege, system install,
  external publish, and external message always ask the user;
- task text and context cannot grant authority;
- expired and mismatched grant hashes deny;
- rework may reuse but never widen the grant;
- a wider new attempt requires plan revision and user approval.

**Step 2: Implement the compiler**

```ts
export function compileTaskAuthority(
  workspaceRoot: string,
  request: PlanMeetingTask['authorityRequest'],
  approvedAt: number,
): TaskAuthorityGrant
```

Normalize and confine paths to `workspaceRoot`. Normalize command argv without
joining through a shell. Canonicalize host names. Compute `grantHash` from
non-secret normalized facts.

**Step 3: Add deterministic policy**

```ts
export type AuthorityDecision =
  | { kind: 'allow'; reason: string }
  | { kind: 'ask-user'; reason: string }
  | { kind: 'deny'; reason: string };
```

High-risk classification runs before in-grant allow logic. Trust or
Coordinator identity cannot override `ask-user` or `deny`.

**Step 4: Integrate with existing Permission Broker**

Native Backend permission requests must be normalized to the same policy
facts. Preserve the current UI card and response path. Journal the canonical
decision, not raw credential-bearing native payloads.

**Step 5: Run tests**

```powershell
npm run build:electron
node --import "data:text/javascript,import { register } from 'node:module'; import { pathToFileURL } from 'node:url'; register('./tests/electron-stub.mjs', pathToFileURL('./'));" --test tests/task-authority.test.mjs tests/permission-broker.test.mjs tests/backend-capability-gates.test.mjs
```

**Step 6: Commit**

```powershell
git add electron/task-authority.ts electron/permission-broker.ts electron/orchestrator.ts electron/worker-scheduler.ts electron/orchestrator-types.ts tests/task-authority.test.mjs tests/permission-broker.test.mjs
git commit -m "feat(collaboration): enforce bounded task authority"
```

### Task 5: Guard dirty workspaces and explicit shared mode

**Files:**

- Modify: `electron/task-workspace.ts:1-170`
- Modify: `electron/worker-scheduler.ts:1305-1385`
- Modify: `electron/orchestrator-types.ts`
- Modify: `tests/task-workspace.test.mjs`
- Create: `tests/task-workspace-dirty-baseline.test.mjs`

**Step 1: Write failing workspace tests**

Test:

- a clean Git base creates a worktree;
- a dirty Git base permits read-only tasks;
- a dirty Git base rejects `git-worktree` write tasks before `git worktree add`;
- no automatic commit, stash, or file copy occurs;
- explicit `shared-locked` is allowed on a dirty base;
- shared writers serialize by hierarchical paths;
- unknown shared write scope locks the whole workspace;
- a worker never sees an uncommitted file accidentally omitted from its
  worktree without a visible diagnostic.

**Step 2: Add baseline inspection**

```ts
export interface WorkspaceBaseline {
  kind: 'git-clean' | 'git-dirty' | 'non-git';
  revision: string;
  changedPaths: string[];
  untrackedPaths: string[];
}

inspectBaseline(): WorkspaceBaseline
```

Use `git status --porcelain=v1 -z` and bound the number and total length of
reported paths. Never include file contents.

**Step 3: Make `prepare()` explicit**

Change the signature to accept:

```ts
prepare(taskId: string, input: {
  mode: 'read-only' | 'git-worktree' | 'shared-locked';
  writePaths: string[];
}): TaskWorkspace
```

Throw a typed `DirtyWorkspaceWriteBlockedError` before any mutation.

**Step 4: Surface the blocked state**

The Scheduler must keep the task blocked with a visible diagnostic and offer:

- handle workspace changes outside AhaStation;
- choose shared locked mode through a versioned plan revision;
- cancel the task.

**Step 5: Run tests and commit**

```powershell
npm run build:electron
node --import "data:text/javascript,import { register } from 'node:module'; import { pathToFileURL } from 'node:url'; register('./tests/electron-stub.mjs', pathToFileURL('./'));" --test tests/task-workspace.test.mjs tests/task-workspace-dirty-baseline.test.mjs
git add electron/task-workspace.ts electron/worker-scheduler.ts electron/orchestrator-types.ts tests/task-workspace.test.mjs tests/task-workspace-dirty-baseline.test.mjs
git commit -m "feat(collaboration): guard task workspace baselines"
```

## Milestone 3: Durable Task Mailbox

### Task 6: Add mailbox events and task projection

**Files:**

- Create: `electron/task-mailbox.ts`
- Create: `electron/task-projection.ts`
- Create: `tests/task-mailbox.test.mjs`
- Create: `tests/task-projection.test.mjs`
- Modify: `electron/meeting-repository.ts:1-125`
- Modify: `electron/orchestrator.ts:670-790`

**Step 1: Write failing mailbox tests**

Test:

- task message is appended before a delivery callback runs;
- sequence is monotonic per task attempt;
- duplicate IDs are idempotent;
- messages restore in order;
- delivery and acknowledgement are separate events;
- an unacknowledged delivered message restores as queued or uncertain, never
  acknowledged;
- a terminal-task follow-up cannot mutate the terminal attempt;
- native Backend payloads are not stored.

**Step 2: Make repository append return identity**

Change:

```ts
append(type: string, payload: unknown): Promise<void>
```

to:

```ts
append(type: string, payload: unknown): Promise<PersistedMeetingEvent>
```

Keep all existing callers source-compatible when they ignore the return value.

Add:

```ts
static async replayAfter(
  meetingId: string,
  afterSeq: number,
): Promise<PersistedMeetingEvent[]>
```

Ignore a final partial JSONL line exactly as current replay does.

**Step 3: Implement mailbox service**

```ts
export class TaskMailbox {
  async enqueue(input: NewTaskMessage): Promise<TaskMessage>;
  async markDelivered(taskId: string, messageId: string): Promise<TaskMessage>;
  async acknowledge(taskId: string, messageId: string): Promise<TaskMessage>;
  list(taskId: string, afterSeq?: number): TaskMessage[];
}
```

Status transitions must be monotonic. Failed delivery can be retried without
creating another semantic instruction.

**Step 4: Implement pure task projection**

Fold task-related Meeting events into `MeetingTaskRecord`. Reject impossible
transitions and collect safe diagnostics rather than throwing during recovery.

**Step 5: Run tests and commit**

```powershell
npm run build:electron
node --import "data:text/javascript,import { register } from 'node:module'; import { pathToFileURL } from 'node:url'; register('./tests/electron-stub.mjs', pathToFileURL('./'));" --test tests/task-mailbox.test.mjs tests/task-projection.test.mjs tests/meeting-recovery.test.mjs
git add electron/task-mailbox.ts electron/task-projection.ts electron/meeting-repository.ts electron/orchestrator.ts tests/task-mailbox.test.mjs tests/task-projection.test.mjs
git commit -m "feat(collaboration): persist task mailboxes"
```

### Task 7: Route follow-up, steering, and interrupt through Mailbox

**Files:**

- Modify: `electron/worker-scheduler.ts:607-665,1455-1590`
- Modify: `electron/orchestrator.ts:520-590,1040-1060`
- Modify: `electron/meeting-command.ts`
- Modify: `electron/meeting-mcp.ts`
- Modify: `electron/meeting-tools.ts`
- Modify: `electron/orchestrator-prompts.ts`
- Modify: `electron/ipc/documents.ts`
- Create: `tests/task-message-routing.test.mjs`
- Modify: `tests/plan-revision.test.mjs`

**Step 1: Write failing routing tests**

Test:

- follow-up remains FIFO and waits for turn completion;
- steering is durable before `interrupt('steer')`;
- a running tool is not declared cancelled merely because the model turn was
  interrupted;
- interrupt preserves workspace and session checkpoint;
- failed delivery remains queued;
- Worker question reaches only the Coordinator;
- Coordinator forwarding creates two visible mailbox events and no direct peer
  channel;
- terminal follow-up creates a new attempt;
- legacy `steerWorker()` calls the new mailbox path.

**Step 2: Add typed commands**

Add Meeting commands:

```ts
{ kind: 'send-task-message'; taskId: string; message: string }
{ kind: 'follow-up-task'; taskId: string; message: string }
{ kind: 'steer-task'; taskId: string; message: string }
{ kind: 'interrupt-task'; taskId: string; reason?: string }
{ kind: 'forward-task-message'; fromTaskId: string; toTaskId: string; messageId: string }
```

Only the Coordinator may issue forwarding and plan operations.

**Step 3: Add Scheduler methods**

```ts
queueFollowUp(taskId: string, text: string): Promise<TaskMessage>
steerTask(taskId: string, text: string): Promise<TaskMessage>
interruptTask(taskId: string, reason?: string): Promise<void>
```

Do not call the Backend until the journal flush covering the queued message
completes.

**Step 4: Update Coordinator prompts**

State that Workers do not communicate directly and that a successful tool call
means the instruction was queued, not necessarily acknowledged.

**Step 5: Run tests and commit**

```powershell
npm run build:electron
node --import "data:text/javascript,import { register } from 'node:module'; import { pathToFileURL } from 'node:url'; register('./tests/electron-stub.mjs', pathToFileURL('./'));" --test tests/task-message-routing.test.mjs tests/plan-revision.test.mjs tests/orchestrator-cleanup.test.mjs
git add electron/worker-scheduler.ts electron/orchestrator.ts electron/meeting-command.ts electron/meeting-mcp.ts electron/meeting-tools.ts electron/orchestrator-prompts.ts electron/ipc/documents.ts tests/task-message-routing.test.mjs tests/plan-revision.test.mjs
git commit -m "feat(collaboration): route durable task messages"
```

## Milestone 4: Snapshot IPC and Task Inspector

### Task 8: Add task snapshot and `afterSeq` replay

**Files:**

- Create: `electron/ipc/tasks.ts`
- Modify: `electron/main.ts`
- Modify: `electron/preload.cjs`
- Modify: `src/types.ts`
- Create: `src/lib/task-event-reducer.ts`
- Create: `tests/task-ipc.test.mjs`
- Create: `tests/renderer-task-event-reducer.test.mjs`
- Modify: `src/lib/meeting-store.ts`

**Step 1: Write failing IPC and reducer tests**

Test:

- snapshot contains the task record, mailbox, attempt evidence, and last seq;
- `afterSeq` returns only later task events;
- another Meeting/task cannot be read through the IPC;
- invalid cursor and oversized request fail;
- duplicate event ID and sequence are ignored;
- a gap triggers snapshot refresh rather than speculative reduction;
- sensitive authority internals are projected to a safe renderer view.

**Step 2: Add main-process API**

```ts
getTaskSnapshot(sessionId: string, taskId: string): Promise<TaskSnapshot>
getTaskEvents(sessionId: string, taskId: string, afterSeq: number): Promise<TaskEvent[]>
```

Use the existing session authorization lookup. Do not expose arbitrary Meeting
journal reads.

**Step 3: Add preload bridge**

Expose typed methods:

```ts
tasks.getSnapshot(sessionId, taskId)
tasks.getEvents(sessionId, taskId, afterSeq)
tasks.followUp(sessionId, taskId, text)
tasks.steer(sessionId, taskId, text)
tasks.interrupt(sessionId, taskId, reason)
```

Bound all strings and IDs at IPC validation.

**Step 4: Add renderer hydration**

On Task Inspector open:

1. fetch snapshot;
2. set `afterSeq = snapshot.seq`;
3. apply live events;
4. if a sequence gap appears, re-fetch the snapshot.

Do not fetch the entire Meeting transcript for every task.

**Step 5: Run tests and commit**

```powershell
npm run build:electron
node --import "data:text/javascript,import { register } from 'node:module'; import { pathToFileURL } from 'node:url'; register('./tests/electron-stub.mjs', pathToFileURL('./'));" --test tests/task-ipc.test.mjs tests/renderer-task-event-reducer.test.mjs tests/renderer-security.test.mjs
npm run typecheck:renderer
git add electron/ipc/tasks.ts electron/main.ts electron/preload.cjs src/types.ts src/lib/task-event-reducer.ts src/lib/meeting-store.ts tests/task-ipc.test.mjs tests/renderer-task-event-reducer.test.mjs
git commit -m "feat(collaboration): replay task state through typed ipc"
```

### Task 9: Build the docked Task Inspector

**Files:**

- Create: `src/components/TaskInspector.tsx`
- Create: `src/components/TaskMailboxPanel.tsx`
- Create: `src/components/TaskProfilePanel.tsx`
- Create: `src/components/TaskReviewPanel.tsx`
- Modify: `src/components/TaskRail.tsx`
- Modify: `src/components/ScreenStage.tsx`
- Modify: `src/components/ActivityTabContent.tsx`
- Modify: `src/components/PermissionCard.tsx`
- Modify: `src/styles.css`
- Create: `tests/renderer-task-inspector.test.mjs`
- Modify: `src/dev-fixture-bootstrap.ts`

**Step 1: Write failing renderer structure tests**

Test:

- selecting a Task Rail node opens the inspector;
- tabs are Overview, Context, Messages, Activity, Diff Review, Verification,
  Permissions, and Integration;
- requested and effective profiles are both visible;
- message delivery state is visible;
- Follow-up, Steering, and Interrupt are distinct controls;
- high-risk pending approval is visible in the rail and inspector;
- statuses have text/icon labels and are not color-only;
- inspector remains usable while the Meeting input stays visible;
- compact width collapses inspector into a drawer without a separate window.

**Step 2: Implement the three-column target**

Match the accepted screenshot structure:

- left Task Rail;
- center Meeting conversation;
- right docked inspector.

Use the current AhaStation dark visual system and existing backend icon assets.
Do not introduce another design system.

**Step 3: Add review coverage and Integration Queue status**

Display:

- `reviewedChunks / totalChunks`;
- frozen candidate commit;
- verification summary;
- queue position;
- integration and post-integration status.

No per-task user accept button appears in normal mode. Keep a developer-only
manual control only if required for migration testing.

**Step 4: Run tests and visual fixture**

```powershell
npm run typecheck:renderer
npm run build:renderer
node --import "data:text/javascript,import { register } from 'node:module'; import { pathToFileURL } from 'node:url'; register('./tests/electron-stub.mjs', pathToFileURL('./'));" --test tests/renderer-task-inspector.test.mjs tests/renderer-dev-fixture.test.mjs tests/renderer-security.test.mjs
```

Capture and inspect the deterministic dev fixture at desktop and narrow widths
before committing.

**Step 5: Commit**

```powershell
git add src/components/TaskInspector.tsx src/components/TaskMailboxPanel.tsx src/components/TaskProfilePanel.tsx src/components/TaskReviewPanel.tsx src/components/TaskRail.tsx src/components/ScreenStage.tsx src/components/ActivityTabContent.tsx src/components/PermissionCard.tsx src/styles.css src/dev-fixture-bootstrap.ts tests/renderer-task-inspector.test.mjs
git commit -m "feat(collaboration): add the task inspector workspace"
```

## Milestone 5: Coordinator review and automatic acceptance

### Task 10: Add frozen, chunked Coordinator diff review

**Files:**

- Create: `electron/delivery-diff.ts`
- Create: `electron/coordinator-review.ts`
- Create: `tests/coordinator-diff-review.test.mjs`
- Modify: `electron/delivery-harness.ts`
- Modify: `electron/meeting-mcp.ts`
- Modify: `electron/meeting-tools.ts`
- Modify: `electron/orchestrator-prompts.ts`
- Modify: `electron/worker-scheduler.ts`
- Modify: `electron/orchestrator-types.ts`

**Step 1: Write failing review-state tests**

Test:

- review freezes candidate commit and diff hash;
- manifest contains every changed file and bounded statistics;
- chunks are deterministic and bounded by bytes/lines;
- binary and oversized files produce explicit non-inline evidence;
- Coordinator can review chunks only in order or by explicit chunk ID;
- every review records the chunk hash;
- changed candidate invalidates affected reviews;
- incomplete coverage cannot complete;
- blocking finding creates a structured rework request;
- complete passing review emits `coordinator-review-completed`;
- Coordinator has no write or shell tool.

**Step 2: Implement safe diff construction**

Use Git argv, never a shell string:

```text
git diff --binary --no-ext-diff <base>..<candidate> --
git diff --numstat <base>..<candidate> --
```

Confine all reported paths to the task workspace. Redact credential-shaped
content from diagnostic metadata, but never mutate the diff being reviewed.
If a diff itself contains a suspected secret, block automatic acceptance and
request the user.

**Step 3: Add review tools to Meeting MCP**

Provide Coordinator-only tools:

```text
inspect_delivery_review
get_delivery_review_chunk
submit_delivery_chunk_review
complete_delivery_review
request_delivery_rework
```

Tool output is bounded and never exposes arbitrary files.

**Step 4: Change Delivery Harness ownership**

After deterministic verification, enter `coordinator-reviewing`. The existing
simple reviewer becomes a pre-review structural check, not the acceptance
owner.

Only a complete review session may call the internal acceptance transition.

**Step 5: Run tests and commit**

```powershell
npm run build:electron
node --import "data:text/javascript,import { register } from 'node:module'; import { pathToFileURL } from 'node:url'; register('./tests/electron-stub.mjs', pathToFileURL('./'));" --test tests/coordinator-diff-review.test.mjs tests/delivery-harness.test.mjs tests/delivery-verifier.test.mjs tests/meeting-command-execution.test.mjs
git add electron/delivery-diff.ts electron/coordinator-review.ts electron/delivery-harness.ts electron/meeting-mcp.ts electron/meeting-tools.ts electron/orchestrator-prompts.ts electron/worker-scheduler.ts electron/orchestrator-types.ts tests/coordinator-diff-review.test.mjs
git commit -m "feat(collaboration): require complete coordinator diff review"
```

### Task 11: Replace fast-forward acceptance with Integration Queue

**Files:**

- Create: `electron/integration-queue.ts`
- Create: `tests/integration-queue.test.mjs`
- Modify: `electron/delivery-integrator.ts`
- Modify: `electron/delivery-harness.ts`
- Modify: `electron/worker-scheduler.ts:1000-1180,1305-1335`
- Modify: `electron/orchestrator.ts:1170-1220`
- Modify: `electron/orchestrator-types.ts`
- Modify: `src/lib/meeting-store.ts`
- Modify: `src/components/DeliveryViewer.tsx`
- Modify: `tests/delivery-integrator.test.mjs`
- Modify: `tests/worker-delivery-slice.test.mjs`

**Step 1: Replace fast-forward tests with parallel integration tests**

Test:

- two branches from the same base both integrate serially;
- each task produces exactly one reviewed candidate commit;
- the queue cherry-picks the exact reviewed commit;
- unreported or unreviewed files refuse candidate creation;
- moved base is re-checked rather than blindly refused;
- cherry-pick conflict aborts the cherry-pick and preserves the task branch;
- no automatic conflict resolution occurs;
- post-integration verification failure leaves recoverable evidence;
- dependency remains blocked until journal flush after integration;
- no normal per-task user acceptance is required.

**Step 2: Split candidate creation from base integration**

`GitDeliveryIntegrator` should expose:

```ts
prepareCandidate(view: DeliveryView, candidate: DeliveryCandidate): Promise<PreparedCandidate>
integrateCandidate(candidate: PreparedCandidate): Promise<WorkspaceIntegration>
abortIntegration(candidate: PreparedCandidate): Promise<void>
```

`prepareCandidate` stages only WorkReport paths and commits them in the task
worktree. `integrateCandidate` runs:

```text
git cherry-pick <reviewedCommit>
```

against the base. Never use `git add -A`.

**Step 3: Implement serialized queue**

One Meeting queue processes one candidate at a time. Queue state is journaled
before cherry-pick. On conflict:

```text
git cherry-pick --abort
```

is allowed because the queue created that operation and verified the repository
state. Preserve the task worktree and mark `integration-conflict`.

**Step 4: Move automatic acceptance**

Coordinator review completion enqueues integration. Successful integration and
post-checks produce durable `accepted`. Remove the normal renderer dependency
on `acceptDelivery()`; retain a migration/developer path until journal replay
tests cover old deliveries.

**Step 5: Run tests and commit**

```powershell
npm run build:electron
node --import "data:text/javascript,import { register } from 'node:module'; import { pathToFileURL } from 'node:url'; register('./tests/electron-stub.mjs', pathToFileURL('./'));" --test tests/integration-queue.test.mjs tests/delivery-integrator.test.mjs tests/worker-delivery-slice.test.mjs tests/meeting-recovery.test.mjs
git add electron/integration-queue.ts electron/delivery-integrator.ts electron/delivery-harness.ts electron/worker-scheduler.ts electron/orchestrator.ts electron/orchestrator-types.ts src/lib/meeting-store.ts src/components/DeliveryViewer.tsx tests/integration-queue.test.mjs tests/delivery-integrator.test.mjs tests/worker-delivery-slice.test.mjs
git commit -m "feat(collaboration): serialize reviewed commit integration"
```

## Milestone 6: Rework budget and recovery

### Task 12: Add bounded continuous rework

**Files:**

- Create: `electron/task-budget.ts`
- Create: `tests/task-budget.test.mjs`
- Modify: `electron/worker-scheduler.ts`
- Modify: `electron/orchestrator-types.ts`
- Modify: `electron/worker-protocol.ts`
- Modify: `src/types.ts`
- Modify: `src/components/TaskInspector.tsx`

**Step 1: Write failing budget tests**

Cover:

- ordinary verification/review failure creates a new attempt;
- token and time usage accumulate across attempts;
- failure fingerprint includes normalized error, failing check, and relevant
  file set but excludes secrets;
- equivalent repeated failure with no meaningful diff/evidence change increments
  stagnation;
- three stagnant attempts enter `budget-paused`;
- user can add budget through a versioned decision;
- rework cannot widen authority;
- task succeeds after any bounded attempt and old attempts remain immutable.

**Step 2: Implement pure budget evaluation**

```ts
export function evaluateTaskBudget(
  budget: TaskBudget,
  attempts: TaskAttemptRecord[],
): 'continue' | 'budget-paused' | 'non-converging';
```

Do not let the Coordinator override a pause by prompt text. A user decision or
plan revision is required.

**Step 3: Bind rework requests**

Structured rework includes findings, affected chunks, failed checks, expected
behavior, and unchanged authority hash. Create a fresh attempt and append the
request to its initial mailbox.

**Step 4: Run tests and commit**

```powershell
npm run build:electron
node --import "data:text/javascript,import { register } from 'node:module'; import { pathToFileURL } from 'node:url'; register('./tests/electron-stub.mjs', pathToFileURL('./'));" --test tests/task-budget.test.mjs tests/delivery-harness.test.mjs tests/coordinator-diff-review.test.mjs
git add electron/task-budget.ts electron/worker-scheduler.ts electron/orchestrator-types.ts electron/worker-protocol.ts src/types.ts src/components/TaskInspector.tsx tests/task-budget.test.mjs
git commit -m "feat(collaboration): bound automatic task rework"
```

### Task 13: Recover task mailboxes, attempts, reviews, and integration safely

**Files:**

- Modify: `electron/meeting-repository.ts`
- Modify: `electron/task-projection.ts`
- Modify: `electron/worker-scheduler.ts:279-390`
- Modify: `electron/orchestrator.ts:700-790`
- Modify: `electron/ipc/sessions.ts:100-220`
- Modify: `src/components/Lobby.tsx`
- Modify: `src/components/TaskInspector.tsx`
- Modify: `tests/meeting-recovery.test.mjs`
- Create: `tests/collaboration-recovery.test.mjs`

**Step 1: Write failing recovery scenarios**

Test:

- read-only running task may resume automatically;
- write, command, network, and external side-effect tasks restore interrupted;
- no Backend prompt or side effect occurs before confirmation;
- queued and delivered-but-unacknowledged messages remain recoverable;
- review chunk coverage restores exactly;
- integration queued before a crash is not duplicated;
- an in-progress cherry-pick is detected and requires explicit recovery;
- accepted task never regresses due to late events;
- event sequence continues after restart;
- task snapshot and renderer replay agree.

**Step 2: Extend snapshot**

Include:

- task records and attempts;
- mailbox cursors;
- review sessions;
- integration queue;
- budget;
- Coordinator identity and plan version.

Snapshot remains a projection. Replay must reconstruct equivalent state.

**Step 3: Implement recovery decisions**

Expose:

```text
continue-read-only
continue-side-effecting
retry-attempt
resolve-integration-conflict
abandon-task
```

Only the user may choose side-effecting continuation after restart.

**Step 4: Run tests and commit**

```powershell
npm run build:electron
node --import "data:text/javascript,import { register } from 'node:module'; import { pathToFileURL } from 'node:url'; register('./tests/electron-stub.mjs', pathToFileURL('./'));" --test tests/collaboration-recovery.test.mjs tests/meeting-recovery.test.mjs tests/task-mailbox.test.mjs tests/integration-queue.test.mjs
git add electron/meeting-repository.ts electron/task-projection.ts electron/worker-scheduler.ts electron/orchestrator.ts electron/ipc/sessions.ts src/components/Lobby.tsx src/components/TaskInspector.tsx tests/meeting-recovery.test.mjs tests/collaboration-recovery.test.mjs
git commit -m "feat(collaboration): recover meeting tasks safely"
```

## Milestone 7: Capability gates and real vertical acceptance

### Task 14: Gate stable Worker Backends and run the full workflow

**Files:**

- Modify: `electron/backends/worker-runtime-contract.ts`
- Modify: `electron/backends/registry.ts`
- Modify: `tests/backend-capability-gates.test.mjs`
- Modify: `tests/multi-backend-worker-smoke.test.mjs`
- Create: `tests/collaboration-vertical-slice.test.mjs`
- Modify: `docs/orchestrator-v2-progress.md`
- Modify: `README.md`

**Step 1: Write the vertical slice**

Use a deterministic Claude Coordinator fixture to:

1. propose four tasks;
2. edit and approve the plan;
3. grant bounded authority;
4. spawn Claude and Codex Workers in parallel;
5. queue a follow-up;
6. steer one turn;
7. handle one high-risk user permission;
8. accept valid reports;
9. verify;
10. review every diff chunk;
11. request one rework;
12. integrate two parallel commits serially;
13. release dependencies only after accepted;
14. produce one final Meeting delivery.

Assert no Worker-to-Worker message and no Coordinator file write.

**Step 2: Add Backend stability gates**

Stable Worker requires:

```text
runtime compatible
auth ready
profile compilation
WorkReport
interrupt
resume
permission bridge
recovery
real vertical smoke
```

Claude and Codex may become stable when all gates pass. OpenCode and Kimi stay
experimental even if basic execute tests pass.

**Step 3: Run complete automated validation**

```powershell
npm run typecheck:renderer
npm run typecheck:electron
npm test
npm run build
git diff --check
```

Expected: zero failures.

**Step 4: Run manual/real matrix**

- Claude Coordinator → Claude Worker.
- Claude Coordinator → Codex Worker.
- Two parallel write tasks with non-overlapping worktrees.
- Dirty base blocked.
- Shared locked compatibility mode.
- Steering while a tool is active.
- High-risk permission.
- Coordinator reconnect.
- Application restart with side-effecting tasks.
- Integration conflict.
- Budget pause and user extension.
- Final Meeting acceptance.

Do not mark OpenCode or Kimi stable from mocked tests.

**Step 5: Update documentation and commit**

Document actual pass/fail evidence and remaining gates.

```powershell
git add electron/backends/worker-runtime-contract.ts electron/backends/registry.ts tests/backend-capability-gates.test.mjs tests/multi-backend-worker-smoke.test.mjs tests/collaboration-vertical-slice.test.mjs docs/orchestrator-v2-progress.md README.md
git commit -m "feat(collaboration): enable coordinated meeting tasks"
```

## Final acceptance checklist

- [ ] One and only one Coordinator exists.
- [ ] Coordinator cannot edit files.
- [ ] Workers cannot directly message peers.
- [ ] User-approved authority is structural and bounded.
- [ ] High-risk actions always reach the user.
- [ ] Requested and effective Backend profiles are visible.
- [ ] Dirty Git state blocks parallel writes.
- [ ] Every task message is durable before delivery.
- [ ] Snapshot plus `afterSeq` recovery is idempotent.
- [ ] WorkReport is the only completion signal.
- [ ] Verification precedes Coordinator review.
- [ ] Every frozen diff chunk is reviewed.
- [ ] Automatic acceptance requires complete evidence.
- [ ] Integration uses exact reviewed-commit cherry-picks.
- [ ] Conflicts do not auto-resolve.
- [ ] Dependency release follows durable post-integration acceptance.
- [ ] Rework is continuous but budgeted and convergence-aware.
- [ ] Side effects never auto-replay after restart.
- [ ] Claude and Codex pass real vertical tests.
- [ ] OpenCode and Kimi remain experimental until their gates pass.
- [ ] Renderer and Electron typechecks pass.
- [ ] Full Node test suite passes.
- [ ] Production build passes.
