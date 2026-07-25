import { useEffect, useState } from 'react';
import { AlertTriangle, Bell, RotateCcw, Terminal } from 'lucide-react';
import type { WorkerState } from '../lib/meeting-store';
import { BackendAvatar } from './BackendAvatar';

interface WorkerCardProps {
  worker: WorkerState;
  depTitles?: Map<string, string>;
  mode: 'gallery' | 'sidebar';
  selected?: boolean;
  speaking?: boolean;
  onSelect?: () => void;
  onResolvePermission: (id: string, decision: 'allow' | 'deny') => void;
  /** Open the high-fidelity CLI execution view for this worker. */
  onOpenTerminal?: () => void;
  /** Backend icon identifier for per-backend avatar rendering. */
  iconId?: string;
  /** Custom avatar image URL (overrides iconId). */
  customAvatar?: string | null;
}

const statusTone: Record<WorkerState['status'], 'idle' | 'waiting' | 'working' | 'done' | 'failed'> = {
  idle: 'idle',
  pending: 'waiting',
  interrupted: 'waiting',
  running: 'working',
  verifying: 'working',
  reviewing: 'working',
  'awaiting-acceptance': 'waiting',
  'integration-queued': 'waiting',
  integrating: 'working',
  'integration-conflict': 'failed',
  reworking: 'working',
  'budget-paused': 'waiting',
  accepted: 'done',
  done: 'done',
  failed: 'failed',
};

function avatarInitial(title: string): string {
  const trim = title.trim();
  if (!trim) return '?';
  return trim.slice(0, 1).toUpperCase();
}

function formatUpdateTime(timestamp: number): string {
  if (!timestamp) return '尚无活动';
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(timestamp);
}

/** Human-readable status label shown below the avatar. */
function statusLabel(worker: WorkerState, speaking: boolean): string {
  if (speaking) return '发言中';
  if (worker.pendingPermission) return '等待权限';
  if (worker.currentTool) return '执行中';
  switch (worker.status) {
    case 'running': return '执行中';
    case 'verifying': return '校验中';
    case 'reviewing': return '评审中';
    case 'awaiting-acceptance': return '等待验收';
    case 'integration-queued': return '等待集成';
    case 'integrating': return '集成中';
    case 'integration-conflict': return '集成冲突';
    case 'reworking': return '需要返工';
    case 'budget-paused': return '预算暂停';
    case 'accepted': return '已接受';
    case 'pending': return '等待调度';
    case 'interrupted': return '已中断';
    case 'done':    return '已完成';
    case 'failed':  return '失败';
    default:        return '空闲';
  }
}

const PULSE_MS = 600;

export function WorkerCard({
  worker,
  mode,
  selected,
  speaking,
  onSelect,
  onResolvePermission,
  onOpenTerminal,
  iconId,
  customAvatar,
}: WorkerCardProps) {
  const isTalker = worker.role === 'talker';
  const tone = statusTone[worker.status];

  const [pulse, setPulse] = useState(false);
  const lastTs = worker.activity.length > 0 ? worker.activity[worker.activity.length - 1].ts : 0;
  useEffect(() => {
    if (!lastTs) return;
    setPulse(true);
    const t = setTimeout(() => setPulse(false), PULSE_MS);
    return () => clearTimeout(t);
  }, [lastTs]);

  const avatarSize = mode === 'gallery' ? 56 : 32;
  const avatar = iconId ? (
    <BackendAvatar iconId={iconId} size={avatarSize} speaking={Boolean(speaking)} customAvatar={customAvatar} />
  ) : isTalker ? (
    <BackendAvatar iconId="claude" size={avatarSize} speaking={Boolean(speaking)} customAvatar={customAvatar} />
  ) : (
    <span className="worker-card-initial">{avatarInitial(worker.title)}</span>
  );
  const latestActivity = worker.activity.at(-1);
  const updateTimestamp = latestActivity?.ts ?? worker.endedAt ?? worker.startedAt ?? 0;
  const currentStep = worker.currentTool
    ? `工具：${worker.currentTool}`
    : worker.lastText || latestActivity?.title || '等待下一步';
  const reportBlocked = worker.workReport?.status === 'blocked';

  const className = [
    'worker-card',
    `worker-card-${mode}`,
    `worker-card-${tone}`,
    selected ? 'worker-card-selected' : '',
    pulse || speaking ? 'worker-card-pulse' : '',
  ]
    .filter(Boolean)
    .join(' ');

  if (mode === 'gallery') {
    const label = statusLabel(worker, Boolean(speaking));
    const roleName = isTalker ? 'Talker' : 'Worker';

    return (
      <div className={className} role="group" aria-label={`${worker.title}，${label}`}>
        {/* Role badge — top-right */}
        <div className="tile-role-badge">{roleName}</div>
        {onOpenTerminal && (
          <button
            type="button"
            className="worker-card-terminal-btn"
            onClick={(e) => { e.stopPropagation(); onOpenTerminal(); }}
            title="查看真实 CLI 执行情况"
            aria-label="打开 CLI 执行视图"
          >
            <Terminal size={12} />
          </button>
        )}

        <button
          type="button"
          className="worker-card-select-surface"
          onClick={onSelect}
          disabled={!onSelect}
          aria-label={`查看任务：${worker.title}`}
        >
          <div className={`worker-card-stage worker-card-stage-centered ${isTalker ? 'worker-card-stage-talker' : 'worker-card-stage-worker'}`}>
            <div className={`worker-card-avatar worker-card-avatar-${isTalker ? 'talker' : 'worker'}`}>
              {avatar}
            </div>
            {/* Status below avatar */}
            <div className="worker-card-status-badge">
              <span className={`worker-card-pill worker-card-pill-${tone}`}>{label}</span>
              {worker.pendingPermission && (
                <span className="worker-card-icon worker-card-icon-perm" title="等待权限" aria-label="等待权限">
                  <Bell size={11} />
                </span>
              )}
            </div>
          </div>

          {!isTalker && (
            <div className="worker-card-gallery-detail">
              <div className="worker-card-gallery-title" title={worker.title}>{worker.title}</div>
              <div className="worker-card-gallery-step" title={currentStep}>{currentStep}</div>
              <div className="worker-card-gallery-meta">
                <span>attempt {worker.attempt ?? 1}</span>
                <time dateTime={updateTimestamp ? new Date(updateTimestamp).toISOString() : undefined}>
                  {formatUpdateTime(updateTimestamp)}
                </time>
              </div>
              <div className="worker-card-gallery-flags" aria-label="任务提示">
                {worker.pendingPermission && <span className="is-permission"><Bell size={11} />等待权限</span>}
                {worker.status === 'reworking' && <span className="is-rework"><RotateCcw size={11} />返工</span>}
                {reportBlocked && <span className="is-blocked"><AlertTriangle size={11} />阻塞</span>}
                {worker.status === 'failed' && <span className="is-failed"><AlertTriangle size={11} />失败</span>}
              </div>
            </div>
          )}
        </button>

        {/* Permission approval inline */}
        {worker.pendingPermission && (
          <div className="worker-card-perm">
            <div className="worker-card-perm-text">
              是否允许 <span className="worker-card-perm-tool">{worker.pendingPermission.toolName}</span>？
            </div>
            {worker.permissionError && (
              <div className="worker-card-perm-error" role="alert">{worker.permissionError}</div>
            )}
            <div className="worker-card-perm-actions">
              <button type="button" className="worker-card-perm-allow"
                disabled={worker.resolvingPermissionId === worker.pendingPermission.id}
                onClick={(e) => { e.stopPropagation(); if (worker.pendingPermission) onResolvePermission(worker.pendingPermission.id, 'allow'); }}
              >允许</button>
              <button type="button" className="worker-card-perm-deny"
                disabled={worker.resolvingPermissionId === worker.pendingPermission.id}
                onClick={(e) => { e.stopPropagation(); if (worker.pendingPermission) onResolvePermission(worker.pendingPermission.id, 'deny'); }}
              >拒绝</button>
            </div>
          </div>
        )}
      </div>
    );
  }

  // sidebar mode — horizontal layout
  return (
    <div className={className} role="group" aria-label={`${worker.title}，${statusLabel(worker, Boolean(speaking))}`}>
      <button
        type="button"
        className="worker-card-select-surface worker-card-select-surface-sidebar"
        onClick={onSelect}
        disabled={!onSelect}
        aria-label={`查看任务：${worker.title}`}
      >
        <div className="worker-card-header">
          <div className={`worker-card-avatar worker-card-avatar-${isTalker ? 'talker' : 'worker'}`}>
            {avatar}
          </div>
          <div className="worker-card-titleblock">
            <div className="worker-card-title" title={worker.title}>{worker.title}</div>
            <div className="worker-card-meta">
              <span className={`worker-card-pill worker-card-pill-${tone}`}>{statusLabel(worker, Boolean(speaking))}</span>
              {worker.pendingPermission && (
                <span className="worker-card-icon worker-card-icon-perm" title="等待权限" aria-label="等待权限">
                  <Bell size={12} />
                </span>
              )}
            </div>
          </div>
        </div>
      </button>

      {worker.pendingPermission && (
        <div className="worker-card-perm">
          <div className="worker-card-perm-text">
            是否允许 <span className="worker-card-perm-tool">{worker.pendingPermission.toolName}</span>？
          </div>
          {worker.permissionError && (
            <div className="worker-card-perm-error" role="alert">{worker.permissionError}</div>
          )}
          <div className="worker-card-perm-actions">
            <button type="button" className="worker-card-perm-allow"
              disabled={worker.resolvingPermissionId === worker.pendingPermission.id}
              onClick={(e) => { e.stopPropagation(); if (worker.pendingPermission) onResolvePermission(worker.pendingPermission.id, 'allow'); }}
            >允许</button>
            <button type="button" className="worker-card-perm-deny"
              disabled={worker.resolvingPermissionId === worker.pendingPermission.id}
              onClick={(e) => { e.stopPropagation(); if (worker.pendingPermission) onResolvePermission(worker.pendingPermission.id, 'deny'); }}
            >拒绝</button>
          </div>
        </div>
      )}
    </div>
  );
}
