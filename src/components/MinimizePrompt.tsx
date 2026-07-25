// MinimizePrompt.tsx — modal shown when the user minimizes/closes the main
// window while AhaBar isn't floating (and hasn't opted out with 不再提示).
//
// main.ts intercepts the minimize/close, sends `app:minimize-prompt`, and
// waits for the answer on `app:minimize-choice` (with a 60s fail-safe that
// replays the original minimize/close if we never answer). Mount anywhere in
// the main window's tree — it renders null until prompted.

import { useEffect, useState } from 'react';

type MinimizePromptKind = 'minimize' | 'close';

export function MinimizePrompt() {
  const [kind, setKind] = useState<MinimizePromptKind | null>(null);
  const [never, setNever] = useState(false);

  useEffect(() => {
    const api = window.vibeMeet.app;
    if (!api?.onMinimizePrompt) return;
    return api.onMinimizePrompt((payload) => {
      setNever(false);
      setKind(payload.kind);
    });
  }, []);

  if (!kind) return null;

  const choose = (action: 'ahabar' | 'hide') => {
    setKind(null);
    void window.vibeMeet.app.minimizeChoice({ action, never }).catch(() => {
      // Main already proceeded via its fail-safe — nothing to recover here.
    });
  };

  return (
    <div className="perm-modal-backdrop" role="dialog" aria-modal="true" aria-label="开启 AhaBar 提醒？">
      <div className="perm-modal minimize-prompt">
        <h3 className="minimize-prompt-title">开启 AhaBar 提醒？</h3>
        <p className="minimize-prompt-copy">
          AhaBar 会悬浮在屏幕顶端。主窗口{kind === 'close' ? '关闭' : '最小化'}后，
          有待批准的审批时它会第一时间浮出提醒你，点一下即可处理。
        </p>
        <label className="minimize-prompt-never">
          <input
            type="checkbox"
            checked={never}
            onChange={(e) => setNever(e.target.checked)}
          />
          <span>不再提示</span>
        </label>
        <div className="minimize-prompt-actions">
          <button type="button" className="minimize-prompt-btn" onClick={() => choose('hide')}>
            仅隐藏窗口
          </button>
          <button
            type="button"
            className="minimize-prompt-btn minimize-prompt-btn-primary"
            onClick={() => choose('ahabar')}
          >
            开启 AhaBar
          </button>
        </div>
      </div>
    </div>
  );
}
