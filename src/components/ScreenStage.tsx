import {
  ReactNode,
  RefObject,
  useState,
  useCallback,
  useMemo,
  useRef,
  cloneElement,
  isValidElement,
} from 'react';
import type { ScreenShareState } from '../hooks/useScreenShare';
import type { DeliverySnapshot, HostGroupState, WorkerState } from '../lib/meeting-store';
import type { ActivityEntry, BrowserTabInfo, CoordinatorBriefing, MeetingPlan } from '../types';
import type { StageWindow, StageWindowType } from '../lib/stage-window-store';
import { FileViewer } from './FileViewer';
import { BrowserStage } from './BrowserStage';
import { StageTabBar } from './StageTabBar';
import { TerminalPanel } from './TerminalPanel';
import { ActivityTabContent } from './ActivityTabContent';
import { DeliveryViewer } from './DeliveryViewer';
import { TaskRail } from './TaskRail';

interface ScreenStageProps {
  share: ScreenShareState;
  videoRef: RefObject<HTMLVideoElement>;
  onPickSource: () => void;
  onStopShare: () => void;
  workers: WorkerState[];
  hostGroups: Map<string, HostGroupState>;
  plan: MeetingPlan | null;
  coordinatorBriefings: CoordinatorBriefing[];
  running: boolean;
  aiSpeaking: boolean;
  galleryContent: ReactNode;
  delivery: DeliverySnapshot | null;
  sessionId: string | null;
  onAcceptDelivery: () => Promise<{ ok: true } | { ok: false; error: string }>;
  onReviseDelivery: (feedback: string) => Promise<
    | { ok: true; route: 'worker' | 'talker'; queued?: boolean }
    | { ok: false; error: string }
  >;
  viewingFile?: { relativePath: string } | null;
  onCloseFileView?: () => void;
  stageWindows: StageWindow[];
  activeWindowId: string | null;
  onSelectWindow: (id: string) => void;
  onCloseWindow: (id: string) => void;
  onCreateWindow: (type: StageWindowType, opts?: { workerId?: string; title?: string }) => void;
  onPopOutWindow?: (id: string) => void;
  onResolvePermission: (id: string, decision: 'allow' | 'deny') => void;
  browserTabs?: BrowserTabInfo[];
  browserActiveTabId?: string | null;
  browserViewportRef?: RefObject<HTMLDivElement>;
  onBrowserOpenTab?: () => void;
  onBrowserCloseTab?: (id: string) => void;
  onBrowserSetActive?: (id: string) => void;
  onBrowserNavigate?: (tabId: string, url: string) => void;
  onBrowserBack?: (tabId: string) => void;
  onBrowserForward?: (tabId: string) => void;
  onBrowserReload?: (tabId: string) => void;
  /** Map of iconId → custom avatar data URL */
  customAvatars?: Map<string, string | null>;
}

const ACTIVITY_TAB_ID = 'activity-default';

export function ScreenStage({
  share,
  videoRef,
  onPickSource: _onPickSource,
  onStopShare,
  workers,
  hostGroups,
  plan,
  coordinatorBriefings,
  running,
  aiSpeaking = false,
  galleryContent,
  delivery,
  sessionId,
  onAcceptDelivery,
  onReviseDelivery,
  viewingFile,
  onCloseFileView,
  stageWindows,
  activeWindowId,
  onSelectWindow,
  onCloseWindow,
  onCreateWindow,
  onPopOutWindow,
  onResolvePermission,
  browserTabs = [],
  browserActiveTabId = null,
  browserViewportRef,
  onBrowserOpenTab,
  onBrowserCloseTab,
  onBrowserSetActive,
  onBrowserNavigate,
  onBrowserBack,
  onBrowserForward,
  onBrowserReload,
  customAvatars,
}: ScreenStageProps) {
  const [selectedParticipantId, setSelectedParticipantId] = useState<string | null>(null);
  const [inspectorHeight, setInspectorHeight] = useState(76);
  const [inspectorFullscreen, setInspectorFullscreen] = useState(false);
  const dragState = useRef<{ pointerId: number; startY: number } | null>(null);
  const suppressInspectorClick = useRef(false);

  const handleSelectParticipant = useCallback((id: string) => {
    setSelectedParticipantId(id);
    setInspectorHeight(76);
    setInspectorFullscreen(false);
    // Auto-switch to activity tab so the selection is visible
    if (activeWindowId !== ACTIVITY_TAB_ID) {
      onSelectWindow(ACTIVITY_TAB_ID);
    }
  }, [activeWindowId, onSelectWindow]);

  const handleInspectorPointerDown = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    dragState.current = { pointerId: event.pointerId, startY: event.clientY };
    suppressInspectorClick.current = false;
    event.currentTarget.setPointerCapture(event.pointerId);
  }, []);

  const handleInspectorPointerMove = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    if (dragState.current?.pointerId !== event.pointerId) return;
    if (Math.abs(event.clientY - dragState.current.startY) > 4) {
      suppressInspectorClick.current = true;
    }
    const next = Math.max(44, Math.min(100, ((window.innerHeight - event.clientY) / window.innerHeight) * 100));
    setInspectorHeight(next);
    setInspectorFullscreen(next >= 96);
  }, []);

  const finishInspectorDrag = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    if (dragState.current?.pointerId !== event.pointerId) return;
    dragState.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setInspectorHeight((current) => {
      if (current >= 88) {
        setInspectorFullscreen(true);
        return 100;
      }
      if (current <= 56) return 52;
      return 76;
    });
  }, []);

  const toggleInspectorFullscreen = useCallback(() => {
    setInspectorFullscreen((current) => {
      setInspectorHeight(current ? 76 : 100);
      return !current;
    });
  }, []);

  const activeWindow = stageWindows.find((w) => w.id === activeWindowId) ?? null;
  const isActivityTab = activeWindow?.type === 'activity' || activeWindowId === ACTIVITY_TAB_ID;
  const selectedIsWorker = Boolean(
    selectedParticipantId
    && workers.some((worker) => worker.role !== 'talker' && worker.id === selectedParticipantId),
  );
  const capacity = useMemo(() => {
    const nodes = plan?.nodes ?? [];
    const statusById = new Map(nodes.map((node) => [node.id, node.status]));
    const active = nodes.filter((node) => (
      node.status === 'running'
      || node.status === 'verifying'
      || node.status === 'reviewing'
      || node.status === 'awaiting-acceptance'
      || node.status === 'reworking'
    )).length;
    const waiting = nodes.filter((node) => (
      node.status === 'pending'
      && node.deps.every((dependencyId) => statusById.get(dependencyId) === 'accepted')
    )).length;
    return { active, waiting, saturated: active >= 4 && waiting > 0 };
  }, [plan]);

  // For terminal stage windows, find the worker whose activity should be
  // displayed. When no workerId is specified, aggregate all workers' Bash
  // activity so the terminal tab shows real command output instead of being
  // empty (talkers have `tools: []` and never produce Bash activity).
  const terminalActivity = useMemo(() => {
    if (activeWindow?.type !== 'terminal') return [];
    if (activeWindow.workerId) {
      // Match by worker id OR by hostId (gallery passes hostId when opening terminal)
      const target = workers.find(
        (w) => w.id === activeWindow.workerId || w.hostId === activeWindow.workerId,
      );
      return target?.activity ?? [];
    }
    // Aggregate all workers' Bash-related activity chronologically
    const bashEntries: ActivityEntry[] = [];
    for (const w of workers) {
      for (const a of w.activity) {
        if (a.title?.toLowerCase().includes('bash') || a.kind === 'tool-call' || a.kind === 'tool-result') {
          bashEntries.push(a);
        }
      }
    }
    bashEntries.sort((a, b) => a.ts - b.ts);
    return bashEntries;
  }, [activeWindow, workers]);

  const stageClass = share.active
    ? 'stage-sharing'
    : isActivityTab
      ? 'stage-default'
      : activeWindow?.type === 'browser'
        ? 'stage-browser'
        : activeWindow?.type === 'file'
          ? 'stage-file'
          : 'stage-default';

  return (
    <div className={`stage ${stageClass}`}>
      {share.active && (
        <>
          <video
            ref={videoRef}
            className="stage-video"
            autoPlay
            playsInline
            muted
          />
          <div className="stage-banner">
            <span className="stage-banner-dot" />
            Sharing your screen · {share.sourceName}
            <button className="stage-banner-stop" onClick={onStopShare}>Stop</button>
          </div>
        </>
      )}

      {share.error && !share.active && (
        <div className="stage-error-floating">{share.error}</div>
      )}

      {!share.active && (
        <>
          <div className="stage-gallery">
            {isValidElement(galleryContent)
              ? cloneElement(galleryContent, { onSelectParticipant: handleSelectParticipant } as any)
              : galleryContent}
          </div>

          {capacity.saturated && (
            <div className="stage-capacity-banner" role="status" aria-live="polite">
              <span>Worker 已满载（{capacity.active}/4）</span>
              <small>{capacity.waiting} 项任务正在等待执行名额；已运行任务不会被抢占。</small>
            </div>
          )}

          <StageTabBar
            windows={stageWindows}
            activeWindowId={activeWindowId}
            onSelect={onSelectWindow}
            onClose={onCloseWindow}
            onCreate={onCreateWindow}
            onPopOut={onPopOutWindow}
          />

          <TaskRail
            plan={plan}
            workers={workers}
            selectedId={selectedParticipantId}
            onSelect={handleSelectParticipant}
          />

          <div
            className={`stage-content${selectedIsWorker && !delivery ? ' has-task-inspector' : ''}${inspectorFullscreen ? ' is-task-inspector-fullscreen' : ''}`}
            style={selectedIsWorker && !delivery
              ? { '--task-inspector-height': `${inspectorHeight}dvh` } as React.CSSProperties
              : undefined}
          >
            {selectedIsWorker && !delivery && (
              <>
                <button
                  type="button"
                  className="task-inspector-drag-handle"
                  onPointerDown={handleInspectorPointerDown}
                  onPointerMove={handleInspectorPointerMove}
                  onPointerUp={finishInspectorDrag}
                  onPointerCancel={finishInspectorDrag}
                  onClick={() => {
                    if (suppressInspectorClick.current) {
                      suppressInspectorClick.current = false;
                      return;
                    }
                    toggleInspectorFullscreen();
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      toggleInspectorFullscreen();
                    } else if (event.key === 'ArrowUp') {
                      event.preventDefault();
                      setInspectorHeight((current) => Math.min(100, current + 12));
                    } else if (event.key === 'ArrowDown') {
                      event.preventDefault();
                      setInspectorFullscreen(false);
                      setInspectorHeight((current) => Math.max(44, current - 12));
                    } else if (event.key === 'Home') {
                      event.preventDefault();
                      setInspectorFullscreen(true);
                      setInspectorHeight(100);
                    } else if (event.key === 'End') {
                      event.preventDefault();
                      setInspectorFullscreen(false);
                      setInspectorHeight(52);
                    }
                  }}
                  aria-label={inspectorFullscreen ? '收起任务检查器' : '展开任务检查器至全屏'}
                  aria-valuemin={44}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(inspectorHeight)}
                >
                  <span aria-hidden />
                </button>
                <button
                  type="button"
                  className="task-inspector-close"
                  onClick={() => setSelectedParticipantId(null)}
                  aria-label="关闭任务检查器"
                >
                  ×
                </button>
              </>
            )}
            {delivery ? (
              <div className="stage-delivery-content">
                <DeliveryViewer
                  delivery={delivery}
                  sessionId={sessionId}
                  aiSpeaking={aiSpeaking}
                  onAccept={onAcceptDelivery}
                  onRevise={onReviseDelivery}
                />
              </div>
            ) : isActivityTab && (
              <ActivityTabContent
                workers={workers}
                hostGroups={hostGroups}
                plan={plan}
                coordinatorBriefings={coordinatorBriefings}
                running={running}
                aiSpeaking={aiSpeaking}
                onResolvePermission={onResolvePermission}
                selectedId={selectedParticipantId}
                onOpenInTerminal={(workerId) => onCreateWindow('terminal', { workerId })}
          customAvatars={customAvatars}
          sessionId={sessionId}
              />
            )}

            {!delivery && activeWindow?.type === 'browser' && browserViewportRef && onBrowserOpenTab && onBrowserCloseTab && onBrowserSetActive && onBrowserNavigate && onBrowserBack && onBrowserForward && onBrowserReload && (
              <div className="stage-browser-content">
                <BrowserStage
                  tabs={browserTabs}
                  activeTabId={browserActiveTabId}
                  viewportRef={browserViewportRef}
                  onOpenTab={onBrowserOpenTab}
                  onCloseTab={onBrowserCloseTab}
                  onSetActive={onBrowserSetActive}
                  onNavigate={onBrowserNavigate}
                  onBack={onBrowserBack}
                  onForward={onBrowserForward}
                  onReload={onBrowserReload}
                />
              </div>
            )}

            {!delivery && activeWindow?.type === 'terminal' && (
              <div className="stage-terminal-content">
                <TerminalPanel activity={terminalActivity} />
              </div>
            )}

            {!delivery && activeWindow?.type === 'file' && activeWindow.filePath && (
              <div className="stage-file-content">
                <FileViewer
                  relativePath={activeWindow.filePath}
                  sessionId={sessionId}
                  onClose={() => {
                    onCloseWindow(activeWindow.id);
                    onCloseFileView?.();
                  }}
                />
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
