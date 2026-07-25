import { memo, useEffect, useMemo, useRef } from 'react';
import { Terminal as TerminalIcon, ChevronRight } from 'lucide-react';
import type { CommandRun } from '../types';

interface TerminalPanelProps {
  commands: CommandRun[];
}

function formatDuration(ms: number | undefined): string | null {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return null;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
}

export const TerminalPanel = memo(function TerminalPanel({ commands }: TerminalPanelProps) {
  const endRef = useRef<HTMLDivElement | null>(null);
  const ordered = useMemo(
    () => [...commands].sort((a, b) => a.startedAt - b.startedAt),
    [commands],
  );

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [ordered.length, ordered.at(-1)?.output, ordered.at(-1)?.status]);

  if (ordered.length === 0) {
    return (
      <div className="terminal-panel-empty">
        <TerminalIcon size={32} />
        <p>No terminal commands yet</p>
        <small>Bash / shell 命令会在这里按调用实时展示完整输出。</small>
      </div>
    );
  }

  return (
    <div className="terminal-panel" role="log" aria-live="polite" aria-relevant="additions">
      {ordered.map((run) => {
        const duration = formatDuration(
          run.durationMs ?? (run.endedAt != null ? run.endedAt - run.startedAt : undefined),
        );
        return (
          <div
            key={run.id}
            className={`terminal-block ${run.status === 'failed' ? 'terminal-block-error' : ''} ${run.status === 'running' ? 'terminal-block-running' : ''}`}
          >
            <div className="terminal-block-header">
              <ChevronRight size={12} />
              <span className="terminal-block-ts">
                {new Date(run.startedAt).toLocaleTimeString()}
              </span>
              {run.backendId && (
                <span className="terminal-block-backend">{run.backendId}</span>
              )}
              {run.status === 'running' && (
                <span className="terminal-block-status is-running">running</span>
              )}
              {run.status !== 'running' && run.exitCode !== undefined && (
                <span className={`terminal-block-status is-exit-${run.exitCode === 0 ? 'ok' : 'fail'}`}>
                  exit {run.exitCode}
                </span>
              )}
              {run.status === 'failed' && run.exitCode === undefined && (
                <span className="terminal-block-status is-exit-fail">failed</span>
              )}
              {duration && <span className="terminal-block-duration">{duration}</span>}
            </div>
            <pre className="terminal-block-command">{`$ ${run.command || '(unknown command)'}`}</pre>
            {run.output != null && run.output.length > 0 && (
              <pre className="terminal-block-output">{run.output}</pre>
            )}
            {run.status === 'running' && (run.output == null || run.output.length === 0) && (
              <pre className="terminal-block-output terminal-block-output-pending">…</pre>
            )}
          </div>
        );
      })}
      <div ref={endRef} />
    </div>
  );
});
