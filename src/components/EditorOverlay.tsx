// EditorOverlay — handheld editor form factor (Phase 6a, 整机 D7/软件 D1).
//
// A full-screen overlay INSIDE the App subtree — NOT a route/view swap. The
// App component tree (useClaude / useAsr / useTtsWiring / useVoiceLock)
// stays mounted, so the voice link keeps running while the user edits.
// Data flows through the exact same ide-files / ideSession / idePty channels
// as the independent editor window: the overlay first registers itself via
// ideOverlay.bind (main-side, cwd resolved from the meeting slot), so
// OpenCodeEditor works unchanged. Top: host chip strip. Bottom: mini voice
// bar (mic status + interrupt + return).

import { useEffect, useState } from 'react';
import { Mic, MicOff, Square, ChevronLeft } from 'lucide-react';
import { OpenCodeEditor } from './OpenCodeEditor';
import { requestHideBrowser } from '../lib/browser-store';
import {
  NO_EDITOR_CAPABILITIES,
  type EditorCapabilities,
} from '../types';

export interface OverlayHostChip {
  hostId: string;
  backendId: string;
}

interface EditorOverlayProps {
  hostId: string;
  /** Meeting tab id the overlay binds to. */
  sessionId: string;
  cwd: string;
  hosts: OverlayHostChip[];
  onSwitchHost: (hostId: string) => void;
  onClose: () => void;
  // Mini voice bar.
  muted: boolean;
  listening: boolean;
  onToggleMute: () => void;
  onInterrupt: () => void;
}

export function EditorOverlay({
  hostId,
  sessionId,
  cwd,
  hosts,
  onSwitchHost,
  onClose,
  muted,
  listening,
  onToggleMute,
  onInterrupt,
}: EditorOverlayProps) {
  const [capabilities, setCapabilities] = useState<EditorCapabilities>(NO_EDITOR_CAPABILITIES);
  const [bindError, setBindError] = useState<string | null>(null);

  // The overlay covers the stage area where the native browser
  // WebContentsView paints — hide it for the overlay's lifetime.
  useEffect(() => requestHideBrowser(), []);

  // Resolve the IDE capabilities for the current host (default ide today).
  useEffect(() => {
    let cancelled = false;
    void window.vibeMeet.ideRegistry.list().then((res) => {
      if (cancelled || !res.ok) return;
      const ide = res.state.ides.find((i) => i.id === res.state.defaultIdeId);
      if (ide?.capabilities) setCapabilities(ide.capabilities);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // Bind the overlay as the editor surface for this host (main-side cwd).
  // Re-binds on host switch; unbinds on unmount.
  useEffect(() => {
    let cancelled = false;
    void window.vibeMeet.ideOverlay.bind(hostId, sessionId).then((res) => {
      if (!cancelled && !res.ok) setBindError(res.error ?? 'bind failed');
      if (!cancelled && res.ok) setBindError(null);
    });
    return () => {
      cancelled = true;
      void window.vibeMeet.ideOverlay.close();
    };
  }, [hostId, sessionId]);

  const currentHost = hosts.find((h) => h.hostId === hostId);

  return (
    <div className="editor-overlay">
      <div className="editor-overlay-chips">
        <button type="button" className="editor-overlay-back" onClick={onClose} title="返回会议">
          <ChevronLeft size={18} />
        </button>
        <div className="editor-overlay-chip-strip">
          {hosts.map((h) => (
            <button
              key={h.hostId}
              type="button"
              className={`editor-overlay-chip ${h.hostId === hostId ? 'editor-overlay-chip-active' : ''}`}
              onClick={() => onSwitchHost(h.hostId)}
            >
              {h.backendId} · {h.hostId}
            </button>
          ))}
        </div>
      </div>

      <div className="editor-overlay-body">
        {bindError ? (
          <div className="opencode-editor-error">{bindError}</div>
        ) : (
          <OpenCodeEditor
            hostId={hostId}
            backendId={currentHost?.backendId ?? ''}
            sessionId={sessionId}
            cwd={cwd}
            capabilities={capabilities}
          />
        )}
      </div>

      <div className="editor-overlay-voicebar">
        <button
          type="button"
          className={`tb-btn ${!muted && listening ? 'tb-btn-active' : ''}`}
          onClick={onToggleMute}
          title={muted ? '取消静音' : '静音'}
        >
          <span className="tb-btn-icon" aria-hidden="true">
            {muted ? <MicOff size={18} /> : <Mic size={18} />}
          </span>
          <span className="tb-btn-label">{muted ? '已静音' : listening ? '聆听中' : '麦克风'}</span>
        </button>
        <button type="button" className="tb-btn" onClick={onInterrupt} title="打断">
          <span className="tb-btn-icon" aria-hidden="true"><Square size={18} /></span>
          <span className="tb-btn-label">打断</span>
        </button>
        <button type="button" className="tb-btn" onClick={onClose} title="返回会议">
          <span className="tb-btn-icon" aria-hidden="true"><ChevronLeft size={18} /></span>
          <span className="tb-btn-label">返回会议</span>
        </button>
      </div>
    </div>
  );
}
