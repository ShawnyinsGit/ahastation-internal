import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { meetingStore, type DeliverySnapshot, type HostGroupState, type WorkerState } from '../lib/meeting-store';
import type { SpeakHandle } from '../lib/speech-session';
import type {
  CoordinatorBriefing,
  FinalMeetingDecision,
  MeetingDelivery,
  MeetingPlan,
  PlanMeetingTaskInput,
  StagedAttachment,
} from '../types';

export interface UseWorkersResult {
  workers: Map<string, WorkerState>;
  workerList: WorkerState[];
  hostGroups: Map<string, HostGroupState>;
  coordinatorHostId: string;
  plan: MeetingPlan | null;
  pendingPlan: PlanMeetingTaskInput[] | null;
  running: boolean;
  cwd: string | null;
  lastError: string | null;
  currentDelivery: DeliverySnapshot | null;
  deliveryHistory: DeliverySnapshot[];
  finalMeetingDelivery: MeetingDelivery | null;
  finalMeetingDecision: FinalMeetingDecision | null;
  coordinatorBriefings: CoordinatorBriefing[];
  savedDocuments: string[];
  restartSession: () => Promise<void>;
  sendText: (text: string) => Promise<void>;
  sendImage: (dataUrl: string, caption: string) => Promise<void>;
  sendAttachments: (staged: StagedAttachment[], text: string) => Promise<{ ok: boolean; error?: string }>;
  publishDroppedFiles: (files: File[]) => void;
  onDroppedFiles: (cb: (files: File[]) => void) => () => void;
  resolvePermission: (id: string, decision: 'allow' | 'deny') => Promise<void>;
  interrupt: () => Promise<void>;
  endSession: () => Promise<void>;
  setSpeakCallback: (cb: SpeakHandle | null) => void;
  acceptDelivery: () => Promise<{ ok: true } | { ok: false; error: string }>;
  reviseDelivery: (feedback: string) => Promise<
    | { ok: true; route: 'worker' | 'talker'; queued?: boolean }
    | { ok: false; error: string }
  >;
  acceptFinalMeetingDelivery: () => Promise<{ ok: true } | { ok: false; error: string }>;
  requestFinalMeetingRework: (reason: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  decidePendingPlan: (
    approved: boolean,
    tasks?: PlanMeetingTaskInput[],
  ) => Promise<{ ok: boolean; error?: string }>;
  toggleHostGroupCollapsed: (hostId: string) => void;
  addHostGroup: (backendId: string) => Promise<{ ok: boolean; hostId?: string; error?: string }>;
  removeHostGroup: (hostId: string) => Promise<{ ok: boolean; error?: string }>;
  setCoordinator: (hostId: string) => Promise<{ ok: boolean; error?: string }>;
  restartHost: (hostId: string) => Promise<{ ok: boolean; error?: string }>;
  syncDefaultBackend: (backendId: string) => void;
}

export function useWorkers(): UseWorkersResult {
  const state = useSyncExternalStore(meetingStore.subscribe, meetingStore.getSnapshot);
  // cwd changes when the active tab flips — subscribe to the tab listener too
  // so consumers re-render on tab switches without dragging cwd into the
  // active-slot state shape.
  const cwd = useSyncExternalStore(meetingStore.subscribeTabs, meetingStore.getActiveCwd);

  const workerList = useMemo(() => Array.from(state.workers.values()), [state.workers]);

  const setSpeakCallback = useCallback((cb: SpeakHandle | null) => {
    meetingStore.setSpeakCallback(cb);
  }, []);

  const restartSession = useCallback(() => meetingStore.restartSession(), []);
  const sendText = useCallback((text: string) => meetingStore.sendText(text), []);
  const sendImage = useCallback((dataUrl: string, caption: string) => meetingStore.sendImage(dataUrl, caption), []);
  const sendAttachments = useCallback(
    (staged: StagedAttachment[], text: string) => meetingStore.sendAttachments(staged, text),
    [],
  );
  const publishDroppedFiles = useCallback((files: File[]) => meetingStore.publishDroppedFiles(files), []);
  const onDroppedFiles = useCallback(
    (cb: (files: File[]) => void) => meetingStore.onDroppedFiles(cb),
    [],
  );
  const resolvePermission = useCallback(
    (id: string, decision: 'allow' | 'deny') => meetingStore.resolvePermission(id, decision),
    [],
  );
  const interrupt = useCallback(() => meetingStore.interrupt(), []);
  const endSession = useCallback(() => meetingStore.endSession(), []);
  const acceptDelivery = useCallback(() => meetingStore.acceptDelivery(), []);
  const reviseDelivery = useCallback(
    (feedback: string) => meetingStore.reviseDelivery(feedback),
    [],
  );
  const acceptFinalMeetingDelivery = useCallback(
    () => meetingStore.acceptFinalMeetingDelivery(),
    [],
  );
  const requestFinalMeetingRework = useCallback(
    (reason: string) => meetingStore.requestFinalMeetingRework(reason),
    [],
  );
  const decidePendingPlan = useCallback(
    (approved: boolean, tasks?: PlanMeetingTaskInput[]) =>
      meetingStore.decidePendingPlan(approved, tasks),
    [],
  );
  const toggleHostGroupCollapsed = useCallback(
    (hostId: string) => meetingStore.toggleHostGroupCollapsed(hostId),
    [],
  );
  const addHostGroup = useCallback(
    (backendId: string) => meetingStore.addHostGroup(backendId),
    [],
  );
  const removeHostGroup = useCallback(
    (hostId: string) => meetingStore.removeHostGroup(hostId),
    [],
  );
  const setCoordinator = useCallback((hostId: string) => meetingStore.setCoordinator(hostId), []);
  const restartHost = useCallback((hostId: string) => meetingStore.restartHost(hostId), []);
  const syncDefaultBackend = useCallback(
    (backendId: string) => meetingStore.syncDefaultBackend(backendId),
    [],
  );

  return {
    workers: state.workers,
    workerList,
    hostGroups: state.hostGroups,
    coordinatorHostId: state.coordinatorHostId,
    plan: state.plan,
    pendingPlan: state.pendingPlan,
    running: state.running,
    cwd,
    lastError: state.lastError,
    currentDelivery: state.currentDelivery,
    deliveryHistory: state.deliveryHistory,
    finalMeetingDelivery: state.finalMeetingDelivery,
    finalMeetingDecision: state.finalMeetingDecision,
    coordinatorBriefings: state.coordinatorBriefings,
    savedDocuments: state.savedDocuments,
    restartSession,
    sendText,
    sendImage,
    sendAttachments,
    publishDroppedFiles,
    onDroppedFiles,
    resolvePermission,
    interrupt,
    endSession,
    setSpeakCallback,
    acceptDelivery,
    reviseDelivery,
    acceptFinalMeetingDelivery,
    requestFinalMeetingRework,
    decidePendingPlan,
    toggleHostGroupCollapsed,
    addHostGroup,
    removeHostGroup,
    setCoordinator,
    restartHost,
    syncDefaultBackend,
  };
}
