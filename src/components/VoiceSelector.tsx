// Dropdown that lets the user pick which Chinese voice Claude speaks with.
// Lives in the SideDrawer's topSlot alongside the voice-lock panel.
//
// "Auto" = let useSpeech's rankVoice pick the best installed voice. Any
// explicit pick overrides it and persists across launches.

import { listChineseVoices, tierLabel, type ListedVoice } from '../lib/voice-quality';
import type { SpeechFilterMode } from '../lib/speech-format';
import type { HandheldOverride } from '../lib/handheld-mode';
import type { XfyunAsrCredentials } from '../types';

interface VoiceSelectorProps {
  voices: SpeechSynthesisVoice[];
  selectedVoiceName: string | null;
  onChange: (name: string | null) => void;
  onOpenGuide: () => void;
  filterMode: SpeechFilterMode;
  onChangeFilterMode: (mode: SpeechFilterMode) => void;
  voicePolishEnabled: boolean;
  onChangeVoicePolish: (enabled: boolean) => void;
  reportModeEnabled: boolean;
  onChangeReportMode: (enabled: boolean) => void;
  handheldMode: HandheldOverride;
  onChangeHandheldMode: (mode: HandheldOverride) => void;
  xfyunAsr: XfyunAsrCredentials;
  onXfyunAsrInput: (patch: Partial<XfyunAsrCredentials>) => void;
  onXfyunAsrCommit: () => Promise<boolean>;
  xfyunDirty: boolean;
  xfyunSaveState: 'idle' | 'saving' | 'saved' | 'error';
}

function describeVoice(v: ListedVoice): string {
  const tier = v.tier === 'default' ? '默认' : tierLabel(v.tier);
  return `${v.label} · ${v.localeLabel} · ${tier}`;
}

export function VoiceSelector({
  voices,
  selectedVoiceName,
  onChange,
  onOpenGuide,
  filterMode,
  onChangeFilterMode,
  voicePolishEnabled,
  onChangeVoicePolish,
  reportModeEnabled,
  onChangeReportMode,
  handheldMode,
  onChangeHandheldMode,
  xfyunAsr,
  onXfyunAsrInput,
  onXfyunAsrCommit,
  xfyunDirty,
  xfyunSaveState,
}: VoiceSelectorProps) {
  const chineseVoices = listChineseVoices(voices);
  const hasPremium = chineseVoices.some((v) => v.tier !== 'default');
  const strict = filterMode === 'strict';

  return (
    <div className="drawer-settings">
      <div className="drawer-settings-row">
        <div className="drawer-settings-label">
          <div className="drawer-settings-title">中文播报音色</div>
          <div className="drawer-settings-hint">
            {chineseVoices.length === 0
              ? '没检测到中文音色,会用浏览器默认引擎'
              : hasPremium
                ? '已检测到优质音色,可在下方切换'
                : '只有系统默认机器音,建议下载 Siri 中文音色'}
          </div>
        </div>
        {!hasPremium && chineseVoices.length > 0 && (
          <button
            type="button"
            className="voice-select-guide voice-select-guide-inline"
            onClick={onOpenGuide}
          >
            更多音色
          </button>
        )}
      </div>

      <select
        className="voice-select"
        value={selectedVoiceName ?? ''}
        onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)}
        disabled={chineseVoices.length === 0}
      >
        <option value="">自动(推荐最优)</option>
        {chineseVoices.map((v) => (
          <option key={v.voice.name} value={v.voice.name}>
            {describeVoice(v)}
          </option>
        ))}
      </select>

      <div className="drawer-settings-row" style={{ marginTop: 12 }}>
        <div className="drawer-settings-label">
          <div className="drawer-settings-title">播报过滤</div>
          <div className="drawer-settings-hint">
            {strict
              ? '英文段和工具调用不念出来'
              : '原样播报,包括英文思考和工具名'}
          </div>
        </div>
        <button
          type="button"
          className={`drawer-toggle ${strict ? 'drawer-toggle-on' : ''}`}
          aria-pressed={strict}
          onClick={() => onChangeFilterMode(strict ? 'off' : 'strict')}
        >
          <span className="drawer-toggle-knob" />
        </button>
      </div>

      <div className="drawer-settings-row" style={{ marginTop: 12 }}>
        <div className="drawer-settings-label">
          <div className="drawer-settings-title">讯飞 ASR</div>
          <div className="drawer-settings-hint">
            讯飞 IAT 流式语音转写。填写下方三项凭证，点击保存按钮（或失焦）后立即生效并重连麦克风，未配置时语音识别不可用。
          </div>
        </div>
      </div>

      <div className="asr-cloud-fields">
        <input
          className="asr-cloud-input"
          type="text"
          value={xfyunAsr.appId}
          placeholder="AppID"
          aria-label="讯飞 AppID"
          onChange={(e) => onXfyunAsrInput({ appId: e.target.value })}
          onBlur={onXfyunAsrCommit}
        />
        <input
          className="asr-cloud-input"
          type="password"
          value={xfyunAsr.apiKey}
          placeholder="API Key"
          aria-label="讯飞 API Key"
          autoComplete="off"
          onChange={(e) => onXfyunAsrInput({ apiKey: e.target.value })}
          onBlur={onXfyunAsrCommit}
        />
        <input
          className="asr-cloud-input"
          type="password"
          value={xfyunAsr.apiSecret}
          placeholder="API Secret"
          aria-label="讯飞 API Secret"
          autoComplete="off"
          onChange={(e) => onXfyunAsrInput({ apiSecret: e.target.value })}
          onBlur={onXfyunAsrCommit}
        />
        <button
          type="button"
          className={`asr-cloud-save${xfyunSaveState === 'saved' ? ' is-saved' : ''}${xfyunSaveState === 'error' ? ' is-error' : ''}`}
          disabled={xfyunSaveState === 'saving'}
          onClick={() => { void onXfyunAsrCommit(); }}
        >
          {xfyunSaveState === 'saving'
            ? '保存中…'
            : xfyunSaveState === 'saved'
              ? '已保存 ✓ 正在重连麦克风'
              : xfyunSaveState === 'error'
                ? '保存失败，点击重试'
                : xfyunDirty
                  ? '保存并重连麦克风 ●'
                  : '保存并重连麦克风'}
        </button>
        <div className="drawer-settings-hint">
          在讯飞开放平台控制台获取「语音听写」服务的 AppID、API Key、API Secret。
          凭证保存在本地 settings.json；保存后自动重新探测并连接麦克风；单次识别上限 55 秒。
        </div>
      </div>

      <div className="drawer-settings-row" style={{ marginTop: 12 }}>
        <div className="drawer-settings-label">
          <div className="drawer-settings-title">语音整理</div>
          <div className="drawer-settings-hint">
            {voicePolishEnabled
              ? '口语自动整理为书面语再发送'
              : '原样发送语音识别文本'}
          </div>
        </div>
        <button
          type="button"
          className={`drawer-toggle ${voicePolishEnabled ? 'drawer-toggle-on' : ''}`}
          aria-pressed={voicePolishEnabled}
          onClick={() => onChangeVoicePolish(!voicePolishEnabled)}
        >
          <span className="drawer-toggle-knob" />
        </button>
      </div>

      <div className="drawer-settings-row" style={{ marginTop: 12 }}>
        <div className="drawer-settings-label">
          <div className="drawer-settings-title">汇报模式</div>
          <div className="drawer-settings-hint">
            {reportModeEnabled
              ? '长回复保存为文档，只播报要点摘要'
              : '完整播报所有回复内容'}
          </div>
        </div>
        <button
          type="button"
          className={`drawer-toggle ${reportModeEnabled ? 'drawer-toggle-on' : ''}`}
          aria-pressed={reportModeEnabled}
          onClick={() => onChangeReportMode(!reportModeEnabled)}
        >
          <span className="drawer-toggle-knob" />
        </button>
      </div>

      <div className="drawer-settings-row" style={{ marginTop: 12 }}>
        <div className="drawer-settings-label">
          <div className="drawer-settings-title">掌机模式</div>
          <div className="drawer-settings-hint">
            {handheldMode === 'handheld'
              ? '强制掌机布局（大触控目标、chip 条、模态审批）'
              : handheldMode === 'desktop'
                ? '强制桌面布局'
                : '自动：触屏 + 屏幕 ≤1300px 时用掌机布局'}
          </div>
        </div>
        <div className="handheld-mode-switch" role="group" aria-label="掌机模式">
          {(['auto', 'handheld', 'desktop'] as const).map((m) => (
            <button
              key={m}
              type="button"
              className={`handheld-mode-option ${handheldMode === m ? 'handheld-mode-option-active' : ''}`}
              aria-pressed={handheldMode === m}
              onClick={() => onChangeHandheldMode(m)}
            >
              {m === 'auto' ? '自动' : m === 'handheld' ? '掌机' : '桌面'}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
