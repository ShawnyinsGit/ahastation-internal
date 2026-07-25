// usePtyTerminal - shared xterm lifecycle for any PTY the renderer displays.
//
// Used by RealTerminal (worker PTY, attach mode) and ShellTerminal (shell PTY,
// create mode). The caller supplies the six IPC bindings; the hook owns the
// xterm Terminal + FitAddon, the ResizeObserver (debounced), base64 decoding,
// exit state, and the attach/detach-or-kill lifecycle. Mount-once: callbacks
// are read through a ref so a re-render never re-spawns the pty.

import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';

export interface PtyTerminalHandle {
  /** Acquire the pty on mount. Returns the ptyId + base64 replay for the
   *  initial write (empty for a freshly created shell). ok:false surfaces an
   *  error bar instead of subscribing. */
  attach: () => Promise<
    { ok: true; ptyId: string; replay: string } | { ok: false; error: string }
  >;
  input: (ptyId: string, data: string) => void;
  resize: (ptyId: string, rows: number, cols: number) => void;
  onData: (cb: (e: { ptyId: string; data: string }) => void) => () => void;
  onExit: (cb: (e: { ptyId: string; exitCode: number | null }) => void) => () => void;
  /** Release the pty on unmount: detach for workers (pty stays alive), kill
   *  for shells (renderer owns the lifecycle). */
  dispose: (ptyId: string) => void;
}

function base64ToUint8Array(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) {
    bytes[i] = bin.charCodeAt(i);
  }
  return bytes;
}

export function usePtyTerminal(opts: PtyTerminalHandle) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [exited, setExited] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const optsRef = useRef(opts);
  optsRef.current = opts;

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
    let ptyId: string | null = null;
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;

    const sendResize = () => {
      const dims = fitAddon.proposeDimensions();
      if (dims && dims.rows > 0 && dims.cols > 0 && ptyId) {
        optsRef.current.resize(ptyId, dims.rows, dims.cols);
      }
    };
    const onResize = () => {
      fitAddon.fit();
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(sendResize, 80);
    };

    // Mount -> attach: replay the ring buffer, then live data flows via events.
    void optsRef.current.attach().then((res) => {
      if (disposed) {
        // Fast unmount (e.g. React StrictMode in dev): reap the pty we just
        // spawned/attached so it can't leak as an orphan with no subscriber.
        if (res.ok) optsRef.current.dispose(res.ptyId);
        return;
      }
      if (!res.ok) {
        setError(res.error);
        return;
      }
      ptyId = res.ptyId;
      if (res.replay) term.write(base64ToUint8Array(res.replay));
      sendResize(); // sync initial dimensions
    }).catch((err) => {
      if (!disposed) setError(String(err));
    });

    // Uplink: user keystrokes.
    const dataSub = term.onData((data) => {
      if (ptyId) optsRef.current.input(ptyId, data);
    });

    // Downlink: pty output events, filtered to this pty.
    const disposeData = optsRef.current.onData((e) => {
      if (ptyId && e.ptyId !== ptyId) return;
      term.write(base64ToUint8Array(e.data));
    });
    const disposeExit = optsRef.current.onExit((e) => {
      if (ptyId && e.ptyId !== ptyId) return;
      setExited(true);
      term.write('\r\n\x1b[90m[进程已退出]\x1b[0m\r\n');
    });

    const resizeObserver = new ResizeObserver(onResize);
    resizeObserver.observe(container);

    return () => {
      disposed = true;
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeObserver.disconnect();
      dataSub.dispose();
      disposeData();
      disposeExit();
      if (ptyId) optsRef.current.dispose(ptyId);
      term.dispose();
    };
    // Mount-once: callbacks are read through optsRef, so identity changes do
    // not re-spawn the pty.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { containerRef, exited, error };
}
