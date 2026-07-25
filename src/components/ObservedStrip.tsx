import { memo, useMemo } from 'react';
import { useObservedTasks } from '../hooks/useObservedTasks';
import type { ObservedSession } from '../lib/observed-store';
import {
  OBSERVED_CLIENT_LABEL,
  OBSERVED_STATE_LABEL,
  columnForObserved,
  formatObservedAge,
} from './TasksView';

/** 观察条最多平铺的会话数；超出折叠为「+N 更多」。 */
const MAX_TILES = 8;

interface ObservedStripProps {
  /** 点击任意 tile 或溢出按钮 → 切到任务看板（S0 仅观察，看板是唯一去处）。 */
  onOpenTasks: () => void;
}

/** 会议模式顶部的「观察中」横条：进行中的外部 CLI / 桌面会话一览
 *  （谁在干活）。可见性规则与任务看板一致（columnForObserved 非 null），
 *  噪声会话不重复出现。纯展示只读 —— 点击只跳转看板，不做任何操作。
 *  老 preload 没有 observe 命名空间（或扫描结果为空）时整条不渲染。 */
export const ObservedStrip = memo(function ObservedStrip({ onOpenTasks }: ObservedStripProps) {
  const observed = useObservedTasks();
  const boardable = useMemo(() => {
    const now = Date.now();
    return observed.sessions
      .filter((session) => !session.isNoise && columnForObserved(session, now) !== null)
      .sort((a, b) => b.lastActiveAt - a.lastActiveAt);
  }, [observed]);

  if (!window.vibeMeet?.observe || boardable.length === 0) return null;

  const tiles = boardable.slice(0, MAX_TILES);
  const overflow = boardable.length - tiles.length;
  return (
    <div className="observed-strip" role="status" aria-label="观察中的外部会话">
      <span className="observed-strip-label">观察中</span>
      <div className="observed-strip-tiles">
        {tiles.map((session) => (
          <ObservedStripTile key={session.id} session={session} onOpen={onOpenTasks} />
        ))}
        {overflow > 0 && (
          <button
            type="button"
            className="observed-strip-more"
            onClick={onOpenTasks}
            title="在任务看板查看全部观察中的会话"
          >
            +{overflow} 更多
          </button>
        )}
      </div>
    </div>
  );
});

function ObservedStripTile({
  session,
  onOpen,
}: {
  session: ObservedSession;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      className={`observed-strip-tile is-observed-${session.state}`}
      onClick={onOpen}
      title={`${session.projectName} · ${session.title}\n${session.cwd}`}
    >
      <em className={`tasks-client-chip is-${session.clientKind}`}>
        {OBSERVED_CLIENT_LABEL[session.clientKind]}
      </em>
      <span className="observed-strip-project">{session.projectName}</span>
      <span className="observed-strip-title">{session.title}</span>
      <span className="observed-strip-state">
        <i className={`observed-strip-dot is-${session.state}`} />
        {OBSERVED_STATE_LABEL[session.state]}
        <em className="tasks-card-inferred">推断</em>
      </span>
      <span className="observed-strip-age">{formatObservedAge(session.lastActiveAt)}</span>
    </button>
  );
}
