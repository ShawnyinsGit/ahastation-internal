import type { BackendInfo, PlanMeetingTaskInput } from '../types';

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
  for (const task of tasks) {
    if (!task.id.trim() || !task.title.trim() || !task.prompt.trim()) {
      return '每个任务都需要 ID、标题和完整说明。';
    }
    if ((task.acceptanceCriteria?.length ?? 0) === 0
      || task.acceptanceCriteria?.some((criterion) => !criterion.description.trim())) {
      return `任务 ${task.id} 缺少验收条件。`;
    }
    if (!task.executorBackendId?.trim()) return `任务 ${task.id} 缺少执行 Backend。`;
    const backend = backends.find((item) => item.id === task.executorBackendId);
    if (!backend) return `任务 ${task.id} 的执行 Backend 不存在。`;
    if (!isWorkerBackendReady(backend)) return `任务 ${task.id} 的执行 Backend 当前不可用。`;
    for (const criterion of task.acceptanceCriteria ?? []) {
      if (criterion.verification.kind === 'command' && criterion.verification.argv.length === 0) {
        return `任务 ${task.id} 的测试命令不能为空。`;
      }
    }
  }
  return dependencyError(tasks);
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
