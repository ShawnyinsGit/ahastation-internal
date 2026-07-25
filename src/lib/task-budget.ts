import type { TaskBudget } from '../types';

/** Schema ceilings — mirror of electron/task-budget UNLIMITED_TASK_BUDGET.
 *  Product default: ordinary plan drafts are not paused by rework budgeting. */
export const UNLIMITED_TASK_BUDGET: TaskBudget = Object.freeze({
  schemaVersion: 1,
  maxAttempts: 100,
  maxTotalTokens: 100_000_000,
  maxTotalDurationMs: 7 * 24 * 60 * 60 * 1_000,
  maxStagnantAttempts: 20,
});

/** Default for renderer plan normalization — must match electron DEFAULT_TASK_BUDGET. */
export const DEFAULT_TASK_BUDGET: TaskBudget = UNLIMITED_TASK_BUDGET;

export function isUnlimitedTaskBudget(budget: TaskBudget): boolean {
  return budget.maxAttempts >= UNLIMITED_TASK_BUDGET.maxAttempts
    && budget.maxTotalTokens >= UNLIMITED_TASK_BUDGET.maxTotalTokens
    && budget.maxTotalDurationMs >= UNLIMITED_TASK_BUDGET.maxTotalDurationMs
    && budget.maxStagnantAttempts >= UNLIMITED_TASK_BUDGET.maxStagnantAttempts;
}
