import type { ReactNode } from 'react';
import { useState } from 'react';
import {
  Mic,
  MicOff,
  AudioLines,
  RefreshCw,
  Volume2,
  VolumeX,
  Monitor,
  MonitorUp,
  Camera,
  Square,
  MessageSquare,
  MoreHorizontal,
  ShieldAlert,
  Gamepad2,
  X,
} from 'lucide-react';
import type { MicrophoneCaptureStatus } from '../lib/microphone-ui-state';

interface BottomToolbarProps {
  muted: boolean;
  onToggleMute: () => void;
  micSupported: boolean;
  listening: boolean;
  speechLevel?: number;
  asrMode?: 'xfyun' | 'probing' | 'unavailable';
  micStatus: MicrophoneCaptureStatus;
  micRetryable: boolean;
  onRetryMic: () => void;
  ttsOn: boolean;
  onToggleTts: () => void;
  sharing: boolean;
  onToggleShare: () => void;
  snapshotEnabled: boolean;
  onSnapshot: () => void;
  onInterrupt: () => void;
  chatOpen: boolean;
  onToggleChat: () => void;
  onLeave: () => void;
  /** Toggle the floating companion window (Phase 8). */
  onToggleCompanion: () => void;
  /** 会议控制组（多 Agent / 自动批准档位），渲染在桌面版第三组开头。 */
  controlsSlot?: ReactNode;
  /** Handheld mode (§3.3): fixed 5 keys + 更多 menu + permission badge. */
  handheld?: boolean;
  /** Pending permission requests — badge count in handheld mode. */
  permissionCount?: number;
  /** Opens the permission approval modal (handheld mode). */
  onOpenPermission?: () => void;
}

interface ToolbarButtonProps {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  active?: boolean;
  danger?: boolean;
  disabled?: boolean;
  warning?: boolean;
  title?: string;
}

const ICON_SIZE = 20;

function ToolbarButton({ icon, label, onClick, active, danger, disabled, warning, title }: ToolbarButtonProps) {
  const cls = [
    'tb-btn',
    active && 'tb-btn-active',
    danger && 'tb-btn-danger',
    warning && 'tb-btn-warn',
    disabled && 'tb-btn-disabled',
  ].filter(Boolean).join(' ');
  return (
    <button className={cls} onClick={onClick} disabled={disabled} title={title}>
      <span className="tb-btn-icon" aria-hidden="true">{icon}</span>
      <span className="tb-btn-label">{label}</span>
    </button>
  );
}

export function BottomToolbar({
  muted,
  onToggleMute,
  micSupported,
  listening,
  speechLevel = 0,
  asrMode = 'probing',
  micStatus,
  micRetryable,
  onRetryMic,
  ttsOn,
  onToggleTts,
  sharing,
  onToggleShare,
  snapshotEnabled,
  onSnapshot,
  onInterrupt,
  chatOpen,
  onToggleChat,
  onLeave,
  onToggleCompanion,
  /** 会议控制组（多 Agent / 自动批准档位），渲染在桌面版第三组开头。 */
  controlsSlot,
  handheld = false,
  permissionCount = 0,
  onOpenPermission,
}: BottomToolbarProps) {
  const meterWidth = Math.max(0, Math.min(1, speechLevel)) * 100;
  const asrBadge = asrMode === 'xfyun' ? '讯飞' : asrMode === 'unavailable' ? '未配置' : '…';
  const micBusy = micStatus === 'requesting-permission' || micStatus === 'initializing';
  const [moreOpen, setMoreOpen] = useState(false);
  const micIcon = micRetryable
    ? <RefreshCw size={ICON_SIZE} />
    : muted
      ? <MicOff size={ICON_SIZE} />
      : listening
        ? <AudioLines size={ICON_SIZE} />
        : <Mic size={ICON_SIZE} />;
  const micLabel = micRetryable
    ? 'Retry mic'
    : micBusy
      ? 'Starting…'
      : muted
        ? 'Unmute'
        : listening
          ? 'Listening'
          : 'Mic';

  // Handheld layout (§3.3): fixed 5 keys — mic / speaker / share / interrupt
  // / leave. Snapshot + chat collapse into a 更多 menu (chat is also the
  // bottom-drawer entry); pending permissions surface as a badge button
  // opening the approval modal.
  if (handheld) {
    return (
      <div className="toolbar toolbar-handheld">
        <div className="toolbar-group">
          <div className="tb-mic-cluster">
            <ToolbarButton
              icon={micIcon}
              label={micLabel}
              onClick={micRetryable ? onRetryMic : onToggleMute}
              active={!muted && listening}
              warning={muted || micRetryable}
              disabled={!micSupported}
              title={micRetryable ? 'Microphone failed to start. Click to retry.' : undefined}
            />
            <div className="tb-mic-meter" aria-hidden="true">
              <div
                className="tb-mic-meter-fill"
                style={{ width: `${muted ? 0 : meterWidth}%` }}
              />
            </div>
          </div>
          <ToolbarButton
            icon={ttsOn ? <Volume2 size={ICON_SIZE} /> : <VolumeX size={ICON_SIZE} />}
            label={ttsOn ? 'Voice on' : 'Voice off'}
            onClick={onToggleTts}
            active={ttsOn}
          />
        </div>

        <div className="toolbar-group toolbar-group-primary">
          <ToolbarButton
            icon={sharing ? <Monitor size={ICON_SIZE} /> : <MonitorUp size={ICON_SIZE} />}
            label={sharing ? 'Stop sharing' : 'Share my screen'}
            onClick={onToggleShare}
            active={sharing}
            danger={sharing}
          />
          <ToolbarButton
            icon={<Square size={ICON_SIZE} />}
            label="Interrupt"
            onClick={onInterrupt}
          />
        </div>

        <div className="toolbar-group">
          {permissionCount > 0 && (
            <button
              className="tb-btn tb-perm-badge"
              onClick={onOpenPermission}
              title={`${permissionCount} 个权限请求待审批`}
            >
              <span className="tb-btn-icon" aria-hidden="true"><ShieldAlert size={ICON_SIZE} /></span>
              <span className="tb-btn-label">审批</span>
              <span className="tb-perm-badge-count">{permissionCount}</span>
            </button>
          )}
          <div className="tb-more-wrap">
            <ToolbarButton
              icon={<MoreHorizontal size={ICON_SIZE} />}
              label="更多"
              onClick={() => setMoreOpen((v) => !v)}
              active={moreOpen || chatOpen}
            />
            {moreOpen && (
              <div className="tb-more-menu" role="menu">
                <button
                  type="button"
                  role="menuitem"
                  disabled={!snapshotEnabled}
                  onClick={() => { setMoreOpen(false); onSnapshot(); }}
                >
                  <Camera size={16} /> 快照
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => { setMoreOpen(false); onToggleChat(); }}
                >
                  <MessageSquare size={16} /> 聊天
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => { setMoreOpen(false); onToggleCompanion(); }}
                >
                  <Gamepad2 size={16} /> AhaBar
                </button>
              </div>
            )}
          </div>
          <button className="tb-leave" onClick={onLeave}>
            <span className="tb-btn-icon" aria-hidden="true"><X size={ICON_SIZE} /></span>
            <span className="tb-btn-label">Leave</span>
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="toolbar">
      <div className="toolbar-group">
        <div className="tb-mic-cluster">
          <ToolbarButton
            icon={micIcon}
            label={micLabel}
            onClick={micRetryable ? onRetryMic : onToggleMute}
            active={!muted && listening}
            warning={muted || micRetryable}
            disabled={!micSupported}
            title={micRetryable ? 'Microphone failed to start. Click to retry.' : undefined}
          />
          <div className="tb-mic-meter" aria-hidden="true">
            <div
              className="tb-mic-meter-fill"
              style={{ width: `${muted ? 0 : meterWidth}%` }}
            />
          </div>
          <span className="tb-asr-badge" title={`ASR backend: ${asrBadge}`}>{asrBadge}</span>
        </div>
        <ToolbarButton
          icon={ttsOn ? <Volume2 size={ICON_SIZE} /> : <VolumeX size={ICON_SIZE} />}
          label={ttsOn ? 'Voice on' : 'Voice off'}
          onClick={onToggleTts}
          active={ttsOn}
        />
      </div>

      <div className="toolbar-group toolbar-group-primary">
        <ToolbarButton
          icon={sharing ? <Monitor size={ICON_SIZE} /> : <MonitorUp size={ICON_SIZE} />}
          label={sharing ? 'Stop sharing' : 'Share my screen'}
          onClick={onToggleShare}
          active={sharing}
          danger={sharing}
        />
        <ToolbarButton
          icon={<Camera size={ICON_SIZE} />}
          label={sharing ? 'Send snapshot' : 'Snapshot (share first)'}
          onClick={onSnapshot}
          disabled={!snapshotEnabled}
        />
        <ToolbarButton
          icon={<Square size={ICON_SIZE} />}
          label="Interrupt"
          onClick={onInterrupt}
        />
      </div>

      <div className="toolbar-group">
        {controlsSlot}
        <ToolbarButton
          icon={<MessageSquare size={ICON_SIZE} />}
          label="Chat"
          onClick={onToggleChat}
          active={chatOpen}
        />
        <ToolbarButton
          icon={<Gamepad2 size={ICON_SIZE} />}
          label="AhaBar"
          onClick={onToggleCompanion}
          title="AhaBar 悬浮条 · 待批准快捷键"
        />
        <button className="tb-leave" onClick={onLeave}>
          <span className="tb-btn-icon" aria-hidden="true"><X size={ICON_SIZE} /></span>
          <span className="tb-btn-label">Leave</span>
        </button>
      </div>
    </div>
  );
}
