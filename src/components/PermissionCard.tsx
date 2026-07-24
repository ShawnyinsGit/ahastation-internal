import type { PendingPermission } from '../types';

export function PermissionCard({
  pending,
  onDecide,
}: {
  pending: PendingPermission;
  onDecide: (id: string, decision: 'allow' | 'deny') => void;
}) {
  return (
    <div className="perm-card">
      <div className="perm-head">
        <span className="perm-icon">⚡</span>
        <span>Worker 请求使用 <b>{pending.toolName}</b></span>
      </div>
      <pre className="perm-input">{JSON.stringify(pending.input, null, 2)}</pre>
      <div className="perm-actions">
        <button className="perm-btn perm-deny" onClick={() => onDecide(pending.id, 'deny')}>拒绝</button>
        <button className="perm-btn perm-allow" onClick={() => onDecide(pending.id, 'allow')}>仅本次允许</button>
      </div>
    </div>
  );
}
