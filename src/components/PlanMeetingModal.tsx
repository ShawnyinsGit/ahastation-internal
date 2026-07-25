import { useEffect, useMemo, useState } from 'react';
import type { BackendInfo, MeetingPlanBrief, PlanMeetingTaskInput } from '../types';
import { requestHideBrowser } from '../lib/browser-store';
import {
  isWorkerBackendReady,
  normalizePlanDraft,
  normalizePlanDrafts,
  resolvePlanDefaultWorkerBackendId,
  validatePlanDraft,
} from '../lib/plan-validation';

interface PlanMeetingModalProps {
  open: boolean;
  brief: MeetingPlanBrief | null;
  tasks: PlanMeetingTaskInput[];
  backends: BackendInfo[];
  onReject: () => Promise<{ ok: boolean; error?: string }>;
  onSubmit: (tasks: PlanMeetingTaskInput[]) => Promise<{ ok: boolean; error?: string }>;
}

function cloneBrief(brief: MeetingPlanBrief | null, tasks: PlanMeetingTaskInput[]): MeetingPlanBrief {
  if (brief) {
    return {
      goal: brief.goal,
      approach: brief.approach,
      steps: brief.steps.map((step) => ({ ...step })),
      risks: [...brief.risks],
      openQuestions: [...brief.openQuestions],
    };
  }
  return {
    goal: tasks.length === 1
      ? (tasks[0]?.title || '执行任务')
      : `完成 ${tasks.length} 项协作任务`,
    steps: tasks.map((task) => ({
      title: task.title,
      detail: task.prompt,
      taskId: task.id,
    })),
    risks: [],
    openQuestions: [],
  };
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
  brief,
  tasks,
  backends,
  onReject,
  onSubmit,
}: PlanMeetingModalProps) {
  const [draft, setDraft] = useState<PlanMeetingTaskInput[]>([]);
  const [draftBrief, setDraftBrief] = useState<MeetingPlanBrief>(() => cloneBrief(brief, tasks));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // This modal is a full-screen decision point: the native browser view
  // would paint over it if a browser stage tab happened to be active.
  useEffect(() => {
    if (!open) return;
    return requestHideBrowser();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setDraft(cloneTasks(tasks, backends));
    setDraftBrief(cloneBrief(brief, tasks));
    setError(null);
  }, [backends, brief, open, tasks]);

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

  const patchBrief = (patch: Partial<MeetingPlanBrief>) => {
    setDraftBrief((current) => ({ ...current, ...patch }));
  };

  return (
    <div className="plan-modal-backdrop">
      <section className="plan-modal plan-modal-structured" role="dialog" aria-modal="true" aria-labelledby="plan-title">
        <header className="plan-modal-header">
          <div>
            <span className="plan-modal-kicker">Plan Mode</span>
            <h2 id="plan-title">审阅执行计划</h2>
          </div>
          <div className="plan-capacity">
            立即 {startsImmediately} 项 · 等容量 {waitsForCapacity} 项 · 上限 {workerCapacity}
          </div>
        </header>

        {changedCount > 0 && (
          <div className="plan-diff-note" aria-live="polite">
            你已修改 {changedCount} 项任务配置；提交后以此版本为准。
          </div>
        )}

        <section className="plan-brief-doc" aria-label="计划正文">
          <label className="plan-brief-goal">
            <span>目标</span>
            <textarea
              rows={2}
              value={draftBrief.goal}
              onChange={(event) => patchBrief({ goal: event.target.value })}
              placeholder="成功标准：做完之后用户应看到什么"
            />
          </label>
          <label className="plan-brief-approach">
            <span>做法与取舍</span>
            <textarea
              rows={4}
              value={draftBrief.approach ?? ''}
              onChange={(event) => patchBrief({ approach: event.target.value || undefined })}
              placeholder="架构、顺序、为何这样拆、明确不做的事"
            />
          </label>
          <div className="plan-brief-steps">
            <div className="plan-section-head">
              <strong>步骤</strong>
              <button
                type="button"
                onClick={() => patchBrief({
                  steps: [...draftBrief.steps, { title: '', detail: '' }],
                })}
              >
                添加步骤
              </button>
            </div>
            {draftBrief.steps.length === 0 ? (
              <p className="plan-muted">尚未拆出步骤；下方任务会作为默认步骤。</p>
            ) : (
              <ol className="plan-brief-step-list">
                {draftBrief.steps.map((step, stepIndex) => (
                  <li key={`step-${stepIndex}`}>
                    <div className="plan-brief-step-head">
                      <span>步骤 {stepIndex + 1}</span>
                      <button
                        type="button"
                        aria-label="删除步骤"
                        onClick={() => patchBrief({
                          steps: draftBrief.steps.filter((_, index) => index !== stepIndex),
                        })}
                      >
                        ×
                      </button>
                    </div>
                    <input
                      aria-label="步骤标题"
                      value={step.title}
                      placeholder="这一步做什么"
                      onChange={(event) => {
                        const steps = draftBrief.steps.map((entry, index) => (
                          index === stepIndex ? { ...entry, title: event.target.value } : entry
                        ));
                        patchBrief({ steps });
                      }}
                    />
                    <textarea
                      rows={3}
                      aria-label="步骤说明"
                      value={step.detail}
                      placeholder="为什么、改哪里、如何验收"
                      onChange={(event) => {
                        const steps = draftBrief.steps.map((entry, index) => (
                          index === stepIndex ? { ...entry, detail: event.target.value } : entry
                        ));
                        patchBrief({ steps });
                      }}
                    />
                  </li>
                ))}
              </ol>
            )}
          </div>
          <div className="plan-brief-side-by-side">
            <label>
              <span>风险</span>
              <textarea
                rows={3}
                value={draftBrief.risks.join('\n')}
                onChange={(event) => patchBrief({ risks: lines(event.target.value) })}
                placeholder="每行一条风险或 blast radius"
              />
            </label>
            <label>
              <span>未决问题</span>
              <textarea
                rows={3}
                value={draftBrief.openQuestions.join('\n')}
                onChange={(event) => patchBrief({ openQuestions: lines(event.target.value) })}
                placeholder="不阻塞开干、但宿主应知情的问题"
              />
            </label>
          </div>
        </section>

        <div className="plan-task-list">
          <h3 className="plan-task-list-title">Worker 任务（{draft.length}）</h3>
          {draft.map((task, taskIndex) => {
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
                </div>
                <label>
                  <span>标题</span>
                  <input value={task.title} onChange={(event) => patchTask(taskIndex, { title: event.target.value })} />
                </label>
                <label>
                  <span>Worker brief</span>
                  <textarea
                    rows={6}
                    value={task.prompt}
                    onChange={(event) => patchTask(taskIndex, { prompt: event.target.value })}
                    placeholder="目标、上下文、步骤、触及范围、验收标准"
                  />
                </label>

                <details className="plan-task-ops">
                  <summary>执行与权限配置（可选）</summary>
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
                  <small>
                    默认按近乎无限上限填写（不因返工次数暂停，与主进程一致）。
                    只有你主动收紧上限时，达到上限才会暂停并等你批准继续。
                  </small>
                </fieldset>

                <fieldset>
                  <legend>Workspace 与授权范围</legend>
                  <div className="plan-field-grid">
                    <label>
                      <span>Workspace 模式</span>
                      <select
                        value={task.workspaceMode}
                        onChange={(event) => {
                          const workspaceMode = event.target.value as NonNullable<
                            PlanMeetingTaskInput['workspaceMode']
                          >;
                          if (workspaceMode === 'read-only') {
                            patchTask(taskIndex, {
                              workspaceMode,
                              writePaths: [],
                              authorityRequest: {
                                ...authority,
                                writePaths: [],
                                toolKinds: Array.from(new Set([
                                  ...authority.toolKinds.filter((kind) => (
                                    !['write', 'command', 'bash', 'execute', 'exec', 'shell', 'terminal', 'network', 'fetch', 'web']
                                      .includes(kind.toLowerCase())
                                  )),
                                  'read',
                                ])),
                                commands: [],
                                networkHosts: [],
                                environmentKeys: [],
                              },
                            });
                            return;
                          }
                          const writePaths = authority.writePaths.length > 0
                            ? authority.writePaths
                            : (task.writePaths ?? []);
                          patchTask(taskIndex, {
                            workspaceMode,
                            writePaths,
                            authorityRequest: {
                              ...authority,
                              writePaths,
                              toolKinds: writePaths.length > 0
                                ? Array.from(new Set([...authority.toolKinds, 'read', 'write']))
                                : Array.from(new Set([...authority.toolKinds, 'read'])),
                            },
                          });
                        }}
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
                        onChange={(event) => {
                          const commands = lines(event.target.value)
                            .map((command) => command.split(/\s+/).filter(Boolean));
                          const withoutCommand = authority.toolKinds.filter((kind) => (
                            !['command', 'bash', 'execute', 'exec', 'shell', 'terminal']
                              .includes(kind.toLowerCase())
                          ));
                          patchTask(taskIndex, {
                            authorityRequest: {
                              ...authority,
                              commands,
                              toolKinds: commands.length > 0
                                ? Array.from(new Set([...withoutCommand, 'command']))
                                : withoutCommand,
                            },
                          });
                        }}
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
                        onChange={(event) => {
                          const networkHosts = lines(event.target.value);
                          const withoutNetwork = authority.toolKinds.filter((kind) => (
                            !['network', 'fetch', 'web'].includes(kind.toLowerCase())
                          ));
                          patchTask(taskIndex, {
                            authorityRequest: {
                              ...authority,
                              networkHosts,
                              toolKinds: networkHosts.length > 0
                                ? Array.from(new Set([...withoutNetwork, 'network']))
                                : withoutNetwork,
                            },
                          });
                        }}
                      />
                    </label>
                  </div>
                  <div className="plan-diff-note">
                    授权摘要：{authority.writePaths.length} 个写路径 · {authority.commands.length} 条命令 · {authority.networkHosts.length} 个网络主机。
                    命令、网络、凭据与破坏性操作始终需要高风险确认。
                  </div>
                </fieldset>
                </details>

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
                  <label className="plan-dependency-gate">
                    <span>下游启动门槛</span>
                    <select
                      value={task.dependencyGate ?? 'accepted'}
                      onChange={(event) => patchTask(taskIndex, {
                        dependencyGate: event.target.value === 'reviewed' ? 'reviewed' : 'accepted',
                      })}
                    >
                      <option value="accepted">进入 Meeting 分支后</option>
                      <option value="reviewed">验证与审查通过后即可</option>
                    </select>
                    <small>
                      {(task.dependencyGate ?? 'accepted') === 'reviewed'
                        ? '分析/只读任务默认此项：下游不必等进 Meeting 分支。'
                        : '写代码任务默认此项：下游等交付进入 Meeting 集成分支后再启动（通常 Coordinator 审查后自动集成，不一定要点验收）。'}
                    </small>
                  </label>
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
              const defaultBackendId = resolvePlanDefaultWorkerBackendId(backends);
              const defaultBackend = backends.find((backend) => backend.id === defaultBackendId)
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
              }, defaultBackendId)]);
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
