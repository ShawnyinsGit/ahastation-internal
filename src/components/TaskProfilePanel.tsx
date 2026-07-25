import type { RendererTaskSnapshot } from '../types';

function profileRows(profile: unknown): Array<[string, string]> {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) return [];
  return Object.entries(profile as Record<string, unknown>)
    .filter(([, value]) => (
      typeof value === 'string'
      || typeof value === 'number'
      || typeof value === 'boolean'
    ))
    .slice(0, 12)
    .map(([key, value]) => [key, String(value)]);
}

function ProfileCard({
  title,
  profile,
  tone,
}: {
  title: string;
  profile: unknown;
  tone: 'requested' | 'effective';
}) {
  const rows = profileRows(profile);
  return (
    <section className={`task-profile-card is-${tone}`}>
      <header>
        <span>{title}</span>
        <strong>{rows.length > 0 ? '已绑定' : '未提供'}</strong>
      </header>
      {rows.length > 0 ? (
        <dl>
          {rows.map(([key, value]) => (
            <div key={key}>
              <dt>{key}</dt>
              <dd title={value}>{value}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p>该执行 Backend 未声明此配置。</p>
      )}
    </section>
  );
}

export function TaskProfilePanel({ snapshot }: { snapshot: RendererTaskSnapshot }) {
  const { task } = snapshot;
  return (
    <div className="task-profile-panel">
      <div className="task-profile-compare" aria-label="请求配置与实际配置">
        <ProfileCard title="Requested profile" profile={task.requestedProfile} tone="requested" />
        <ProfileCard title="Effective profile" profile={task.effectiveProfile} tone="effective" />
      </div>

      <section className="task-evidence-grid" aria-label="任务上下文与权限摘要">
        <article>
          <span>Context</span>
          <strong>{task.context?.mode ?? '未绑定'}</strong>
          <small>
            {task.context
              ? `${task.context.messageCount} 消息 · ${task.context.decisionCount} 决策 · ${task.context.attachmentCount} 附件`
              : '没有可展示的上下文摘要'}
          </small>
        </article>
        <article>
          <span>Authority</span>
          <strong>{task.authority?.allowedToolKinds.join(' · ') || '无工具授权'}</strong>
          <small>
            {task.authority
              ? `${task.authority.writePathCount} 写入范围 · ${task.authority.commandCount} 命令 · ${task.authority.networkHostCount} 网络主机`
              : '权限事实尚未编译'}
          </small>
        </article>
        <article>
          <span>Workspace</span>
          <strong>{task.workspace?.kind ?? '未分配'}</strong>
          <small>{task.workspace?.branch ?? task.workspace?.diagnostic ?? '等待工作区事实'}</small>
        </article>
      </section>
    </div>
  );
}
