// RealTerminal — interactive xterm view onto a terminal-mode worker's PTY.
//
// Data path: xterm input → worker-pty:input IPC → WorkerPtyHost → claude TUI;
// pty output → 'worker-pty:data' events (base64) → term.write. On mount we
// attach and replay the ring buffer so remounts show recent history; on
// unmount we only detach — the pty stays alive (the worker session owns its
// lifecycle). Distinct from TerminalPanel.tsx (the commandLog replay view).

import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

interface RealTerminalProps {
  workerId: string;
}

function base64ToUint8Array(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) {
    bytes[i] = bin.charCodeAt(i);
  }
  return bytes;
}

export function RealTerminal({ workerId }: RealTerminalProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [exited, setExited] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    setExited(false);
    setError(null);

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

    const sendResize = () => {
      const dims = fitAddon.proposeDimensions();
      if (dims && dims.rows > 0 && dims.cols > 0) {
        void window.vibeMeet.workerPty.resize(workerId, dims.rows, dims.cols);
      }
    };

    // Mount → attach: replay the ring buffer, then live data flows via events.
    void window.vibeMeet.workerPty.attach(workerId).then((res) => {
      if (disposed) return;
      if (!res.ok) {
        setError(res.error ?? '无法连接到终端');
        return;
      }
      if (res.replay) term.write(base64ToUint8Array(res.replay));
      sendResize(); // sync initial dimensions
    }).catch((err) => {
      if (!disposed) setError(String(err));
    });

    // Uplink: user keystrokes take over the TUI directly.
    const dataSub = term.onData((data) => {
      void window.vibeMeet.workerPty.input(workerId, data);
    });

    // Downlink: pty output events, filtered to this worker.
    const disposeData = window.vibeMeet.workerPty.onData((e) => {
      if (e.workerId !== workerId) return;
      term.write(base64ToUint8Array(e.data));
    });
    const disposeExit = window.vibeMeet.workerPty.onExit((e) => {
      if (e.workerId !== workerId) return;
      setExited(true);
      term.write('\r\n\x1b[90m[进程已退出]\x1b[0m\r\n');
    });

    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit();
      sendResize();
    });
    resizeObserver.observe(container);

    return () => {
      disposed = true;
      resizeObserver.disconnect();
      dataSub.dispose();
      disposeData();
      disposeExit();
      // Detach only — the pty keeps running for the worker session.
      void window.vibeMeet.workerPty.detach(workerId);
      term.dispose();
    };
  }, [workerId]);

  return (
    <div className="real-terminal" style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {error && <div className="real-terminal-error">{error}</div>}
      <div
        ref={containerRef}
        style={{ flex: 1, minHeight: 120, opacity: exited ? 0.7 : 1 }}
      />
    </div>
  );
}
