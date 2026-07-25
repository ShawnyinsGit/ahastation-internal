// ShellTerminal - interactive shell in the main-window bottom drawer.
//
// Renderer-owned lifecycle: mount spawns the shell (shell-pty:create), unmount
// kills it (shell-pty:kill). Each drawer open is a fresh shell. The xterm
// plumbing lives in usePtyTerminal; this component only binds it to the
// shellPty IPC. Distinct from RealTerminal (worker PTY, attach mode).

import { useCallback } from 'react';
import { usePtyTerminal } from '../hooks/usePtyTerminal';

interface ShellTerminalProps {
  cwd: string;
}

export function ShellTerminal({ cwd }: ShellTerminalProps) {
  const attach = useCallback(async () => {
    const r = await window.vibeMeet.shellPty.create({ cwd, cols: 100, rows: 30 });
    if (r.ok) return { ok: true as const, ptyId: r.ptyId, replay: r.replay };
    return { ok: false as const, error: r.error ?? '无法启动终端' };
  }, [cwd]);
  const input = useCallback((ptyId: string, data: string) => {
    void window.vibeMeet.shellPty.input(ptyId, data);
  }, []);
  const resize = useCallback((ptyId: string, rows: number, cols: number) => {
    void window.vibeMeet.shellPty.resize(ptyId, rows, cols);
  }, []);
  const onData = useCallback(
    (cb: (e: { ptyId: string; data: string }) => void) =>
      window.vibeMeet.shellPty.onData(cb),
    [],
  );
  const onExit = useCallback(
    (cb: (e: { ptyId: string; exitCode: number | null }) => void) =>
      window.vibeMeet.shellPty.onExit(cb),
    [],
  );
  const dispose = useCallback((ptyId: string) => {
    void window.vibeMeet.shellPty.kill(ptyId);
  }, []);

  const { containerRef, exited, error } = usePtyTerminal({
    attach,
    input,
    resize,
    onData,
    onExit,
    dispose,
  });

  return (
    <div
      className="shell-terminal"
      style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}
    >
      {error && <div className="shell-terminal-error">{error}</div>}
      <div
        ref={containerRef}
        style={{ flex: 1, minHeight: 120, opacity: exited ? 0.7 : 1 }}
      />
    </div>
  );
}
