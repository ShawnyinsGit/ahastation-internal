import { useState } from 'react';
import type { PendingPermission } from '../types';

type DecideResult = Promise<{ ok: true } | { ok: false; error: string }> | void;

export function PermissionCard({
  pending,
  onDecide,
  resolving,
  error,
}: {
  pending: PendingPermission;
  /** Resolves a permission request. May return a result object so the card can
   *  await it, keep its buttons disabled until the reply lands, and surface an
   *  error without the caller having to thread state down. */
  onDecide: (id: string, decision: 'allow' | 'deny') => DecideResult;
  /** Optional external resolving flag (e.g. from the store). When set, the
   *  card stays disabled even before onDecide's promise settles. */
  resolving?: boolean;
  /** Optional external error (e.g. from the store) shown alongside local ones. */
  error?: string | null;
}) {
  const [localPending, setLocalPending] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const busy = localPending || Boolean(resolving);
  const shownError = error ?? localError;

  async function handle(decision: 'allow' | 'deny') {
    if (busy) return;
    setLocalPending(true);
    setLocalError(null);
    try {
      const res = await onDecide(pending.id, decision);
      if (res && !res.ok) setLocalError(res.error);
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : String(err));
    } finally {
      setLocalPending(false);
    }
  }

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
      {shownError && (
        <p className="perm-error" role="alert">{shownError}</p>
      )}
      <div className="perm-actions">
        <button type="button" className="perm-btn perm-deny" disabled={busy}
          onClick={() => handle('deny')}>拒绝</button>
        <button type="button" className="perm-btn perm-allow" disabled={busy}
          onClick={() => handle('allow')}>{busy ? '处理中…' : '仅本次允许'}</button>
      </div>
    </div>
  );
}
