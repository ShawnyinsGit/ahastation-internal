import type { BackendInfo, PlanMeetingTaskInput } from '../types';

export function normalizePlanDraft(
  task: PlanMeetingTaskInput,
  defaultBackendId: string,
): PlanMeetingTaskInput {
  const backendId = task.executorBackendId
    ?? task.executionProfile?.backendId
    ?? defaultBackendId;
  const writePaths = task.authorityRequest?.writePaths ?? task.writePaths ?? [];
  const contextMode = task.executionProfile?.contextMode ?? 'meeting-summary';
  return {
    ...task,
    deps: [...(task.deps ?? [])],
    executorBackendId: backendId,
    writePaths: [...writePaths],
    executionProfile: task.executionProfile ? { ...task.executionProfile } : {
      schemaVersion: 1,
      backendId,
      workMode: 'balanced',
      contextMode,
      timeoutMs: 1_800_000,
      maxTokenBudget: 200_000,
    },
    contextSelection: task.contextSelection ? {
      ...task.contextSelection,
      messageIds: [...task.contextSelection.messageIds],
      decisionIds: [...(task.contextSelection.decisionIds ?? [])],
      dependencyTaskIds: [...task.contextSelection.dependencyTaskIds],
      attachmentIds: [...task.contextSelection.attachmentIds],
    } : {
      mode: contextMode,
      messageIds: [],
      decisionIds: [],
      dependencyTaskIds: [],
      attachmentIds: [],
    },
    workspaceMode: task.workspaceMode ?? (writePaths.length > 0 ? 'git-worktree' : 'read-only'),
    authorityRequest: task.authorityRequest ? {
      ...task.authorityRequest,
      writePaths: [...task.authorityRequest.writePaths],
      toolKinds: [...task.authorityRequest.toolKinds],
      workingDirectories: [...task.authorityRequest.workingDirectories],
      commands: task.authorityRequest.commands.map((argv) => [...argv]),
      environmentKeys: [...task.authorityRequest.environmentKeys],
      networkHosts: [...task.authorityRequest.networkHosts],
    } : {
      writePaths: [...writePaths],
      toolKinds: writePaths.length > 0 ? ['read', 'write'] : ['read'],
      workingDirectories: ['.'],
      commands: [],
      environmentKeys: [],
      maxCommandTimeoutMs: 1_800_000,
      networkHosts: [],
    },
    budget: task.budget ? { ...task.budget } : {
      schemaVersion: 1,
      maxAttempts: 6,
      maxTotalTokens: 600_000,
      maxTotalDurationMs: 14_400_000,
      maxStagnantAttempts: 3,
    },
  };
}

export function normalizePlanDrafts(
  tasks: PlanMeetingTaskInput[],
  backends: BackendInfo[],
): PlanMeetingTaskInput[] {
  const defaultBackendId = backends.find((backend) => backend.isDefault)?.id
    ?? backends[0]?.id
    ?? '';
  return tasks.map((task) => normalizePlanDraft(task, defaultBackendId));
}

export function isWorkerBackendReady(backend: BackendInfo | undefined): boolean {
  return Boolean(
    backend
    && backend.supportsWorkers
    && backend.available
    && (backend.loggedIn || backend.hasApiKey || backend.authMode === 'none'),
  );
}

export function validatePlanDraft(
  tasks: PlanMeetingTaskInput[],
  backends: BackendInfo[],
): string | null {
  if (tasks.length === 0) return '计划至少需要一个任务。';
  const normalized = normalizePlanDrafts(tasks, backends);
  for (const task of normalized) {
    if (!task.id.trim() || !task.title.trim() || !task.prompt.trim()) {
      return '每个任务都需要 ID、标题和完整说明。';
    }
    if ((task.acceptanceCriteria?.length ?? 0) === 0
      || task.acceptanceCriteria?.some((criterion) => !criterion.description.trim())) {
      return `任务 ${task.id} 缺少验收条件。`;
    }
    if (!task.executorBackendId?.trim()) return `任务 ${task.id} 缺少执行 Backend。`;
    if (!task.executionProfile) return `任务 ${task.id} 缺少执行配置。`;
    if (task.executionProfile.backendId !== task.executorBackendId) {
      return `任务 ${task.id} 的执行 Backend 与执行配置不一致。`;
    }
    if (!task.contextSelection || task.contextSelection.mode !== task.executionProfile.contextMode) {
      return `任务 ${task.id} 的上下文配置不一致。`;
    }
    if (!task.workspaceMode || !task.authorityRequest) return `任务 ${task.id} 缺少 Workspace 或授权配置。`;
    if (
      !task.budget
      || task.budget.maxAttempts < 1
      || task.budget.maxTotalTokens < task.executionProfile.maxTokenBudget
      || task.budget.maxTotalDurationMs < task.executionProfile.timeoutMs
      || task.budget.maxStagnantAttempts < 1
      || task.budget.maxStagnantAttempts > task.budget.maxAttempts
    ) {
      return `任务 ${task.id} 的持续返工预算无效。`;
    }
    if (
      task.workspaceMode === 'read-only'
      && (task.authorityRequest.writePaths.length > 0 || task.authorityRequest.toolKinds.includes('write'))
    ) {
      return `任务 ${task.id} 的只读 Workspace 不能申请写权限。`;
    }
    if (task.authorityRequest.commands.some((argv) => argv.length === 0)) {
      return `任务 ${task.id} 的允许命令不能为空。`;
    }
    const backend = backends.find((item) => item.id === task.executorBackendId);
    if (!backend) return `任务 ${task.id} 的执行 Backend 不存在。`;
    if (!isWorkerBackendReady(backend)) return `任务 ${task.id} 的执行 Backend 当前不可用。`;
    for (const criterion of task.acceptanceCriteria ?? []) {
      if (criterion.verification.kind === 'command' && criterion.verification.argv.length === 0) {
        return `任务 ${task.id} 的测试命令不能为空。`;
      }
    }
  }
  return dependencyError(normalized);
}

export function dependencyError(tasks: PlanMeetingTaskInput[]): string | null {
  const ids = new Set(tasks.map((task) => task.id));
  if (ids.size !== tasks.length) return '任务 ID 不能重复。';
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    const task = tasks.find((item) => item.id === id);
    for (const dep of task?.deps ?? []) {
      if (!ids.has(dep) || visit(dep)) return true;
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  return tasks.some((task) => visit(task.id)) ? '依赖中存在循环或未知任务。' : null;
}
