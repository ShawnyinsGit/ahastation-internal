import { useEffect, useState } from 'react';
import type { BackendInfo } from '../types';

interface OnboardingModalProps {
  backends: BackendInfo[];
  /** 已恢复/进行中的会话数（作为「项目」发现数）。 */
  projectCount: number;
  onFinish: () => void;
}

type Step = 'welcome' | 'scan' | 'results' | 'done';

const SCAN_LINES = [
  '枚举本机已配置的 AI 客户端…',
  '检查各客户端登录态与能力门…',
  '汇总可恢复会话与任务…',
];

/**
 * P8 首次启动引导（04 动线 1 / 03 §5）：欢迎 → 只读扫描 → 发现结果 →
 * 落地会议模式。全程零权限请求。观察层（M7）未建，「扫描」首版对接
 * 真实 backends/sessions 枚举；外部会话发现接入后替换数据源。
 */
export function OnboardingModal({ backends, projectCount, onFinish }: OnboardingModalProps) {
  const [step, setStep] = useState<Step>('welcome');
  const [scanLine, setScanLine] = useState(0);

  useEffect(() => {
    if (step !== 'scan') return;
    setScanLine(0);
    const timer = window.setInterval(() => {
      setScanLine((n) => {
        if (n >= SCAN_LINES.length) {
          window.clearInterval(timer);
          window.setTimeout(() => setStep('results'), 350);
          return n;
        }
        return n + 1;
      });
    }, 420);
    return () => window.clearInterval(timer);
  }, [step]);

  const readyBackends = backends.filter((b) => b.available);
  const authedCount = backends.filter((b) => b.loggedIn || b.hasApiKey || b.authMode === 'none').length;

  return (
    <div className="aha-onboarding">
      <div className="aha-ob-card">
        {step === 'welcome' && (
          <>
            <div className="aha-ob-logo">✦</div>
            <h2 className="aha-ob-title">欢迎使用 AhaStudio</h2>
            <p className="aha-ob-text">
              在一台设备、一场会议里调度所有 AI 任务——Task 是一级对象，会议与任务是同一份真相的两个视图。
            </p>
            <p className="aha-ob-note">首次启动不请求任何写权限、不要求登录、不要求 API Key。</p>
            <button type="button" className="aha-btn aha-btn-primary aha-ob-primary" onClick={() => setStep('scan')}>
              开始
            </button>
          </>
        )}

        {step === 'scan' && (
          <>
            <div className="aha-ob-scan-ring" />
            <p className="aha-ob-text">正在只读扫描本机 AI 环境…</p>
            <ul className="aha-ob-scan-lines">
              {SCAN_LINES.slice(0, scanLine).map((line) => (
                <li key={line}>✓ {line}</li>
              ))}
            </ul>
            <p className="aha-ob-note">只读枚举，无需授权</p>
          </>
        )}

        {step === 'results' && (
          <>
            <h2 className="aha-ob-title">扫描完成</h2>
            <div className="aha-ob-stats">
              <div className="aha-ob-stat"><strong className="aha-tnum">{readyBackends.length}</strong><span>个客户端</span></div>
              <div className="aha-ob-stat"><strong className="aha-tnum">{projectCount}</strong><span>个项目</span></div>
              <div className="aha-ob-stat"><strong className="aha-tnum">{authedCount > 0 ? authedCount : '—'}</strong><span>凭证就绪</span></div>
            </div>
            <p className="aha-ob-text">
              {readyBackends.length > 0
                ? `发现 ${readyBackends.map((b) => b.displayName).slice(0, 4).join('、')}。外部会话观察（M7）上线后，这里还会展示你在别处开的 AI 会话。`
                : '还没有配置任何 AI 客户端——可以稍后在设置中添加。'}
            </p>
            <button type="button" className="aha-btn aha-btn-primary aha-ob-primary" onClick={() => setStep('done')}>
              进入 AhaStudio
            </button>
          </>
        )}

        {step === 'done' && (
          <>
            <div className="aha-ob-logo aha-ob-logo-done">✓</div>
            <h2 className="aha-ob-title">一切就绪</h2>
            <p className="aha-ob-text">
              默认进入会议模式——Host Agent 是你的 AI 工作助理。顶栏「任务」视图一屏看全全部任务，权限将随使用场景逐步请求。
            </p>
            <button type="button" className="aha-btn aha-btn-primary aha-ob-primary" onClick={onFinish}>
              开始使用
            </button>
          </>
        )}
      </div>
    </div>
  );
}
