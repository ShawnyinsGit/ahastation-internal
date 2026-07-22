// companion-sound.ts — programmatic Web Audio beeps for the companion
// screen (§3.4 音效策略). No asset dependency (oscillator only). Grading:
// permission request = strong two-tone; delivery = light short blip. The
// caller is responsible for the TTS mutex + user setting (this module only
// knows how to play).

let ctx: AudioContext | null = null;

/** AudioContext needs a user gesture on some Chromium policies — the sound
 *  toggle / any click in the window resumes it. Safe to call repeatedly. */
export function ensureAudioContext(): AudioContext | null {
  try {
    if (!ctx) ctx = new AudioContext();
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

function beep(ac: AudioContext, freq: number, startAt: number, durationMs: number, gain = 0.06): void {
  const osc = ac.createOscillator();
  const g = ac.createGain();
  osc.type = 'square';
  osc.frequency.value = freq;
  g.gain.setValueAtTime(gain, startAt);
  g.gain.exponentialRampToValueAtTime(0.0001, startAt + durationMs / 1000);
  osc.connect(g).connect(ac.destination);
  osc.start(startAt);
  osc.stop(startAt + durationMs / 1000);
}

export type CompanionBeepLevel = 'strong' | 'light';

export function playCompanionBeep(level: CompanionBeepLevel): void {
  const ac = ensureAudioContext();
  if (!ac) return;
  const t = ac.currentTime;
  if (level === 'strong') {
    // 权限请求 = 强提醒: two-tone, twice.
    beep(ac, 880, t, 120, 0.08);
    beep(ac, 660, t + 0.14, 160, 0.08);
  } else {
    // 交付完成 = 轻提示: single soft blip.
    beep(ac, 520, t, 90, 0.05);
  }
}
