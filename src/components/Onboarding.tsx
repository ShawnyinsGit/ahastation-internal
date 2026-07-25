// Onboarding.tsx — first-launch scan overlay + cold-start splash.
//
// Two modes:
//  - 'full':   first launch ever (no `aha.onboarded.v1` in localStorage) —
//              welcome → scan → results → done, following the UX-review
//              prototype (_design_docs/prototypes/ahastudio-ux-review-v3.html).
//  - 'splash': subsequent cold starts — the scan step only, no clicks. It
//              dismisses on the first observed snapshot (after a short beat so
//              it doesn't flash) and never stays longer than SPLASH_MAX_MS.
//
// The scan lines are REAL data from the observation layer (useObservedTasks),
// deduped by (clientKind, projectName) — nothing is mocked. Mounted only in
// the main window's App tree, so ?view=ahabar / settings / popout windows
// never see it.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useObservedTasks } from '../hooks/useObservedTasks';
import type { ObservedClientKind } from '../lib/observed-store';

export const ONBOARDED_STORAGE_KEY = 'ahastudio.onboarded';

export type OnboardingMode = 'full' | 'splash';

type Step = 'welcome' | 'scan' | 'results' | 'done';

interface OnboardingProps {
  mode: OnboardingMode;
  onFinish: (mode: OnboardingMode) => void;
}

const CLIENT_LABEL: Record<ObservedClientKind, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
};

const FIRST_LINE_MS = 400;
const LINE_STAGGER_MS = 300;
const MAX_SCAN_LINES = 6;
/** Full flow: let the lines play for at least this long before auto-advancing. */
const SCAN_MIN_MS = 2000;
/** Full flow: give up waiting for the first snapshot and offer 继续. */
const SCAN_NO_SNAPSHOT_MS = 6000;
/** Splash: show at least this long (so it reads as a beat, not a flash)… */
const SPLASH_MIN_MS = 1000;
/** …but never longer than this, snapshot or not. */
const SPLASH_MAX_MS = 2500;

interface Discovered {
  key: string;
  label: string;
}

export function Onboarding({ mode, onFinish }: OnboardingProps) {
  const [step, setStep] = useState<Step>(mode === 'splash' ? 'scan' : 'welcome');
  const observed = useObservedTasks();
  const snapshotArrived = observed.scannedAt > 0;

  // One scan line per (clientKind, projectName), in snapshot order.
  const discovered = useMemo<Discovered[]>(() => {
    const seen = new Set<string>();
    const out: Discovered[] = [];
    for (const session of observed.sessions) {
      const key = `${session.clientKind}|${session.projectName}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        key,
        label: `✓ 发现 ${CLIENT_LABEL[session.clientKind]} · ${session.projectName}`,
      });
    }
    return out;
  }, [observed]);

  // Real counts for the results / done steps, over boardable (non-noise)
  // sessions — same population the task board renders.
  const stats = useMemo(() => {
    const sessions = observed.sessions.filter((s) => !s.isNoise);
    const clients = [...new Set(sessions.map((s) => s.clientKind))];
    return {
      clientNames: clients.map((c) => CLIENT_LABEL[c]),
      activeTasks: sessions.filter((s) => s.state === 'active' || s.state === 'waiting').length,
      projects: new Set(sessions.map((s) => s.projectName)).size,
    };
  }, [observed]);

  const [elapsed, setElapsed] = useState(0);
  const advancedRef = useRef(false);

  // Scan-step clock: restarts every time the step is (re-)entered.
  useEffect(() => {
    if (step !== 'scan') return;
    const started = Date.now();
    setElapsed(0);
    advancedRef.current = false;
    const timer = window.setInterval(() => setElapsed(Date.now() - started), 100);
    return () => window.clearInterval(timer);
  }, [step]);

  // Lines reveal on a stagger: first at FIRST_LINE_MS, then every 300ms.
  const shownLineCount = Math.min(discovered.length, MAX_SCAN_LINES);
  const revealedCount = step === 'scan'
    ? Math.max(0, Math.min(shownLineCount, Math.floor((elapsed - FIRST_LINE_MS) / LINE_STAGGER_MS) + 1))
    : 0;
  const linesPlayed = revealedCount >= shownLineCount;

  useEffect(() => {
    if (step !== 'scan' || advancedRef.current) return;
    if (mode === 'splash') {
      if ((snapshotArrived && elapsed >= SPLASH_MIN_MS) || elapsed >= SPLASH_MAX_MS) {
        advancedRef.current = true;
        onFinish(mode);
      }
      return;
    }
    // Full flow: advance once a snapshot has arrived AND the lines have played.
    if (snapshotArrived && elapsed >= SCAN_MIN_MS && linesPlayed) {
      advancedRef.current = true;
      setStep('results');
    }
  }, [step, mode, snapshotArrived, elapsed, linesPlayed, onFinish]);

  const noSnapshotTimeout = step === 'scan' && !snapshotArrived && elapsed >= SCAN_NO_SNAPSHOT_MS;

  return (
    <div className="onboarding-overlay" role="dialog" aria-modal="true" aria-label="首次启动引导">
      <div className="ob-card">
        {step === 'welcome' && (
          <div className="ob-step">
            <div className="ob-logo">✦</div>
            <h2>欢迎使用 AhaStudio</h2>
            <p>在一个地方关注和控制所有 AI 任务——Task 是一级对象，Project 只是分组维度。</p>
            <p className="ob-note">首次启动不请求任何写权限、不要求登录、不要求 API Key。</p>
            <button type="button" className="ob-primary" onClick={() => setStep('scan')}>
              开始
            </button>
          </div>
        )}

        {step === 'scan' && (
          <div className="ob-step">
            <div className="ob-scan">
              <div className="scan-ring" />
              <p>观察层正在只读扫描本机 AI 会话…</p>
              <div className="scan-lines">
                {discovered.slice(0, revealedCount).map((line) => (
                  <div key={line.key} className="found">{line.label}</div>
                ))}
                {noSnapshotTimeout && (
                  <div className="found">未发现本机会话</div>
                )}
              </div>
              <p className="ob-note">只读观察，无需授权</p>
              {mode === 'full' && noSnapshotTimeout && (
                <button type="button" className="ob-primary" onClick={() => setStep('results')}>
                  继续
                </button>
              )}
            </div>
          </div>
        )}

        {step === 'results' && (
          <div className="ob-step">
            <h2>扫描完成</h2>
            <div className="ob-results">
              <div className="ob-stat"><strong>{stats.clientNames.length}</strong><span>个客户端</span></div>
              <div className="ob-stat"><strong>{stats.activeTasks}</strong><span>个活跃任务</span></div>
              <div className="ob-stat"><strong>{stats.projects}</strong><span>个项目</span></div>
            </div>
            <p>
              {stats.clientNames.length > 0
                ? `发现 ${stats.clientNames.join('、')}。`
                : '未发现本机 AI 客户端会话。'}
              AhaStudio 当前处于「观察中」级别，只读不回写。
            </p>
            <button type="button" className="ob-primary" onClick={() => setStep('done')}>
              进入 AhaStudio
            </button>
          </div>
        )}

        {step === 'done' && (
          <div className="ob-step">
            <div className="ob-logo">✓</div>
            <h2>一切就绪</h2>
            <p>
              默认进入会议模式——Host Agent 正在帮你看着 {stats.projects} 个项目的 {stats.activeTasks} 个任务。权限将随使用场景逐步请求。
            </p>
            <button type="button" className="ob-primary" onClick={() => onFinish(mode)}>
              开始使用
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
