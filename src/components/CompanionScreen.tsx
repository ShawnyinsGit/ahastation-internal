// CompanionScreen — the floating companion window's view (Phase 8, §3.4).
// Mounts the Phaser pixel-office via dynamic import (phaser lands in its own
// async chunk), wires the companion state channel (initial snapshot + live
// events), and plays graded beeps under the TTS mutex + user sound pref.
//
// Perf (§3.4): the game runs at fps.target 15; ~1.2s after the last state
// push we sleep the loop (compositing only) and wake it on the next push.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Volume2, VolumeX, X } from 'lucide-react';
import type { CompanionState } from '../types';
import { ensureAudioContext, playCompanionBeep } from '../lib/companion/companion-sound';
import type { CompanionGameHandle } from '../lib/companion/companion-game';

const SLEEP_AFTER_MS = 1200;

export function CompanionScreen() {
  const containerRef = useRef<HTMLDivElement>(null);
  const gameRef = useRef<CompanionGameHandle | null>(null);
  const sleepTimerRef = useRef<number | null>(null);
  const prevAlertRef = useRef<string>('none');
  const soundRef = useRef(true);
  const [soundEnabled, setSoundEnabled] = useState(true);
  soundRef.current = soundEnabled;

  const applyState = useCallback((state: CompanionState): void => {
    const game = gameRef.current;
    if (!game) return;
    game.wake();
    game.applyState(state);
    if (sleepTimerRef.current) window.clearTimeout(sleepTimerRef.current);
    sleepTimerRef.current = window.setTimeout(() => gameRef.current?.sleep(), SLEEP_AFTER_MS);
    // 音效策略（§3.4）：TTS 活动时静默；提醒分级；只在等级跃迁时发声。
    const level = state.mascot.alertLevel;
    if (soundRef.current && !state.ttsActive && level !== 'none' && level !== prevAlertRef.current) {
      playCompanionBeep(level === 'strong' ? 'strong' : 'light');
    }
    prevAlertRef.current = level;
  }, []);

  // Mount the Phaser game (lazy chunk).
  useEffect(() => {
    let disposed = false;
    void import('../lib/companion/companion-game').then((mod) => {
      if (disposed || !containerRef.current) return;
      gameRef.current = mod.createCompanionGame(containerRef.current);
      // Game mounted after the initial snapshot already arrived: re-apply it.
      void window.vibeMeet.companion?.getState?.().then((res) => {
        if (res.ok) applyState(res.state);
      });
    });
    return () => {
      disposed = true;
      if (sleepTimerRef.current) window.clearTimeout(sleepTimerRef.current);
      gameRef.current?.destroy();
      gameRef.current = null;
    };
  }, [applyState]);

  // Live state channel.
  useEffect(() => {
    const api = window.vibeMeet.companion;
    if (!api?.getState || !api?.onEvent) return;
    void api.getState().then((res) => {
      if (res.ok) applyState(res.state);
    });
    return api.onEvent(applyState);
  }, [applyState]);

  // Sound preference.
  useEffect(() => {
    void window.vibeMeet.companion?.getPrefs?.().then((res) => {
      if (res.ok && typeof res.soundEnabled === 'boolean') setSoundEnabled(res.soundEnabled);
    });
  }, []);

  const toggleSound = (): void => {
    const next = !soundEnabled;
    setSoundEnabled(next);
    if (next) ensureAudioContext();
    void window.vibeMeet.companion?.setSound?.(next);
  };

  return (
    <div className="companion-root" onClick={() => ensureAudioContext()}>
      <div className="companion-titlebar">
        <span className="companion-title">陪伴屏</span>
        <button
          type="button"
          className="companion-titlebar-btn"
          onClick={toggleSound}
          title={soundEnabled ? '静音' : '取消静音'}
        >
          {soundEnabled ? <Volume2 size={14} /> : <VolumeX size={14} />}
        </button>
        <button
          type="button"
          className="companion-titlebar-btn"
          onClick={() => window.close()}
          title="关闭"
        >
          <X size={14} />
        </button>
      </div>
      <div ref={containerRef} className="companion-stage" />
    </div>
  );
}
