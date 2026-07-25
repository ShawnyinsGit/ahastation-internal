import type { MeetingPlanNode, PlanMeetingTaskInput, TaskWorkspaceMode } from '../types';

export type DependencyGate = 'reviewed' | 'accepted';

const WRITE_RE = /(?:\b(?:write|edit|create|add|update|fix|refactor|implement|modify|patch|generate|scaffold)\b|写|改|创建|新增|修复|重构|实现|生成)/i;

/**
 * Mirror of electron/task-intent.inferDefaultDependencyGate for the renderer
 * plan draft path. Keep the rules identical.
 */
export function inferDefaultDependencyGate(input: {
  workspaceMode?: TaskWorkspaceMode;
  writePaths?: readonly string[];
  title?: string;
  prompt?: string;
}): DependencyGate {
  if (input.workspaceMode === 'read-only') return 'reviewed';
  if ((input.writePaths?.length ?? 0) > 0) return 'accepted';
  const blob = `${input.title ?? ''} ${input.prompt ?? ''}`;
  return WRITE_RE.test(blob) ? 'accepted' : 'reviewed';
}

export function dependencyGateShortLabel(gate: DependencyGate | undefined): string {
  return (gate ?? 'accepted') === 'reviewed' ? '审查后放行' : '集成后放行';
}

export function dependencyGateDetail(gate: DependencyGate | undefined): string {
  return (gate ?? 'accepted') === 'reviewed'
    ? '下游在验证与独立审查通过后即可启动（审查进行中或集成冲突不放行；不必等进 Meeting 分支）'
    : '下游需等交付真正进入 Meeting 集成分支后启动（冻结失败的代码交付不能靠点确认放行）';
}

export function nodeDependencyGate(node: Pick<MeetingPlanNode, 'dependencyGate'>): DependencyGate {
  return node.dependencyGate === 'reviewed' ? 'reviewed' : 'accepted';
}

export function draftDependencyGate(task: PlanMeetingTaskInput): DependencyGate {
  if (task.dependencyGate === 'reviewed' || task.dependencyGate === 'accepted') {
    return task.dependencyGate;
  }
  return inferDefaultDependencyGate({
    workspaceMode: task.workspaceMode,
    writePaths: task.authorityRequest?.writePaths ?? task.writePaths,
    title: task.title,
    prompt: task.prompt,
  });
}
