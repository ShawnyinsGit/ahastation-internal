import { memo, useMemo, useState } from 'react';
import { ChevronDown, ChevronUp, Crown, ExternalLink, MicOff, Plus, RotateCcw, Terminal, UserX } from 'lucide-react';
import type { HostGroupState, WorkerState } from '../lib/meeting-store';
import { BackendAvatar } from './BackendAvatar';
import { WorkerCard } from './WorkerCard';

interface ParticipantPanelProps {
  workers: WorkerState[];
  hostGroups: Map<string, HostGroupState>;
  /** Map of iconId → custom avatar data URL */
  customAvatars?: Map<string, string | null>;
  /** Set of muted host group IDs */
  mutedHostIds?: Set<string>;
  aiSpeaking: boolean;
  selfTile: React.ReactNode;
  onResolvePermission: (id: string, decision: 'allow' | 'deny', scope?: 'worker' | 'task-wide') => void;
  onOpenParticipantsTab?: () => void;
  onToggleMuteHost?: (hostId: string) => void;
  onRemoveHost?: (hostId: string) => void;
  coordinatorHostId?: string;
  onSetCoordinator?: (hostId: string) => void;
  onRestartHost?: (hostId: string) => void;
  /** Called when a gallery tile is clicked. 'user' for self tile, hostId for host tiles. */
  onSelectParticipant?: (id: string) => void;
  /** Called when the user clicks "详情" on a host tile to open the IDE editor. */
  onOpenEditor?: (backendId: string, hostId: string) => void;
  /** Open the high-fidelity CLI execution view for a worker or host talker. */
  onOpenTerminal?: (workerId: string) => void;
}

export const ParticipantPanel = memo(function ParticipantPanel({
  workers,
  hostGroups,
  customAvatars,
  mutedHostIds,
  aiSpeaking,
  selfTile,
  onResolvePermission,
  onOpenParticipantsTab,
  onToggleMuteHost,
  onRemoveHost,
  coordinatorHostId = 'default',
  onSetCoordinator,
  onRestartHost,
  onSelectParticipant,
  onOpenEditor,
  onOpenTerminal,
}: ParticipantPanelProps) {
  const [barCollapsed, setBarCollapsed] = useState(false);

  // Map hostId -> talker worker (if any)
  const hostTalkers = useMemo(() => {
    const map = new Map<string, WorkerState>();
    for (const w of workers) {
      if (w.role === 'talker') map.set(w.hostId || 'default', w);
    }
    return map;
  }, [workers]);

  // Map hostId -> all workers for that host (for fallback when no talker)
  const hostWorkers = useMemo(() => {
    const map = new Map<string, WorkerState[]>();
    for (const w of workers) {
      const hId = w.hostId || 'default';
      const arr = map.get(hId) ?? [];
      arr.push(w);
      map.set(hId, arr);
    }
    return map;
  }, [workers]);

  // Sort host groups: 'default' first, then alphabetically
  const sortedHostGroups = useMemo(() => {
    const entries = Array.from(hostGroups.entries());
    entries.sort(([a], [b]) => {
      if (a === 'default') return -1;
      if (b === 'default') return 1;
      return a.localeCompare(b);
    });
    return entries;
  }, [hostGroups]);
  const taskWorkers = useMemo(
    () => workers.filter((worker) => worker.role === 'worker'),
    [workers],
  );
  const titleByWorkerId = useMemo(
    () => new Map(taskWorkers.map((worker) => [worker.id, worker.title])),
    [taskWorkers],
  );
  const workerIconId = (backendId?: string): string => {
    switch (backendId) {
      case 'claude-code': return 'claude';
      case 'codex': return 'codex';
      case 'kimi': return 'kimi';
      case 'qoder': return 'qoder';
      default: return backendId ?? 'worker';
    }
  };

  return (
    <aside className="tiles-gallery">
      <div className={`tiles-gallery-scroll ${barCollapsed ? 'tiles-gallery-collapsed' : ''}`}>
        {/* Self tile */}
        <div
          className="tiles-gallery-self"
          onClick={() => onSelectParticipant?.('user')}
          role={onSelectParticipant ? 'button' : undefined}
          tabIndex={onSelectParticipant ? 0 : undefined}
          onKeyDown={(e) => {
            if (onSelectParticipant && (e.key === 'Enter' || e.key === ' ')) {
              e.preventDefault();
              onSelectParticipant('user');
            }
          }}
        >
          {selfTile}
        </div>

        {/* Host group tiles — show talker, or first worker, or a placeholder */}
        {sortedHostGroups.map(([hostId, hg]) => {
          const talker = hostTalkers.get(hostId);
          const avatar = customAvatars?.get(hg.iconId) ?? null;
          const isMuted = mutedHostIds?.has(hostId) ?? false;
          const isDefault = hostId === 'default';
          const isCoordinator = hostId === coordinatorHostId;
          const actions = (
            <div className="tiles-gallery-actions">
              {onOpenTerminal && (
                <button
                  type="button"
                  className="tiles-gallery-action-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    const talker = hostTalkers.get(hostId);
                    onOpenTerminal(talker?.id ?? hostId);
                  }}
                  title="查看真实 CLI 执行情况"
                  aria-label="Open CLI execution view"
                >
                  <Terminal size={12} />
                </button>
              )}
              {onOpenEditor && (
                <button
                  type="button"
                  className="tiles-gallery-action-btn"
                  onClick={(e) => { e.stopPropagation(); onOpenEditor(hg.backendId, hostId); }}
                  title="打开编辑器"
                  aria-label="Open editor"
                >
                  <ExternalLink size={12} />
                </button>
              )}
              {isCoordinator && (
                <span className="tiles-gallery-action-btn tiles-gallery-action-btn-active" title="当前主持人" aria-label="Current coordinator">
                  <Crown size={12} />
                </span>
              )}
              {!isCoordinator && onSetCoordinator && (hg.backendId === 'claude-code' || hg.backendId === 'codex') && (
                <button
                  type="button"
                  className="tiles-gallery-action-btn"
                  onClick={(e) => { e.stopPropagation(); onSetCoordinator(hostId); }}
                  title="设为主持人"
                  aria-label="Set as coordinator"
                >
                  <Crown size={12} />
                </button>
              )}
              {talker?.status === 'idle' && onRestartHost && (
                <button
                  type="button"
                  className="tiles-gallery-action-btn"
                  onClick={(e) => { e.stopPropagation(); onRestartHost(hostId); }}
                  title="重新连接"
                  aria-label="Reconnect host"
                >
                  <RotateCcw size={12} />
                </button>
              )}
              {onToggleMuteHost && (
                <button
                  type="button"
                  className={`tiles-gallery-action-btn ${isMuted ? 'tiles-gallery-action-btn-active' : ''}`}
                  onClick={(e) => { e.stopPropagation(); onToggleMuteHost(hostId); }}
                  title={isMuted ? '取消静音' : '静音'}
                  aria-label={isMuted ? 'Unmute host' : 'Mute host'}
                >
                  <MicOff size={12} />
                </button>
              )}
              {onRemoveHost && !isDefault && (
                <button
                  type="button"
                  className="tiles-gallery-action-btn tiles-gallery-action-btn-danger"
                  onClick={(e) => { e.stopPropagation(); onRemoveHost(hostId); }}
                  title="踢出"
                  aria-label="Remove host"
                >
                  <UserX size={12} />
                </button>
              )}
            </div>
          );
          if (talker) {
            return (
              <div key={hostId} className="tiles-gallery-tile-wrap">
                <WorkerCard
                  worker={talker}
                  depTitles={new Map()}
                  mode="gallery"
                  selected={false}
                  speaking={aiSpeaking && !isMuted}
                  onSelect={onSelectParticipant ? () => onSelectParticipant(hostId) : undefined}
                  onResolvePermission={onResolvePermission}
                  onOpenTerminal={onOpenTerminal ? () => onOpenTerminal(talker.id) : undefined}
                  iconId={hg.iconId}
                  customAvatar={avatar}
                />
                {actions}
              </div>
            );
          }
          // No talker — fall back to first worker of this host group
          const hw = hostWorkers.get(hostId);
          if (hw && hw.length > 0) {
            return (
              <div key={hostId} className="tiles-gallery-tile-wrap">
                <WorkerCard
                  worker={hw[0]}
                  depTitles={new Map()}
                  mode="gallery"
                  selected={false}
                  speaking={false}
                  onSelect={onSelectParticipant ? () => onSelectParticipant(hostId) : undefined}
                  onResolvePermission={onResolvePermission}
                  onOpenTerminal={onOpenTerminal ? () => onOpenTerminal(hw[0].id) : undefined}
                  iconId={hg.iconId}
                  customAvatar={avatar}
                />
                {actions}
              </div>
            );
          }
          // No workers yet — render placeholder "connecting" tile
          return (
            <div key={hostId} className="tiles-gallery-tile-wrap">
              <div
                className="tiles-gallery-placeholder"
                title={hg.backendId}
                onClick={() => onSelectParticipant?.(hostId)}
                role={onSelectParticipant ? 'button' : undefined}
                tabIndex={onSelectParticipant ? 0 : undefined}
              >
                <div className="tiles-gallery-placeholder-avatar">
                  <BackendAvatar iconId={hg.iconId} size={40} customAvatar={avatar} />
                </div>
                <div className="tiles-gallery-placeholder-label">{hg.backendId}</div>
                <div className="tiles-gallery-placeholder-status">Connecting…</div>
              </div>
              {actions}
            </div>
          );
        })}

        {taskWorkers.map((worker) => {
          const iconId = workerIconId(worker.backendId);
          return (
            <div key={worker.id} className="tiles-gallery-tile-wrap tiles-gallery-worker-wrap">
              <WorkerCard
                worker={worker}
                depTitles={titleByWorkerId}
                mode="gallery"
                selected={false}
                speaking={false}
                onSelect={onSelectParticipant ? () => onSelectParticipant(worker.id) : undefined}
                onResolvePermission={onResolvePermission}
                onOpenTerminal={onOpenTerminal ? () => onOpenTerminal(worker.id) : undefined}
                iconId={iconId}
                customAvatar={customAvatars?.get(iconId) ?? null}
              />
            </div>
          );
        })}

        {/* Invite button - opens participants tab */}
        {onOpenParticipantsTab && (
          <button
            type="button"
            className="tiles-gallery-invite-btn"
            onClick={onOpenParticipantsTab}
            title="邀请参会人"
          >
            <Plus size={20} />
          </button>
        )}
      </div>

      {/* Collapse button - bottom center */}
      <button
        type="button"
        className="tiles-gallery-collapse"
        onClick={() => setBarCollapsed((v) => !v)}
        aria-label={barCollapsed ? '展开参会人' : '收起参会人'}
        title={barCollapsed ? '展开参会人' : '收起参会人'}
      >
        {barCollapsed ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
      </button>
    </aside>
  );
});
