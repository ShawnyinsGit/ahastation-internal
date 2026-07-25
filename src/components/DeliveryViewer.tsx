import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { WorkerDeliveryFile } from '../types';
import type { DeliverySnapshot } from '../lib/meeting-store';
import { FileContent, ViewState, basename } from './FileViewer';
import { useAutoScroll } from '../hooks/useAutoScroll';

interface DeliveryViewerProps {
  delivery: DeliverySnapshot;
  sessionId: string | null;
  aiSpeaking: boolean;
  onAccept: () => Promise<{ ok: true } | { ok: false; error: string }>;
  onRevise: (feedback: string) => Promise<
    | { ok: true; route: 'worker' | 'talker'; queued?: boolean }
    | { ok: false; error: string }
  >;
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}

function previewStatusLabel(status: NonNullable<WorkerDeliveryFile['previewStatus']>): string {
  const labels = {
    copied: '已快照',
    'too-large': '文件过大，未生成预览',
    missing: '文件不存在',
    invalid: '不是可预览文件',
    'copy-failed': '快照失败',
  } satisfies Record<NonNullable<WorkerDeliveryFile['previewStatus']>, string>;
  return labels[status];
}

export function DeliveryViewer({
  delivery,
  sessionId,
  aiSpeaking,
  onAccept,
  onRevise,
}: DeliveryViewerProps) {
  const files = delivery.files;
  const [activePath, setActivePath] = useState<string>(
    files[0]?.snapshotPath ?? files[0]?.snapshotRelativePath ?? files[0]?.path ?? '',
  );
  const [state, setState] = useState<ViewState>({ phase: 'loading' });
  const [feedback, setFeedback] = useState('');
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'summary' | 'files' | 'tests' | 'verification' | 'history'>('summary');
  const loadTokenRef = useRef(0);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const { onUserScroll, scrolling } = useAutoScroll({
    scrollRef,
    active: aiSpeaking,
  });

  useEffect(() => {
    const first = files[0]?.snapshotPath ?? files[0]?.snapshotRelativePath ?? files[0]?.path ?? '';
    setActivePath(first);
    setFeedback('');
    // Never auto-open the rework box — Accept must stay the obvious path.
    setFeedbackOpen(false);
    setToast(null);
    setActiveTab(
      delivery.status === 'reworking' || delivery.status === 'coordinator-reviewing'
        ? 'verification'
        : 'summary',
    );
  }, [delivery.taskId, delivery.status, files]);

  useEffect(() => {
    if (!activePath || !sessionId) {
      setState({ phase: 'error', message: '没有可预览的文件' });
      return;
    }
    const token = ++loadTokenRef.current;
    setState({ phase: 'loading' });
    void window.vibeMeet.documents
      .read(sessionId, activePath)
      .then((res) => {
        if (token !== loadTokenRef.current) return;
        if (!res.ok) {
          setState({ phase: 'error', message: res.error });
          return;
        }
        setState({ phase: 'ready', doc: res });
      })
      .catch((err: unknown) => {
        if (token !== loadTokenRef.current) return;
        setState({
          phase: 'error',
          message: err instanceof Error ? err.message : 'Read failed',
        });
      });
  }, [activePath, sessionId]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [activePath, state.phase]);

  const canAccept = delivery.status === 'awaiting-delivery-acceptance'
    || (delivery.status === 'reworking' && Boolean(delivery.report));

  const handleAccept = useCallback(async () => {
    if (submitting || !canAccept) return;
    setSubmitting(true);
    setToast(null);
    try {
      const result = await onAccept();
      if (!result.ok) setToast(`验收失败：${result.error}`);
    } finally {
      setSubmitting(false);
    }
  }, [canAccept, onAccept, submitting]);

  const handleSubmitFeedback = useCallback(async () => {
    const trimmed = feedback.trim();
    if (!trimmed || submitting) return;
    setSubmitting(true);
    setToast(null);
    try {
      const res = await onRevise(trimmed);
      if (res.ok) {
        setToast(
          res.route === 'worker'
            ? '修改意见已直接发回该 worker。'
            : '该 worker 已收尾，修改意见已交给 talker 重新派活。',
        );
        setFeedback('');
        setFeedbackOpen(false);
      } else {
        setToast(`发送失败：${res.error}`);
      }
    } finally {
      setSubmitting(false);
    }
  }, [feedback, onRevise, submitting]);

  const headerMeta = useMemo(() => {
    return `${files.length} 个交付物 · 第 ${delivery.attempt} 次执行 · ${delivery.workerId}`;
  }, [delivery.attempt, files.length, delivery.workerId]);

  const activeFileName = basename(activePath);
  const report = delivery.report;
  const attempts = delivery.view?.attempts ?? [];
  const statusLabel: Record<string, string> = {
    verifying: '正在校验',
    reviewing: '正在评审',
    'coordinator-reviewing': 'Coordinator 审查中',
    'awaiting-delivery-acceptance': '等待验收',
    'integration-queued': '等待自动集成',
    integrating: '正在集成到 Meeting 分支',
    'integration-conflict': '集成冲突',
    reworking: '需要返工',
    accepted: '已接受',
    failed: '失败',
  };
  const canReturn = delivery.status === 'awaiting-delivery-acceptance'
    || delivery.status === 'reworking';
  const tabs = [
    ['summary', '摘要'],
    ['files', `文件 ${report?.files.length ?? files.length}`],
    ['tests', `测试 ${report?.tests.length ?? 0}`],
    ['verification', '校验'],
    ['history', `历史 ${attempts.length}`],
  ] as const;

  return (
    <div className="delivery-viewer">
      <header className="delivery-viewer-header">
        <div className="delivery-viewer-title">
          <span className="delivery-viewer-badge">交付验收</span>
          <h2>{delivery.title}</h2>
        </div>
        <div className="delivery-viewer-meta">
          <span className={`delivery-status-pill is-${delivery.status}`}>
            {statusLabel[delivery.status] ?? delivery.status}
          </span>
          {headerMeta}
        </div>
        {delivery.summary && (
          <p className="delivery-viewer-summary">{delivery.summary}</p>
        )}
      </header>

      <div className="delivery-viewer-tabs" role="tablist" aria-label="交付详情">
        {tabs.map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={activeTab === id}
            className={activeTab === id ? 'is-active' : ''}
            onClick={() => setActiveTab(id)}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="delivery-viewer-body" role="tabpanel">
        {activeTab === 'summary' && (
          <section className="delivery-evidence-panel">
            <h3>WorkReport</h3>
            <p>{report?.summary || delivery.summary || 'Worker 未提供摘要。'}</p>
            <dl className="delivery-summary-grid">
              <div><dt>报告状态</dt><dd>{report?.status ?? '等待报告'}</dd></div>
              <div><dt>文件</dt><dd>{report?.files.length ?? 0}</dd></div>
              <div><dt>测试</dt><dd>{report?.tests.length ?? 0}</dd></div>
              <div><dt>未解决项</dt><dd>{report?.unresolved.length ?? 0}</dd></div>
            </dl>
            {(report?.unresolved.length ?? 0) > 0 && (
              <>
                <h3>未解决项</h3>
                <ul className="delivery-evidence-list">
                  {report!.unresolved.map((item) => (
                    <li key={`${item.code}:${item.message}`}>
                      <strong>{item.blocking ? '阻塞' : '风险'} · {item.code}</strong>
                      <span>{item.message}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
            {delivery.error && (
              <div className="delivery-risk-note" role="alert">
                <strong>当前结论</strong>
                <span>{delivery.error}</span>
              </div>
            )}
          </section>
        )}

        {activeTab === 'files' && (
          <>
            <aside className="delivery-viewer-sidebar">
              {files.length === 0 ? (
                <div className="delivery-viewer-sidebar-empty">
                  这一轮没有可预览文件。
                </div>
              ) : (
                <ul className="delivery-viewer-file-list">
                  {files.map((f: WorkerDeliveryFile) => {
                    const filePath = f.snapshotPath ?? f.snapshotRelativePath ?? f.path;
                    const isActive = filePath === activePath;
                    const action = report?.files.find((item) => item.path === f.path)?.action;
                    return (
                      <li key={filePath}>
                        <button
                          type="button"
                          className={`delivery-viewer-file${isActive ? ' is-active' : ''}`}
                          onClick={() => { setActivePath(filePath); }}
                          title={f.path}
                        >
                          <span className="delivery-viewer-file-name">
                            {basename(f.path)}
                            {action && <small>{action}</small>}
                          </span>
                          <span className="delivery-viewer-file-path">
                            {f.snapshotPath ?? f.snapshotRelativePath ?? f.path}
                          </span>
                          <span className="delivery-viewer-file-evidence">
                            {typeof f.sizeBytes === 'number' ? `${formatBytes(f.sizeBytes)} · ` : ''}
                            {f.sha256 ? `SHA-256 ${f.sha256.slice(0, 12)}…` : '无校验值'}
                            {f.previewStatus && f.previewStatus !== 'copied' ? ` · ${previewStatusLabel(f.previewStatus)}` : ''}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </aside>

            <section
              className={`delivery-viewer-content${scrolling ? ' auto-scrolling' : ''}`}
              ref={scrollRef}
              onWheel={onUserScroll}
              onTouchStart={onUserScroll}
            >
              <FileContent state={state} fileName={activeFileName} />
              {activePath && (
                <button
                  type="button"
                  className="delivery-open-external"
                  onClick={() => {
                    const original = files.find(
                      (file) => (file.snapshotPath ?? file.snapshotRelativePath ?? file.path) === activePath,
                    );
                    void window.vibeMeet.documents.openExternal(
                      sessionId,
                      original?.snapshotPath ?? original?.path ?? activePath,
                    );
                  }}
                >
                  使用外部应用打开
                </button>
              )}
            </section>
          </>
        )}

        {activeTab === 'tests' && (
          <section className="delivery-evidence-panel">
            <h3>Worker 测试证据</h3>
            {(report?.tests.length ?? 0) === 0 ? (
              <p className="delivery-empty-copy">没有测试记录；人工验收不会伪装成自动测试。</p>
            ) : (
              <ul className="delivery-evidence-list">
                {report!.tests.map((test, index) => (
                  <li key={`${test.command}:${index}`} className={`is-${test.status}`}>
                    <strong>{test.status === 'passed' ? '通过' : test.status === 'failed' ? '失败' : '未运行'}</strong>
                    <code>{test.command}</code>
                    {test.summary && <span>{test.summary}</span>}
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}

        {activeTab === 'verification' && (
          <section className="delivery-evidence-panel">
            <h3>DeliveryHarness 校验</h3>
            {delivery.status === 'verifying' && <p className="delivery-live-state" aria-live="polite">正在逐项运行验收条件…</p>}
            {delivery.status === 'reviewing' && <p className="delivery-live-state" aria-live="polite">校验通过，正在进行独立评审…</p>}
            {delivery.status === 'coordinator-reviewing' && (
              <p className="delivery-live-state" aria-live="polite">Coordinator 正在审查冻结候选…</p>
            )}
            {delivery.verification ? (
              <>
                <div className={`delivery-verdict is-${delivery.verification.passed ? 'passed' : 'failed'}`}>
                  {delivery.verification.passed ? '校验通过' : '校验未通过'}
                </div>
                <ol className="delivery-check-list">
                  {delivery.verification.checks.map((check, index) => (
                    <li key={index}><pre>{JSON.stringify(check, null, 2)}</pre></li>
                  ))}
                </ol>
              </>
            ) : delivery.status !== 'verifying' && (
              <p className="delivery-empty-copy">尚无校验证据。</p>
            )}
            {delivery.review && (
              <>
                <h3>独立评审</h3>
                <div className={`delivery-verdict is-${delivery.review.passed ? 'passed' : 'failed'}`}>
                  {delivery.review.passed ? '评审通过' : '评审未通过'}
                </div>
                <ol className="delivery-check-list">
                  {delivery.review.findings.map((finding, index) => (
                    <li key={index}><pre>{JSON.stringify(finding, null, 2)}</pre></li>
                  ))}
                </ol>
              </>
            )}
            {delivery.error && <div className="delivery-risk-note" role="alert">{delivery.error}</div>}
          </section>
        )}

        {activeTab === 'history' && (
          <section className="delivery-evidence-panel">
            <h3>执行历史</h3>
            {attempts.length === 0 ? (
              <p className="delivery-empty-copy">第一份 WorkReport 尚未提交。</p>
            ) : (
              <ol className="delivery-attempt-list">
                {[...attempts].reverse().map((attempt) => (
                  <li key={attempt.attempt}>
                    <div><strong>Attempt {attempt.attempt}</strong><span>{attempt.outcome}</span></div>
                    <p>{attempt.report.summary}</p>
                    {attempt.feedback && <blockquote>返工反馈：{attempt.feedback}</blockquote>}
                  </li>
                ))}
              </ol>
            )}
          </section>
        )}
      </div>

      <footer className="delivery-viewer-footer">
        {toast && <div className="delivery-viewer-toast">{toast}</div>}
        {!feedbackOpen && canReturn ? (
          <div className="delivery-viewer-actions">
            <button
              type="button"
              className="delivery-viewer-btn delivery-viewer-btn-secondary"
              onClick={() => setFeedbackOpen(true)}
              disabled={submitting || !canReturn}
            >
              还要继续改
            </button>
            <button
              type="button"
              className="delivery-viewer-btn delivery-viewer-btn-primary"
              onClick={() => { void handleAccept(); }}
              disabled={submitting || !canAccept}
            >
              {submitting
                ? '处理中…'
                : delivery.status === 'reworking'
                  ? '接受当前报告'
                  : '通过 · 验收'}
            </button>
          </div>
        ) : feedbackOpen ? (
          <div className="delivery-viewer-feedback">
            <textarea
              className="delivery-viewer-feedback-input"
              placeholder="说明哪里不对、希望怎么改。若已满意，直接点「通过 · 验收」。"
              rows={3}
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
              disabled={submitting}
              autoFocus
            />
            <div className="delivery-viewer-actions">
              <button
                type="button"
                className="delivery-viewer-btn delivery-viewer-btn-secondary"
                onClick={() => {
                  setFeedbackOpen(false);
                  setFeedback('');
                }}
                disabled={submitting}
              >
                取消
              </button>
              {canAccept && (
                <button
                  type="button"
                  className="delivery-viewer-btn delivery-viewer-btn-secondary"
                  onClick={() => { void handleAccept(); }}
                  disabled={submitting}
                >
                  通过 · 验收
                </button>
              )}
              <button
                type="button"
                className="delivery-viewer-btn delivery-viewer-btn-primary"
                onClick={handleSubmitFeedback}
                disabled={submitting || feedback.trim().length === 0}
              >
                {submitting ? '发送中…' : '把意见发回去'}
              </button>
            </div>
          </div>
        ) : (
          <div className="delivery-viewer-actions" role="status">
            <span className="delivery-viewer-toast">
              {delivery.status === 'accepted'
                ? 'Coordinator 已审查并自动集成到 Meeting 分支。'
                : delivery.status === 'integration-conflict'
                  ? '自动集成发生冲突，任务将按证据返工；不会修改用户主分支。'
                  : delivery.status === 'coordinator-reviewing'
                    ? 'Coordinator 审查中，完成后会进入自动集成。'
                    : 'Coordinator 正在审查或集成；单任务无需用户验收。'}
            </span>
          </div>
        )}
      </footer>
    </div>
  );
}
