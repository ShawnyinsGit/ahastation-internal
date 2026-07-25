# Orchestrator V2 implementation progress

Updated: 2026-07-25

## Status

- [x] A. Backend runtime/session foundation
- [x] B. Meeting and Coordinator domain core
- [x] C. MeetingCommand and global Scheduler
- [x] D. Workspace isolation and recovery
- [x] E. Multi-host collaboration and failover UI
- [x] F. IPC/browser/ASR/security hardening
- [x] G. Unsigned experience DMG build and automated verification
- [x] I. Meeting-owned visible task collaboration (Tasks 1–17)
- [ ] H. Formal release gate: full installed-app manual matrix, 2-hour soak, signing and notarization

## Current slice

Meeting task collaboration is implemented on `codex/collaboration-workspace-plan`:
Coordinator-only planning, Backend-compiled execution intents, durable mailboxes,
complete diff review, serial integration outside the user base, final Meeting
publication, bounded rework, crash-safe recovery, and Worker stability gates.

Claude Code `2.1.150` and Codex `0.144.1` may qualify as stable Workers only with
exact-version real vertical smoke evidence. OpenCode and Kimi remain experimental
by first-release policy.

### Coordinator review is now actually driven

The review briefing used to be fire-and-forget: `onCoordinatorTurnEnded` existed
but nothing in production ever called it, `resume` was never reachable, and a
Coordinator that read two chunks and moved on left the delivery — and every task
depending on it — stalled in `coordinator-reviewing` forever. The loop is now
closed end to end:

- Coordinator turn boundaries drive the review; a turn that adds no coverage
  charges the stall budget and re-briefs with the uncovered chunk ids.
- Covering a chunk resets that budget, so unrelated user turns cannot pause a
  review that is genuinely progressing.
- A silent Coordinator is caught by a stall watchdog rather than waiting forever.
- While a review is active every non-review meeting tool is refused with the
  pending reviewId and the chunks still owed a verdict.
- Disconnect pauses resume when the Coordinator returns or a new host takes over;
  budget-exhausted pauses escalate to the user with a resume action and are never
  treated as a pass.

Verdicts themselves are unchanged: hash-bound, complete-coverage-gated, and
withheld evidence still requires explicit user confirmation.

## Verification log

- Renderer TypeScript: pass
- Electron TypeScript: pass
- Production build: pass (existing large-chunk warning only)
- Node tests: focused collaboration / authority / vertical-slice suites pass;
  full suite re-run recorded with Task 17
- Deterministic multi-backend vertical slice: pass
- Real Claude Worker vertical smoke journal
  `real-worker-claude-code-eae8d1f9-5112-4049-ab9f-92326cc286d1`: WorkReport,
  Steering ACK, high-risk ask-user with Backend-scoped safeInput, review,
  integration, final publication
- Real Codex Worker vertical smoke journal
  `real-worker-codex-54a5b159-ba2a-49cf-a4ec-cf79942df4fe`: WorkReport, Steering
  ACK, high-risk ask-user, Backend-scoped canonical decisions, review,
  integration, final publication
- Missing / schema-invalid WorkReport: one durable protocol correction, then
  fail-closed
- Opaque native permission failures now journal Backend identity on ask-user
  safeInput so release gates do not require a nonexistent auto-allow
- Coordinator review loop: an unfinished Coordinator turn re-briefs the review
  instead of stalling the delivery (`tests/coordinator-review-loop.test.mjs`)
- The real Worker smoke no longer submits verdicts for the meeting. It asserts
  the Coordinator called `submit_delivery_chunk_review` and
  `complete_delivery_review` itself and reached complete coverage; a stalled
  review fails the gate. Prior smoke journals predate this and were recorded
  with harness-driven review.
- `tests/collaboration-vertical-slice.test.mjs` is explicitly an injected-review
  orchestration test, not evidence of model-driven review

## Formal release checks still open

The current artifact is an unsigned experience build, not a formal release. The
plan's release gate still requires installed-app manual E2E for the complete
Claude/Codex bidirectional Coordinator and failover matrix, a real two-hour
2-Host/4-Worker soak, and Apple signing/notarization. These are intentionally
not reported as passed by the automated smoke checks above.
