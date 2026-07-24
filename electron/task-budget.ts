import { z } from 'zod';
import { redactSecrets } from './format-error.js';

export const taskBudgetSchema = z.object({
  schemaVersion: z.literal(1),
  maxAttempts: z.number().int().min(1).max(100),
  maxTotalTokens: z.number().int().min(1).max(100_000_000),
  maxTotalDurationMs: z.number().int().min(1_000).max(7 * 24 * 60 * 60 * 1_000),
  maxStagnantAttempts: z.number().int().min(1).max(20),
}).strict();

export type TaskBudget = z.infer<typeof taskBudgetSchema>;

export const DEFAULT_TASK_BUDGET: TaskBudget = Object.freeze({
  schemaVersion: 1,
  maxAttempts: 6,
  maxTotalTokens: 600_000,
  maxTotalDurationMs: 14_400_000,
  maxStagnantAttempts: 3,
});

export interface TaskBudgetAttempt {
  attempt: number;
  tokenCost?: number | null;
  /** Conservative per-attempt reservation when a Backend cannot report
   * actual token use. Missing accounting is never treated as zero. */
  reservedTokenCost?: number;
  durationMs: number;
  failureFingerprint?: string | null;
  succeeded?: boolean;
}

export type TaskBudgetEvaluation = 'continue' | 'budget-paused' | 'non-converging';

export function evaluateTaskBudget(
  rawBudget: TaskBudget,
  attempts: readonly TaskBudgetAttempt[],
): TaskBudgetEvaluation {
  const budget = taskBudgetSchema.parse(rawBudget);
  if (attempts.some((attempt) => attempt.succeeded)) return 'continue';
  if (attempts.length >= budget.maxAttempts) return 'budget-paused';

  let totalTokens = 0;
  let totalDurationMs = 0;
  for (const attempt of attempts) {
    if (!Number.isSafeInteger(attempt.durationMs) || attempt.durationMs < 0) {
      return 'budget-paused';
    }
    totalDurationMs += attempt.durationMs;
    const accounted = attempt.tokenCost ?? attempt.reservedTokenCost;
    if (!Number.isSafeInteger(accounted) || (accounted ?? -1) < 0) {
      return 'budget-paused';
    }
    totalTokens += accounted!;
  }
  if (
    totalTokens >= budget.maxTotalTokens
    || totalDurationMs >= budget.maxTotalDurationMs
  ) return 'budget-paused';

  let stagnant = 0;
  let previous: string | null = null;
  for (const attempt of [...attempts].reverse()) {
    const fingerprint = attempt.failureFingerprint ?? null;
    if (!fingerprint) break;
    if (previous === null) previous = fingerprint;
    if (fingerprint !== previous) break;
    stagnant += 1;
  }
  return stagnant >= budget.maxStagnantAttempts ? 'non-converging' : 'continue';
}

export function buildFailureFingerprint(input: {
  error?: string;
  failingChecks?: string[];
  relevantFiles?: string[];
  evidenceHash?: string;
}): string {
  const normalized = {
    error: normalizeText(input.error ?? ''),
    failingChecks: [...new Set((input.failingChecks ?? []).map(normalizeText))].sort(),
    relevantFiles: [...new Set((input.relevantFiles ?? []).map(normalizePath))].sort(),
    evidenceHash: /^[0-9a-f]{64}$/u.test(input.evidenceHash ?? '')
      ? input.evidenceHash
      : '',
  };
  return stableFingerprint(stableStringify(normalized));
}

function normalizeText(value: string): string {
  return redactSecrets(value)
    .toLowerCase()
    .replace(/\b0x[0-9a-f]+\b/giu, '<address>')
    .replace(/\b\d+(?:\.\d+)?(?:ms|s|kb|mb|gb)?\b/giu, '<number>')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 4_000);
}

function normalizePath(value: string): string {
  return redactSecrets(value)
    .replaceAll('\\', '/')
    .replace(/^[a-zA-Z]:\/Users\/[^/]+/u, '<workspace>')
    .replace(/^[a-zA-Z]:\/home\/[^/]+/u, '<workspace>')
    .replace(/^[a-zA-Z]:\//u, '<workspace>/')
    .replace(/^\/(?:Users|home)\/[^/]+/u, '<workspace>')
    .trim()
    .slice(0, 4_096);
}

/** A deterministic, dependency-free 256-bit identity for convergence
 * comparison. This is not used as a security signature; the immutable
 * evidence hashes included in the input remain SHA-256 values. Keeping this
 * module browser-safe lets the shared plan schema compile in both Electron
 * and renderer TypeScript projects. */
function stableFingerprint(value: string): string {
  const seeds = [
    0xcbf29ce484222325n,
    0x84222325cbf29ce4n,
    0x9e3779b185ebca87n,
    0x517cc1b727220a95n,
  ];
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  return seeds.map((seed, index) => {
    let hash = seed;
    for (let cursor = 0; cursor < value.length; cursor += 1) {
      hash ^= BigInt(value.charCodeAt(cursor) + index);
      hash = (hash * prime) & mask;
    }
    return hash.toString(16).padStart(16, '0');
  }).join('');
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableStringify(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
