import { createHash } from 'node:crypto';

import { redactSecrets } from './format-error.js';
import {
  contextPackageSchema,
  type ContextPackage,
} from './task-collaboration.js';

export interface ContextSelection {
  mode: 'minimal' | 'meeting-summary' | 'selected-history' | 'full-visible-history';
  messageIds: string[];
  decisionIds: string[];
  dependencyTaskIds: string[];
  attachmentIds: string[];
}

export interface AuthorizedMeetingContextSource {
  messages: Array<{
    id: string;
    role: 'user' | 'assistant';
    text: string;
    timestamp: number;
  }>;
  meetingSummary?: string;
  decisions: Array<{ id: string; summary: string }>;
  dependencyReports: Array<{ taskId: string; reportHash: string; summary: string }>;
  attachments: Array<{ id: string; name: string; contentHash: string }>;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, stableValue(child)]),
    );
  }
  return value;
}

export function stableSerialize(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

export function hashVisibleContextValue(value: unknown): string {
  return createHash('sha256').update(stableSerialize(value), 'utf8').digest('hex');
}

function uniqueIds(ids: string[], field: string): string[] {
  const unique = new Set(ids);
  if (unique.size !== ids.length) throw new Error(`${field} contains duplicate identifiers`);
  return [...ids];
}

function resolveIds<T>(
  requested: string[],
  available: readonly T[],
  idOf: (entry: T) => string,
  field: string,
): T[] {
  const index = new Map(available.map((entry) => [idOf(entry), entry]));
  return uniqueIds(requested, field).map((id) => {
    const entry = index.get(id);
    if (!entry) throw new Error(`${field} references unauthorized or missing id: ${id}`);
    return entry;
  });
}

function visibleText(text: string, maxLength = 20_000): string {
  return redactSecrets(text).slice(0, maxLength);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

export function freezeContextPackage(contextPackage: ContextPackage): ContextPackage {
  return deepFreeze(contextPackage);
}

export function verifyContextPackageIntegrity(contextPackage: ContextPackage): boolean {
  const hashInput = {
    schemaVersion: contextPackage.schemaVersion,
    taskId: contextPackage.taskId,
    attempt: contextPackage.attempt,
    mode: contextPackage.mode,
    messages: contextPackage.messages,
    decisions: contextPackage.decisions,
    dependencyReports: contextPackage.dependencyReports,
    attachments: contextPackage.attachments,
  };
  const serialized = stableSerialize(hashInput);
  return Buffer.byteLength(serialized, 'utf8') === contextPackage.byteLength
    && hashVisibleContextValue(hashInput) === contextPackage.packageHash;
}

export function compileContextPackage(input: {
  taskId: string;
  attempt: number;
  selection: ContextSelection;
  source: AuthorizedMeetingContextSource;
  limits: { maxBytes: number; maxEstimatedTokens: number };
}): ContextPackage {
  if (!input.taskId.trim()) throw new Error('context package requires a task id');
  if (!Number.isSafeInteger(input.attempt) || input.attempt < 1) {
    throw new Error('context package requires a positive attempt');
  }
  if (!Number.isSafeInteger(input.limits.maxBytes) || input.limits.maxBytes < 1) {
    throw new Error('context package maxBytes must be positive');
  }
  if (
    !Number.isSafeInteger(input.limits.maxEstimatedTokens)
    || input.limits.maxEstimatedTokens < 1
  ) {
    throw new Error('context package maxEstimatedTokens must be positive');
  }

  // Resolve every caller-supplied identifier before copying any selected
  // content. A stale/foreign identifier aborts the package as one unit.
  const selectedMessages = resolveIds(
    input.selection.messageIds,
    input.source.messages,
    (entry) => entry.id,
    'messageIds',
  );
  const selectedDecisions = resolveIds(
    input.selection.decisionIds,
    input.source.decisions,
    (entry) => entry.id,
    'decisionIds',
  );
  const selectedReports = resolveIds(
    input.selection.dependencyTaskIds,
    input.source.dependencyReports,
    (entry) => entry.taskId,
    'dependencyTaskIds',
  );
  const selectedAttachments = resolveIds(
    input.selection.attachmentIds,
    input.source.attachments,
    (entry) => entry.id,
    'attachmentIds',
  );

  let messages: ContextPackage['messages'];
  if (input.selection.mode === 'minimal') {
    messages = [];
  } else if (input.selection.mode === 'meeting-summary') {
    messages = input.source.meetingSummary?.trim()
      ? [{
          id: 'meeting-summary',
          role: 'assistant',
          text: visibleText(input.source.meetingSummary, 40_000),
        }]
      : [];
  } else if (input.selection.mode === 'selected-history') {
    messages = selectedMessages.map(({ id, role, text }) => ({
      id,
      role,
      text: visibleText(text),
    }));
  } else {
    messages = [...input.source.messages]
      .sort((left, right) => left.timestamp - right.timestamp || left.id.localeCompare(right.id))
      .map(({ id, role, text }) => ({ id, role, text: visibleText(text) }));
  }

  const decisions = selectedDecisions
    .map(({ id, summary }) => ({ id, summary: visibleText(summary, 4_000) }));
  const dependencyReports = selectedReports.map(({ taskId, reportHash, summary }) => ({
    taskId,
    reportHash,
    summary: visibleText(summary, 4_000),
  }));
  const attachments = selectedAttachments.map(({ id, name, contentHash }) => ({
    id,
    name,
    contentHash,
  }));

  const hashInput = {
    schemaVersion: 1 as const,
    taskId: input.taskId,
    attempt: input.attempt,
    mode: input.selection.mode,
    messages,
    decisions,
    dependencyReports,
    attachments,
  };
  const serialized = stableSerialize(hashInput);
  const byteLength = Buffer.byteLength(serialized, 'utf8');
  const estimatedTokens = Math.ceil(byteLength / 4);
  if (byteLength > input.limits.maxBytes) {
    throw new Error(`context package exceeds byte limit: ${byteLength}/${input.limits.maxBytes}`);
  }
  if (estimatedTokens > input.limits.maxEstimatedTokens) {
    throw new Error(
      `context package exceeds estimated token limit: ${estimatedTokens}/${input.limits.maxEstimatedTokens}`,
    );
  }
  const contextPackage = contextPackageSchema.parse({
    ...hashInput,
    byteLength,
    packageHash: hashVisibleContextValue(hashInput),
  });
  return freezeContextPackage(contextPackage);
}

export function renderContextPackageForWorker(
  taskPrompt: string,
  contextPackage: ContextPackage,
): string {
  const visibleContext = {
    mode: contextPackage.mode,
    messages: contextPackage.messages,
    decisions: contextPackage.decisions,
    dependencyReports: contextPackage.dependencyReports,
    attachments: contextPackage.attachments,
  };
  return [
    '## Task',
    taskPrompt,
    '',
    '## Frozen visible context',
    stableSerialize(visibleContext),
    '',
    `Context package: ${contextPackage.packageHash}`,
    'Later instructions arrive through the task mailbox and do not rewrite this package.',
  ].join('\n');
}
