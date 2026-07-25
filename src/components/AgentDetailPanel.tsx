import { ExternalLink, FolderOpen, X } from 'lucide-react';
import type { HostGroupState, WorkerState } from '../lib/meeting-store';
import type { BackendInfo } from '../types';
import { BackendAvatar } from './BackendAvatar';

interface AgentDetailPanelProps {
  /** 解析后的展示对象：host tile 传 talker，worker tile 传 worker。 */
  worker: WorkerState | null;
  hostGroup: HostGroupState | null;
  backends: BackendInfo[];
  cwd: string | null;
  onClose: () => void;
  /** 打开员工编辑器窗口（P10，已有能力）。 */
  onOpenEditor?: (backendId: string, hostId: string) => void;
}

function iconIdForBackend(backendId?: string): string {
  switch (backendId) {
    case 'claude-code': return 'claude';
    case 'codex': return 'codex';
    case 'kimi': return 'kimi';
    case 'qoder': return 'qoder';
    default: return backendId ?? 'worker';
  }
}

const STATUS_TEXT: Record<string, string> = {
  idle: '空闲',
  pending: '排队中',
  running: '运行中',
  verifying: '验证中',
  reviewing: '审查中',
  'awaiting-acceptance': '待验收',
  reworking: '返工中',
  accepted: '已验收',
  done: '已完成',
  failed: '失败',
  interrupted: '已中断',
};

/**
 * P3 agent 详情面板（04 §9.5）：右侧滑出——头像/客户端/角色、当前任务、
 * 最近活动、产出文件；主按钮打开编辑器窗口深挖（P10），「跳转到对应客户端
 * 软件页面」（D6/M6-3）的 OS 级激活 IPC 尚未建设，标「开发中」。
 */
export function AgentDetailPanel({
  worker,
  hostGroup,
  backends,
  cwd,
  onClose,
  onOpenEditor,
}: AgentDetailPanelProps) {
  const backendId = worker?.backendId ?? hostGroup?.backendId ?? '';
  const hostId = worker?.hostId ?? hostGroup?.id ?? 'default';
  const backendLabel = backends.find((b) => b.id === backendId)?.displayName ?? backendId;
  const roleLabel = worker?.role === 'talker'
    ? (hostId === 'default' ? 'Host Agent · Coordinator' : 'Host Agent')
    : 'Worker';
  const name = worker?.title ?? hostGroup?.backendId ?? 'Agent';
  const recentActivity = (worker?.activity ?? []).slice(-5).reverse();
  const outputFiles = worker?.workReport?.files ?? [];

  return (
    <aside className="aha-agent-panel" role="complementary" aria-label="agent 详情">
      <header className="aha-agent-panel-head">
        <BackendAvatar iconId={iconIdForBackend(backendId)} size={36} />
        <div className="aha-agent-panel-id">
          <div className="aha-agent-panel-name">{name}</div>
          <div className="aha-agent-panel-sub">{backendLabel} · {roleLabel}</div>
        </div>
        <button type="button" className="aha-icon-btn" onClick={onClose} aria-label="关闭详情">
          <X size={16} />
        </button>
      </header>

      <section className="aha-agent-panel-section">
        <div className="aha-agent-panel-label">当前任务</div>
        {worker && worker.role === 'worker' ? (
          <div className="aha-agent-panel-task">
            <span className={`aha-status-dot ${worker.status === 'running' ? 'aha-status-dot-run' : 'aha-status-dot-idle'}`} />
            <span>{worker.title}</span>
            <span className="aha-agent-panel-status">{STATUS_TEXT[worker.status] ?? worker.status}</span>
          </div>
        ) : (
          <div className="aha-agent-panel-task">
            <span className="aha-status-dot aha-status-dot-run" />
            <span>{worker?.lastText ? '正在统筹任务' : '待命 — 按住说话给我派活'}</span>
          </div>
        )}
        {worker?.currentTool && (
          <div className="aha-agent-panel-tool aha-tnum">正在调用：{worker.currentTool}</div>
        )}
      </section>

      {recentActivity.length > 0 && (
        <section className="aha-agent-panel-section">
          <div className="aha-agent-panel-label">最近活动</div>
          <ul className="aha-agent-panel-activity">
            {recentActivity.map((a) => (
              <li key={a.id} title={a.title}>{a.title}</li>
            ))}
          </ul>
        </section>
      )}

      {outputFiles.length > 0 && (
        <section className="aha-agent-panel-section">
          <div className="aha-agent-panel-label">产出文件</div>
          <ul className="aha-agent-panel-files">
            {outputFiles.slice(0, 6).map((f) => (
              <li key={f.path}>
                <code className="aha-mono">{f.path.split('/').pop()}</code>
                <span className={`aha-agent-panel-file-action aha-file-${f.action}`}>
                  {f.action === 'created' ? '新建' : f.action === 'modified' ? '修改' : '删除'}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <footer className="aha-agent-panel-actions">
        {onOpenEditor && (
          <button
            type="button"
            className="aha-btn aha-btn-primary aha-agent-panel-main-btn"
            onClick={() => onOpenEditor(backendId, hostId)}
          >
            <ExternalLink size={14} /> 打开编辑器窗口
          </button>
        )}
        <button type="button" className="aha-btn aha-btn-ghost" disabled title="OS 级跳转到对应客户端软件页面（M6-3）">
          在 {backendLabel} 中打开 ↗ <span className="aha-dev-tag">开发中</span>
        </button>
        {cwd && (
          <button
            type="button"
            className="aha-btn aha-btn-ghost"
            onClick={() => { void window.vibeMeet.documents.openExternal(null, cwd); }}
          >
            <FolderOpen size={14} /> 在文件管理器中显示项目
          </button>
        )}
      </footer>
    </aside>
  );
}
