// Dropdown that lets the user pick which Chinese voice Claude speaks with.
// Lives in the SideDrawer's topSlot alongside the voice-lock panel.
//
// "Auto" = let useSpeech's rankVoice pick the best installed voice. Any
// explicit pick overrides it and persists across launches.

import { listChineseVoices, tierLabel, type ListedVoice } from '../lib/voice-quality';
import type { SpeechFilterMode } from '../lib/speech-format';
import type { HandheldOverride } from '../lib/handheld-mode';
import type { AsrProvider, CloudAsrSettings } from '../types';

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
  asrProvider: AsrProvider;
  onChangeAsrProvider: (provider: AsrProvider) => void;
  cloudAsr: CloudAsrSettings;
  onCloudAsrInput: (patch: Partial<CloudAsrSettings>) => void;
  onCloudAsrCommit: () => void;
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
  asrProvider,
  onChangeAsrProvider,
  cloudAsr,
  onCloudAsrInput,
  onCloudAsrCommit,
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
          <div className="drawer-settings-title">ASR 提供商</div>
          <div className="drawer-settings-hint">
            {asrProvider === 'cloud'
              ? '云端 API 转写，适合无法运行本地模型的设备'
              : '本地 whisper 转写，离线可用'}
          </div>
        </div>
        <div className="handheld-mode-switch" role="group" aria-label="ASR 提供商">
          {(['local', 'cloud'] as const).map((p) => (
            <button
              key={p}
              type="button"
              className={`handheld-mode-option ${asrProvider === p ? 'handheld-mode-option-active' : ''}`}
              aria-pressed={asrProvider === p}
              onClick={() => onChangeAsrProvider(p)}
            >
              {p === 'local' ? '本地' : '云端'}
            </button>
          ))}
        </div>
      </div>

      {asrProvider === 'cloud' && (
        <div className="asr-cloud-fields">
          <input
            className="asr-cloud-input"
            type="text"
            value={cloudAsr.baseUrl}
            placeholder="Base URL（默认 https://api.openai.com/v1）"
            aria-label="云端 ASR Base URL"
            onChange={(e) => onCloudAsrInput({ baseUrl: e.target.value })}
            onBlur={onCloudAsrCommit}
          />
          <input
            className="asr-cloud-input"
            type="password"
            value={cloudAsr.apiKey}
            placeholder="API Key"
            aria-label="云端 ASR API Key"
            autoComplete="off"
            onChange={(e) => onCloudAsrInput({ apiKey: e.target.value })}
            onBlur={onCloudAsrCommit}
          />
          <input
            className="asr-cloud-input"
            type="text"
            value={cloudAsr.model}
            placeholder="模型（默认 whisper-1）"
            aria-label="云端 ASR 模型"
            onChange={(e) => onCloudAsrInput({ model: e.target.value })}
            onBlur={onCloudAsrCommit}
          />
          <div className="drawer-settings-hint">
            兼容 OpenAI /audio/transcriptions 的端点都可用，例如 OpenAI（whisper-1）、
            Groq（https://api.groq.com/openai/v1，whisper-large-v3）、硅基流动。
            失焦自动保存；云端失败不会自动回退本地。
          </div>
        </div>
      )}

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
