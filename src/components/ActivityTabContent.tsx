import { useMemo, useCallback } from 'react';
import type { HostGroupState, WorkerState } from '../lib/meeting-store';
import type { CoordinatorBriefing, MeetingPlan } from '../types';
import { ClaudeWorkspace } from './ClaudeWorkspace';
import { UserTasksPanel } from './UserTasksPanel';

const USER_SLOT = 'user';

interface ActivityTabContentProps {
  workers: WorkerState[];
  hostGroups: Map<string, HostGroupState>;
  plan: MeetingPlan | null;
  coordinatorBriefings: CoordinatorBriefing[];
  running: boolean;
  aiSpeaking: boolean;
  onResolvePermission: (id: string, decision: 'allow' | 'deny') => void;
  /** Currently selected participant: 'user', a worker id, or null (defaults to first talker). */
  selectedId?: string | null;
  /** Called when the workspace internally changes selection (unused for now). */
  onSelectId?: (id: string | null) => void;
  onOpenInTerminal?: (workerId: string) => void;
  /** Map of iconId → custom avatar data URL */
  customAvatars?: Map<string, string | null>;
  sessionId?: string | null;
  /** Open the docked Task Inspector for a meeting-local task. */
  onOpenTask?: (taskId: string) => void;
}

export function ActivityTabContent({
  workers,
  hostGroups,
  plan,
  coordinatorBriefings,
  running,
  aiSpeaking,
  onResolvePermission,
  selectedId: externalSelectedId,
  onSelectId: _onSelectId,
  onOpenInTerminal,
  customAvatars,
  sessionId,
  onOpenTask,
}: ActivityTabContentProps) {
  const sortedWorkers = useMemo(() => {
    const statusPriority = (w: WorkerState): number => {
      if (w.role === 'talker') return 0;
      switch (w.status) {
        case 'running': return 1;
        case 'pending': return 2;
        case 'interrupted': return 3;
        case 'idle':    return 3;
        case 'done':    return 4;
        case 'failed':  return 4;
        default:        return 3;
      }
    };
    return [...workers].sort((a, b) => {
      const pa = statusPriority(a);
      const pb = statusPriority(b);
      if (pa !== pb) return pa - pb;
      const aTs = a.activity.length > 0 ? a.activity[0].ts : 0;
      const bTs = b.activity.length > 0 ? b.activity[0].ts : 0;
      if (aTs !== bTs) return aTs - bTs;
      return a.id.localeCompare(b.id);
    });
  }, [workers]);

  // Controlled selection: use external prop, fall back to first talker
  const selectedWorker = useMemo(() => {
    if (externalSelectedId === USER_SLOT) return null;
    if (externalSelectedId) {
      // Match by worker id OR by hostId (gallery passes hostId)
      return sortedWorkers.find((w) => w.id === externalSelectedId || w.hostId === externalSelectedId) ?? sortedWorkers[0] ?? null;
    }
    // Default: select first talker
    return sortedWorkers.find((w) => w.role === 'talker') ?? sortedWorkers[0] ?? null;
  }, [externalSelectedId, sortedWorkers]);

  const isUserSelected = externalSelectedId === USER_SLOT;

  // Resolve iconId and customAvatar from the worker's host group
  const { selectedIconId, selectedCustomAvatar } = useMemo(() => {
    if (!selectedWorker) return { selectedIconId: 'claude', selectedCustomAvatar: null };
    const hg = hostGroups.get(selectedWorker.hostId || 'default');
    const iconId = hg?.iconId ?? 'claude';
    return { selectedIconId: iconId, selectedCustomAvatar: customAvatars?.get(iconId) ?? null };
  }, [selectedWorker, hostGroups, customAvatars]);

  const handleOpenInTerminal = useCallback(() => {
    if (selectedWorker && onOpenInTerminal) {
      onOpenInTerminal(selectedWorker.id);
    }
  }, [selectedWorker, onOpenInTerminal]);

  return (
    <div className="activity-detail">
      {isUserSelected ? (
        <UserTasksPanel
          workers={workers}
          plan={plan}
          sessionId={sessionId}
          onOpenTask={onOpenTask}
        />
      ) : selectedWorker && (
        <ClaudeWorkspace
          key={selectedWorker.id}
          speaking={selectedWorker.role === 'talker' && aiSpeaking}
          awaitingPermission={Boolean(selectedWorker.pendingPermission)}
          running={running}
          transcript={selectedWorker.transcript}
          activity={selectedWorker.activity}
          name={selectedWorker.title}
          subtitle={selectedWorker.role === 'talker' ? 'Host · Talker' : 'Worker'}
          avatar={selectedWorker.role === 'talker' ? 'claude' : 'worker'}
          initial={selectedWorker.title.trim().slice(0, 1).toUpperCase()}
          iconId={selectedIconId}
          customAvatar={selectedCustomAvatar}
          hideHero
          task={
            selectedWorker.role === 'talker'
              ? (selectedWorker.lastText || 'Ready')
              : selectedWorker.title
          }
          taskStatus={
            selectedWorker.role === 'talker'
              ? (aiSpeaking ? 'speaking' : running ? 'running' : 'idle')
              : (selectedWorker.role === 'worker' && aiSpeaking ? 'speaking' : selectedWorker.status)
          }
          taskSpecialty={selectedWorker.role === 'talker' ? undefined : selectedWorker.specialty}
          taskDeps={selectedWorker.role === 'talker' ? undefined : selectedWorker.deps}
          taskHistory={selectedWorker.role === 'talker' ? undefined : selectedWorker.taskHistory}
          currentTool={selectedWorker.currentTool}
          currentToolInput={selectedWorker.currentToolInput}
          lastText={selectedWorker.lastText}
          startedAt={selectedWorker.startedAt}
          pendingPermissionTool={selectedWorker.pendingPermission?.toolName ?? null}
          backendId={selectedWorker.backendId}
          attempt={selectedWorker.attempt}
          workerEvents={selectedWorker.workerEvents}
          workReport={selectedWorker.workReport}
          coordinatorBriefings={selectedWorker.role === 'talker' ? coordinatorBriefings : undefined}
          onInterruptTask={
            selectedWorker.role === 'worker'
              && selectedWorker.status === 'running'
              && sessionId
              ? () => window.vibeMeet.interruptWorker(sessionId, selectedWorker.id)
              : undefined
          }
          onSteerTask={
            selectedWorker.role === 'worker'
              && selectedWorker.status === 'running'
              && sessionId
              ? (instruction) => window.vibeMeet.steerWorker(sessionId, selectedWorker.id, instruction)
              : undefined
          }
          onOpenWorkspace={
            selectedWorker.role === 'worker' && sessionId
              ? () => window.vibeMeet.documents.openExternal(sessionId, '.')
              : undefined
          }
          onOpenInTerminal={onOpenInTerminal ? handleOpenInTerminal : undefined}
          isTalker={selectedWorker.role === 'talker'}
          commandLog={selectedWorker.commandLog}
        />
      )}
    </div>
  );
}
