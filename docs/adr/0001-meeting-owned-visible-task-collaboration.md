# ADR-0001: Meeting-Owned Visible Task Collaboration

Status: Accepted
Date: 2026-07-24
Amended: 2026-07-24 — defer user-base publication until final Meeting acceptance

## Context

AhaStation already has a Meeting Coordinator, a global Worker Scheduler,
multi-Backend adapters, task worktrees, canonical Worker reports, delivery
verification, recovery, and a task rail.

The product needs a deeper collaboration experience comparable to a main
coding task coordinating several independent tasks: per-task contexts and
execution profiles, durable follow-up and steering, complete Coordinator
review, evidence-gated task acceptance, and safe integration.

Creating separate sidebar chats or a second orchestration runtime would
duplicate the existing Meeting domain and create competing fact sources.

## Decision

AhaStation will model delegated work as visible, durable tasks owned by the
current Meeting.

One Claude Code Host is the first-release Coordinator. It owns planning,
context selection, message routing, complete diff review, rework decisions,
and reviewed-candidate approval. It cannot edit files or directly update the
main branch. Only verified Integration Queue staging on the Meeting branch
produces task acceptance.

The existing `WorkerScheduler` remains the only execution owner. Backend
Adapters compile a provider-neutral execution intent and run isolated task
attempts. Workers cannot communicate directly.

Task messages, attempts, permission decisions, review coverage, and integration
events are appended to the existing Meeting journal. The renderer hydrates
from snapshots, bounded replay, and task-scoped live events.

The user approves the plan and a bounded task authority grant. The Coordinator
may auto-approve only operations within that grant. High-risk operations always
require the user.

A valid WorkReport is followed by deterministic verification and complete,
chunked Coordinator diff review. The review is a durable session that survives
incomplete Coordinator turns and restart. Passing candidates enter a
serialized Integration Queue. The queue cherry-picks the exact reviewed commit
onto a Meeting-owned integration branch and verifies the accumulated state.
Durable task acceptance on that branch releases dependent tasks; it does not
advance the user's base.

The user accepts one final Meeting delivery rather than every task. That
decision is the only publication gate for fast-forwarding a clean, unchanged
user base to the exact verified integration head. Rejecting the delivery
creates a versioned rework plan while the user's base remains unchanged.

Plan and event schema migration is additive. Legacy task statuses and plan
records remain replayable until every producer and consumer has migrated.

## Alternatives considered

### Separate sidebar tasks

This most closely resembles Codex task navigation but requires a global task
repository, cross-Meeting lifecycle, separate navigation, and duplicated
recovery. It is deferred until Meeting-owned tasks prove the domain.

### Coordinator edits code

This resembles a coding main thread but creates a hidden additional writer and
conflicts with Worker worktree ownership. Rejected.

### Direct Worker-to-Worker communication

This reduces Coordinator latency but creates hidden discussion, circular
delegation, and multi-owner planning. Rejected.

### User accepts every task

This is safe but stalls multi-task DAGs. Rejected in favor of bounded
Coordinator candidate approval, verified Integration Queue task acceptance,
and final Meeting acceptance.

### Fast-forward integration

Directly fast-forwarding each task worktree works for one task but fails when
parallel branches share a base. Directly cherry-picking into the user branch
also exposes failed post-integration checks. Replaced with serialized
exact-commit cherry-picks on a Meeting integration branch followed by verified
fast-forward publication after final Meeting acceptance.

### Per-task publication

Publishing each accepted task would let downstream work branch from the user
base, but it makes final Meeting acceptance a non-authoritative acknowledgement
and requires destructive rollback semantics on rejection. Rejected. Dependent
tasks instead branch from the durably accepted Meeting integration head.

### SQLite event store

It offers stronger queries but expands the current change into database
migration and dual recovery semantics. Deferred; the Meeting journal and
snapshots remain sufficient for the local-first first release.

## Consequences

Positive:

- Builds on the existing tested orchestration core.
- Preserves one Coordinator, Scheduler, journal, and integration owner.
- Makes cross-Backend execution observable and auditable.
- Supports parallel work without unsafe shared writes.
- Removes per-task user acceptance friction.
- Provides explicit recovery and non-convergence behavior.
- Keeps failed post-integration candidates off the user's base branch.
- Makes the user's final Meeting decision the actual publication boundary.

Negative:

- Claude Code is a first-release Coordinator dependency.
- Complete Coordinator diff review consumes context and model budget.
- Task state and event schemas become more sophisticated.
- Cherry-pick integration needs conflict and rollback handling.
- A Meeting-owned integration worktree consumes additional local disk space.
- Backend capability compilation requires per-version contract testing.
- Downstream worktrees must branch from the Meeting integration head rather
  than assuming the user's base has already advanced.

## Safety invariants

1. Coordinator has no code-write capability.
2. Workers have no direct peer channel.
3. Every message is durable before delivery.
4. Dirty Git state blocks parallel write work by default.
5. Goal, context, and plan text never grant permissions.
6. High-risk operations require the user.
7. Incomplete review coverage cannot accept a task.
8. Per-task integration never writes the user's base branch.
9. Only explicit final Meeting acceptance may publish the exact verified head.
10. Post-integration checks complete before task acceptance and dependency
    release.
11. Final Meeting rejection leaves the user's base unchanged.
12. Shared-locked dirty Git execution is compatibility-only, uses the legacy
    delivery path, and cannot be mixed with or claim managed collaboration
    acceptance.
13. Recovery never auto-replays side effects.

## Rollback

The feature ships behind a Meeting collaboration capability gate. Rollback
disables task profiles, mailbox commands, Coordinator auto-review, and the
Integration Queue, then returns to the current Scheduler and per-delivery user
acceptance. Any unpublished Meeting integration branch remains recoverable and
does not mutate the user base. Versioned events remain readable as historical
evidence.
