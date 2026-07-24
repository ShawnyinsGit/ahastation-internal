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
Every attempt receives one frozen, user-inspectable Context Package compiled
from authorized Meeting facts.

This design extends the existing `WorkerScheduler`, Worker protocol,
`DeliveryHarness`, Meeting journal, worktree manager, and Task Rail. It does
not create a second scheduler or a separate sidebar task product.

The user approves the plan and its bounded authority grant once. The
Coordinator can then run, steer, review, request rework, and approve reviewed
candidates for staged integration within that grant. High-risk operations
always require the user.
Task integrations are verified on a Meeting-owned integration branch before
the user's base branch is advanced. The user accepts or requests rework on one
final Meeting delivery.

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
| Delivery acceptance | Coordinator approves complete review; Integration Queue accepts only after verified publication |
| User acceptance | User accepts one final Meeting delivery; rejection creates a versioned rework plan |
| Integration | Serialized queue stages exact reviewed commits on a Meeting integration branch and publishes only verified state |
| Rework | Continue within budget; pause on budget or non-convergence |
| Recovery | Read-only work may resume; side-effecting work requires confirmation |
| Review | Coordinator reviews the complete diff through durable chunks |
| Plan updates | Versioned operations with optimistic concurrency |
| Persistence | Existing append-only Meeting journal plus snapshots |
| Renderer sync | Typed IPC snapshot, bounded `afterSeq` replay, and task-scoped live subscription |
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
9. Passing tasks enter a serialized Meeting integration queue.
10. Reviewed commits and post-integration checks run on a Meeting-owned
    integration branch before the user's base branch changes.
11. A dependency is released only after verified integration is durably
    accepted.
12. The final Meeting delivery aggregates accepted task evidence, changed
    files, verification, risks, and unresolved items.
13. The user either accepts that final delivery or creates a versioned rework
    plan; final rejection never performs an implicit destructive rollback.

### 3.2 Non-functional requirements

- Local-first: no service is required beyond the selected CLI Backends.
- Recoverable: crashes lose neither instructions nor accepted evidence; a
  partially staged integration never becomes a published base-branch update.
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
            ├─ Meeting integration worktree/branch
            └─ compare-and-publish gate
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
       reviewed commit → staged cherry-pick → integration verification
            │
            v
       atomic base publish → durable accepted event → release dependents
            │
            v
       Final Meeting Delivery → user accept or versioned rework plan
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
- approve a completely reviewed candidate for the Integration Queue.

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

An Adapter compiles a provider-neutral task profile, normalizes native
permission requests, creates a session, maps native progress into canonical
events, implements interrupt/resume when supported, and emits a validated
`WorkReport`.

### Integration Queue

The queue is the only component allowed to update the base branch. It
serializes reviewed candidates, cherry-picks exact commits into a
Meeting-owned integration worktree, verifies the staged result, and publishes
only when the user base is clean and still at the expected revision.

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

```ts
interface ContextPackage {
  schemaVersion: 1;
  taskId: string;
  attempt: number;
  mode:
    | 'minimal'
    | 'meeting-summary'
    | 'selected-history'
    | 'full-visible-history';
  messages: Array<{ id: string; role: 'user' | 'assistant'; text: string }>;
  decisions: Array<{ id: string; summary: string }>;
  dependencyReports: Array<{ taskId: string; reportHash: string; summary: string }>;
  attachments: Array<{ id: string; name: string; contentHash: string }>;
  byteLength: number;
  packageHash: string;
}
```

The compiler resolves identifiers against the current Meeting, checks
attachment authorization, applies byte/token bounds, redacts forbidden
metadata, freezes the result, and appends `context-package-frozen` before any
workspace or Backend session is created. A selection is not a package until
this compilation succeeds.

### 7.4 Authority grant

```ts
interface TaskAuthorityGrant {
  schemaVersion: 1;
  workspaceRoot: string;
  writePaths: string[];
  allowedToolKinds: string[];
  allowedWorkingDirectories: string[];
  allowedCommands: string[][];
  allowedEnvironmentKeys: string[];
  maxCommandTimeoutMs: number;
  allowedNetworkHosts: string[];
  expiresAt: number;
  grantHash: string;
}
```

The user approves the grant with the plan. The Coordinator may approve only
operations that are a subset of this grant.

Native Backend permission requests compile into one canonical request before
policy evaluation:

```ts
interface CanonicalExecutionRequest {
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

The Adapter, not the Coordinator prompt, owns this compilation. Shell-wrapped
commands are compared as their exact executable plus argv; they are never
joined into a shell string. Environment values and native credential-bearing
payloads are never journaled.

### 7.5 Attempt record

Each execution or rework creates a new attempt. An attempt records Backend
session identity, frozen context hash, grant hash, base revision, worktree,
message range, report, verification, review coverage, candidate commit,
failure fingerprint, cost, and duration.

Historical attempts are immutable.

Budget is a separate user-approved execution constraint, not part of the
permission grant:

```ts
interface TaskBudget {
  schemaVersion: 1;
  maxAttempts: number;
  maxTotalTokens: number;
  maxTotalDurationMs: number;
  maxStagnantAttempts: number;
}
```

Increasing a budget requires a versioned user decision. It never widens file,
command, network, or external-service authority.

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

Schema evolution is additive before it is subtractive. Existing
`reviewing`, `awaiting-acceptance`, and `done` values remain readable during
the migration window. A versioned projection maps them to the new lifecycle
without rewriting historical events. Production types may remove the legacy
values only after Scheduler, renderer, fixture, and recovery consumers have
all migrated and replay tests cover both schemas.

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
The Meeting integration worktree persists across the accepted task chain and
is removed only after final Meeting acceptance is durable and the published
base contains its head.

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

Review is driven by a durable `CoordinatorReviewSession`, not by one advisory
chat message. Verification appends `coordinator-review-requested` before the
Host is notified. Chunk results and the next cursor are idempotent journal
events. If a Coordinator turn ends before coverage is complete, the review
driver queues another bounded turn. Restart reconstructs the cursor and
continues; it never converts incomplete coverage into acceptance.

Rework continues within token, time, and non-convergence budgets. Repeated
equivalent failures without meaningful diff or evidence changes pause the task
and request user direction.

## 13. Integration Queue

The current fast-forward integration is replaced for parallel work.

For each queued task:

1. Verify the candidate commit equals the reviewed commit.
2. Verify or create the Meeting-owned integration worktree and branch at the
   last durably published base.
3. Cherry-pick the exact commit onto that integration branch.
4. Stop on conflict; do not auto-resolve.
5. Run post-integration checks in the integration worktree.
6. Persist candidate, resulting tree, checks, and expected base revision.
7. Re-check that the user's base worktree is clean and its HEAD still equals
   the expected revision.
8. Publish only the verified integration branch by fast-forwarding the base.
9. Flush the journal.
10. Mark the task accepted and release dependents.

An integration conflict creates a rework attempt based on the new base.
Verification failure leaves the user's base unchanged. A moved or dirty base
pauses publication; the queue rebuilds and re-verifies on the new base only
after the user workspace is safe. It never auto-reverts or resets user work.

## 14. Final Meeting delivery

After all required tasks are accepted or explicitly resolved, the Coordinator
compiles a durable `MeetingDelivery` containing:

- the accepted plan version and task/attempt identities;
- integrated commit and file manifest;
- deterministic verification and review summaries;
- high-risk approvals and remaining limitations;
- unresolved, cancelled, or intentionally skipped work;
- a final content hash.

The renderer offers one user decision:

```text
accept-final-meeting
request-final-meeting-rework
```

Acceptance acknowledges the delivered integrated state. A rework request
creates a new versioned plan revision with replacement/rework task nodes that
reference, but never regress, accepted tasks. It does not silently roll back
already integrated commits.

## 15. Recovery

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

## 16. Renderer synchronization and information architecture

The main process exposes:

```text
getTaskSnapshot(sessionId, taskId)
getTaskEvents(sessionId, taskId, afterSeq, limit)
subscribeTask(sessionId, taskId, afterSeq)
```

Replay returns `events`, `nextAfterSeq`, and `hasMore`; it never returns an
unbounded journal tail. The renderer hydrates from a snapshot, pages to the
current cursor, then applies task-scoped live events idempotently by
`eventId + seq`. A gap triggers snapshot refresh. Subscription ownership and
unsubscribe are explicit IPC contracts.

The accepted visual direction is a three-column desktop workspace:

- left: Task Rail and dependency DAG;
- center: Meeting conversation and Coordinator briefings;
- right: docked Task Inspector.

The Inspector contains overview, context, mailbox, activity, diff review,
verification, permissions, and integration tabs. It shows requested versus
effective execution profile and distinguishes states with text and icons.

## 17. Backend capability compilation

Every Adapter implements a pure profile compilation step. Codex maps work mode
to native reasoning effort. Claude maps to SDK-supported model/thinking
configuration. OpenCode compiles against provider/model facts. Kimi uses only
ACP/CLI-supported settings.

Unsupported settings produce explicit diagnostics. A Backend becomes a stable
Worker only after runtime, auth, WorkReport, interrupt, resume, permission, and
recovery contract tests pass.

Claude and Codex are stable first-release Workers. OpenCode and Kimi remain
experimental until their complete matrices pass.

## 18. Failure modes

| Failure | Required behavior |
|---|---|
| Invalid task profile | Reject before plan approval |
| Adapter cannot compile profile | Keep task pending with diagnostic |
| Context package exceeds bound | Require narrower selection |
| Message delivery fails | Keep queued and retry safely |
| Backend turn ends without report | Fail the attempt |
| Verification fails | Create rework attempt |
| Diff changes during review | Invalidate changed chunks |
| Coordinator turn ends mid-review | Persist cursor and queue another bounded review turn |
| Integration base moves | Re-check before cherry-pick |
| Cherry-pick conflicts | Preserve worktree and pause |
| Post-integration verification fails | Preserve integration branch; leave user base unchanged |
| Final Meeting rejected | Create versioned rework plan; do not auto-rollback |
| Repeated equivalent failure | Enter `budget-paused` |
| Coordinator disconnects | Existing Workers continue; new scheduling pauses |
| Application restarts | Side-effecting tasks become interrupted |

## 19. Acceptance gates

The feature is ready when:

- protocol, state-machine, mailbox, workspace, and recovery tests pass;
- Claude Coordinator can schedule and steer Claude and Codex Workers;
- both Workers produce valid reports and survive interruption/recovery;
- complete chunk review is enforced;
- parallel commits stage and verify serially before atomic base publication;
- conflict, dirty workspace, high-risk permission, budget pause, and restart
  scenarios pass;
- renderer snapshot/replay/live subscription is bounded and idempotent;
- one final Meeting delivery can be accepted or revised without destructive
  rollback;
- a real four-task Meeting completes without hidden peer communication;
- two-hour soak and packaged-app checks pass before formal release.
