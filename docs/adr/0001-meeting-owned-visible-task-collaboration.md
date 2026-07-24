# ADR-0001: Meeting-Owned Visible Task Collaboration

Status: Accepted
Date: 2026-07-24

## Context

AhaStation already has a Meeting Coordinator, a global Worker Scheduler,
multi-Backend adapters, task worktrees, canonical Worker reports, delivery
verification, recovery, and a task rail.

The product needs a deeper collaboration experience comparable to a main
coding task coordinating several independent tasks: per-task contexts and
execution profiles, durable follow-up and steering, complete Coordinator
review, automatic acceptance, and safe integration.

Creating separate sidebar chats or a second orchestration runtime would
duplicate the existing Meeting domain and create competing fact sources.

## Decision

AhaStation will model delegated work as visible, durable tasks owned by the
current Meeting.

One Claude Code Host is the first-release Coordinator. It owns planning,
context selection, message routing, complete diff review, rework decisions,
and task acceptance. It cannot edit files or directly update the main branch.

The existing `WorkerScheduler` remains the only execution owner. Backend
Adapters compile a provider-neutral execution intent and run isolated task
attempts. Workers cannot communicate directly.

Task messages, attempts, permission decisions, review coverage, and integration
events are appended to the existing Meeting journal. The renderer hydrates
from snapshots and incrementally applies events.

The user approves the plan and a bounded task authority grant. The Coordinator
may auto-approve only operations within that grant. High-risk operations always
require the user.

A valid WorkReport is followed by deterministic verification and complete,
chunked Coordinator diff review. Passing candidates enter a serialized
Integration Queue. The queue cherry-picks the exact reviewed commit, verifies
the integrated state, durably marks the task accepted, and only then releases
dependent tasks.

The user accepts the final Meeting result rather than every task.

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
Coordinator acceptance plus final Meeting acceptance.

### Fast-forward integration

It works for one task but fails when parallel branches share a base. Replaced
with serialized exact-commit cherry-picks.

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

Negative:

- Claude Code is a first-release Coordinator dependency.
- Complete Coordinator diff review consumes context and model budget.
- Task state and event schemas become more sophisticated.
- Cherry-pick integration needs conflict and rollback handling.
- Backend capability compilation requires per-version contract testing.

## Safety invariants

1. Coordinator has no code-write capability.
2. Workers have no direct peer channel.
3. Every message is durable before delivery.
4. Dirty Git state blocks parallel write work by default.
5. Goal, context, and plan text never grant permissions.
6. High-risk operations require the user.
7. Incomplete review coverage cannot accept a task.
8. Only the Integration Queue writes the base branch.
9. Only durable post-integration acceptance releases dependencies.
10. Recovery never auto-replays side effects.

## Rollback

The feature ships behind a Meeting collaboration capability gate. Rollback
disables task profiles, mailbox commands, Coordinator auto-review, and the
Integration Queue, then returns to the current Scheduler and per-delivery user
acceptance. Versioned events remain readable as historical evidence.
