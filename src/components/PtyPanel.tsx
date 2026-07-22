// PtyPanel — embedded terminal for an OpenCode editor window (Phase 4).
//
// Data path: xterm input → ide-pty:input IPC → main WS (authed) → server;
// server output → main WS → point-to-point 'ide-editor:event' → term.write.
// Resize goes REST PUT via ide-pty:resize (never a WS control frame —
// spike §6). Distinct from TerminalPanel.tsx (the tool-call transcript
// view) — this is a real interactive shell in the window's workspace cwd.

import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

interface PtyPanelProps {
  hostId: string;
}

function base64ToUint8Array(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) {
    bytes[i] = bin.charCodeAt(i);
  }
  return bytes;
}

export function PtyPanel({ hostId }: PtyPanelProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [exited, setExited] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      scrollback: 5000,
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(container);
    fitAddon.fit();

    let disposed = false;
    let disposeEvents: (() => void) | null = null;
    let resizeObserver: ResizeObserver | null = null;

    const sendResize = () => {
      const dims = fitAddon.proposeDimensions();
      if (dims) {
        void window.vibeMeet.idePty.resize(dims.rows, dims.cols);
      }
    };

    // Mount → create (idempotent per window: main returns the existing PTY).
    void window.vibeMeet.idePty.create().then((res) => {
      if (disposed) return;
      if (!res.ok) {
        setError(res.error);
        return;
      }
      sendResize(); // sync initial dimensions
    }).catch((err) => {
      if (!disposed) setError(String(err));
    });

    // Uplink: user input → main → WS.
    const dataSub = term.onData((data) => {
      void window.vibeMeet.idePty.input(data);
    });

    // Downlink: main → point-to-point event → xterm.
    disposeEvents = window.vibeMeet.ideSession.onEvent((msg) => {
      if (msg.hostId !== hostId) return;
      const p = msg.payload;
      if (p.kind === 'pty-data') {
        if (p.encoding === 'base64') term.write(base64ToUint8Array(p.data));
        else term.write(p.data);
      } else if (p.kind === 'pty-exit') {
        setExited(true);
        term.write('\r\n\x1b[90m[进程已退出]\x1b[0m\r\n');
      } else if (p.kind === 'pty-error') {
        setError(p.error);
      }
    });

    resizeObserver = new ResizeObserver(() => {
      fitAddon.fit();
      sendResize();
    });
    resizeObserver.observe(container);

    return () => {
      disposed = true;
      resizeObserver?.disconnect();
      dataSub.dispose();
      disposeEvents?.();
      void window.vibeMeet.idePty.close();
      term.dispose();
    };
  }, [hostId]);

  return (
    <div className="pty-panel" style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {error && <div className="opencode-editor-error">{error}</div>}
      <div
        ref={containerRef}
        style={{ flex: 1, minHeight: 120, opacity: exited ? 0.7 : 1 }}
      />
    </div>
  );
}
