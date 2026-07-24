# AhaStation Meeting Task Collaboration Design

Status: Accepted design
Date: 2026-07-24
Implementation baseline: `e4fb1f5`
Scope: Meeting-owned visible tasks coordinated by one Claude Code Host

## 1. Summary

AhaStation will provide Codex-like coordinated task execution inside one
Meeting. A single Claude Code Coordinator owns planning, task communication,
review, and integration decisions. Claude and Codex Workers execute tasks in
isolated contexts and worktrees. OpenCode and Kimi use the same contracts
behind experimental capability gates until their real runtime matrices pass.

This design extends the existing `WorkerScheduler`, Worker protocol,
`DeliveryHarness`, Meeting journal, worktree manager, and Task Rail. It does
not create a second scheduler or a separate sidebar task product.

The user approves the plan and its bounded authority grant once. The
Coordinator can then run, steer, review, rework, accept, and integrate tasks
within that grant. High-risk operations always require the user.

## 2. Confirmed product decisions

| Topic | Decision |
|---|---|
| Task surface | Visible tasks inside the current Meeting |
| Coordinator | Claude Code in the first stable release |
| Coordinator writes | Never; Coordinator controls, reviews, and integrates |
| Worker communication | All messages go through the Coordinator |
| Dirty Git workspace | Block parallel write tasks by default |
| Dirty compatibility | User may explicitly choose shared locked execution |
| Steering | FIFO follow-up plus safe-boundary steering and turn interrupt |
| Backend settings | Provider-neutral execution intent compiled per Backend |
| Context | Coordinator chooses scope; user can inspect the frozen package |
| Permission | Coordinator auto-approves only within an approved authority grant |
| High risk | Always requires the user |
| Delivery acceptance | Coordinator automatically accepts passing tasks |
| User acceptance | User accepts the final Meeting result, not every task |
| Integration | Serialized queue with exact reviewed-commit cherry-picks |
| Rework | Continue within budget; pause on budget or non-convergence |
| Recovery | Read-only work may resume; side-effecting work requires confirmation |
| Review | Coordinator reviews the complete diff through durable chunks |
| Plan updates | Versioned operations with optimistic concurrency |
| Persistence | Existing append-only Meeting journal plus snapshots |
| Renderer sync | Typed IPC snapshot plus `afterSeq` replay |
| First stable Workers | Claude and Codex |

## 3. Requirements

### 3.1 Functional requirements

1. A Coordinator can propose a typed DAG and the user can edit dependencies,
   Backend selection, acceptance criteria, execution intent, and write scope.
2. The approved plan produces a bounded task authority grant.
3. Independent tasks run concurrently, up to the Meeting capacity limit.
4. Every task has a frozen context package, effective Backend profile,
   mailbox, attempts, workspace, evidence, and integration history.
5. Follow-up, steering, interrupt, questions, approvals, and status requests
   have explicit durable semantics.
6. A valid `WorkReport` is the only Worker completion signal.
7. Deterministic verification runs before Coordinator review.
8. The Coordinator reviews every chunk of the frozen diff.
9. Passing tasks enter a serialized integration queue.
10. A dependency is released only after integration succeeds and the
    `accepted` event is durable.
11. The user reviews one final Meeting delivery.

### 3.2 Non-functional requirements

- Local-first: no service is required beyond the selected CLI Backends.
- Recoverable: crashes lose neither instructions nor accepted evidence.
- Fail-closed: missing authority, workspace facts, report identity, review
  coverage, or integration provenance cannot widen access.
- Auditable: requested and effective Backend settings remain visible.
- Bounded: token, time, output, retry, and non-convergence limits apply.
- Backend-neutral: provider-native events never reach the renderer.
- Accessible: task states are conveyed by text and icons, not color alone.
- Maintainable: one scheduler, one Meeting journal, and one integration owner.

## 4. Existing baseline

The implementation baseline already contains:

- a versioned DAG and optimistic plan revision;
- a Meeting-wide `WorkerScheduler` with four-Worker capacity;
- per-task Backend selection and acceptance criteria;
- Git worktrees and non-Git write locks;
- canonical `WorkerEvent` and strict `WorkReport`;
- external-report `DeliveryHarness` verification and review states;
- append-only `events.jsonl` recovery;
- Task Rail, Worker cards, delivery evidence, and recovery UI.

The collaboration work extends these modules. It must not fork their state into
parallel stores.

## 5. High-level architecture

```text
Meeting UI
  └─ Claude Code Coordinator
       ├─ Versioned Plan
       ├─ Context Package compiler
       ├─ Task Mailbox router
       └─ Diff Review controller
            │
            v
       WorkerScheduler
       ├─ Task records and attempts
       ├─ Budget and non-convergence guard
       ├─ Authority projection
       ├─ Workspace allocation
       └─ Integration Queue
            │
            v
       Backend Adapter
       ├─ Claude Worker
       ├─ Codex Worker
       ├─ OpenCode Worker (experimental)
       └─ Kimi Worker (experimental)
            │
            v
       WorkReport → Verifier → Coordinator chunk review
            │
            v
       reviewed commit → exact cherry-pick → integration verification
            │
            v
       durable accepted event → release dependent tasks
```

## 6. Ownership

### Coordinator

The Coordinator may:

- create and revise plans;
- choose execution intent and context scope;
- route all inter-task messages;
- explain permission requests;
- review complete diffs;
- request rework;
- accept tasks and enqueue integration.

The Coordinator may not:

- edit workspace files;
- run arbitrary project tools;
- approve operations outside the task authority grant;
- communicate Workers through a hidden peer channel;
- directly write the main Git branch.

### WorkerScheduler

The Scheduler is the only execution owner. It owns task status, active
attempts, queues, capacity, workspace leases, Backend sessions, budget,
recovery, and dependency release.

### Backend Adapter

An Adapter compiles a provider-neutral task profile, creates a session, maps
native progress into canonical events, implements interrupt/resume when
supported, and emits a validated `WorkReport`.

### Integration Queue

The queue is the only component allowed to update the base branch. It
serializes accepted candidates and cherry-picks the exact reviewed commit.

## 7. Domain model

### 7.1 Task record

```ts
interface MeetingTaskRecord {
  schemaVersion: 1;
  id: string;
  title: string;
  prompt: string;
  deps: string[];
  status: TaskStatus;
  planVersion: number;
  requestedProfile: TaskExecutionProfile;
  effectiveProfile?: BackendEffectiveProfile;
  contextPackage: ContextPackage;
  authorityGrant: TaskAuthorityGrant;
  workspace: TaskWorkspaceSnapshot | null;
  currentAttempt: number;
  attempts: TaskAttemptRecord[];
  mailboxCursor: number;
  eventCursor: number;
}
```

The task is the durable product object. A Backend process, session, worktree,
or Worker handle is a replaceable task-attempt resource.

### 7.2 Execution intent

```ts
interface TaskExecutionProfile {
  backendId: string;
  modelPreference?: string;
  workMode: 'fast' | 'balanced' | 'deep';
  contextMode:
    | 'minimal'
    | 'meeting-summary'
    | 'selected-history'
    | 'full-visible-history';
  timeoutMs: number;
  maxTokenBudget: number;
}

interface BackendEffectiveProfile {
  backendId: string;
  runtimeVersion: string;
  model: string;
  nativeReasoning?: Record<string, unknown>;
  unsupported: string[];
  downgraded: string[];
  capabilityHash: string;
}
```

The requested profile is user- and Coordinator-facing. The effective profile
is produced by the Adapter and is the only source for claims about what
actually ran.

### 7.3 Context package

The Coordinator chooses one of four visible-history modes and may select
specific messages, decisions, dependency reports, or authorized attachment
references. The package is visible to the user, frozen before attempt start,
hashed, and excludes hidden reasoning, credentials, Backend authentication,
and unauthorized attachments.

Later context is added as mailbox messages. It never rewrites the frozen
initial package.

### 7.4 Authority grant

```ts
interface TaskAuthorityGrant {
  schemaVersion: 1;
  workspaceRoot: string;
  writePaths: string[];
  allowedToolKinds: string[];
  allowedCommands: string[][];
  allowedNetworkHosts: string[];
  expiresAt: number;
  maxAttempts: number;
  grantHash: string;
}
```

The user approves the grant with the plan. The Coordinator may approve only
operations that are a subset of this grant.

### 7.5 Attempt record

Each execution or rework creates a new attempt. An attempt records Backend
session identity, frozen context hash, grant hash, base revision, worktree,
message range, report, verification, review coverage, candidate commit,
failure fingerprint, cost, and duration.

Historical attempts are immutable.

## 8. Task state machine

```text
draft
  → pending
  → running
  → verifying
  → coordinator-reviewing
  → integration-queued
  → integrating
  → accepted

recoverable branches:
  blocked
  reworking
  integration-conflict
  budget-paused
  interrupted
  failed
  cancelled
```

Only `accepted` releases a dependency. `accepted` is written after the exact
candidate commit is integrated, post-integration verification passes, and the
journal flush completes.

## 9. Task Mailbox

```ts
interface TaskMessage {
  schemaVersion: 1;
  id: string;
  seq: number;
  taskId: string;
  attempt: number;
  sender: 'user' | 'coordinator' | 'worker' | 'system';
  kind:
    | 'instruction'
    | 'follow-up'
    | 'steer'
    | 'interrupt'
    | 'status-request'
    | 'progress'
    | 'question'
    | 'approval-request'
    | 'approval-response';
  replyTo?: string;
  payload: unknown;
  status: 'queued' | 'delivered' | 'acknowledged' | 'failed';
  timestamp: number;
}
```

Every message is journaled before delivery.

- Follow-up waits in FIFO order until the current turn completes.
- Steering requests turn interruption, then delivers at a safe boundary.
- Interrupt stops the current turn and preserves task state.
- Workers ask the Coordinator; they never message a peer directly.
- Terminal-task follow-up creates a new attempt or a new task.

IPC success means only that the main process accepted the request. Delivery
and acknowledgement have distinct events.

## 10. Workspace policy

For Git repositories:

- a clean base may create parallel task worktrees;
- a dirty base blocks write tasks;
- read-only tasks may continue;
- the user may explicitly choose shared locked mode;
- AhaStation never auto-commits, stashes, or copies dirty user changes.

For non-Git or shared mode:

- declared write paths acquire hierarchical locks;
- unknown write scope acquires a whole-workspace lock;
- overlapping writers remain pending rather than failing.

Failed and conflicting worktrees remain recoverable. Successful worktrees are
removed only after integration and durable acceptance.

## 11. Permission model

Plan approval delegates bounded authority. Safe in-grant project reads,
declared writes, tests, and approved commands can be auto-approved by the
Coordinator.

The following always require the user:

- deleting or overwriting existing user data;
- destructive Git and force push;
- credential or keychain access;
- administrator privileges or system installation;
- undeclared network hosts;
- publishing, sending messages, or mutating external services.

Permission decisions are canonical events. Native Backend permission dialogs
must project into the same broker and cannot bypass the task grant.

## 12. Delivery and review

The authoritative flow is:

```text
valid WorkReport
  → deterministic verification
  → freeze candidate commit and diff hash
  → Coordinator reviews every diff chunk
  → accept or create structured rework request
  → enqueue exact candidate commit
  → cherry-pick
  → post-integration verification
  → durable accepted
  → release dependents
```

Diff review begins with a manifest and continues through bounded file chunks.
Every chunk has a content hash and review result. Changing the candidate
invalidates affected review results. The Coordinator cannot accept incomplete
coverage.

Rework continues within token, time, and non-convergence budgets. Repeated
equivalent failures without meaningful diff or evidence changes pause the task
and request user direction.

## 13. Integration Queue

The current fast-forward integration is replaced for parallel work.

For each queued task:

1. Verify the candidate commit equals the reviewed commit.
2. Verify the base branch and user workspace are safe.
3. Cherry-pick the exact commit.
4. Stop on conflict; do not auto-resolve.
5. Run post-integration checks.
6. Persist integration evidence.
7. Flush the journal.
8. Mark the task accepted and release dependents.

An integration conflict creates a rework attempt based on the new base.

## 14. Recovery

The Meeting journal remains the fact source. Snapshots accelerate startup but
are disposable projections.

- Read-only tasks may resume automatically.
- Write, command, network, and external side-effect tasks restore as
  `interrupted`.
- Recovery shows the last attempt, workspace, side-effect summary, pending
  mailbox, budget, and failure fingerprint.
- Continue may reuse a verified checkpoint.
- Retry creates a new attempt after re-checking workspace state.
- Side effects are never automatically replayed.

## 15. Renderer synchronization and information architecture

The main process exposes:

```text
getTaskSnapshot(taskId)
subscribeTask(taskId, afterSeq)
```

The renderer hydrates from a snapshot and applies idempotent events by
`eventId + seq`.

The accepted visual direction is a three-column desktop workspace:

- left: Task Rail and dependency DAG;
- center: Meeting conversation and Coordinator briefings;
- right: docked Task Inspector.

The Inspector contains overview, context, mailbox, activity, diff review,
verification, permissions, and integration tabs. It shows requested versus
effective execution profile and distinguishes states with text and icons.

## 16. Backend capability compilation

Every Adapter implements a pure profile compilation step. Codex maps work mode
to native reasoning effort. Claude maps to SDK-supported model/thinking
configuration. OpenCode compiles against provider/model facts. Kimi uses only
ACP/CLI-supported settings.

Unsupported settings produce explicit diagnostics. A Backend becomes a stable
Worker only after runtime, auth, WorkReport, interrupt, resume, permission, and
recovery contract tests pass.

Claude and Codex are stable first-release Workers. OpenCode and Kimi remain
experimental until their complete matrices pass.

## 17. Failure modes

| Failure | Required behavior |
|---|---|
| Invalid task profile | Reject before plan approval |
| Adapter cannot compile profile | Keep task pending with diagnostic |
| Context package exceeds bound | Require narrower selection |
| Message delivery fails | Keep queued and retry safely |
| Backend turn ends without report | Fail the attempt |
| Verification fails | Create rework attempt |
| Diff changes during review | Invalidate changed chunks |
| Integration base moves | Re-check before cherry-pick |
| Cherry-pick conflicts | Preserve worktree and pause |
| Repeated equivalent failure | Enter `budget-paused` |
| Coordinator disconnects | Existing Workers continue; new scheduling pauses |
| Application restarts | Side-effecting tasks become interrupted |

## 18. Acceptance gates

The feature is ready when:

- protocol, state-machine, mailbox, workspace, and recovery tests pass;
- Claude Coordinator can schedule and steer Claude and Codex Workers;
- both Workers produce valid reports and survive interruption/recovery;
- complete chunk review is enforced;
- parallel commits integrate serially without fast-forward assumptions;
- conflict, dirty workspace, high-risk permission, budget pause, and restart
  scenarios pass;
- renderer snapshot/replay is idempotent;
- a real four-task Meeting completes without hidden peer communication;
- two-hour soak and packaged-app checks pass before formal release.
