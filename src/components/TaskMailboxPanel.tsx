import { useMemo, useState } from 'react';
import { CornerDownRight, Octagon, Route } from 'lucide-react';
import type { RendererTaskSnapshot, TaskMessage } from '../types';

const MESSAGE_STATUS: Record<TaskMessage['status'], string> = {
  queued: '排队中',
  delivered: '已送达',
  acknowledged: '已确认',
  failed: '待重试',
};

function visiblePayload(payload: unknown): string {
  if (typeof payload === 'string') return payload;
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const value = payload as Record<string, unknown>;
    if (typeof value.text === 'string') return value.text;
    if (typeof value.question === 'string') return value.question;
    if (typeof value.answer === 'string') return value.answer;
  }
  try {
    return JSON.stringify(payload);
  } catch {
    return '结构化消息';
  }
}

export function TaskMailboxPanel({
  sessionId,
  taskId,
  snapshot,
}: {
  sessionId: string;
  taskId: string;
  snapshot: RendererTaskSnapshot;
}) {
  const [followUp, setFollowUp] = useState('');
  const [steering, setSteering] = useState('');
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [feedback, setFeedback] = useState('');
  const messages = useMemo(
    () => [...snapshot.mailbox].sort((left, right) => left.seq - right.seq),
    [snapshot.mailbox],
  );

  const runAction = async (
    kind: 'follow-up' | 'steer' | 'interrupt',
    action: () => Promise<{ ok: boolean; error?: string }>,
  ) => {
    setPendingAction(kind);
    setFeedback('');
    try {
      const result = await action();
      setFeedback(result.ok
        ? kind === 'follow-up'
          ? 'Follow-up 已进入 FIFO 队列。'
          : kind === 'steer'
            ? 'Steering 已排队，将在安全边界送达。'
            : 'Interrupt 已请求；工作区与恢复点会保留。'
        : result.error ?? '操作失败');
      return result.ok;
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      setPendingAction(null);
    }
  };

  return (
    <div className="task-mailbox-panel">
      <section className="task-control-stack" aria-label="Task message controls">
        <label>
          <span><CornerDownRight size={14} /> Follow-up</span>
          <textarea
            value={followUp}
            onChange={(event) => setFollowUp(event.target.value)}
            placeholder="在当前执行完成后继续处理…"
            maxLength={100_000}
          />
          <button
            type="button"
            disabled={pendingAction !== null || !followUp.trim()}
            onClick={() => {
              const text = followUp.trim();
              if (!text) return;
              void runAction('follow-up', () => (
                window.vibeMeet.tasks.followUp(sessionId, taskId, text)
              )).then((ok) => {
                if (ok) setFollowUp('');
              });
            }}
          >
            加入后续队列
          </button>
        </label>

        <label>
          <span><Route size={14} /> Steering</span>
          <textarea
            value={steering}
            onChange={(event) => setSteering(event.target.value)}
            placeholder="调整方向；当前不可中断步骤不会被篡改…"
            maxLength={100_000}
          />
          <button
            type="button"
            disabled={pendingAction !== null || !steering.trim()}
            onClick={() => {
              const text = steering.trim();
              if (!text) return;
              void runAction('steer', () => (
                window.vibeMeet.tasks.steer(sessionId, taskId, text)
              )).then((ok) => {
                if (ok) setSteering('');
              });
            }}
          >
            在安全边界转向
          </button>
        </label>

        <button
          type="button"
          className="task-interrupt-button"
          disabled={pendingAction !== null}
          onClick={() => {
            void runAction('interrupt', () => (
              window.vibeMeet.tasks.interrupt(sessionId, taskId, 'User interrupted from Task Inspector')
            ));
          }}
        >
          <Octagon size={14} /> Interrupt Task
        </button>
        {feedback && <p className="task-control-feedback" role="status">{feedback}</p>}
      </section>

      <section className="task-message-list" aria-label="Task mailbox">
        <header>
          <strong>Mailbox</strong>
          <span>{messages.length}{snapshot.mailboxTruncated ? '+' : ''} 条</span>
        </header>
        {messages.length === 0 ? (
          <p className="task-empty-state">尚无 Coordinator、Worker 或用户消息。</p>
        ) : (
          <ol>
            {messages.map((message) => (
              <li key={message.id}>
                <div>
                  <strong>{message.sender}</strong>
                  <span>{message.kind}</span>
                  <time>{new Date(message.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
                </div>
                <p>{visiblePayload(message.payload).slice(0, 4_000)}</p>
                <small className={`is-${message.status}`}>
                  {MESSAGE_STATUS[message.status]} · seq {message.seq}
                </small>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
