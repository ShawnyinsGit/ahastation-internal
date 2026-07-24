import { useEffect, useMemo, useState } from 'react';
import type { BackendInfo, PlanMeetingTaskInput } from '../types';
import {
  isWorkerBackendReady,
  normalizePlanDraft,
  normalizePlanDrafts,
  validatePlanDraft,
} from '../lib/plan-validation';

interface PlanMeetingModalProps {
  open: boolean;
  tasks: PlanMeetingTaskInput[];
  backends: BackendInfo[];
  onReject: () => Promise<{ ok: boolean; error?: string }>;
  onSubmit: (tasks: PlanMeetingTaskInput[]) => Promise<{ ok: boolean; error?: string }>;
}

type Criterion = NonNullable<PlanMeetingTaskInput['acceptanceCriteria']>[number];

function cloneTasks(tasks: PlanMeetingTaskInput[], backends: BackendInfo[]): PlanMeetingTaskInput[] {
  return normalizePlanDrafts(tasks, backends).map((task) => ({
    ...task,
    deps: [...task.deps],
    writePaths: task.writePaths ? [...task.writePaths] : undefined,
    acceptanceCriteria: task.acceptanceCriteria?.map((criterion) => ({
      ...criterion,
      verification: criterion.verification.kind === 'command'
        ? { ...criterion.verification, argv: [...criterion.verification.argv] }
        : { kind: 'manual' },
    })) ?? [{
      id: 'manual-acceptance',
      description: '人工检查交付内容并确认满足任务目标',
      verification: { kind: 'manual' },
    }],
    executionProfile: task.executionProfile ? { ...task.executionProfile } : undefined,
    budget: task.budget ? { ...task.budget } : undefined,
    contextSelection: task.contextSelection ? {
      ...task.contextSelection,
      messageIds: [...task.contextSelection.messageIds],
      decisionIds: [...task.contextSelection.decisionIds],
      dependencyTaskIds: [...task.contextSelection.dependencyTaskIds],
      attachmentIds: [...task.contextSelection.attachmentIds],
    } : undefined,
    authorityRequest: task.authorityRequest ? {
      ...task.authorityRequest,
      writePaths: [...task.authorityRequest.writePaths],
      toolKinds: [...task.authorityRequest.toolKinds],
      workingDirectories: [...task.authorityRequest.workingDirectories],
      commands: task.authorityRequest.commands.map((argv) => [...argv]),
      environmentKeys: [...task.authorityRequest.environmentKeys],
      networkHosts: [...task.authorityRequest.networkHosts],
    } : undefined,
  }));
}

function lines(value: string): string[] {
  return value.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean);
}

export function PlanMeetingModal({
  open,
  tasks,
  backends,
  onReject,
  onSubmit,
}: PlanMeetingModalProps) {
  const [draft, setDraft] = useState<PlanMeetingTaskInput[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setDraft(cloneTasks(tasks, backends));
    setError(null);
  }, [backends, open, tasks]);

  const validation = useMemo(() => {
    return validatePlanDraft(draft, backends);
  }, [backends, draft]);

  const changedCount = useMemo(() => {
    const original = cloneTasks(tasks, backends);
    return draft.reduce(
      (count, task, index) => count + (JSON.stringify(task) === JSON.stringify(original[index]) ? 0 : 1),
      Math.abs(draft.length - original.length),
    );
  }, [backends, draft, tasks]);

  if (!open) return null;

  const patchTask = (index: number, patch: Partial<PlanMeetingTaskInput>) => {
    setDraft((current) => current.map((task, taskIndex) =>
      taskIndex === index ? { ...task, ...patch } : task));
  };

  const patchCriterion = (taskIndex: number, criterionIndex: number, criterion: Criterion) => {
    const criteria = [...(draft[taskIndex].acceptanceCriteria ?? [])];
    criteria[criterionIndex] = criterion;
    patchTask(taskIndex, { acceptanceCriteria: criteria });
  };

  const submit = async () => {
    if (validation || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await onSubmit(draft);
      if (!result.ok) setError(result.error ?? '计划调度失败。');
    } finally {
      setSubmitting(false);
    }
  };

  const reject = async () => {
    if (submitting) return;
    setSubmitting(true);
    try {
      const result = await onReject();
      if (!result.ok) setError(result.error ?? '无法拒绝计划。');
    } finally {
      setSubmitting(false);
    }
  };

  const runnable = draft.filter((task) => task.deps.length === 0).length;
  const workerCapacity = 4;
  const startsImmediately = Math.min(runnable, workerCapacity);
  const waitsForCapacity = Math.max(0, runnable - workerCapacity);

  return (
    <div className="plan-modal-backdrop">
      <section className="plan-modal plan-modal-structured" role="dialog" aria-modal="true" aria-labelledby="plan-title">
        <header className="plan-modal-header">
          <div>
            <span className="plan-modal-kicker">Coordinator 建议</span>
            <h2 id="plan-title">确认结构化执行计划</h2>
          </div>
          <div className="plan-capacity">
            立即 {startsImmediately} 项 · 等容量 {waitsForCapacity} 项 · 上限 {workerCapacity}
          </div>
        </header>

        {changedCount > 0 && (
          <div className="plan-diff-note" aria-live="polite">
            你已修改 {changedCount} 项 Coordinator 建议；提交后以此版本为准。
          </div>
        )}

        <div className="plan-task-list">
          {draft.map((task, taskIndex) => {
            const selectedBackend = backends.find((backend) => backend.id === task.executorBackendId);
            const profile = task.executionProfile!;
            const contextSelection = task.contextSelection!;
            const authority = task.authorityRequest!;
            const budget = task.budget!;
            return (
              <article className="plan-task-card" key={`${task.id}:${taskIndex}`}>
                <div className="plan-task-card-head">
                  <span>任务 {taskIndex + 1}</span>
                  <button
                    type="button"
                    onClick={() => setDraft((current) => current.filter((_, index) => index !== taskIndex))}
                    disabled={draft.length === 1}
                  >
                    删除
                  </button>
                </div>
                <div className="plan-field-grid">
                  <label>
                    <span>任务 ID</span>
                    <input value={task.id} onChange={(event) => patchTask(taskIndex, { id: event.target.value })} />
                  </label>
                  <label>
                    <span>执行 Backend</span>
                    <select
                      value={selectedBackend?.id ?? ''}
                      onChange={(event) => patchTask(taskIndex, {
                        executorBackendId: event.target.value,
                        executionProfile: { ...profile, backendId: event.target.value },
                      })}
                    >
                      <option value="" disabled>请选择 Backend</option>
                      {backends.filter((backend) => backend.id !== 'qoder').map((backend) => (
                        <option key={backend.id} value={backend.id} disabled={!isWorkerBackendReady(backend)}>
                          {backend.displayName} · {isWorkerBackendReady(backend) ? '可用' : !backend.available ? '需安装' : !backend.supportsWorkers ? '契约未通过' : '需登录'}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <label>
                  <span>标题</span>
                  <input value={task.title} onChange={(event) => patchTask(taskIndex, { title: event.target.value })} />
                </label>

                <fieldset>
                  <legend>执行配置</legend>
                  <div className="plan-field-grid">
                    <label>
                      <span>工作模式</span>
                      <select
                        value={profile.workMode}
                        onChange={(event) => patchTask(taskIndex, {
                          executionProfile: {
                            ...profile,
                            workMode: event.target.value as typeof profile.workMode,
                          },
                        })}
                      >
                        <option value="fast">快速</option>
                        <option value="balanced">平衡</option>
                        <option value="deep">深度</option>
                      </select>
                    </label>
                    <label>
                      <span>上下文范围</span>
                      <select
                        value={profile.contextMode}
                        onChange={(event) => {
                          const mode = event.target.value as typeof profile.contextMode;
                          patchTask(taskIndex, {
                            executionProfile: { ...profile, contextMode: mode },
                            contextSelection: { ...contextSelection, mode },
                          });
                        }}
                      >
                        <option value="minimal">最小</option>
                        <option value="meeting-summary">会议摘要</option>
                        <option value="selected-history">选择的历史</option>
                        <option value="full-visible-history">全部可见历史</option>
                      </select>
                    </label>
                    <label>
                      <span>任务超时（毫秒）</span>
                      <input
                        type="number"
                        min={30_000}
                        max={7_200_000}
                        value={profile.timeoutMs}
                        onChange={(event) => patchTask(taskIndex, {
                          executionProfile: { ...profile, timeoutMs: Number(event.target.value) },
                        })}
                      />
                    </label>
                    <label>
                      <span>Token 预算</span>
                      <input
                        type="number"
                        min={1_000}
                        max={10_000_000}
                        value={profile.maxTokenBudget}
                        onChange={(event) => patchTask(taskIndex, {
                          executionProfile: { ...profile, maxTokenBudget: Number(event.target.value) },
                        })}
                      />
                    </label>
                  </div>
                </fieldset>

                <fieldset>
                  <legend>持续返工预算</legend>
                  <div className="plan-field-grid">
                    <label>
                      <span>最大尝试次数</span>
                      <input
                        type="number"
                        min={1}
                        max={100}
                        value={budget.maxAttempts}
                        onChange={(event) => patchTask(taskIndex, {
                          budget: { ...budget, maxAttempts: Number(event.target.value) },
                        })}
                      />
                    </label>
                    <label>
                      <span>总 Token 上限</span>
                      <input
                        type="number"
                        min={profile.maxTokenBudget}
                        value={budget.maxTotalTokens}
                        onChange={(event) => patchTask(taskIndex, {
                          budget: { ...budget, maxTotalTokens: Number(event.target.value) },
                        })}
                      />
                    </label>
                    <label>
                      <span>总时长上限（毫秒）</span>
                      <input
                        type="number"
                        min={profile.timeoutMs}
                        value={budget.maxTotalDurationMs}
                        onChange={(event) => patchTask(taskIndex, {
                          budget: { ...budget, maxTotalDurationMs: Number(event.target.value) },
                        })}
                      />
                    </label>
                    <label>
                      <span>停滞尝试上限</span>
                      <input
                        type="number"
                        min={1}
                        max={budget.maxAttempts}
                        value={budget.maxStagnantAttempts}
                        onChange={(event) => patchTask(taskIndex, {
                          budget: { ...budget, maxStagnantAttempts: Number(event.target.value) },
                        })}
                      />
                    </label>
                  </div>
                  <small>达到任一上限会暂停任务；只有用户批准新版本预算后才会继续。</small>
                </fieldset>

                <fieldset>
                  <legend>Workspace 与授权范围</legend>
                  <div className="plan-field-grid">
                    <label>
                      <span>Workspace 模式</span>
                      <select
                        value={task.workspaceMode}
                        onChange={(event) => patchTask(taskIndex, {
                          workspaceMode: event.target.value as NonNullable<PlanMeetingTaskInput['workspaceMode']>,
                        })}
                      >
                        <option value="read-only">只读</option>
                        <option value="git-worktree">Git Worktree</option>
                        <option value="shared-locked">共享目录锁（兼容模式）</option>
                      </select>
                      {task.workspaceMode === 'shared-locked' && (
                        <small role="alert">
                          直接写入当前目录，仅提供进程内路径锁；不会防止用户或外部进程改动，
                          并停用 Coordinator 自动验收、集成与最终原子发布。
                        </small>
                      )}
                    </label>
                    <label>
                      <span>命令超时上限（毫秒）</span>
                      <input
                        type="number"
                        min={1_000}
                        max={7_200_000}
                        value={authority.maxCommandTimeoutMs}
                        onChange={(event) => patchTask(taskIndex, {
                          authorityRequest: {
                            ...authority,
                            maxCommandTimeoutMs: Number(event.target.value),
                          },
                        })}
                      />
                    </label>
                  </div>
                  <div className="plan-field-grid">
                    <label>
                      <span>可写路径（每行一项）</span>
                      <textarea
                        rows={3}
                        value={authority.writePaths.join('\n')}
                        onChange={(event) => {
                          const writePaths = lines(event.target.value);
                          patchTask(taskIndex, {
                            writePaths,
                            authorityRequest: {
                              ...authority,
                              writePaths,
                              toolKinds: writePaths.length > 0
                                ? Array.from(new Set([...authority.toolKinds, 'read', 'write']))
                                : authority.toolKinds.filter((kind) => kind !== 'write'),
                            },
                          });
                        }}
                      />
                    </label>
                    <label>
                      <span>允许工作目录（每行一项）</span>
                      <textarea
                        rows={3}
                        value={authority.workingDirectories.join('\n')}
                        onChange={(event) => patchTask(taskIndex, {
                          authorityRequest: {
                            ...authority,
                            workingDirectories: lines(event.target.value),
                          },
                        })}
                      />
                    </label>
                    <label>
                      <span>允许命令（每行一条 argv）</span>
                      <textarea
                        rows={3}
                        value={authority.commands.map((argv) => argv.join(' ')).join('\n')}
                        onChange={(event) => patchTask(taskIndex, {
                          authorityRequest: {
                            ...authority,
                            commands: lines(event.target.value)
                              .map((command) => command.split(/\s+/).filter(Boolean)),
                          },
                        })}
                      />
                    </label>
                    <label>
                      <span>环境变量名（每行一项）</span>
                      <textarea
                        rows={3}
                        value={authority.environmentKeys.join('\n')}
                        onChange={(event) => patchTask(taskIndex, {
                          authorityRequest: {
                            ...authority,
                            environmentKeys: lines(event.target.value),
                          },
                        })}
                      />
                    </label>
                    <label>
                      <span>网络主机（每行一项）</span>
                      <textarea
                        rows={3}
                        value={authority.networkHosts.join('\n')}
                        onChange={(event) => patchTask(taskIndex, {
                          authorityRequest: {
                            ...authority,
                            networkHosts: lines(event.target.value),
                          },
                        })}
                      />
                    </label>
                  </div>
                  <div className="plan-diff-note">
                    授权摘要：{authority.writePaths.length} 个写路径 · {authority.commands.length} 条命令 · {authority.networkHosts.length} 个网络主机。
                    命令、网络、凭据与破坏性操作始终需要高风险确认。
                  </div>
                </fieldset>
                <label>
                  <span>完整任务说明</span>
                  <textarea rows={4} value={task.prompt} onChange={(event) => patchTask(taskIndex, { prompt: event.target.value })} />
                </label>

                <fieldset className="plan-dependencies">
                  <legend>前置依赖</legend>
                  {draft.filter((_, index) => index !== taskIndex).length === 0
                    ? <span className="plan-muted">无其他任务</span>
                    : draft.map((candidate, candidateIndex) => candidateIndex === taskIndex ? null : (
                      <label key={`${candidate.id}:${candidateIndex}`}>
                        <input
                          type="checkbox"
                          checked={task.deps.includes(candidate.id)}
                          onChange={(event) => patchTask(taskIndex, {
                            deps: event.target.checked
                              ? [...task.deps, candidate.id]
                              : task.deps.filter((id) => id !== candidate.id),
                          })}
                        />
                        <span>{candidate.title || candidate.id}</span>
                      </label>
                    ))}
                </fieldset>

                <label className="plan-decision-forecast">
                  <input
                    type="checkbox"
                    checked={task.requiresDecision === true}
                    onChange={(event) => patchTask(taskIndex, { requiresDecision: event.target.checked })}
                  />
                  <span>预计执行中需要用户决策</span>
                </label>

                <div className="plan-criteria">
                  <div className="plan-section-head">
                    <strong>验收条件与允许测试</strong>
                    <button
                      type="button"
                      onClick={() => patchTask(taskIndex, {
                        acceptanceCriteria: [
                          ...(task.acceptanceCriteria ?? []),
                          {
                            id: `criterion-${(task.acceptanceCriteria?.length ?? 0) + 1}`,
                            description: '',
                            verification: { kind: 'manual' },
                          },
                        ],
                      })}
                    >
                      添加条件
                    </button>
                  </div>
                  {(task.acceptanceCriteria ?? []).map((criterion, criterionIndex) => (
                    <div className="plan-criterion-row" key={`${criterion.id}:${criterionIndex}`}>
                      <input
                        aria-label="验收条件"
                        value={criterion.description}
                        placeholder="明确、可检查的验收条件"
                        onChange={(event) => patchCriterion(taskIndex, criterionIndex, {
                          ...criterion,
                          description: event.target.value,
                        })}
                      />
                      <select
                        aria-label="校验方式"
                        value={criterion.verification.kind}
                        onChange={(event) => patchCriterion(taskIndex, criterionIndex, {
                          ...criterion,
                          verification: event.target.value === 'command'
                            ? { kind: 'command', argv: [] }
                            : { kind: 'manual' },
                        })}
                      >
                        <option value="manual">人工验收</option>
                        <option value="command">自动命令</option>
                      </select>
                      {criterion.verification.kind === 'command' && (
                        <input
                          aria-label="命令 argv"
                          value={criterion.verification.argv.join(' ')}
                          placeholder="npm test（按空格拆为 argv，不经过 shell）"
                          onChange={(event) => patchCriterion(taskIndex, criterionIndex, {
                            ...criterion,
                            verification: {
                              kind: 'command',
                              argv: event.target.value.trim().split(/\s+/).filter(Boolean),
                              ...(criterion.verification.kind === 'command'
                                && criterion.verification.timeoutMs
                                ? { timeoutMs: criterion.verification.timeoutMs }
                                : {}),
                            },
                          })}
                        />
                      )}
                      <button
                        type="button"
                        aria-label="删除验收条件"
                        onClick={() => patchTask(taskIndex, {
                          acceptanceCriteria: task.acceptanceCriteria?.filter((_, index) => index !== criterionIndex),
                        })}
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              </article>
            );
          })}
          <button
            type="button"
            className="plan-add-task"
            onClick={() => {
              const sequence = draft.length + 1;
              const defaultBackend = backends.find((backend) => backend.isDefault && isWorkerBackendReady(backend))
                ?? backends.find(isWorkerBackendReady);
              setDraft((current) => [...current, normalizePlanDraft({
                id: `task-${sequence}`,
                title: '',
                prompt: '',
                deps: [],
                executorBackendId: defaultBackend?.id,
                acceptanceCriteria: [{
                  id: 'manual-acceptance',
                  description: '人工检查交付内容并确认满足任务目标',
                  verification: { kind: 'manual' },
                }],
              }, defaultBackend?.id ?? '')]);
            }}
          >
            添加任务
          </button>
        </div>

        {validation && <div className="plan-modal-error" role="alert">{validation}</div>}
        {error && <div className="plan-modal-error" role="alert">{error}</div>}
        <footer className="plan-modal-actions">
          <button type="button" className="plan-modal-cancel" onClick={() => { void reject(); }} disabled={submitting}>
            拒绝计划
          </button>
          <button type="button" className="plan-modal-submit" onClick={() => { void submit(); }} disabled={submitting || Boolean(validation)}>
            {submitting ? '处理中…' : `确认并调度 ${draft.length} 个任务`}
          </button>
        </footer>
      </section>
    </div>
  );
}
