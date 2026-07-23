// One-shot guide modal that nudges macOS users to install the higher-quality
// Siri / Premium / Enhanced Chinese voices. Apple gives no API to trigger the
// download, so the best we can do is open the right System Settings pane.
//
// Triggered from App when speechSynthesis hasn't loaded any premium Chinese
// voice AND the user hasn't dismissed permanently. Closes itself silently
// once voiceschanged fires with a premium voice in the list.

import { useState } from 'react';
import { X } from 'lucide-react';

interface VoiceGuideModalProps {
  open: boolean;
  // Called when the user clicks "Maybe later" — closes for this session only.
  onClose: () => void;
  // Called when the user ticks "Don't show again" and confirms — persisted
  // to settings so future launches stop nagging.
  onDismissForever: () => void;
}

export function VoiceGuideModal({ open, onClose, onDismissForever }: VoiceGuideModalProps) {
  const [dontShowAgain, setDontShowAgain] = useState(false);

  if (!open) return null;

  const handleOpenSettings = () => {
    void window.vibeMeet.openVoiceSettings();
  };

  const handleClose = () => {
    if (dontShowAgain) onDismissForever();
    else onClose();
  };

  return (
    <div className="picker-backdrop" onClick={handleClose}>
      <div className="picker voice-guide" onClick={(e) => e.stopPropagation()}>
        <div className="picker-head">
          <span>升级中文播报音色</span>
          <button className="picker-close" onClick={handleClose} aria-label="Close"><X size={16} /></button>
        </div>

        <div className="voice-guide-body">
          <p className="voice-guide-intro">
            macOS 默认的中文音色比较机械。下载一个 Siri 中文音色后，Claude
            的播报会自然很多——只需要点几下系统设置。
          </p>

          <ol className="voice-guide-steps">
            <li>
              点下面的 <b>打开系统设置</b> 按钮，会跳到「辅助功能 → 朗读内容」。
            </li>
            <li>
              点击 <b>系统语音 → 管理语音</b>。
            </li>
            <li>
              在「中文（中国大陆）」下找到 <b>语音 1 / 2 / 3 / 4</b> 或者 <b>Lili Premium</b>，
              点 ↓ 下载（每个约 200 MB）。
            </li>
            <li>下载完成后切回 AhaStation，播报会自动用上新音色。</li>
          </ol>

          {/* Screenshot placeholder — slot in step-by-step images later. */}
          <div className="voice-guide-screenshot" aria-hidden="true">
            <span>截图位置</span>
          </div>

          <label className="voice-guide-dontshow">
            <input
              type="checkbox"
              checked={dontShowAgain}
              onChange={(e) => setDontShowAgain(e.target.checked)}
            />
            <span>不再提示</span>
          </label>

          <div className="voice-guide-actions">
            <button className="picker-btn picker-btn-primary" onClick={handleOpenSettings}>
              打开系统设置
            </button>
            <button className="picker-btn" onClick={handleClose}>
              {dontShowAgain ? '关闭并不再提示' : '以后再说'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
