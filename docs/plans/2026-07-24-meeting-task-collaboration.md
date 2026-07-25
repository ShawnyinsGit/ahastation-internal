# Meeting Task Collaboration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add Meeting-owned visible tasks with frozen context packages, durable mailboxes, per-Backend execution profiles, bounded Coordinator authority, complete Coordinator diff review, staged exact-commit integration, and one final Meeting delivery.

**Architecture:** Extend the existing Meeting `WorkerScheduler`, append-only journal, Backend adapters, worktree manager, Delivery Harness, and Task Rail. Claude Code remains the only first-release Coordinator; it never edits files. Workers execute isolated attempts, the Coordinator reviews frozen diff chunks through a durable review session, and one Integration Queue accumulates exact commits on a Meeting-owned integration branch. Only final Meeting acceptance publishes the exact verified head to the user's base.

**Tech Stack:** TypeScript 5.7, Zod 4, Electron main/preload IPC, React 18, Node test runner, Git worktrees, append-only JSONL journal, Claude Agent SDK, Codex app-server, OpenCode SDK, Kimi ACP.

---

## Plan revision

Revision 2 was accepted during the implementation review after Tasks 1-3.
It preserves their completed contracts and tightens later work:

- task acceptance means verified accumulation on the Meeting integration
  branch, while final Meeting acceptance is the only user-base publication
  boundary;
- dirty Git `shared-locked` execution is compatibility-only and cannot claim
  automatic integration;
- authority grants bind plan, approval, attempt, and workspace identity;
- mailbox and Meeting journal cursors remain separate;
- renderer catch-up and subscription are race-free;
- opaque or secret-bearing diff coverage requires the user.

The authoritative attempt-start order is:

```text
normalize approved plan
→ freeze and flush Context Package
→ probe runtime and compile/flush Backend effective profile
→ inspect baseline and allocate workspace
→ compile/flush attempt-specific authority grant
→ create Backend session
→ deliver first prompt
```

Failure at any step must not perform a later step.

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

If the shell cannot resolve `node`/`npm`, follow `AGENTS.md`: prepend
`/usr/local/bin` to `PATH` or use `/usr/local/bin/node` and
`/usr/local/bin/npm`. Do not interpret a missing shell `PATH` entry as a
product failure.

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

Do not enable the collaboration capability in production until Task 17 passes.
Do not expose automatic Coordinator candidate acceptance until Tasks 1-15
pass, including budget enforcement.
Do not expose final base publication until Tasks 14 and 16 pass.
Do not remove per-delivery migration controls until Task 14 and legacy replay
tests pass.

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
- every new task status and every legacy status projection;
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

**Step 3: Add versioned task statuses without breaking legacy consumers**

Add a new `MeetingTaskStatus` for the durable collaboration record:

```ts
export type MeetingTaskStatus =
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

Do **not** remove `reviewing`, `awaiting-acceptance`, or `done` from the
existing `WorkerStatusKind` in this task. Add a pure, versioned normalizer:

```ts
normalizeLegacyWorkerStatus(
  input: { status: WorkerStatusKind | string; evidence?: LegacyDeliveryEvidence },
): { status: MeetingTaskStatus; diagnostic?: string }
```

Do not infer new review or integration evidence from an old status string.
Legacy `reviewing` and `awaiting-acceptance` recover as `interrupted` with a
`legacy-delivery-review-required` diagnostic. Legacy `done` becomes
`accepted` only when durable legacy acceptance/integration evidence exists;
otherwise it also recovers interrupted. Historical journal events remain
unchanged. Keep renderer and Electron types in parity.

**Step 4: Run targeted tests**

```powershell
npm run build:electron
node --import "data:text/javascript,import { register } from 'node:module'; import { pathToFileURL } from 'node:url'; register('./tests/electron-stub.mjs', pathToFileURL('./'));" --test tests/task-collaboration.test.mjs tests/worker-event-schema-parity.test.mjs tests/meeting-recovery.test.mjs
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
- legacy task input is normalized before strict validation;
- recovery of a legacy plan never gains command, network, or undeclared write
  authority;
- `backendId` agrees with `executorBackendId` during the compatibility window;
- write tasks declare `workspaceMode`;
- plan revision cannot mutate a running task's frozen profile, grant request,
  context package, or workspace mode;
- a revision may add a task, cancel a pending task, change pending-task
  dependencies, or steer a running task;
- stale `expectedPlanVersion` remains rejected.

**Step 2: Add a versioned plan-input normalizer**

Keep a permissive legacy input schema at the command/recovery boundary and
compile it into the strict current schema. Use these conservative defaults:

```text
backendId       = executorBackendId ?? current Meeting Worker default
workMode        = balanced
contextMode     = meeting-summary
timeoutMs       = 1_800_000
maxTokenBudget  = 200_000
workspaceMode   = writePaths.length > 0 ? git-worktree : read-only
writePaths      = legacy writePaths
toolKinds       = read plus write only when writePaths are declared
workingDirectories = ["."]
commands        = []
environmentKeys = []
maxCommandTimeoutMs = 1_800_000
networkHosts    = []
```

The normalizer emits a safe migration diagnostic and never infers command,
network, credential, destructive, or external-service authority. Persist the
normalized plan version after user approval; do not rewrite historical journal
events during replay.

**Step 3: Extend `planMeetingTaskSchema`**

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
  workingDirectories: z.array(z.string().min(1)).max(100),
  commands: z.array(z.array(z.string().max(4_000)).min(1).max(100)).max(100),
  environmentKeys: z.array(z.string().min(1).max(200)).max(100),
  maxCommandTimeoutMs: z.number().int().min(1_000).max(7_200_000),
  networkHosts: z.array(z.string().min(1).max(253)).max(100),
}).strict(),
```

Keep old `executorBackendId` and `writePaths` only as read compatibility fields.
Normalize them into the new shape at the command boundary.

**Step 4: Update plan revision invariants**

Capture the task status before applying each revision operation. Reject
in-place changes to immutable running-attempt fields with:

```text
running task execution boundaries require a new attempt
```

**Step 5: Update `PlanMeetingModal`**

Add controls for:

- Backend;
- work mode;
- context mode;
- workspace mode;
- write paths;
- allowed working directories;
- commands;
- environment-key names and maximum command timeout;
- network hosts;
- timeout and token budget.

Show a compact authority summary before the user confirms. High-risk actions
must not appear as auto-approved options.

**Step 6: Run tests and typechecks**

```powershell
npm run build:electron
node --import "data:text/javascript,import { register } from 'node:module'; import { pathToFileURL } from 'node:url'; register('./tests/electron-stub.mjs', pathToFileURL('./'));" --test tests/plan-task-profile.test.mjs tests/meeting-command.test.mjs tests/plan-revision.test.mjs tests/renderer-plan-validation.test.mjs tests/meeting-recovery.test.mjs
npm run typecheck:renderer
```

**Step 7: Commit**

```powershell
git add electron/meeting-tools.ts electron/meeting-command.ts electron/worker-scheduler.ts electron/orchestrator-types.ts src/types.ts src/lib/plan-validation.ts src/components/PlanMeetingModal.tsx tests/meeting-command.test.mjs tests/plan-revision.test.mjs tests/renderer-plan-validation.test.mjs tests/plan-task-profile.test.mjs
git commit -m "feat(collaboration): add task execution profiles to plans"
```

### Task 3: Compile and freeze the Context Package

**Files:**

- Create: `electron/task-context.ts`
- Create: `tests/task-context.test.mjs`
- Modify: `electron/orchestrator.ts`
- Modify: `electron/host-group.ts`
- Modify: `electron/worker-scheduler.ts:70-125,1184-1235,1340-1425`
- Modify: `electron/orchestrator-types.ts`
- Modify: `electron/attachments/assets.ts`
- Modify: `tests/meeting-command-execution.test.mjs`

**Step 1: Write failing context-compiler tests**

Test:

- `minimal`, `meeting-summary`, `selected-history`, and
  `full-visible-history` compile deterministic packages;
- selected message, decision, dependency-report, and attachment IDs must
  belong to the current Meeting/task authority;
- missing and unauthorized references reject before workspace creation;
- hidden reasoning, Backend authentication, credential-shaped metadata, and
  native payloads never enter the package;
- byte and estimated-token bounds reject an oversized package;
- the package hash changes with visible content but not map ordering;
- later mailbox messages do not mutate the frozen initial package;
- a failed compile produces no worktree and no Backend session.

**Step 2: Implement a pure compiler**

```ts
export function compileContextPackage(input: {
  taskId: string;
  attempt: number;
  selection: ContextSelection;
  source: AuthorizedMeetingContextSource;
  limits: { maxBytes: number; maxEstimatedTokens: number };
}): ContextPackage
```

Resolve IDs before reading content. Copy only user-visible text, bounded
decision summaries, accepted dependency reports, and authorized attachment
references. Hash attachment contents without embedding arbitrary binary data.
Use stable serialization plus SHA-256 for `packageHash`.

**Step 3: Add one explicit source seam**

The Orchestrator owns Meeting transcript, decisions, dependency reports, and
attachment authorization. Add one read-only
`getAuthorizedTaskContextSource(taskId, selection)` callback to
`WorkerSchedulerOptions`; do not let the Scheduler scrape renderer state or
the filesystem outside the attachment resolver.

**Step 4: Freeze before any execution side effect**

In `spawnWorker()`:

1. compile the package;
2. append and flush `context-package-frozen`;
3. store its immutable hash on the attempt;
4. only then compile the Backend profile, allocate the workspace, and create
   the session.

Render the package into a bounded provider-neutral first message. The
Backend-specific Adapter may frame it but cannot add hidden Meeting history.

**Step 5: Run tests**

```powershell
npm run build:electron
node --import "data:text/javascript,import { register } from 'node:module'; import { pathToFileURL } from 'node:url'; register('./tests/electron-stub.mjs', pathToFileURL('./'));" --test tests/task-context.test.mjs tests/meeting-command-execution.test.mjs tests/meeting-recovery.test.mjs
```

Expected: all tests pass, including the assertion that context failure creates
no worktree or Backend process.

**Step 6: Commit**

```powershell
git add electron/task-context.ts electron/orchestrator.ts electron/host-group.ts electron/worker-scheduler.ts electron/orchestrator-types.ts electron/attachments/assets.ts tests/task-context.test.mjs tests/meeting-command-execution.test.mjs
git commit -m "feat(collaboration): freeze authorized task context"
```

## Milestone 2: Backend intent, authority, and workspace safety

### Task 4: Compile execution intent per Backend

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

**Step 2: Extend the registered `CliBackend` contract**

```ts
export interface CliBackend {
  // existing members...
  compileTaskProfile?(
    requested: TaskExecutionProfile,
    runtime: BackendRuntime,
  ): BackendEffectiveProfile;
}
```

`BackendRegistry` already stores `CliBackend` instances. Add the method there;
do not introduce a parallel `BackendAdapter` type and do not let the Scheduler
contain provider-specific `if` chains. The method may remain optional for
source compatibility, but every Backend advertising `executeTasks: true` must
provide it or fail its Worker capability gate.

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

Persist the requested profile, runtime facts, effective profile, and
`capabilityHash` in one event before workspace allocation. Runtime probing may
spawn only the existing version probe after the Context Package is durable; it
must not authenticate, read credentials, or create a Backend session.

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

### Task 5: Normalize native Backend permission requests

**Files:**

- Create: `electron/backends/canonical-execution.ts`
- Create: `tests/backend-canonical-execution.test.mjs`
- Modify: `electron/backends/cli-backend.ts`
- Modify: `electron/backends/claude-code-adapter.ts`
- Modify: `electron/backends/codex-adapter.ts`
- Modify: `electron/backends/opencode-adapter.ts`
- Modify: `electron/backends/kimi-adapter.ts`

**Step 1: Write failing normalization tests**

Cover, for every Worker-capable Backend:

- source read and workspace write;
- exact executable plus argv, `cwd`, timeout, and environment-key names;
- shell-wrapped command identity without joining a new shell string;
- network hosts and external-service side effects;
- destructive Git, credential, administrator, and system-install facts;
- stable native request identity;
- native credential values and raw payloads never enter the canonical request;
- an incomplete or unrecognized native request fails closed.

Qoder and custom Backends currently have `executeTasks: false`; assert they
remain unavailable as Workers rather than inventing an unverified permission
normalizer.

**Step 2: Add the canonical contract**

```ts
export interface CanonicalExecutionRequest {
  schemaVersion: 1;
  taskId: string;
  backendId: string;
  kind: 'read' | 'write' | 'command' | 'network' | 'external';
  workspaceRoot: string;
  cwd?: string;
  executable?: string;
  argv?: string[];
  writePaths: string[];
  networkHosts: string[];
  environmentKeys: string[];
  sideEffects: string[];
  timeoutMs?: number;
  nativeRequestId: string;
}
```

Add `normalizePermissionRequest(...)` to `CliBackend`. The Adapter must return
either a complete canonical request or an explicit unsupported diagnostic.
The Coordinator and Scheduler never parse provider-native payloads.

**Step 3: Implement Backend-specific pure normalizers**

Do not start a process, read credentials, or access the network. Preserve the
exact executable/argv boundary supplied by the Backend. If a Backend exposes
only opaque shell text, classify it as requiring the user until a safe parser
and test matrix exist. An opaque request cannot satisfy the stable Worker
permission-normalization gate and must never receive in-grant auto-approval.

**Step 4: Run tests and commit**

```powershell
npm run build:electron
node --import "data:text/javascript,import { register } from 'node:module'; import { pathToFileURL } from 'node:url'; register('./tests/electron-stub.mjs', pathToFileURL('./'));" --test tests/backend-canonical-execution.test.mjs tests/permission-broker.test.mjs tests/backend-capability-gates.test.mjs
git add electron/backends/canonical-execution.ts electron/backends/cli-backend.ts electron/backends/claude-code-adapter.ts electron/backends/codex-adapter.ts electron/backends/opencode-adapter.ts electron/backends/kimi-adapter.ts tests/backend-canonical-execution.test.mjs
git commit -m "feat(collaboration): normalize backend execution requests"
```

### Task 6: Compile bounded authority grants

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
- path escape, wrong `cwd`, executable/argv mismatch, undeclared environment
  key, undeclared command, and undeclared network host deny;
- deletion, destructive Git, credential access, admin privilege, system install,
  external publish, and external message always ask the user;
- task text and context cannot grant authority;
- grants bind the task ID, attempt, plan version, approval decision,
  authority-request hash, and actual workspace identity;
- expired and mismatched grant hashes deny;
- rework may reuse but never widen the grant;
- a wider new attempt requires plan revision and user approval.

**Step 2: Implement the compiler**

```ts
export function compileTaskAuthority(
  taskId: string,
  attempt: number,
  planVersion: number,
  approvalDecisionId: string,
  workspaceRoot: string,
  request: PlanMeetingTask['authorityRequest'],
  approvedAt: number,
): TaskAuthorityGrant
```

The user approves the relative `authorityRequest`; this function compiles the
attempt-specific grant only after workspace allocation and before Backend
session creation. Persist and flush the derived grant before any tool-capable
session starts.

Normalize and confine write paths and working directories to `workspaceRoot`.
Normalize command executable/argv without joining through a shell. Normalize
environment-key names, cap timeout, and canonicalize host names. Compute
`authorityRequestHash`, `workspaceIdentityHash`, and `grantHash` from
non-secret normalized facts. Resolve existing path ancestors and reject
symlink/junction or case-normalization escapes rather than relying on lexical
prefix checks.

**Step 3: Add deterministic policy**

```ts
export type AuthorityDecision =
  | { kind: 'allow'; reason: string }
  | { kind: 'ask-user'; reason: string }
  | { kind: 'deny'; reason: string };
```

High-risk classification runs before in-grant allow logic. Trust or
Coordinator identity cannot override `ask-user` or `deny`.

**Step 4: Integrate canonical requests with the existing Permission Broker**

The Permission Broker accepts only `CanonicalExecutionRequest` from Task 5.
Preserve the current UI card and native response path. Journal the canonical
decision and safe summary, not raw credential-bearing native payloads.
Missing Adapter normalization is `ask-user` or `deny`, never an in-grant
automatic allow.

The deterministic Broker owns the allow/ask/deny decision. The Coordinator
may explain or forward it but prompt text, identity, or model output cannot
override policy. `allowedNetworkHosts` applies to normalized native network
requests; do not claim it sandboxes network egress from an approved process.

**Step 5: Run tests**

```powershell
npm run build:electron
node --import "data:text/javascript,import { register } from 'node:module'; import { pathToFileURL } from 'node:url'; register('./tests/electron-stub.mjs', pathToFileURL('./'));" --test tests/task-authority.test.mjs tests/permission-broker.test.mjs tests/backend-capability-gates.test.mjs
```

**Step 6: Commit**

```powershell
git add electron/task-authority.ts electron/task-collaboration.ts electron/permission-broker.ts electron/orchestrator.ts electron/worker-scheduler.ts electron/orchestrator-types.ts src/types.ts tests/task-authority.test.mjs tests/task-collaboration.test.mjs tests/permission-broker.test.mjs
git commit -m "feat(collaboration): enforce bounded task authority"
```

### Task 7: Guard dirty workspaces and explicit shared mode

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
- a dirty Git `shared-locked` choice is visibly compatibility-only, switches
  to the existing legacy per-delivery path, and cannot enter the managed
  collaboration DAG;
- a plan cannot mix legacy shared-locked write tasks with managed
  `git-worktree` write tasks;
- a read-only workspace has an explicit `read-only` snapshot kind and never
  receives write, command, network, or external authority;
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
  sourceRevision?: string;
}): TaskWorkspace
```

Throw a typed `DirtyWorkspaceWriteBlockedError` before any mutation. For a
dependency-released Git task, `sourceRevision` is the durably accepted Meeting
integration head, not the user's potentially stale base HEAD.

**Step 4: Surface the blocked state**

The Scheduler must keep the task blocked with a visible diagnostic and offer:

- handle workspace changes outside AhaStation;
- choose shared locked mode through a versioned plan revision;
- cancel the task.

The shared-locked choice must state that it writes the selected workspace in
place, disables Coordinator automatic task acceptance/integration and final
atomic publication, and returns to the existing per-delivery user controls.
Never present path locks as protection against the user or external processes.

**Step 5: Run tests and commit**

```powershell
npm run build:electron
node --import "data:text/javascript,import { register } from 'node:module'; import { pathToFileURL } from 'node:url'; register('./tests/electron-stub.mjs', pathToFileURL('./'));" --test tests/task-workspace.test.mjs tests/task-workspace-dirty-baseline.test.mjs
git add electron/task-workspace.ts electron/task-collaboration.ts electron/worker-scheduler.ts electron/orchestrator-types.ts src/types.ts tests/task-workspace.test.mjs tests/task-workspace-dirty-baseline.test.mjs
git commit -m "feat(collaboration): guard task workspace baselines"
```

## Milestone 3: Durable Task Mailbox

### Task 8: Add mailbox events and task projection

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
- message sequence is monotonic per task across attempts and never resets;
- Meeting journal sequence remains separate from task mailbox sequence;
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

Add a stable event ID and a typed task-event envelope carrying `taskId` and
optional `attempt`. Normalize historical events without IDs to
`<meetingId>:<seq>` during replay. Enforce bounded payload depth and serialized
size before append.

An append resolves only after the line is durable enough for subsequent
delivery. If a journal write fails, the repository becomes write-faulted:
later appends, snapshots, live notifications, Backend delivery, and integration
must stop rather than skipping a sequence and continuing.

Add:

```ts
static async replayAfter(
  meetingId: string,
  afterSeq: number,
  limit: number,
): Promise<{
  events: PersistedMeetingEvent[];
  nextAfterSeq: number;
  hasMore: boolean;
}>
```

Clamp `limit` to `1..500`, stop collecting after the page is full, and bound
serialized output. Ignore a final partial JSONL line exactly as current replay
does. The first release may scan the local JSONL file, but it must not return
an unbounded tail to IPC callers.

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
Use the Meeting event sequence for `eventCursor` and the task-local message
sequence for `mailboxCursor`; never compare or substitute them.

**Step 5: Run tests and commit**

```powershell
npm run build:electron
node --import "data:text/javascript,import { register } from 'node:module'; import { pathToFileURL } from 'node:url'; register('./tests/electron-stub.mjs', pathToFileURL('./'));" --test tests/task-mailbox.test.mjs tests/task-projection.test.mjs tests/meeting-recovery.test.mjs
git add electron/task-mailbox.ts electron/task-projection.ts electron/meeting-repository.ts electron/orchestrator.ts tests/task-mailbox.test.mjs tests/task-projection.test.mjs
git commit -m "feat(collaboration): persist task mailboxes"
```

### Task 9: Route follow-up, steering, and interrupt through Mailbox

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

### Task 10: Add bounded task snapshot, replay, and live subscription

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
- `afterSeq` returns only later task events in bounded pages;
- another Meeting/task cannot be read through the IPC;
- invalid cursor and oversized request fail;
- live subscription emits only the authorized Meeting/task and can unsubscribe;
- an event persisted between the final replay page and subscription setup is
  delivered exactly once;
- duplicate event ID and sequence are ignored;
- a gap triggers snapshot refresh rather than speculative reduction;
- sensitive authority internals are projected to a safe renderer view.

**Step 2: Add main-process API**

```ts
getTaskSnapshot(sessionId: string, taskId: string): Promise<TaskSnapshot>
getTaskEvents(
  sessionId: string,
  taskId: string,
  afterSeq: number,
  limit: number,
): Promise<{
  events: TaskEvent[];
  nextAfterSeq: number;
  hasMore: boolean;
}>
```

Use the existing session authorization lookup. Do not expose arbitrary Meeting
journal reads. Clamp `limit` to `1..500` and bound the serialized response.

**Step 3: Add preload bridge**

Expose typed methods:

```ts
tasks.getSnapshot(sessionId, taskId)
tasks.getEvents(sessionId, taskId, afterSeq, limit)
tasks.onEvent(sessionId, taskId, afterSeq, listener) => unsubscribe
tasks.followUp(sessionId, taskId, text)
tasks.steer(sessionId, taskId, text)
tasks.interrupt(sessionId, taskId, reason)
```

Bound all strings and IDs at IPC validation.
`onEvent` must atomically register the subscriber and replay persisted task
events after `afterSeq` before releasing live events. A plain “fetch pages,
then attach an unbuffered listener” implementation is invalid.

**Step 4: Add renderer hydration**

On Task Inspector open:

1. fetch snapshot;
2. page persisted events until `hasMore === false`;
3. subscribe from the last applied sequence;
4. apply live events;
5. if a sequence gap appears, unsubscribe and re-fetch the snapshot.

Do not fetch the entire Meeting transcript for every task.

**Step 5: Run tests and commit**

```powershell
npm run build:electron
node --import "data:text/javascript,import { register } from 'node:module'; import { pathToFileURL } from 'node:url'; register('./tests/electron-stub.mjs', pathToFileURL('./'));" --test tests/task-ipc.test.mjs tests/renderer-task-event-reducer.test.mjs tests/renderer-security.test.mjs
npm run typecheck:renderer
git add electron/ipc/tasks.ts electron/main.ts electron/preload.cjs src/types.ts src/lib/task-event-reducer.ts src/lib/meeting-store.ts tests/task-ipc.test.mjs tests/renderer-task-event-reducer.test.mjs
git commit -m "feat(collaboration): replay task state through typed ipc"
```

### Task 11: Build the docked Task Inspector

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
Do not introduce another design system. The screenshot is visual inspiration;
the requirements and tests in this plan are normative, so implementation must
not depend on a file in the original user's Downloads directory.

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

## Milestone 5: Coordinator review, staged integration, and final delivery

### Task 12: Add durable frozen, chunked Coordinator diff review

**Files:**

- Create: `electron/delivery-diff.ts`
- Create: `electron/delivery-candidate.ts`
- Create: `electron/coordinator-review.ts`
- Create: `electron/coordinator-review-driver.ts`
- Create: `tests/coordinator-diff-review.test.mjs`
- Create: `tests/coordinator-review-driver.test.mjs`
- Modify: `electron/delivery-harness.ts`
- Modify: `electron/meeting-mcp.ts`
- Modify: `electron/meeting-tools.ts`
- Modify: `electron/orchestrator-prompts.ts`
- Modify: `electron/worker-scheduler.ts`
- Modify: `electron/orchestrator-types.ts`

**Step 1: Write failing review-state tests**

Test:

- review freezes candidate commit and diff hash;
- candidate creation commits only WorkReport paths after deterministic
  verification and refuses unreported changes;
- manifest contains every changed file and bounded statistics;
- chunks are deterministic and bounded by bytes/lines;
- binary and oversized files produce explicit non-inline evidence;
- symlink, submodule, rename, and file-mode changes produce typed evidence;
- suspected-secret chunks are never sent to the Coordinator model;
- binary, oversized, or secret-withheld coverage cannot complete without an
  explicit user confirmation bound to the chunk hash;
- Coordinator can review chunks only in order or by explicit chunk ID;
- every review records the chunk hash;
- changed candidate invalidates affected reviews;
- incomplete coverage cannot complete;
- blocking finding creates a structured rework request;
- complete passing review emits `coordinator-review-completed`;
- verification appends `coordinator-review-requested` before notifying the
  Host;
- a Coordinator turn that ends with incomplete coverage queues the next
  bounded review turn;
- restart resumes the exact unreviewed chunk without duplicating reviewed
  chunks;
- Coordinator disconnect pauses new review turns but preserves the session;
- Coordinator has no write or shell tool.

**Step 2: Prepare and freeze the exact candidate before review**

After deterministic verification:

1. compare all dirty worktree paths with the WorkReport manifest;
2. refuse missing/unreported paths;
3. stage only reported paths with explicit Git argv;
4. create one candidate commit in the task worktree;
5. persist commit ID, tree ID, base revision, and report hash;
6. build the review manifest from that immutable commit.

Never use `git add -A`. Candidate preparation is idempotent for the same
attempt/report hash. Any subsequent worktree change creates a new attempt or
invalidates review; it never mutates the frozen candidate.

**Step 3: Implement safe diff construction**

Use Git argv, never a shell string:

```text
git diff --binary --no-ext-diff <base>..<candidate> --
git diff --numstat <base>..<candidate> --
```

Confine all reported paths to the task workspace. Redact credential-shaped
content from diagnostic metadata, but never mutate the diff being reviewed.
If a diff itself contains a suspected secret, block automatic acceptance and
request the user before the raw chunk is exposed to any model. Treat diff text
as untrusted input: it cannot alter Coordinator tools, authority, review cursor,
or integration decisions.

**Step 4: Implement the durable review driver**

```ts
export class CoordinatorReviewDriver {
  request(input: VerifiedDelivery): Promise<CoordinatorReviewSession>;
  onCoordinatorTurnEnded(reviewId: string): Promise<void>;
  resume(reviewId: string): Promise<void>;
}
```

The driver journals the session and current cursor before sending a bounded
review briefing to the Coordinator. Tool results advance the cursor
idempotently. If a turn ends before complete coverage, enqueue another turn
instead of accepting or abandoning the review. Backoff and maximum
review-turn budget are structural; exceeding them pauses for the user.

**Step 5: Add review tools to Meeting MCP**

Provide Coordinator-only tools:

```text
inspect_delivery_review
get_delivery_review_chunk
submit_delivery_chunk_review
complete_delivery_review
request_delivery_rework
```

Tool output is bounded and never exposes arbitrary files.

**Step 6: Change Delivery Harness ownership**

After deterministic verification, enter `coordinator-reviewing`. The existing
simple reviewer becomes a pre-review structural check, not the acceptance
owner.

Only a complete review session may produce a `ReviewedCandidate` and enqueue
Task 13. It cannot mark the task accepted; durable acceptance remains
post-integration-branch verification and journal flush.

**Step 7: Run tests and commit**

```powershell
npm run build:electron
node --import "data:text/javascript,import { register } from 'node:module'; import { pathToFileURL } from 'node:url'; register('./tests/electron-stub.mjs', pathToFileURL('./'));" --test tests/coordinator-diff-review.test.mjs tests/coordinator-review-driver.test.mjs tests/delivery-harness.test.mjs tests/delivery-verifier.test.mjs tests/meeting-command-execution.test.mjs tests/meeting-recovery.test.mjs
git add electron/delivery-candidate.ts electron/delivery-diff.ts electron/coordinator-review.ts electron/coordinator-review-driver.ts electron/delivery-harness.ts electron/meeting-mcp.ts electron/meeting-tools.ts electron/orchestrator-prompts.ts electron/worker-scheduler.ts electron/orchestrator-types.ts tests/coordinator-diff-review.test.mjs tests/coordinator-review-driver.test.mjs
git commit -m "feat(collaboration): require complete coordinator diff review"
```

### Task 13: Replace direct base integration with a staged Integration Queue

**Files:**

- Create: `electron/integration-queue.ts`
- Create: `tests/integration-queue.test.mjs`
- Modify: `electron/delivery-integrator.ts`
- Modify: `electron/task-workspace.ts`
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
- the queue cherry-picks the exact reviewed commit into a Meeting-owned
  integration worktree/branch;
- unreported or unreviewed files refuse candidate creation;
- post-integration verification failure leaves the prior integration head and
  user's base unchanged;
- per-task acceptance never modifies the user's base;
- a dependent task workspace starts from the accepted integration head;
- cherry-pick conflict aborts the cherry-pick and preserves the task branch;
- no automatic conflict resolution occurs;
- a crash between staged verification and durable task acceptance is idempotently
  recoverable;
- dependency remains blocked until journal flush after integration-branch
  acceptance;
- no normal per-task user acceptance is required.

**Step 2: Split staging, verification, and task acceptance**

`GitDeliveryIntegrator` should expose:

```ts
stageCandidate(candidate: ReviewedCandidate, state: IntegrationState): Promise<StagedIntegration>
verifyStagedIntegration(staged: StagedIntegration): Promise<VerifiedIntegration>
acceptVerifiedIntegration(verified: VerifiedIntegration): Promise<WorkspaceIntegration>
abortStagedIntegration(staged: StagedIntegration): Promise<void>
```

Task 12 already created and froze the candidate commit before Coordinator
review. `stageCandidate` first re-verifies its commit, tree, report, and review
hashes, then runs:

```text
git cherry-pick <reviewedCommit>
```

inside the Meeting-owned integration worktree, never the user's base
worktree. Never use `git add -A`. `acceptVerifiedIntegration` first checks:

```text
verified.priorIntegrationHead == durable queue head before staging
integration HEAD == verified.resultingIntegrationHead
integration checks match verified tree hash
```

It then records the verified integration revision as the new Meeting
integration head. It never runs Git commands in the user's base worktree.

**Step 3: Implement serialized queue**

One Meeting queue processes one candidate at a time. Create the integration
branch/worktree from the last durably accepted integration head and journal its identity
before cherry-pick. On conflict:

```text
git cherry-pick --abort
```

is allowed only in the queue-owned integration worktree because the queue
created that operation and verified the repository state. Preserve both task
and integration evidence and mark `integration-conflict`. Never run
`cherry-pick --abort`, reset, or revert in the user's base worktree.

Reuse one integration branch/worktree per Meeting so accepted tasks form one
verified chain. Remove the integration worktree only after final Meeting
acceptance and publication are durable and the published base contains its
head; cleanup
failure is diagnostic, not acceptance rollback.

**Step 4: Move task acceptance to verified Meeting-branch integration**

Coordinator review completion enqueues staging. Successful staged checks,
integration-head update, and journal flush produce durable task `accepted`.
That state releases dependents but does not mean “published to user base”.
Remove the normal renderer dependency on `acceptDelivery()`; retain a
migration/developer path until journal replay tests cover old deliveries.

**Step 5: Run tests and commit**

```powershell
npm run build:electron
node --import "data:text/javascript,import { register } from 'node:module'; import { pathToFileURL } from 'node:url'; register('./tests/electron-stub.mjs', pathToFileURL('./'));" --test tests/integration-queue.test.mjs tests/delivery-integrator.test.mjs tests/worker-delivery-slice.test.mjs tests/meeting-recovery.test.mjs
git add electron/integration-queue.ts electron/delivery-integrator.ts electron/task-workspace.ts electron/delivery-harness.ts electron/worker-scheduler.ts electron/orchestrator.ts electron/orchestrator-types.ts src/lib/meeting-store.ts src/components/DeliveryViewer.tsx tests/integration-queue.test.mjs tests/delivery-integrator.test.mjs tests/worker-delivery-slice.test.mjs
git commit -m "feat(collaboration): serialize reviewed commit integration"
```

### Task 14: Aggregate and accept one final Meeting delivery

**Files:**

- Create: `electron/meeting-delivery.ts`
- Create: `electron/ipc/meeting-delivery.ts`
- Create: `src/components/FinalMeetingDelivery.tsx`
- Create: `tests/meeting-final-delivery.test.mjs`
- Create: `tests/renderer-final-meeting-delivery.test.mjs`
- Modify: `electron/main.ts`
- Modify: `electron/preload.cjs`
- Modify: `electron/orchestrator.ts`
- Modify: `electron/integration-queue.ts`
- Modify: `electron/task-workspace.ts`
- Modify: `electron/meeting-command.ts`
- Modify: `electron/orchestrator-types.ts`
- Modify: `src/types.ts`
- Modify: `src/lib/meeting-store.ts`
- Modify: `src/components/ScreenStage.tsx`

**Step 1: Write failing final-delivery tests**

Test:

- a final delivery cannot be created while required tasks are pending,
  unreviewed, unintegrated, conflicted, or budget-paused;
- it includes accepted plan version, task/attempt IDs, integrated commits,
  changed-file manifest, verification/review summaries, approvals, limitations,
  and unresolved/cancelled work;
- its content hash is deterministic and excludes credentials/native payloads;
- `meeting-delivery-ready` is durable before the UI can act;
- full-Meeting verification passes on the exact integration head before ready;
- user acceptance intent is durable before publication begins;
- publication checks a clean user base at the expected revision and
  fast-forwards it to the exact verified integration head;
- `meeting-delivery-accepted` is appended only after publication;
- crash after Git publication but before the final event is idempotently
  recoverable from exact HEAD/hash evidence;
- a dirty or moved base pauses publication and does not record acceptance;
- rebuilding on a new base invalidates the old delivery hash, re-runs all
  integration and Meeting checks, and requires a new user decision;
- a rebuild is a Meeting-level publication attempt and never mutates accepted
  task attempts; replay conflicts create versioned rework tasks;
- accepted final delivery permits cleanup only after the published base
  contains the integration head;
- user rejection requires a reason and creates versioned replacement/rework
  task nodes without regressing accepted tasks;
- rejection does not reset, revert, or rewrite already integrated commits;
- duplicate accept/rework commands are idempotent;
- recovery restores the same final delivery and decision.

**Step 2: Implement the pure aggregator**

```ts
export function buildMeetingDelivery(input: {
  meetingId: string;
  planVersion: number;
  tasks: MeetingTaskRecord[];
  integrationHead: string;
  expectedUserBaseRevision: string;
}): MeetingDelivery
```

Only durable accepted task evidence may enter the successful manifest. List
cancelled, skipped, or unresolved work separately. Bound every summary and
compute a stable SHA-256 content hash.

**Step 3: Add durable user decisions**

Expose typed IPC:

```ts
meetingDelivery.get(sessionId): Promise<MeetingDelivery | null>
meetingDelivery.accept(sessionId, deliveryId, contentHash): Promise<Result>
meetingDelivery.requestRework(
  sessionId,
  deliveryId,
  contentHash,
  reason,
): Promise<Result>
```

`accept` first appends and flushes an acceptance intent, then invokes the sole
base publisher in `IntegrationQueue`. Use only:

```text
git merge --ff-only <verifiedIntegrationHead>
```

in the clean user base after exact HEAD comparison. Never publish during
per-task acceptance. `requestRework` creates a new plan version with explicit
`add-rework-task`/dependency operations. Each new node references the accepted
task it supersedes; accepted task records remain terminal and immutable. It
never runs Git rollback, and the user's base is still unchanged. Stale
delivery hashes and duplicate conflicting
decisions fail closed.

**Step 4: Build the final Meeting panel**

Show:

- integrated files and commits;
- explicit “Meeting branch only / published” state;
- per-task verification/review status;
- high-risk approvals;
- unresolved limitations;
- `接受最终交付` and `请求返工` controls.

The task Inspector remains read-only for per-task acceptance. Final Meeting
rework requires a visible reason and shows that existing integrated commits
will remain until a new plan changes them explicitly.

**Step 5: Run tests and commit**

```powershell
npm run build:electron
npm run typecheck:renderer
node --import "data:text/javascript,import { register } from 'node:module'; import { pathToFileURL } from 'node:url'; register('./tests/electron-stub.mjs', pathToFileURL('./'));" --test tests/meeting-final-delivery.test.mjs tests/renderer-final-meeting-delivery.test.mjs tests/plan-revision.test.mjs tests/meeting-recovery.test.mjs
git add electron/meeting-delivery.ts electron/ipc/meeting-delivery.ts electron/main.ts electron/preload.cjs electron/orchestrator.ts electron/integration-queue.ts electron/task-workspace.ts electron/meeting-command.ts electron/orchestrator-types.ts src/types.ts src/lib/meeting-store.ts src/components/FinalMeetingDelivery.tsx src/components/ScreenStage.tsx tests/meeting-final-delivery.test.mjs tests/renderer-final-meeting-delivery.test.mjs
git commit -m "feat(collaboration): deliver final meeting result"
```

## Milestone 6: Rework budget and recovery

### Task 15: Add bounded continuous rework

**Files:**

- Create: `electron/task-budget.ts`
- Create: `tests/task-budget.test.mjs`
- Modify: `electron/meeting-tools.ts`
- Modify: `electron/worker-scheduler.ts`
- Modify: `electron/orchestrator-types.ts`
- Modify: `electron/worker-protocol.ts`
- Modify: `src/types.ts`
- Modify: `src/lib/plan-validation.ts`
- Modify: `src/components/PlanMeetingModal.tsx`
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
- `executionProfile.maxTokenBudget` caps one attempt while
  `TaskBudget.maxTotalTokens` caps all attempts;
- missing Backend token accounting never counts as zero;
- task succeeds after any bounded attempt and old attempts remain immutable.

**Step 2: Implement pure budget evaluation**

```ts
export interface TaskBudget {
  schemaVersion: 1;
  maxAttempts: number;
  maxTotalTokens: number;
  maxTotalDurationMs: number;
  maxStagnantAttempts: number;
}

export function evaluateTaskBudget(
  budget: TaskBudget,
  attempts: TaskAttemptRecord[],
): 'continue' | 'budget-paused' | 'non-converging';
```

Do not let the Coordinator override a pause by prompt text. A user decision or
plan revision is required. Budget extension never changes the task authority
grant.

Add `budget` to the current plan task schema and approval UI. Use an explicit
editable first-release default:

```ts
{
  schemaVersion: 1,
  maxAttempts: 6,
  maxTotalTokens: 600_000,
  maxTotalDurationMs: 14_400_000,
  maxStagnantAttempts: 3,
}
```

Legacy plans normalize to that bounded value with a migration diagnostic.
Do not start automatic Coordinator rework before this approved budget is
durable.

**Step 3: Bind rework requests**

Structured rework includes findings, affected chunks, failed checks, expected
behavior, and unchanged authority hash. Create a fresh attempt and append the
request to its initial mailbox.

**Step 4: Run tests and commit**

```powershell
npm run build:electron
node --import "data:text/javascript,import { register } from 'node:module'; import { pathToFileURL } from 'node:url'; register('./tests/electron-stub.mjs', pathToFileURL('./'));" --test tests/task-budget.test.mjs tests/delivery-harness.test.mjs tests/coordinator-diff-review.test.mjs
git add electron/task-budget.ts electron/meeting-tools.ts electron/worker-scheduler.ts electron/orchestrator-types.ts electron/worker-protocol.ts src/types.ts src/lib/plan-validation.ts src/components/PlanMeetingModal.tsx src/components/TaskInspector.tsx tests/task-budget.test.mjs
git commit -m "feat(collaboration): bound automatic task rework"
```

### Task 16: Recover task mailboxes, attempts, reviews, and integration safely

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
- an in-progress cherry-pick is detected only in the queue-owned integration
  worktree and requires explicit recovery;
- a task-accepted integration head remains unpublished until final Meeting
  acceptance, base cleanliness, and expected HEAD are re-checked;
- crash after final fast-forward but before acceptance event completes
  idempotently only when exact Meeting/head/hash evidence agrees;
- a failed staged check never changes the user's base;
- accepted task never regresses due to late events;
- legacy `reviewing`, `awaiting-acceptance`, and `done` records normalize
  conservatively without inventing Coordinator review or integration evidence;
- final Meeting delivery and accept/rework decision restore exactly;
- event sequence continues after restart;
- task snapshot and renderer replay agree.

**Step 2: Extend snapshot**

Include:

- task records and attempts;
- mailbox cursors;
- review sessions;
- integration queue;
- integration branch/worktree, staged tree hash, verified head, expected base,
  and publication state;
- budget;
- final Meeting delivery and decision;
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

### Task 17: Gate stable Worker Backends and run the full workflow

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
3. normalize the plan and freeze one authorized Context Package per attempt;
4. grant bounded authority;
5. spawn Claude and Codex Workers in parallel;
6. queue a follow-up;
7. steer one turn;
8. normalize and handle one high-risk user permission;
9. accept valid reports;
10. verify;
11. resume a partial Coordinator review and cover every diff chunk;
12. request one rework;
13. stage and verify two parallel commits serially;
14. release dependencies from the durably accepted integration head without
    modifying the user base;
15. produce one final Meeting delivery;
16. accept it and publish the exact verified integration head once.

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
canonical permission normalization
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
- Staged verification failure leaves base unchanged.
- Final publication with a dirty or moved base pauses without mutation.
- Budget pause and user extension.
- Final Meeting acceptance and versioned rework request.

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
- [ ] Every attempt freezes one authorized, bounded Context Package before any
      workspace or Backend side effect.
- [ ] Dirty Git state blocks parallel writes.
- [ ] Every task message is durable before delivery.
- [ ] Snapshot, bounded `afterSeq` replay, and task-scoped live subscription
      are idempotent.
- [ ] WorkReport is the only completion signal.
- [ ] Verification precedes Coordinator review.
- [ ] Every frozen diff chunk is reviewed.
- [ ] Incomplete Coordinator review turns resume durably.
- [ ] Automatic task acceptance requires complete review, staged verification,
      integration-branch acceptance, and durable evidence.
- [ ] Integration stages exact reviewed-commit cherry-picks outside the user
      base; per-task acceptance never publishes the user base.
- [ ] Conflicts do not auto-resolve.
- [ ] Dependency release follows durable post-integration acceptance.
- [ ] Dependent task worktrees start from the accepted Meeting integration head.
- [ ] Rework is continuous but budgeted and convergence-aware.
- [ ] Side effects never auto-replay after restart.
- [ ] Claude and Codex pass real vertical tests.
- [ ] OpenCode and Kimi remain experimental until their gates pass.
- [ ] The user can accept one final Meeting delivery or request versioned
      rework while the base remains unchanged; acceptance publishes exactly
      the verified integration head.
- [ ] Renderer and Electron typechecks pass.
- [ ] Full Node test suite passes.
- [ ] Production build passes.
