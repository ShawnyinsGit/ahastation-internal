import { formatElapsed, useElapsedSeconds } from '../hooks/useTimer';

/**
 * Self-ticking elapsed timer. Isolates the 1 Hz re-render to this single
 * <span> instead of letting the interval bubble through the parent tree
 * (previously the interval lived in App, re-rendering the whole meeting
 * screen every second).
 */
export function ElapsedTime({
  startedAt,
  className,
}: {
  startedAt: number | null;
  className?: string;
}) {
  const elapsed = useElapsedSeconds(startedAt);
  return <span className={className}>{formatElapsed(elapsed)}</span>;
}
