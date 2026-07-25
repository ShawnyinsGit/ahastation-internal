import {
  memo,
  ReactNode,
  RefObject,
  useState,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  cloneElement,
  isValidElement,
} from 'react';
import type { ScreenShareState } from '../hooks/useScreenShare';
import type { DeliverySnapshot, HostGroupState, WorkerState } from '../lib/meeting-store';
import type {
  BrowserTabInfo,
  CommandRun,
  CoordinatorBriefing,
  FinalMeetingDecision,
  MeetingDelivery,
  MeetingPlan,
} from '../types';
import type { StageWindow, StageWindowType } from '../lib/stage-window-store';
import { computeWorkerCapacity } from '../lib/worker-capacity';
import { FileViewer } from './FileViewer';
import { BrowserStage } from './BrowserStage';
import { StageTabBar } from './StageTabBar';
import { TerminalPanel } from './TerminalPanel';
import { RealTerminal } from './RealTerminal';
import { WorkerWorkbench } from './WorkerWorkbench';
import { ActivityTabContent } from './ActivityTabContent';
import { DeliveryViewer } from './DeliveryViewer';
import { TaskInspector } from './TaskInspector';
import { FinalMeetingDelivery } from './FinalMeetingDelivery';

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
  finalMeetingDelivery: MeetingDelivery | null;
  finalMeetingDecision: FinalMeetingDecision | null;
  sessionId: string | null;
  /** Task the cross-project board asked us to open. `seq` changes on every
   *  request so re-picking the same task after closing the inspector works. */
  focusTask?: { taskId: string; seq: number } | null;
  onAcceptDelivery: () => Promise<{ ok: true } | { ok: false; error: string }>;
  onReviseDelivery: (feedback: string) => Promise<
    | { ok: true; route: 'worker' | 'talker'; queued?: boolean }
    | { ok: false; error: string }
  >;
  onAcceptFinalMeetingDelivery: () => Promise<{ ok: true } | { ok: false; error: string }>;
  onRequestFinalMeetingRework: (reason: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  viewingFile?: { relativePath: string } | null;
  onCloseFileView?: () => void;
  stageWindows: StageWindow[];
  activeWindowId: string | null;
  onSelectWindow: (id: string) => void;
  onCloseWindow: (id: string) => void;
  onCreateWindow: (type: StageWindowType, opts?: { workerId?: string; title?: string }) => void;
  onPopOutWindow?: (id: string) => void;
  onResolvePermission: (id: string, decision: 'allow' | 'deny') => Promise<{ ok: true } | { ok: false; error: string }> | void;
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

export const ScreenStage = memo(function ScreenStage({
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
  finalMeetingDelivery,
  finalMeetingDecision,
  sessionId,
  focusTask,
  onAcceptDelivery,
  onReviseDelivery,
  onAcceptFinalMeetingDelivery,
  onRequestFinalMeetingRework,
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
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  /** Bumped on every task open so the inspector returns to Overview even for the same taskId. */
  const [inspectorOpenSeq, setInspectorOpenSeq] = useState(0);
  const [inspectorHeight, setInspectorHeight] = useState(76);
  const [inspectorFullscreen, setInspectorFullscreen] = useState(false);
  const dragState = useRef<{ pointerId: number; startY: number } | null>(null);
  const suppressInspectorClick = useRef(false);

  /** Task requested by the cross-project board whose plan hasn't arrived yet.
   *  Suppresses the stale-selection sweep below during the switch. */
  const awaitingFocus = useRef<string | null>(null);

  const handleSelectTask = useCallback((id: string) => {
    awaitingFocus.current = null;
    setSelectedTaskId(id);
    setInspectorOpenSeq((seq) => seq + 1);
    setInspectorHeight(76);
    setInspectorFullscreen(false);
    if (activeWindowId !== ACTIVITY_TAB_ID) {
      onSelectWindow(ACTIVITY_TAB_ID);
    }
  }, [activeWindowId, onSelectWindow]);

  /** Open the docked Task Inspector from the Worker Workbench without switching
   *  the stage window away from the terminal - the TUI stays visible while the
   *  dock expands below for deep review (diff / verification / permissions). */
  const handleOpenInspectorFromWorkbench = useCallback((id: string) => {
    setSelectedTaskId(id);
    setInspectorOpenSeq((seq) => seq + 1);
    setInspectorHeight(76);
    setInspectorFullscreen(false);
  }, []);

  const handleSelectParticipant = useCallback((id: string) => {
    setSelectedParticipantId(id);
    // Worker tiles double as the in-meeting task picker now that TaskRail is
    // gone — open the inspector when the tile maps to a plan node.
    if ((plan?.nodes ?? []).some((node) => node.id === id)) {
      handleSelectTask(id);
      return;
    }
    if (activeWindowId !== ACTIVITY_TAB_ID) {
      onSelectWindow(ACTIVITY_TAB_ID);
    }
  }, [activeWindowId, onSelectWindow, plan, handleSelectTask]);

  useEffect(() => {
    if (!selectedTaskId) return;
    if ((plan?.nodes ?? []).some((node) => node.id === selectedTaskId)) {
      awaitingFocus.current = null;
      return;
    }
    // Switching projects from the board sets the selection before the target
    // session's plan swaps in, so hold the selection until its node lands.
    if (awaitingFocus.current === selectedTaskId) return;
    setSelectedTaskId(null);
  }, [plan, selectedTaskId]);

  // Depends on seq alone: the board can hand us the same taskId twice and the
  // inspector still has to come back up. Set awaitingFocus BEFORE selection so
  // the plan-sweep effect cannot clear the card during a cross-project switch
  // (handleSelectTask used to null the ref first, racing the hold).
  const focusSeq = focusTask?.seq;
  const focusTaskId = focusTask?.taskId;
  useEffect(() => {
    if (focusSeq === undefined || !focusTaskId) return;
    awaitingFocus.current = focusTaskId;
    setSelectedTaskId(focusTaskId);
    setInspectorOpenSeq((seq) => seq + 1);
    setInspectorHeight(76);
    setInspectorFullscreen(false);
    if (activeWindowId !== ACTIVITY_TAB_ID) {
      onSelectWindow(ACTIVITY_TAB_ID);
    }
  }, [focusSeq, focusTaskId, activeWindowId, onSelectWindow]);

  // Auto-open a stage terminal window when a terminal-mode worker spawns, so
  // the human can supervise the TUI without manually clicking each worker
  // card. Dedup by workerId so re-renders never reopen a window the user
  // closed; only running workers qualify (a worker that already failed before
  // we noticed it is left alone). backendId arrives with the first worker
  // event (the adapter's "终端 Claude 已启动" progress), which is what makes
  // the terminal-mode check reliable.
  const autoOpenedTerminals = useRef<Set<string>>(new Set());
  useEffect(() => {
    for (const w of workers) {
      if (w.role !== 'worker') continue;
      if (w.status !== 'running') continue;
      if (w.backendId !== 'claude-code-terminal') continue;
      if (autoOpenedTerminals.current.has(w.id)) continue;
      autoOpenedTerminals.current.add(w.id);
      void onCreateWindow('terminal', { workerId: w.id, title: w.title });
    }
  }, [workers, onCreateWindow]);

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
  const selectedTaskWorker = selectedTaskId
    ? workers.find((worker) => worker.role !== 'talker' && worker.id === selectedTaskId)
    : undefined;
  const capacity = useMemo(
    () => computeWorkerCapacity(plan?.nodes ?? []),
    [plan],
  );

  // For terminal stage windows, project the high-fidelity Bash command log.
  // When no workerId is specified, aggregate every worker chronologically.
  const terminalCommands = useMemo(() => {
    if (activeWindow?.type !== 'terminal') return [] as CommandRun[];
    if (activeWindow.workerId) {
      const target = workers.find(
        (w) => w.id === activeWindow.workerId || w.hostId === activeWindow.workerId,
      );
      return target?.commandLog ?? [];
    }
    const merged: CommandRun[] = [];
    for (const w of workers) {
      for (const run of w.commandLog ?? []) merged.push(run);
    }
    merged.sort((a, b) => a.startedAt - b.startedAt);
    return merged;
  }, [activeWindow, workers]);

  // Terminal-mode workers get a live interactive pty instead of the replay.
  const terminalPtyWorker = useMemo(() => {
    if (activeWindow?.type !== 'terminal' || !activeWindow.workerId) return undefined;
    const target = workers.find(
      (w) => w.id === activeWindow.workerId || w.hostId === activeWindow.workerId,
    );
    return target?.backendId === 'claude-code-terminal' ? target : undefined;
  }, [activeWindow, workers]);

  // When the terminal worker's own delivery arrives, show it in the workbench
  // sidebar instead of letting the global DeliveryViewer cover the stage - the
  // TUI stays visible so the human can keep supervising.
  const terminalOwnsDelivery = Boolean(
    terminalPtyWorker && delivery?.workerId === terminalPtyWorker.id,
  );
  const stageDeliveryCovered = Boolean(delivery) && !terminalOwnsDelivery;

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
    <div className={`stage ${stageClass}${selectedTaskId ? ' has-task-inspector' : ''}`}>
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
              ? cloneElement(galleryContent, {
                  onSelectParticipant: handleSelectParticipant,
                  onOpenTerminal: (workerId: string) => onCreateWindow('terminal', { workerId }),
                } as any)
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

          <div className="stage-content">
            {finalMeetingDelivery ? (
              <FinalMeetingDelivery
                delivery={finalMeetingDelivery}
                decision={finalMeetingDecision}
                onAccept={onAcceptFinalMeetingDelivery}
                onRequestRework={onRequestFinalMeetingRework}
              />
            ) : stageDeliveryCovered ? (
              <div className="stage-delivery-content">
                <DeliveryViewer
                  delivery={delivery!}
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
                onOpenTask={handleSelectTask}
              />
            )}

            {!stageDeliveryCovered && !finalMeetingDelivery && activeWindow?.type === 'browser' && browserViewportRef && onBrowserOpenTab && onBrowserCloseTab && onBrowserSetActive && onBrowserNavigate && onBrowserBack && onBrowserForward && onBrowserReload && (
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

            {!stageDeliveryCovered && !finalMeetingDelivery && activeWindow?.type === 'terminal' && (
              <div className="stage-terminal-content">
                {terminalPtyWorker ? (
                  <WorkerWorkbench
                    workerId={terminalPtyWorker.id}
                    sessionId={sessionId!}
                    onOpenInspector={handleOpenInspectorFromWorkbench}
                    onAcceptDelivery={onAcceptDelivery}
                    onReviseDelivery={onReviseDelivery}
                  />
                ) : (
                  <TerminalPanel commands={terminalCommands} />
                )}
              </div>
            )}

            {!stageDeliveryCovered && !finalMeetingDelivery && activeWindow?.type === 'file' && activeWindow.filePath && (
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

          {selectedTaskId && sessionId && (
            <div
              className={`task-inspector-dock${inspectorFullscreen ? ' is-task-inspector-fullscreen' : ''}`}
              style={{ '--task-inspector-height': `${inspectorHeight}dvh` } as React.CSSProperties}
            >
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
              <TaskInspector
                sessionId={sessionId}
                taskId={selectedTaskId}
                openSeq={inspectorOpenSeq}
                worker={selectedTaskWorker}
                onClose={() => setSelectedTaskId(null)}
                onResolvePermission={onResolvePermission}
              />
            </div>
          )}
        </>
      )}
    </div>
  );
});
