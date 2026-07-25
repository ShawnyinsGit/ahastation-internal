import { memo } from 'react';
import { ElapsedTime } from './ElapsedTime';

interface StatusBarProps {
  /** 已连接客户端数（host groups）。 */
  clientCount: number;
  /** 活跃任务数（进行中 + 待批准 + 待验收）。 */
  activeTaskCount: number;
  /** 当前目录（单会议 = 一个项目）。 */
  cwd: string | null;
  /** 会议开始时间戳（ms）；计时 tick 由 ElapsedTime 自行驱动。 */
  startedAt: number | null;
  /** 当前视图（会议/任务）。 */
  viewLabel: string;
}

/**
 * 状态栏（04 §9.1）：客户端连接 · 活跃任务 · 访问级别徽章 · 处理路径。
 * 访问级别是带色持久徽章（03 改进建议 6.6）——当前代码只会编排自己
 * spawn 的 agent，无观察层接入前恒为「交互控制」以下的展示级徽章；
 * 观察层（M7）落地后按真实级别渲染。
 */
export const StatusBar = memo(function StatusBar({ clientCount, activeTaskCount, cwd, startedAt, viewLabel }: StatusBarProps) {
  return (
    <footer className="aha-statusbar">
      <span className="aha-statusbar-item aha-tnum">{clientCount} 个客户端连接中</span>
      <span className="aha-statusbar-item aha-tnum">{activeTaskCount} 个活跃任务</span>
      <span className="aha-statusbar-item aha-statusbar-path" title={cwd ?? ''}>
        {cwd ?? '未打开目录'}
      </span>
      <ElapsedTime startedAt={startedAt} className="aha-statusbar-item aha-tnum" />
      <span className="aha-statusbar-spacer" />
      <span className="aha-statusbar-item">AhaTalk · 本地</span>
      <span className="aha-level-pill aha-level-pill-meet">{viewLabel}</span>
      <span className="aha-level-pill aha-level-pill-info" title="当前可编排本会话内的 agent；外部会话观察（M7）开发中">
        交互控制
      </span>
    </footer>
  );
});
