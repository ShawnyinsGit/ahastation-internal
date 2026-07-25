import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { Send, Paperclip, X, FileText, FileType, Image as ImageIcon, FileWarning, FolderOpen, Users, MessageSquare, Settings, Zap } from 'lucide-react';
import type {
  ActivityEntry,
  AttachmentKind,
  BackendInfo,
  PendingPermission,
  SkillInfo,
  StagedAttachment,
  TranscriptEntry,
} from '../types';
import type { HostGroupState } from '../lib/meeting-store';
import {
  DISPATCH_MODE_HINTS,
  DISPATCH_MODE_LABELS,
  type DispatchMode,
} from '../lib/dispatch-mode';
import { PermissionCard } from './PermissionCard';
import { FileTree } from './FileTree';
import { Modal } from './Modal';
import { toast } from '../lib/toast';

interface SideDrawerProps {
  open: boolean;
  transcript: TranscriptEntry[];
  activity: ActivityEntry[];
  pending: PendingPermission | null;
  /** Resolving flag for the legacy single permission card, sourced from the
   *  worker that owns `pending.id`. Keeps the drawer card in lock-step with
   *  WorkerCard and TaskInspector. */
  pendingResolving?: boolean;
  /** Permission IPC error for the legacy single permission card. */
  pendingError?: string | null;
  onResolve: (id: string, decision: 'allow' | 'deny') => Promise<{ ok: true } | { ok: false; error: string }> | void;
  onSend: (text: string) => void;
  onSendAttachments?: (
    staged: StagedAttachment[],
    text: string,
  ) => Promise<{ ok: boolean; error?: string }>;
  onSubscribeDroppedFiles?: (cb: (files: File[]) => void) => () => void;
  multiAgent?: boolean;
  dispatchMode?: DispatchMode;
  onChangeDispatchMode?: (mode: DispatchMode) => void;
  disabled: boolean;
  sessionId?: string | null;
  onViewFile?: (relativePath: string) => void;
  viewingFilePath?: string | null;
  backends?: BackendInfo[];
  activeBackendIds?: Set<string>;
  onAddHost?: (backendId: string) => void;
  forceParticipantsTab?: boolean;
  /** Host group map for resolving default host's backend name. */
  hostGroups?: Map<string, HostGroupState>;
}

const TIME_TICK_MS = 30_000;
const STAGED_MAX = 10;
const PER_FILE_MAX = 25 * 1024 * 1024;
const TOTAL_MAX = 50 * 1024 * 1024;

const ACCEPT_ATTR = [
  '.md', '.markdown', '.txt', '.log',
  '.json', '.jsonc',
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.go', '.rs', '.java', '.kt', '.swift',
  '.c', '.cc', '.cpp', '.h', '.hpp', '.cs', '.rb', '.php',
  '.css', '.scss', '.less', '.html', '.htm', '.xml', '.svg',
  '.yaml', '.yml', '.toml', '.ini', '.env',
  '.sh', '.bash', '.zsh', '.fish',
  '.sql', '.graphql', '.gql',
  '.csv', '.tsv',
  '.docx', '.pdf', '.pptx', '.xlsx', '.xls',
  'image/png', 'image/jpeg', 'image/webp',
].join(',');

type Tab = 'chat' | 'participants' | 'files';

const dotColor: Record<ActivityEntry['kind'], string> = {
  'tool-call': '#7cc6ff',
  'tool-result': '#9ae29a',
  system: '#c8c8c8',
  error: '#ff7a7a',
  document: '#5b8def',
};

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function formatMessageTime(ts: number, now: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return '';
  const diffMs = now - ts;
  if (diffMs < 60_000) return '刚刚';
  if (diffMs < 60 * 60_000) return `${Math.floor(diffMs / 60_000)} 分钟前`;
  const d = new Date(ts);
  const time = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  const sameDay = new Date(now).toDateString() === d.toDateString();
  return sameDay ? time : `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${time}`;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

const TEXT_EXTS = new Set([
  'md', 'markdown', 'txt', 'log', 'json', 'jsonc',
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs',
  'py', 'go', 'rs', 'java', 'kt', 'swift',
  'c', 'cc', 'cpp', 'h', 'hpp', 'cs', 'rb', 'php',
  'css', 'scss', 'less', 'html', 'htm', 'xml', 'svg',
  'yaml', 'yml', 'toml', 'ini', 'env',
  'sh', 'bash', 'zsh', 'fish',
  'sql', 'graphql', 'gql',
  'csv', 'tsv',
]);

function classifyKind(name: string, mime: string): AttachmentKind | null {
  const m = (mime || '').toLowerCase();
  if (m === 'application/pdf') return 'pdf';
  if (m === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return 'word';
  if (m === 'image/png' || m === 'image/jpeg' || m === 'image/jpg' || m === 'image/webp') return 'image';
  if (m.startsWith('text/') || m.startsWith('application/json') || m.startsWith('application/xml')) return 'text';
  const idx = name.lastIndexOf('.');
  if (idx < 0) return null;
  const ext = name.slice(idx + 1).toLowerCase();
  if (ext === 'docx') return 'word';
  if (ext === 'pdf') return 'pdf';
  if (ext === 'png' || ext === 'jpg' || ext === 'jpeg' || ext === 'webp') return 'image';
  if (TEXT_EXTS.has(ext)) return 'text';
  return null;
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      const idx = result.indexOf(',');
      resolve(idx >= 0 ? result.slice(idx + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'));
    reader.readAsDataURL(file);
  });
}

function uid(): string {
  return Math.random().toString(36).slice(2, 10);
}

function iconFor(kind: AttachmentKind) {
  if (kind === 'image') return <ImageIcon size={12} aria-hidden="true" />;
  if (kind === 'pdf') return <FileType size={12} aria-hidden="true" />;
  if (kind === 'word') return <FileType size={12} aria-hidden="true" />;
  return <FileText size={12} aria-hidden="true" />;
}

export function SideDrawer({
  open,
  transcript,
  activity,
  pending,
  pendingResolving,
  pendingError,
  onResolve,
  onSend,
  onSendAttachments,
  onSubscribeDroppedFiles,
  multiAgent = false,
  dispatchMode = 'direct',
  onChangeDispatchMode,
  disabled,
  sessionId,
  onViewFile,
  viewingFilePath,
  backends = [],
  activeBackendIds = new Set(),
  onAddHost,
  forceParticipantsTab,
  hostGroups,
}: SideDrawerProps) {
  const [tab, setTab] = useState<Tab>('chat');
  const [text, setText] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [now, setNow] = useState(() => Date.now());
  const [staged, setStaged] = useState<StagedAttachment[]>([]);
  const [previewImg, setPreviewImg] = useState<string | null>(null);
  const [rejected, setRejected] = useState<Array<{ id: string; name: string; reason: string }>>([]);
  const [staging, setStaging] = useState(false);
  const endRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // ── Slash command picker ───────────────────────────────────────────────
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [slashPickerOpen, setSlashPickerOpen] = useState(false);
  const [slashFilter, setSlashFilter] = useState('');
  const [slashSelectedIdx, setSlashSelectedIdx] = useState(0);
  const slashStartRef = useRef<number>(-1); // position of '/' in text

  // ── @mention picker for backends ───────────────────────────────────────
  const [mentionPickerOpen, setMentionPickerOpen] = useState(false);
  const [mentionFilter, setMentionFilter] = useState('');
  const [mentionSelectedIdx, setMentionSelectedIdx] = useState(0);
  const mentionStartRef = useRef<number>(-1); // position of '@' in text

  // Load skills list on mount
  useEffect(() => {
    window.vibeMeet.skills.list().then((res) => {
      if (res.ok) setSkills(res.skills);
    }).catch(() => {});
  }, []);

  const filteredSkills = useMemo(() => {
    if (!slashFilter) return skills;
    const lower = slashFilter.toLowerCase();
    return skills.filter((s) =>
      s.name.toLowerCase().includes(lower) ||
      s.description.toLowerCase().includes(lower)
    );
  }, [skills, slashFilter]);

  const filteredBackends = useMemo(() => {
    const participants = backends.filter((backend) => activeBackendIds.has(backend.id));
    if (!mentionFilter) return participants;
    const lower = mentionFilter.toLowerCase();
    return participants.filter((b) =>
      b.displayName.toLowerCase().includes(lower)
    );
  }, [activeBackendIds, backends, mentionFilter]);

  const handleSlashSelect = useCallback((skill: SkillInfo) => {
    const before = text.slice(0, slashStartRef.current);
    const after = text.slice(slashStartRef.current + 1 + slashFilter.length);
    const newText = `${before}/${skill.name} ${after}`;
    setText(newText);
    setSlashPickerOpen(false);
    setSlashFilter('');
    slashStartRef.current = -1;
    // Focus textarea after selection
    setTimeout(() => textareaRef.current?.focus(), 0);
  }, [text, slashFilter]);

  const handleMentionSelect = useCallback((backend: BackendInfo) => {
    const before = text.slice(0, mentionStartRef.current);
    const after = text.slice(mentionStartRef.current + 1 + mentionFilter.length);
    const newText = `${before}@${backend.id} ${after}`;
    setText(newText);
    setMentionPickerOpen(false);
    setMentionFilter('');
    mentionStartRef.current = -1;
    // Focus textarea after selection
    setTimeout(() => textareaRef.current?.focus(), 0);
  }, [text, mentionFilter]);

  const handleTextChange = useCallback((newText: string) => {
    setText(newText);
    const cursorPos = textareaRef.current?.selectionStart ?? newText.length;
    const beforeCursor = newText.slice(0, cursorPos);

    // Detect slash command: '/' at start or after whitespace
    const lastSlash = beforeCursor.lastIndexOf('/');
    if (lastSlash >= 0) {
      const charBefore = lastSlash > 0 ? beforeCursor[lastSlash - 1] : ' ';
      // Slash must be at start or after whitespace
      if (lastSlash === 0 || /\s/.test(charBefore)) {
        const afterSlash = beforeCursor.slice(lastSlash + 1);
        // No space between slash and cursor = still typing the command
        if (!/\s/.test(afterSlash)) {
          slashStartRef.current = lastSlash;
          setSlashFilter(afterSlash);
          setSlashPickerOpen(true);
          setSlashSelectedIdx(0);
          // Close mention picker if open
          setMentionPickerOpen(false);
          mentionStartRef.current = -1;
          return;
        }
      }
    }
    setSlashPickerOpen(false);
    slashStartRef.current = -1;

    // Detect @mention: '@' at start or after whitespace
    const lastMention = beforeCursor.lastIndexOf('@');
    if (lastMention >= 0) {
      const charBefore = lastMention > 0 ? beforeCursor[lastMention - 1] : ' ';
      // @ must be at start or after whitespace
      if (lastMention === 0 || /\s/.test(charBefore)) {
        const afterMention = beforeCursor.slice(lastMention + 1);
        // No space between @ and cursor = still typing the mention
        if (!/\s/.test(afterMention)) {
          mentionStartRef.current = lastMention;
          setMentionFilter(afterMention);
          setMentionPickerOpen(true);
          setMentionSelectedIdx(0);
          return;
        }
      }
    }
    setMentionPickerOpen(false);
    mentionStartRef.current = -1;
  }, []);

  useEffect(() => {
    if (viewingFilePath) setTab('files');
  }, [viewingFilePath]);

  useEffect(() => {
    if (forceParticipantsTab) setTab('participants');
  }, [forceParticipantsTab]);

  useEffect(() => {
    if (tab !== 'chat') return;
    const id = window.setInterval(() => setNow(Date.now()), TIME_TICK_MS);
    return () => window.clearInterval(id);
  }, [tab]);

  // Resolve hostId → display name from backends list
  const backendNameForHost = useCallback((hostId: string | undefined): string => {
    // For default/undefined hostId, look up the actual backendId from hostGroups
    if (!hostId || hostId === 'default') {
      const defaultHg = hostGroups?.get('default');
      if (defaultHg) {
        const backend = backends.find((b) => b.id === defaultHg.backendId);
        return backend?.displayName ?? defaultHg.backendId;
      }
      return 'Claude';
    }
    // For added hosts, try direct backend match first, then hostGroup lookup
    const backend = backends.find((b) => b.id === hostId);
    if (backend) return backend.displayName;
    const hg = hostGroups?.get(hostId);
    if (hg) {
      const fallback = backends.find((b) => b.id === hg.backendId);
      return fallback?.displayName ?? hg.backendId;
    }
    return 'Claude';
  }, [backends, hostGroups]);

  // Resolve hostId → iconId from backends list
  const backendIconIdForHost = useCallback((hostId: string | undefined): string => {
    if (!hostId || hostId === 'default') {
      const defaultHg = hostGroups?.get('default');
      if (defaultHg) {
        const backend = backends.find((b) => b.id === defaultHg.backendId);
        return backend?.iconId ?? defaultHg.backendId;
      }
      return 'claude';
    }
    const backend = backends.find((b) => b.id === hostId);
    if (backend) return backend.iconId;
    const hg = hostGroups?.get(hostId);
    if (hg) {
      const fallback = backends.find((b) => b.id === hg.backendId);
      return fallback?.iconId ?? hg.backendId;
    }
    return 'claude';
  }, [backends, hostGroups]);

  const toggleExpanded = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  useEffect(() => {
    if (tab !== 'chat') return;
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [transcript.length, tab, pending]);

  const totalStagedBytes = useMemo(
    () => staged.reduce((acc, a) => acc + a.sizeBytes, 0),
    [staged],
  );

  const enqueueFiles = async (files: File[] | FileList) => {
    if (disabled) return;
    if (!onSendAttachments) return;
    const list = Array.from(files);
    if (list.length === 0) return;
    setStaging(true);
    try {
      const accepted: StagedAttachment[] = [];
      const rejects: Array<{ id: string; name: string; reason: string }> = [];
      let runningTotal = totalStagedBytes + accepted.reduce((a, x) => a + x.sizeBytes, 0);
      for (const f of list) {
        if (staged.length + accepted.length >= STAGED_MAX) {
          rejects.push({ id: uid(), name: f.name, reason: `已达 ${STAGED_MAX} 个附件上限` });
          continue;
        }
        if (f.size > PER_FILE_MAX) {
          rejects.push({ id: uid(), name: f.name, reason: `超过单文件 ${formatBytes(PER_FILE_MAX)} 上限` });
          continue;
        }
        if (runningTotal + f.size > TOTAL_MAX) {
          rejects.push({ id: uid(), name: f.name, reason: `本次合计将超过 ${formatBytes(TOTAL_MAX)} 上限` });
          continue;
        }
        const kind = classifyKind(f.name, f.type);
        if (!kind) {
          rejects.push({ id: uid(), name: f.name, reason: '不支持的文件类型' });
          continue;
        }
        try {
          const dataBase64 = await fileToBase64(f);
          accepted.push({
            id: uid(),
            name: f.name,
            mime: f.type || '',
            sizeBytes: f.size,
            kind,
            dataBase64,
          });
          runningTotal += f.size;
        } catch {
          rejects.push({ id: uid(), name: f.name, reason: '读取失败' });
        }
      }
      if (accepted.length > 0) setStaged((prev) => [...prev, ...accepted]);
      if (rejects.length > 0) setRejected((prev) => [...prev, ...rejects]);
    } finally {
      setStaging(false);
    }
  };

  // Subscribe to window-level drops published by App.tsx.
  useEffect(() => {
    if (!onSubscribeDroppedFiles) return;
    const unsub = onSubscribeDroppedFiles((files) => {
      void enqueueFiles(files);
    });
    return unsub;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onSubscribeDroppedFiles, disabled, totalStagedBytes, staged.length, onSendAttachments]);

  const removeStaged = (id: string) => {
    setStaged((prev) => prev.filter((a) => a.id !== id));
  };

  const dismissRejected = (id: string) => {
    setRejected((prev) => prev.filter((r) => r.id !== id));
  };

  const submit = async () => {
    const trimmed = text.trim();
    if (staged.length > 0 && onSendAttachments) {
      const res = await onSendAttachments(staged, trimmed);
      if (res.ok) {
        setStaged([]);
        setText('');
        setRejected([]);
      } else {
        // Without this the user sees the draft stay put and assumes it sent.
        toast.error(`附件发送失败：${res.error ?? '未知原因'}`);
      }
      return;
    }
    if (!trimmed) return;
    onSend(trimmed);
    setText('');
  };

  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    if (!onSendAttachments) return;
    const files = Array.from(e.clipboardData.files ?? []);
    if (files.length > 0) {
      e.preventDefault();
      void enqueueFiles(files);
    }
  };

  const placeholder = disabled
    ? 'Join a meeting to chat'
    : multiAgent
      ? dispatchMode === 'plan'
        ? 'Plan 模式 · Enter 发送 · Shift+Enter 换行 · 📎/拖放/粘贴可附文件'
        : '直接派活 · Enter 发送 · Shift+Enter 换行 · 📎/拖放/粘贴可附文件'
      : 'Type a message · Enter 发送 · 📎 附件 / 拖放 / 粘贴均可';

  const sendDisabled = disabled || staging || (staged.length === 0 && !text.trim());

  return (
    <aside className={`drawer ${open ? 'drawer-open' : ''}`}>
      <div className="drawer-tabs">
        <button className={`drawer-tab ${tab === 'participants' ? 'active' : ''}`} onClick={() => setTab('participants')}>
          <Users size={14} aria-hidden="true" style={{ marginRight: 4, verticalAlign: -2 }} />
          Participants
          {backends.filter((b) => activeBackendIds.has(b.id)).length > 0 && (
            <span className="drawer-badge">{backends.filter((b) => activeBackendIds.has(b.id)).length}</span>
          )}
        </button>
        <button className={`drawer-tab ${tab === 'chat' ? 'active' : ''}`} onClick={() => setTab('chat')}>
          <MessageSquare size={14} aria-hidden="true" style={{ marginRight: 4, verticalAlign: -2 }} />
          Chat
          {transcript.length > 0 && <span className="drawer-badge">{transcript.length}</span>}
        </button>
        <button className={`drawer-tab ${tab === 'files' ? 'active' : ''}`} onClick={() => setTab('files')}>
          <FolderOpen size={14} aria-hidden="true" style={{ marginRight: 4, verticalAlign: -2 }} />
          Files
        </button>
      </div>

      {tab === 'participants' && (
        <div className="drawer-participants">
          <div className="drawer-participants-header">
            <span className="drawer-participants-title">Configured CLI Backends</span>
            <span className="drawer-participants-count">{backends.length} available</span>
          </div>
          <div className="drawer-participants-list">
            {backends.length === 0 && (
              <div className="drawer-empty">暂无已配置的 CLI 后端。请在设置中添加。</div>
            )}
            {backends.map((b) => {
              const isActive = activeBackendIds.has(b.id);
              // A backend is "configured" if:
              // - It's the default (bundled, no extra setup needed), OR
              // - It has an auth entry with valid credentials (apiKey or oauth)
              const isConfigured = b.loggedIn;
              return (
                <div key={b.id} className={`drawer-participant-row ${isActive ? 'active' : ''}`}>
                  <div className="drawer-participant-info">
                    <span className="drawer-participant-name">{b.displayName}</span>
                    <span className="drawer-participant-status">
                      {b.available ? '✓ 已安装' : '✗ 未安装'}
                      {' · '}
                      {isConfigured ? '✓ 已配置' : '✗ 未配置'}
                    </span>
                  </div>
                  {isActive ? (
                    <span className="drawer-participant-badge">已加入</span>
                  ) : (
                    <button
                      className="drawer-participant-invite"
                      onClick={() => onAddHost?.(b.id)}
                      disabled={!b.available || !isConfigured || disabled}
                      title={
                        !b.available
                          ? 'CLI 未安装，无法邀请'
                          : !isConfigured
                            ? '未配置 API Key，请先去设置'
                            : disabled
                              ? '会议未开始'
                              : `邀请 ${b.displayName}`
                      }
                    >
                      邀请
                    </button>
                  )}
                  {!isConfigured && (
                    <button
                      className="drawer-participant-configure"
                      onClick={() => void window.vibeMeet.settingsWindow.open()}
                      title="去设置中配置"
                    >
                      去配置
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {tab === 'chat' && (
        <div className="drawer-chat">
          <div className="drawer-scroll">
            {transcript.length === 0 && (
              <div className="drawer-empty">Host 已就绪。直接输入任务，或用 @ 点名已参会的 Expert。</div>
            )}
            {transcript.map((e) => {
              const timeLabel = formatMessageTime(e.ts, now);
              const isoTitle = e.ts ? new Date(e.ts).toISOString() : undefined;
              const authorName = e.role === 'assistant'
                ? backendNameForHost(e.hostId)
                : e.role === 'user' ? 'You' : 'System';
              return (
                <div key={e.id} className={`msg msg-${e.role}`}>
                  <div className="msg-meta">
                    <span className="msg-author">
                      {authorName}
                    </span>
                    {timeLabel && (
                      <span className="msg-time" title={isoTitle}>{timeLabel}</span>
                    )}
                  </div>
                  {e.imageUrl && (
                    <img
                      className="msg-image msg-image-clickable"
                      src={e.imageUrl}
                      alt={e.text || 'Shared screenshot'}
                      role="button"
                      tabIndex={0}
                      onClick={() => setPreviewImg(e.imageUrl!)}
                      onKeyDown={(ev) => {
                        if (ev.key === 'Enter' || ev.key === ' ') {
                          ev.preventDefault();
                          setPreviewImg(e.imageUrl!);
                        }
                      }}
                    />
                  )}
                  {e.attachments && e.attachments.length > 0 && (
                    <div className="msg-attachments">
                      {e.attachments.map((a, idx) => (
                        <span key={`${e.id}-att-${idx}`} className={`attachment-chip attachment-chip-${a.kind} attachment-chip-sent`}>
                          <span className="attachment-icon">{iconFor(a.kind)}</span>
                          <span className="attachment-name">{a.name}</span>
                          <span className="attachment-size">{formatBytes(a.sizeBytes)}</span>
                        </span>
                      ))}
                    </div>
                  )}
                  {e.text && <div className="msg-body">{e.text}</div>}
                </div>
              );
            })}
            {pending && <PermissionCard pending={pending} onDecide={onResolve} resolving={pendingResolving} error={pendingError} />}
            <div ref={endRef} />
          </div>
          <div className="drawer-composer">
            {multiAgent && onChangeDispatchMode && (
              <div
                className="dispatch-mode-switch"
                role="group"
                aria-label="派活方式"
              >
                {(['direct', 'plan'] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    className={`dispatch-mode-option ${dispatchMode === mode ? 'is-active' : ''}`}
                    aria-pressed={dispatchMode === mode}
                    title={DISPATCH_MODE_HINTS[mode]}
                    onClick={() => onChangeDispatchMode(mode)}
                  >
                    {DISPATCH_MODE_LABELS[mode]}
                  </button>
                ))}
              </div>
            )}
            {(staged.length > 0 || rejected.length > 0) && (
              <div className="attachment-strip">
                {staged.map((a) => (
                  <span key={a.id} className={`attachment-chip attachment-chip-${a.kind}`}>
                    <span className="attachment-icon">{iconFor(a.kind)}</span>
                    <span className="attachment-name" title={a.name}>{a.name}</span>
                    <span className="attachment-size">{formatBytes(a.sizeBytes)}</span>
                    <button
                      type="button"
                      className="attachment-chip-remove"
                      onClick={() => removeStaged(a.id)}
                      aria-label={`移除 ${a.name}`}
                      title="移除"
                    >
                      <X size={10} aria-hidden="true" />
                    </button>
                  </span>
                ))}
                {rejected.map((r) => (
                  <span key={r.id} className="attachment-chip attachment-chip-rejected" title={r.reason}>
                    <span className="attachment-icon"><FileWarning size={12} aria-hidden="true" /></span>
                    <span className="attachment-name">{r.name}</span>
                    <span className="attachment-size">{r.reason}</span>
                    <button
                      type="button"
                      className="attachment-chip-remove"
                      onClick={() => dismissRejected(r.id)}
                      aria-label={`关闭 ${r.name}`}
                      title="关闭"
                    >
                      <X size={10} aria-hidden="true" />
                    </button>
                  </span>
                ))}
              </div>
            )}
            <div className="drawer-input-wrap">
              {slashPickerOpen && filteredSkills.length > 0 && (
                <div className="slash-picker">
                  {filteredSkills.map((skill, idx) => (
                    <button
                      key={skill.name}
                      type="button"
                      className={`slash-picker-item ${idx === slashSelectedIdx ? 'slash-picker-item-active' : ''}`}
                      onClick={() => handleSlashSelect(skill)}
                      onMouseEnter={() => setSlashSelectedIdx(idx)}
                    >
                      <Zap size={12} className="slash-picker-icon" />
                      <div className="slash-picker-text">
                        <span className="slash-picker-name">/{skill.name}</span>
                        <span className="slash-picker-desc">{skill.description}</span>
                      </div>
                    </button>
                  ))}
                </div>
              )}
              {slashPickerOpen && filteredSkills.length === 0 && (
                <div className="slash-picker slash-picker-empty">
                  <span>没有找到匹配的 skill</span>
                </div>
              )}
              {mentionPickerOpen && filteredBackends.length > 0 && (
                <div className="slash-picker">
                  {filteredBackends.map((backend, idx) => (
                    <button
                      key={backend.id}
                      type="button"
                      className={`slash-picker-item ${idx === mentionSelectedIdx ? 'slash-picker-item-active' : ''}`}
                      onClick={() => handleMentionSelect(backend)}
                      onMouseEnter={() => setMentionSelectedIdx(idx)}
                    >
                      <Users size={12} className="slash-picker-icon" />
                      <div className="slash-picker-text">
                        <span className="slash-picker-name">@{backend.displayName}</span>
                        <span className="slash-picker-desc">{backend.authMode === 'oauth' ? 'OAuth' : backend.authMode === 'apikey' ? 'API Key' : 'None'}</span>
                      </div>
                    </button>
                  ))}
                </div>
              )}
              {mentionPickerOpen && filteredBackends.length === 0 && (
                <div className="slash-picker slash-picker-empty">
                  <span>没有找到匹配的参会 Talker，请先在 Participants 邀请</span>
                </div>
              )}
              <input
                ref={fileInputRef}
                type="file"
                hidden
                multiple
                accept={ACCEPT_ATTR}
                onChange={(e) => {
                  const files = e.target.files;
                  if (files && files.length > 0) void enqueueFiles(files);
                  // Reset so picking the same file twice still fires onChange.
                  e.target.value = '';
                }}
              />
              {onSendAttachments && (
                <button
                  type="button"
                  className="drawer-attach-icon"
                  disabled={disabled || staging}
                  onClick={() => fileInputRef.current?.click()}
                  aria-label="添加附件"
                  title="添加附件 (.md, .docx, .pdf, 图片…)"
                >
                  <Paperclip size={16} aria-hidden="true" />
                </button>
              )}
              <textarea
                ref={textareaRef}
                className="drawer-input"
                value={text}
                disabled={disabled}
                placeholder={placeholder}
                onChange={(e) => handleTextChange(e.target.value)}
                onPaste={onPaste}
                onKeyDown={(e) => {
                  // Handle slash command picker navigation
                  if (slashPickerOpen && filteredSkills.length > 0) {
                    if (e.key === 'ArrowDown') {
                      e.preventDefault();
                      setSlashSelectedIdx((i) => (i + 1) % filteredSkills.length);
                      return;
                    }
                    if (e.key === 'ArrowUp') {
                      e.preventDefault();
                      setSlashSelectedIdx((i) => (i - 1 + filteredSkills.length) % filteredSkills.length);
                      return;
                    }
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      handleSlashSelect(filteredSkills[slashSelectedIdx]);
                      return;
                    }
                    if (e.key === 'Escape') {
                      e.preventDefault();
                      setSlashPickerOpen(false);
                      return;
                    }
                  }
                  // Handle @mention picker navigation
                  if (mentionPickerOpen && filteredBackends.length > 0) {
                    if (e.key === 'ArrowDown') {
                      e.preventDefault();
                      setMentionSelectedIdx((i) => (i + 1) % filteredBackends.length);
                      return;
                    }
                    if (e.key === 'ArrowUp') {
                      e.preventDefault();
                      setMentionSelectedIdx((i) => (i - 1 + filteredBackends.length) % filteredBackends.length);
                      return;
                    }
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      handleMentionSelect(filteredBackends[mentionSelectedIdx]);
                      return;
                    }
                    if (e.key === 'Escape') {
                      e.preventDefault();
                      setMentionPickerOpen(false);
                      return;
                    }
                  }
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    void submit();
                  }
                }}
                rows={2}
              />
              <button
                type="button"
                className="drawer-send-icon"
                disabled={sendDisabled}
                onClick={() => void submit()}
                aria-label="发送"
                title="发送 · Enter"
              >
                <Send size={16} aria-hidden="true" />
              </button>
            </div>
          </div>
        </div>
      )}

      {tab === 'files' && (
        <div className="drawer-files">
          <FileTree
            sessionId={sessionId ?? null}
            onViewFile={(path) => onViewFile?.(path)}
            viewingPath={viewingFilePath ?? null}
          />
        </div>
      )}

      {previewImg && (
        <Modal
          open
          onClose={() => setPreviewImg(null)}
          backdropClassName="img-preview-backdrop"
          ariaLabel="图片预览"
        >
          <button
            type="button"
            className="img-preview-close"
            onClick={() => setPreviewImg(null)}
            aria-label="关闭预览"
          >
            <X size={20} aria-hidden="true" />
          </button>
          <img
            className="img-preview-img"
            src={previewImg}
            alt="Preview"
            onClick={(ev) => ev.stopPropagation()}
          />
        </Modal>
      )}
    </aside>
  );
}
