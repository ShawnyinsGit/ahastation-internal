import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useClaude } from './hooks/useClaude';
import { useWorkers } from './hooks/useWorkers';
import { useTabs } from './hooks/useTabs';
import { useScreenShare } from './hooks/useScreenShare';
import { useBrowser } from './hooks/useBrowser';
import { useStageWindows } from './hooks/useStageWindows';
import { useElapsedSeconds } from './hooks/useTimer';
import { cancelSpeech, isSpeechActive } from './hooks/useSpeech';
import { useAsr } from './hooks/useAsr';
import { useVoiceLock } from './hooks/useVoiceLock';
import { useVoicePreferences } from './hooks/useVoicePreferences';
import { useSpacebarMute } from './hooks/useSpacebarMute';
import { useTtsWiring } from './hooks/useTtsWiring';
import { useDragAndDrop } from './hooks/useDragAndDrop';
import { meetingStore } from './lib/meeting-store';
import { Lobby } from './components/Lobby';
import { TabStrip } from './components/TabStrip';
import { MeetingHeader } from './components/MeetingHeader';
import { ParticipantTile } from './components/ParticipantTile';
import { ScreenStage } from './components/ScreenStage';
import { SourcePicker } from './components/SourcePicker';
import { BottomToolbar } from './components/BottomToolbar';
import { SideDrawer } from './components/SideDrawer';
import { SettingsMenu } from './components/SettingsMenu';
import { VoiceGuideModal } from './components/VoiceGuideModal';
import { ParticipantPanel } from './components/ParticipantPanel';
import type { AutoApproveScope, BackendInfo, DesktopSource, SkillInfo } from './types';

export function App() {
  const { state, restartSession, sendText, sendImage, sendAttachments, publishDroppedFiles, onDroppedFiles, resolvePermission, interrupt, setSpeakCallback } = useClaude();
  const workers = useWorkers();
  const tabs = useTabs();
  const { state: share, start: startShare, startSystemPicker, stop: stopShare, captureFrame, videoRef } = useScreenShare();
  const browser = useBrowser();
  const stageWindows = useStageWindows();

  const activeTab = useMemo(() => tabs.find((t) => t.isActive) ?? null, [tabs]);
  const hasTabs = tabs.length > 0;
  const hasLiveTab = !!(activeTab && !activeTab.placeholder);
  const activeOpenedAt = activeTab?.openedAt ?? null;

  const [drawerOpen, setDrawerOpen] = useState(true);
  const [ttsOn, setTtsOn] = useState(true);
  const [muted, setMuted] = useState(false);
  const [autoApproveScope, setAutoApproveScope] = useState<AutoApproveScope>('off');
  const [multiAgent, setMultiAgent] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [aiSpeaking, setAiSpeaking] = useState(false);
  const [viewingFile, setViewingFile] = useState<{ relativePath: string } | null>(null);
  const [openParticipantsTab, setOpenParticipantsTab] = useState(false);
  const [backends, setBackends] = useState<BackendInfo[]>([]);
  const [mutedHostIds, setMutedHostIds] = useState<Set<string>>(new Set());
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const elapsed = useElapsedSeconds(activeOpenedAt);

  useEffect(() => {
    if (!activeTab || activeTab.placeholder) return;
    void window.vibeMeet.setOrchestrationMode(activeTab.id, multiAgent);
  }, [activeTab?.id, activeTab?.placeholder, multiAgent]);

  // Load available backends for the participants tab
  useEffect(() => {
    window.vibeMeet.backendAuth.list().then(setBackends).catch(() => setBackends([]));
    window.vibeMeet.skills.list().then((res) => {
      if (res.ok) setSkills(res.skills);
    }).catch(() => {});
  }, []);

  // Reload backends when main window regains focus (e.g. settings window closed)
  useEffect(() => {
    const onFocus = () => {
      window.vibeMeet.backendAuth.list().then(setBackends).catch(() => {});
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);

  const activeBackendIds = useMemo(() => {
    const ids = new Set<string>();
    for (const [, hg] of workers.hostGroups) ids.add(hg.backendId);
    return ids;
  }, [workers.hostGroups]);

  // Sync the meeting store's default host group with the actual default backend
  useEffect(() => {
    const defaultBackend = backends.find((b) => b.isDefault);
    if (defaultBackend) {
      workers.syncDefaultBackend(defaultBackend.id);
    }
  }, [backends, workers]);

  // Map backendId → custom avatar data URL for participant panel rendering
  const customAvatars = useMemo(() => {
    const map = new Map<string, string | null>();
    for (const b of backends) {
      if (b.customAvatar) map.set(b.iconId, b.customAvatar);
    }
    return map;
  }, [backends]);

  const speakingRef = useRef(false);
  const sendWithModeRef = useRef<(text: string) => void>(sendText);

  const voiceLock = useVoiceLock({ muted, setMuted, setAiSpeaking, speakingRef });
  const voicePrefs = useVoicePreferences();
  useSpacebarMute(muted, setMuted);
  useTtsWiring({ ttsOn, speakingRef, setAiSpeaking, setSpeakCallback });
  const dragDrop = useDragAndDrop({
    publishDroppedFiles,
    onFilesDropped: () => setDrawerOpen(true),
  });

  // aiSpeaking safety-net: clears stuck state when TTS controller drains
  useEffect(() => {
    if (!aiSpeaking) return;
    const id = window.setInterval(() => {
      if (speakingRef.current && !isSpeechActive()) {
        speakingRef.current = false;
        setAiSpeaking(false);
      }
    }, 300);
    return () => window.clearInterval(id);
  }, [aiSpeaking]);

  // Reset the participants-tab signal once SideDrawer has consumed it
  useEffect(() => {
    if (openParticipantsTab && drawerOpen) {
      setOpenParticipantsTab(false);
    }
  }, [openParticipantsTab, drawerOpen]);

  useEffect(() => {
    meetingStore.hydrateRestore().catch((err) => {
      console.error('[App] hydrateRestore failed:', err);
    });
  }, []);

  // Auto-open delivery files as individual top-level tabs when a new delivery arrives
  const lastDeliveryTaskId = useRef<string | null>(null);
  useEffect(() => {
    const delivery = workers.currentDelivery;
    if (!delivery) return;
    if (delivery.taskId === lastDeliveryTaskId.current) return;
    lastDeliveryTaskId.current = delivery.taskId;
    // Open each delivery file as its own independent top-level tab
    // Use the snapshot path (inside deliveries/) when available so files
    // are always read from the project directory, not external locations.
    const cwd = state.cwd;
    for (const f of delivery.files) {
      const filePath = f.snapshotRelativePath && cwd
        ? `${cwd}/${f.snapshotRelativePath}`
        : f.path;
      stageWindows.openFile(filePath);
    }
  }, [workers.currentDelivery, stageWindows, state.cwd]);

  // Auto-open saved documents (from save_document MCP tool) as file tabs
  const lastSavedDocCount = useRef(0);
  useEffect(() => {
    const docs = workers.savedDocuments;
    if (docs.length <= lastSavedDocCount.current) return;
    // Only open new documents (the ones added since last check)
    const newDocs = docs.slice(lastSavedDocCount.current);
    lastSavedDocCount.current = docs.length;
    for (const path of newDocs) {
      stageWindows.openFile(path);
    }
  }, [workers.savedDocuments, stageWindows]);

  const micEnabled = hasLiveTab || voiceLock.enrollmentActive;

  const onVoiceFinal = useCallback(async (text: string) => {
    const id = meetingStore.getActiveId();
    if (!id) {
      console.warn('[voice] dropped — no active session');
      return;
    }
    let finalText = text;
    if (voicePrefs.voicePolishEnabled) {
      try {
        const result = await window.vibeMeet.polishAsrText(text);
        if (result.ok) finalText = result.text;
      } catch (err) {
        console.warn('[voice] polishAsrText IPC failed:', err);
      }
    }
    // Fuzzy match skill names from voice input — if spoken text contains a
    // skill name, prepend "/" to invoke it as a slash command.
    if (skills.length > 0 && !finalText.startsWith('/')) {
      const lower = finalText.toLowerCase();
      let bestMatch: SkillInfo | null = null;
      let bestScore = 0;
      for (const skill of skills) {
        const nameLower = skill.name.toLowerCase();
        // Check for exact substring match
        if (lower.includes(nameLower)) {
          const score = nameLower.length;
          if (score > bestScore) {
            bestScore = score;
            bestMatch = skill;
          }
        }
        // Check for fuzzy match: remove spaces and dashes for comparison
        const normalized = lower.replace(/[\s_-]/g, '');
        const nameNormalized = nameLower.replace(/[\s_-]/g, '');
        if (normalized.includes(nameNormalized)) {
          const score = nameNormalized.length;
          if (score > bestScore) {
            bestScore = score;
            bestMatch = skill;
          }
        }
      }
      if (bestMatch) {
        // Remove the matched skill name from the text and prepend the slash command
        const nameLower = bestMatch.name.toLowerCase();
        const idx = lower.indexOf(nameLower);
        if (idx >= 0) {
          const before = finalText.slice(0, idx).trim();
          const after = finalText.slice(idx + bestMatch.name.length).trim();
          const remaining = [before, after].filter(Boolean).join(' ');
          finalText = remaining ? `/${bestMatch.name} ${remaining}` : `/${bestMatch.name}`;
        }
      }
    }
    // Fuzzy match backend names from voice input — if spoken text contains a
    // backend display name, prepend "@" to invoke it as a mention.
    const mentionableBackends = backends.filter((backend) => activeBackendIds.has(backend.id));
    if (mentionableBackends.length > 0 && !finalText.includes('@')) {
      const lower = finalText.toLowerCase();
      let bestBackend: BackendInfo | null = null;
      let bestBackendScore = 0;
      for (const backend of mentionableBackends) {
        const nameLower = backend.displayName.toLowerCase();
        // Check for exact substring match
        if (lower.includes(nameLower)) {
          const score = nameLower.length;
          if (score > bestBackendScore) {
            bestBackendScore = score;
            bestBackend = backend;
          }
        }
        // Check for fuzzy match: remove spaces and dashes for comparison
        const normalized = lower.replace(/[\s_-]/g, '');
        const nameNormalized = nameLower.replace(/[\s_-]/g, '');
        if (normalized.includes(nameNormalized)) {
          const score = nameNormalized.length;
          if (score > bestBackendScore) {
            bestBackendScore = score;
            bestBackend = backend;
          }
        }
      }
      if (bestBackend) {
        // Remove the matched backend name from the text and prepend the @mention
        const nameLower = bestBackend.displayName.toLowerCase();
        const idx = lower.indexOf(nameLower);
        if (idx >= 0) {
          const before = finalText.slice(0, idx).trim();
          const after = finalText.slice(idx + bestBackend.displayName.length).trim();
          const remaining = [before, after].filter(Boolean).join(' ');
          finalText = remaining ? `@${bestBackend.id} ${remaining}` : `@${bestBackend.id}`;
        }
      }
    }
    sendWithModeRef.current(finalText);
  }, [voicePrefs.voicePolishEnabled, skills, backends, activeBackendIds]);

  const onBargeIn = useCallback(() => {
    if (speakingRef.current) {
      cancelSpeech();
      meetingStore.markBargeIn();
      speakingRef.current = false;
      setAiSpeaking(false);
    }
  }, []);

  const {
    mode: asrMode,
    listening: effectiveListening,
    supported: micSupported,
    speechLevel,
    lastError: micError,
    status: micStatus,
    retryable: micRetryable,
    retry: retryMic,
  } = useAsr({
    enabled: micEnabled,
    onTranscript: onVoiceFinal,
    onBargeIn,
    paused: muted,
    suppressed: aiSpeaking,
    voiceLockEnabled: voiceLock.voiceLockEnabled,
    voicePrintEmbedding: voiceLock.voicePrintEmbedding,
    onVoiceLockReject: voiceLock.handleVoiceLockReject,
    tapSegment: voiceLock.enrollmentActive ? voiceLock.handleEnrollmentSegment : undefined,
  });

  useEffect(() => {
    meetingStore.setAutoApproveScope(autoApproveScope);
    void (async () => {
      const res = await window.vibeMeet.setAutoApprove(autoApproveScope);
      if (!res.ok || !state.running) return;
      const id = meetingStore.getActiveId();
      void window.vibeMeet.setPermissionMode(
        id,
        autoApproveScope !== 'off' ? 'bypassPermissions' : 'default',
      );
    })();
  }, [autoApproveScope, state.running]);

  useEffect(() => {
    if (autoApproveScope !== 'off' && state.pendingPermission) {
      void resolvePermission(state.pendingPermission.id, 'allow');
    }
  }, [autoApproveScope, state.pendingPermission, resolvePermission]);

  const leave = useCallback(async () => {
    cancelSpeech();
    speakingRef.current = false;
    setAiSpeaking(false);
    stopShare();
    const id = meetingStore.getActiveId();
    if (id) await meetingStore.closeTab(id);
  }, [stopShare]);

  const handlePickSource = useCallback(async (src: DesktopSource) => {
    await startShare(src.id, src.name);
  }, [startShare]);

  const toggleShare = useCallback(async () => {
    if (share.active) {
      stopShare();
      return;
    }
    try {
      const useSystem = await window.vibeMeet.useSystemPicker();
      if (useSystem) {
        await startSystemPicker();
      } else {
        setPickerOpen(true);
      }
    } catch {
      setPickerOpen(true);
    }
  }, [share.active, stopShare, startSystemPicker]);

  const handleSnapshot = useCallback(async () => {
    const dataUrl = captureFrame();
    if (!dataUrl) return;
    const caption = `Here is the current view of "${share.sourceName ?? 'my screen'}". Take a look and let me know what you see.`;
    await sendImage(dataUrl, caption);
  }, [captureFrame, sendImage, share.sourceName]);

  const handleToggleMuteHost = useCallback((hostId: string) => {
    setMutedHostIds((prev) => {
      const next = new Set(prev);
      if (next.has(hostId)) next.delete(hostId);
      else next.add(hostId);
      return next;
    });
  }, []);

  const handleRemoveHost = useCallback(async (hostId: string) => {
    if (hostId === 'default') return;
    await workers.removeHostGroup(hostId);
  }, [workers]);

  const handleSetCoordinator = useCallback(async (hostId: string) => {
    const result = await workers.setCoordinator(hostId);
    if (!result.ok) console.warn('[coordinator] transfer failed:', result.error);
  }, [workers]);

  const handleRestartHost = useCallback(async (hostId: string) => {
    const result = await workers.restartHost(hostId);
    if (!result.ok) console.warn('[host] reconnect failed:', result.error);
  }, [workers]);

  const handleOpenEditor = useCallback((backendId: string, hostId: string) => {
    const sessionId = activeTab?.id ?? 'default';
    const cwd = state.cwd || '.';
    const title = `${backendId} - ${hostId}`;
    void window.vibeMeet.openCodeEditor.open({
      backendId,
      hostId,
      sessionId,
      cwd,
      title,
    });
  }, [activeTab?.id, state.cwd]);

  const sendWithMode = useCallback(async (raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed) return;
    if (!multiAgent) {
      await sendText(trimmed);
      return;
    }
    const directive = `请把下面这段需求当作"多 Agent 并行"模式处理：先评估各子任务之间的依赖关系，再拆成多个相互独立（或按依赖排序）的子任务，**立即调用 plan_meeting 工具**一次性派发给多个 worker 并行执行。
- 仔细判断哪些任务可以并行、哪些有依赖（用 deps 字段标注）。
- 每个 task 给一个稳定的 kebab-case id、一句话标题、给 worker 看的完整 prompt。
- 拆完直接调工具，不要先问我确认。

需求：
${trimmed}`;
    await sendText(directive);
  }, [multiAgent, sendText]);

  sendWithModeRef.current = sendWithMode;

  const sendAttachmentsWithMode = useCallback(
    async (staged: Parameters<typeof sendAttachments>[0], raw: string) => {
      const trimmed = raw.trim();
      if (!multiAgent) {
        return sendAttachments(staged, trimmed);
      }
      const directive = trimmed.length > 0
        ? `请把下面这段需求和附带文档一起当作"多 Agent 并行"模式处理：评估依赖，拆任务，**调用 plan_meeting 工具**派发多个 worker 并行执行。

需求：
${trimmed}`
        : '请阅读附带的文档，按"多 Agent 并行"模式拆解：评估依赖，调用 plan_meeting 派发 worker。';
      return sendAttachments(staged, directive);
    },
    [multiAgent, sendAttachments],
  );

  if (!hasTabs) {
    return <Lobby lastError={state.lastError} />;
  }

  return (
    <div
      className={`mtg${dragDrop.dropActive ? ' mtg-dropping' : ''}`}
      onDragEnter={dragDrop.onDragEnter}
      onDragOver={dragDrop.onDragOver}
      onDragLeave={dragDrop.onDragLeave}
      onDrop={dragDrop.onDrop}
    >
      <TabStrip tabs={tabs} />
      <MeetingHeader
        cwd={state.cwd}
        elapsed={elapsed}
        autoApproveScope={autoApproveScope}
        onChangeAutoApproveScope={setAutoApproveScope}
        multiAgent={multiAgent}
        onToggleMultiAgent={() => setMultiAgent((v) => !v)}
        settingsSlot={
          <SettingsMenu badge={voiceLock.enrollmentActive} />
        }
      />

      <main className="mtg-main">
        <section className="stage-wrap">
          <ScreenStage
            share={share}
            videoRef={videoRef}
            onPickSource={() => setPickerOpen(true)}
            onStopShare={stopShare}
            workers={workers.workerList}
            hostGroups={workers.hostGroups}
            plan={workers.plan}
            running={state.running}
            aiSpeaking={aiSpeaking}
            galleryContent={
              <ParticipantPanel
                workers={workers.workerList}
                hostGroups={workers.hostGroups}
                customAvatars={customAvatars}
                mutedHostIds={mutedHostIds}
                aiSpeaking={aiSpeaking}
                onResolvePermission={resolvePermission}
                onToggleMuteHost={handleToggleMuteHost}
                onRemoveHost={handleRemoveHost}
                coordinatorHostId={workers.coordinatorHostId}
                onSetCoordinator={handleSetCoordinator}
                onRestartHost={handleRestartHost}
                onOpenParticipantsTab={() => {
                  setDrawerOpen(true);
                  setOpenParticipantsTab(true);
                }}
                onOpenEditor={handleOpenEditor}
                selfTile={
                  <ParticipantTile
                    name="You"
                    role="You"
                    initials="You"
                    variant="self"
                    speaking={effectiveListening && !muted}
                    muted={muted}
                    status={muted ? 'Muted' : effectiveListening ? 'Speaking' : 'Mic idle'}
                    ariaLabel="查看我派出的任务"
                  />
                }
              />
            }
            delivery={workers.currentDelivery}
            sessionId={activeTab?.id ?? null}
            onAcceptDelivery={() => { setViewingFile(null); workers.acceptDelivery(); }}
            onReviseDelivery={(fb: string) => { setViewingFile(null); return workers.reviseDelivery(fb); }}
            viewingFile={viewingFile}
            onCloseFileView={() => setViewingFile(null)}
            stageWindows={stageWindows.windows}
            activeWindowId={stageWindows.activeWindowId}
            onSelectWindow={stageWindows.setActiveWindow}
            onCloseWindow={stageWindows.closeWindow}
            onCreateWindow={stageWindows.createWindow}
            onPopOutWindow={(id: string) => {
              if (window.vibeMeet?.popoutStage) {
                const win = stageWindows.windows.find((w) => w.id === id);
                void window.vibeMeet.popoutStage(id, win?.type ?? 'activity');
              }
            }}
            onResolvePermission={resolvePermission}
            browserTabs={browser.state.tabs}
            browserActiveTabId={browser.state.activeTabId}
            browserViewportRef={browser.viewportRef}
            onBrowserOpenTab={() => browser.openTab()}
            onBrowserCloseTab={browser.closeTab}
            onBrowserSetActive={browser.setActiveTab}
            onBrowserNavigate={browser.navigate}
            onBrowserBack={browser.goBack}
            onBrowserForward={browser.goForward}
            onBrowserReload={browser.reload}
            customAvatars={customAvatars}
          />
        </section>

        <SideDrawer
          open={drawerOpen}
          transcript={state.transcript}
          activity={state.activity}
          pending={state.pendingPermission}
          onResolve={resolvePermission}
          onSend={sendWithMode}
          onSendAttachments={sendAttachmentsWithMode}
          onSubscribeDroppedFiles={onDroppedFiles}
          multiAgent={multiAgent}
          disabled={!state.running}
          sessionId={activeTab?.id ?? null}
          onViewFile={(path) => {
            setViewingFile({ relativePath: path });
            stageWindows.openFile(path);
          }}
          viewingFilePath={viewingFile?.relativePath ?? null}
          backends={backends}
          activeBackendIds={activeBackendIds}
          hostGroups={workers.hostGroups}
          onAddHost={(backendId) => {
            workers.addHostGroup(backendId);
            // Refresh backends after adding a host
            window.vibeMeet.backendAuth.list().then(setBackends).catch(() => setBackends([]));
          }}
          forceParticipantsTab={openParticipantsTab}
        />
      </main>

      <BottomToolbar
        muted={muted}
        onToggleMute={() => setMuted((v) => !v)}
        micSupported={micSupported}
        listening={effectiveListening}
        speechLevel={speechLevel}
        asrMode={asrMode}
        micStatus={micStatus}
        micRetryable={micRetryable}
        onRetryMic={retryMic}
        ttsOn={ttsOn}
        onToggleTts={() => setTtsOn((v) => !v)}
        sharing={share.active}
        onToggleShare={toggleShare}
        snapshotEnabled={share.active && state.running}
        onSnapshot={handleSnapshot}
        onInterrupt={interrupt}
        chatOpen={drawerOpen}
        onToggleChat={() => setDrawerOpen((v) => !v)}
        onLeave={leave}
      />

      <SourcePicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onPick={handlePickSource}
      />

      <VoiceGuideModal
        open={voicePrefs.guideOpen}
        onClose={voicePrefs.handleGuideClose}
        onDismissForever={voicePrefs.handleDismissForever}
      />

      {(state.lastError || micError) && (
        <div className="error-banner">
          <span className="error-banner__text">{state.lastError ?? micError}</span>
          {state.lastError && !state.running && (
            <button
              type="button"
              className="error-banner__reconnect"
              onClick={() => { void restartSession(); }}
            >
              Reconnect
            </button>
          )}
          {!state.lastError && micError && micRetryable && (
            <button
              type="button"
              className="error-banner__reconnect"
              onClick={retryMic}
            >
              Retry microphone
            </button>
          )}
        </div>
      )}
    </div>
  );
}
