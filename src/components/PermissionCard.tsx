import type { PendingPermission } from '../types';

export function PermissionCard({
  pending,
  onDecide,
}: {
  pending: PendingPermission;
  onDecide: (id: string, decision: 'allow' | 'deny') => void;
}) {
  return (
    <div className="perm-card" role="group" aria-label={`高风险权限请求：${pending.toolName}`}>
      <div className="perm-head">
        <span className="perm-icon" aria-hidden>⚡</span>
        <span>
          <small>High-risk approval</small>
          Worker 请求使用 <b>{pending.toolName}</b>
        </span>
      </div>
      <p className="perm-explainer">
        高风险操作不会被 Coordinator 自动批准。确认对象仅限当前请求，不会扩大任务授权。
      </p>
      <pre className="perm-input">{JSON.stringify(pending.input, null, 2)}</pre>
      <div className="perm-actions">
        <button className="perm-btn perm-deny" onClick={() => onDecide(pending.id, 'deny')}>拒绝</button>
        <button className="perm-btn perm-allow" onClick={() => onDecide(pending.id, 'allow')}>仅本次允许</button>
      </div>
    </div>
  );
}
