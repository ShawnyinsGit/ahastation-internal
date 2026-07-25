import { useState } from 'react';
import { VolumeX, X } from 'lucide-react';
import type { CoordinatorBriefing } from '../types';

interface BroadcastStripProps {
  briefings: CoordinatorBriefing[];
  /** 静音/打断播报（打断 TTS）。 */
  onInterrupt?: () => void;
}

const KIND_ICON: Record<CoordinatorBriefing['kind'], string> = {
  'delivery-ready': '📦',
  accepted: '✅',
  failed: '⚠️',
  stalled: '🐢',
  capacity: '◷',
  'workspace-blocked': '🔒',
};

/**
 * Host 播报条（04 §9.3）：会议模式顶部展示 Host Agent 最新进展汇报，
 * 可打断（TTS）、可关闭。数据来自现有 coordinatorBriefings。
 */
export function BroadcastStrip({ briefings, onInterrupt }: BroadcastStripProps) {
  const [dismissedId, setDismissedId] = useState<string | null>(null);
  const latest = briefings.length > 0 ? briefings[briefings.length - 1] : null;

  if (!latest || latest.id === dismissedId) return null;

  return (
    <div className="aha-broadcast" role="status">
      <span className="aha-broadcast-icon" aria-hidden>{KIND_ICON[latest.kind]}</span>
      <span className="aha-broadcast-label">Host 播报</span>
      <span className="aha-broadcast-text" title={latest.summary}>
        <b>{latest.title}</b>
        {latest.summary && latest.summary !== latest.title ? ` — ${latest.summary}` : ''}
      </span>
      {(latest.completedTasks > 0 || latest.failedTasks > 0) && (
        <span className="aha-broadcast-stats aha-tnum">
          完成 {latest.completedTasks}{latest.failedTasks > 0 ? ` · 失败 ${latest.failedTasks}` : ''}
        </span>
      )}
      {onInterrupt && (
        <button type="button" className="aha-broadcast-btn" onClick={onInterrupt} title="打断播报" aria-label="打断播报">
          <VolumeX size={13} />
        </button>
      )}
      <button
        type="button"
        className="aha-broadcast-btn"
        onClick={() => setDismissedId(latest.id)}
        title="关闭播报条"
        aria-label="关闭播报条"
      >
        <X size={13} />
      </button>
    </div>
  );
}
