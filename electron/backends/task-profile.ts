import { createHash } from 'node:crypto';
import { z } from 'zod';

import {
  backendEffectiveProfileSchema,
  taskExecutionProfileSchema,
  type BackendEffectiveProfile,
  type TaskExecutionProfile,
} from '../task-collaboration.js';

export const backendRuntimeSchema = z.object({
  schemaVersion: z.literal(1),
  backendId: z.string().trim().min(1).max(100),
  runtimeVersion: z.string().trim().min(1).max(100),
}).strict();

export type BackendRuntime = z.infer<typeof backendRuntimeSchema>;

type CompileOptions = {
  backendId: string;
  defaultModel: string;
  models?: readonly string[];
  nativeReasoning?: (
    requested: TaskExecutionProfile,
    model: string,
  ) => Record<string, unknown> | undefined;
  unsupported?: (
    requested: TaskExecutionProfile,
    model: string,
  ) => string[];
  downgraded?: (
    requested: TaskExecutionProfile,
    model: string,
  ) => string[];
};

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stableValue(entry)]),
    );
  }
  return value;
}

export function stableProfileStringify(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function profileHash(value: unknown): string {
  return createHash('sha256').update(stableProfileStringify(value)).digest('hex');
}

function selectModel(
  requested: TaskExecutionProfile,
  options: CompileOptions,
): { model: string; unsupported: string[]; downgraded: string[] } {
  const preference = requested.modelPreference;
  if (!preference) {
    return { model: options.defaultModel, unsupported: [], downgraded: [] };
  }
  if (!options.models || options.models.includes(preference)) {
    return { model: preference, unsupported: [], downgraded: [] };
  }
  return {
    model: options.defaultModel,
    unsupported: ['modelPreference'],
    downgraded: [`modelPreference:${preference}->${options.defaultModel}`],
  };
}

export function compileBackendTaskProfile(
  requestedInput: TaskExecutionProfile,
  runtimeInput: BackendRuntime,
  options: CompileOptions,
): BackendEffectiveProfile {
  const requested = taskExecutionProfileSchema.parse(structuredClone(requestedInput));
  const runtime = backendRuntimeSchema.parse(structuredClone(runtimeInput));
  if (requested.backendId !== options.backendId) {
    throw new Error(
      `requested backend mismatch: expected '${options.backendId}', got '${requested.backendId}'`,
    );
  }
  if (runtime.backendId !== options.backendId) {
    throw new Error(
      `runtime backend mismatch: expected '${options.backendId}', got '${runtime.backendId}'`,
    );
  }

  const selected = selectModel(requested, options);
  const unsupported = [
    ...selected.unsupported,
    ...(options.unsupported?.(requested, selected.model) ?? []),
  ];
  const downgraded = [
    ...selected.downgraded,
    ...(options.downgraded?.(requested, selected.model) ?? []),
  ];
  const facts = {
    schemaVersion: 1 as const,
    backendId: options.backendId,
    runtimeVersion: runtime.runtimeVersion,
    model: selected.model,
    nativeReasoning: options.nativeReasoning?.(requested, selected.model),
    unsupported: Array.from(new Set(unsupported)),
    downgraded: Array.from(new Set(downgraded)),
  };
  return backendEffectiveProfileSchema.parse({
    ...facts,
    capabilityHash: profileHash(facts),
  });
}

export function compileCodexTaskProfile(
  requested: TaskExecutionProfile,
  runtime: BackendRuntime,
): BackendEffectiveProfile {
  const effort = {
    fast: 'low',
    balanced: 'medium',
    deep: 'high',
  } as const;
  return compileBackendTaskProfile(requested, runtime, {
    backendId: 'codex',
    defaultModel: 'gpt-5.4',
    nativeReasoning: (profile) => ({
      modelReasoningEffort: effort[profile.workMode],
    }),
  });
}

export function compileClaudeTaskProfile(
  requested: TaskExecutionProfile,
  runtime: BackendRuntime,
  defaultModel: string,
  models: readonly string[],
): BackendEffectiveProfile {
  const effort = {
    fast: 'low',
    balanced: 'medium',
    deep: 'high',
  } as const;
  return compileBackendTaskProfile(requested, runtime, {
    backendId: 'claude-code',
    defaultModel,
    models,
    nativeReasoning: (profile) => ({
      effort: effort[profile.workMode],
      thinking: { type: 'adaptive' },
    }),
  });
}

export function parseOpenCodeModel(model: string): {
  providerID: string;
  modelID: string;
} {
  const separator = model.indexOf('/');
  if (separator <= 0 || separator === model.length - 1) {
    throw new Error(`OpenCode model must use provider/model syntax: '${model}'`);
  }
  return {
    providerID: model.slice(0, separator),
    modelID: model.slice(separator + 1),
  };
}

export function compileOpenCodeTaskProfile(
  requested: TaskExecutionProfile,
  runtime: BackendRuntime,
  defaultModel: string,
  models: readonly string[],
): BackendEffectiveProfile {
  return compileBackendTaskProfile(requested, runtime, {
    backendId: 'opencode',
    defaultModel,
    models,
    nativeReasoning: (_profile, model) => ({
      promptModel: parseOpenCodeModel(model),
    }),
    unsupported: () => ['workMode'],
    downgraded: (profile) => [`workMode:${profile.workMode}->backend-default`],
  });
}

export function compilePocketVibeTaskProfile(
  requested: TaskExecutionProfile,
  runtime: BackendRuntime,
  defaultModel: string,
): BackendEffectiveProfile {
  return compileBackendTaskProfile(requested, runtime, {
    backendId: 'pocket-vibe',
    defaultModel,
    // The "model" slot doubles as the hub's target_agent_id — any id the
    // hub knows is valid, so no fixed model list is enforced.
    unsupported: () => ['workMode'],
    downgraded: (profile) => [`workMode:${profile.workMode}->backend-default`],
  });
}

export function compileKimiTaskProfile(
  requested: TaskExecutionProfile,
  runtime: BackendRuntime,
  defaultModel: string,
): BackendEffectiveProfile {
  return compileBackendTaskProfile(requested, runtime, {
    backendId: 'kimi',
    defaultModel,
    models: [defaultModel],
    unsupported: () => ['workMode'],
    downgraded: (profile) => [`workMode:${profile.workMode}->backend-default`],
  });
}
