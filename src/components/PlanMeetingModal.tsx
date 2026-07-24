import { useEffect, useMemo, useState } from 'react';
import type { BackendInfo, PlanMeetingTaskInput } from '../types';
import { isWorkerBackendReady, validatePlanDraft } from '../lib/plan-validation';

interface PlanMeetingModalProps {
  open: boolean;
  tasks: PlanMeetingTaskInput[];
  backends: BackendInfo[];
  onReject: () => Promise<{ ok: boolean; error?: string }>;
  onSubmit: (tasks: PlanMeetingTaskInput[]) => Promise<{ ok: boolean; error?: string }>;
}

type Criterion = NonNullable<PlanMeetingTaskInput['acceptanceCriteria']>[number];

function cloneTasks(tasks: PlanMeetingTaskInput[]): PlanMeetingTaskInput[] {
  return tasks.map((task) => ({
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
  }));
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
    setDraft(cloneTasks(tasks));
    setError(null);
  }, [open, tasks]);

  const validation = useMemo(() => {
    return validatePlanDraft(draft, backends);
  }, [backends, draft]);

  const changedCount = useMemo(() => {
    const original = cloneTasks(tasks);
    return draft.reduce(
      (count, task, index) => count + (JSON.stringify(task) === JSON.stringify(original[index]) ? 0 : 1),
      Math.abs(draft.length - original.length),
    );
  }, [draft, tasks]);

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
                      onChange={(event) => patchTask(taskIndex, { executorBackendId: event.target.value })}
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
              setDraft((current) => [...current, {
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
              }]);
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
