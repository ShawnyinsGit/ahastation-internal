// OpenCodeEditor — independent editor window for a digital employee.
// File tree browsing, code viewing, and the LIVE panel (status light, todo
// list, session diff, activity timeline) fed point-to-point from main via
// ideSession.getState() + ideSession.onEvent() (Phase 2 PR③).

import { useCallback, useEffect, useState } from 'react';
import { ChevronRight, ChevronDown, File, Folder, RefreshCw } from 'lucide-react';
import type {
  EditorActivityItem,
  EditorKeyedActivity,
  EditorPanelEvent,
  EditorSnapshot,
  EditorStatus,
  FileEntry,
} from '../types';
import { EDITOR_ACTIVITY_CAP } from '../types';

interface OpenCodeEditorProps {
  hostId: string;
  backendId: string;
  sessionId: string;
  cwd: string;
}

interface FileNode extends FileEntry {
  children?: FileNode[];
  expanded?: boolean;
}

const STATUS_LABEL: Record<EditorStatus, string> = {
  idle: '空闲',
  busy: '工作中',
  retry: '重试中',
  error: '错误',
};

const STATUS_COLOR: Record<EditorStatus, string> = {
  idle: '#34c759',
  busy: '#ffcc00',
  retry: '#ff9500',
  error: '#ff3b30',
};

function applyPanelEvent(prev: EditorSnapshot, ev: EditorPanelEvent): EditorSnapshot {
  switch (ev.kind) {
    case 'status':
      return { ...prev, status: ev.status };
    case 'todo':
      return { ...prev, todos: ev.todos };
    case 'diff':
      return { ...prev, diff: ev.diff };
    case 'activity-upsert': {
      const idx = prev.activity.findIndex((a) => a.key === ev.key);
      const next = idx >= 0
        ? prev.activity.map((a, i) => (i === idx ? { key: ev.key, item: ev.item } : a))
        : [...prev.activity, { key: ev.key, item: ev.item }];
      return { ...prev, activity: next.slice(-EDITOR_ACTIVITY_CAP) };
    }
    default:
      return prev;
  }
}

const EMPTY_PANEL: EditorSnapshot = { status: 'idle', todos: [], diff: [], activity: [] };

export function OpenCodeEditor({ hostId, backendId, sessionId, cwd }: OpenCodeEditorProps) {
  const [files, setFiles] = useState<FileNode[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [panel, setPanel] = useState<EditorSnapshot>(EMPTY_PANEL);

  const loadFiles = useCallback(async (path?: string) => {
    try {
      // No cwd is sent — the main process resolves the workspace from this
      // window's registration (keyed by hostId at window creation).
      const result = await window.vibeMeet.ideFiles.list(path);
      if (result.ok) {
        return result.entries.map((e) => ({ ...e, expanded: false }));
      }
      return [];
    } catch (err) {
      console.error('[OpenCodeEditor] loadFiles failed:', err);
      return [];
    }
  }, []);

  useEffect(() => {
    loadFiles().then(setFiles);
  }, [loadFiles]);

  // Live panel: initial snapshot, then point-to-point incremental events.
  useEffect(() => {
    let cancelled = false;
    void window.vibeMeet.ideSession.getState().then((res) => {
      if (!cancelled && res.ok) setPanel(res.state);
    }).catch(() => { /* no live session yet — panels stay empty */ });
    const dispose = window.vibeMeet.ideSession.onEvent((msg) => {
      if (msg.hostId !== hostId) return; // defensive; main routes point-to-point
      setPanel((prev) => applyPanelEvent(prev, msg.payload));
    });
    return () => {
      cancelled = true;
      dispose();
    };
  }, [hostId]);

  const toggleDir = async (node: FileNode) => {
    if (!node.isDir) return;

    if (node.expanded) {
      // Collapse
      setFiles((prev) =>
        prev.map((f) =>
          f.path === node.path ? { ...f, expanded: false } : f,
        ),
      );
    } else {
      // Expand and load children
      const children = await loadFiles(node.path);
      setFiles((prev) =>
        prev.map((f) =>
          f.path === node.path ? { ...f, expanded: true, children } : f,
        ),
      );
    }
  };

  const openFile = useCallback(async (path: string) => {
    setSelectedFile(path);
    setLoading(true);
    setError(null);
    try {
      const result = await window.vibeMeet.ideFiles.read(path);
      if (result.ok) {
        setFileContent(result.file.content);
      } else {
        setError(result.error);
        setFileContent('');
      }
    } catch (err) {
      setError(String(err));
      setFileContent('');
    } finally {
      setLoading(false);
    }
  }, []);

  const handleSelectFile = async (node: FileNode) => {
    if (node.isDir) {
      await toggleDir(node);
      return;
    }
    await openFile(node.path);
  };

  const renderFileNode = (node: FileNode, depth = 0): React.ReactNode => {
    const paddingLeft = 12 + depth * 16;
    return (
      <div key={node.path}>
        <div
          className={`opencode-editor-file-item ${selectedFile === node.path ? 'opencode-editor-file-item-selected' : ''}`}
          style={{ paddingLeft }}
          onClick={() => handleSelectFile(node)}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              handleSelectFile(node);
            }
          }}
        >
          {node.isDir ? (
            <>
              {node.expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              <Folder size={14} />
              <span>{node.name}</span>
            </>
          ) : (
            <>
              <span style={{ width: 14 }} />
              <File size={14} />
              <span>{node.name}</span>
            </>
          )}
        </div>
        {node.expanded && node.children?.map((child) => renderFileNode(child, depth + 1))}
      </div>
    );
  };

  const renderActivityItem = ({ key, item }: EditorKeyedActivity) => (
    <div key={key} className="opencode-editor-activity-item">
      <div className="opencode-editor-activity-time">
        {new Date(item.ts).toLocaleTimeString()}
      </div>
      <div className="opencode-editor-activity-text" title={item.detail}>
        {activityPrefix(item)}{item.label}
      </div>
    </div>
  );

  return (
    <div className="opencode-editor">
      <header className="opencode-editor-header">
        <button
          type="button"
          className="opencode-editor-back"
          onClick={() => window.close()}
        >
          ← 返回会议
        </button>
        <div className="opencode-editor-title">
          <span
            className="opencode-editor-status-dot"
            style={{
              display: 'inline-block',
              width: 8,
              height: 8,
              borderRadius: '50%',
              backgroundColor: STATUS_COLOR[panel.status],
              marginRight: 6,
            }}
            title={STATUS_LABEL[panel.status]}
          />
          <span className="opencode-editor-backend">{backendId}</span>
          <span className="opencode-editor-session">{hostId}</span>
          <span className="opencode-editor-session">{STATUS_LABEL[panel.status]}</span>
        </div>
        <button
          type="button"
          className="opencode-editor-close"
          onClick={() => window.close()}
        >
          ✕
        </button>
      </header>

      <div className="opencode-editor-body">
        <aside className="opencode-editor-sidebar">
          <div className="opencode-editor-sidebar-header">
            <span className="opencode-editor-sidebar-title">文件</span>
            <button
              type="button"
              className="opencode-editor-refresh"
              onClick={() => loadFiles().then(setFiles)}
              title="刷新"
            >
              <RefreshCw size={14} />
            </button>
          </div>
          <div className="opencode-editor-file-tree">
            {files.map((node) => renderFileNode(node))}
            {files.length === 0 && (
              <div className="opencode-editor-file-empty">暂无文件</div>
            )}
          </div>
        </aside>

        <main className="opencode-editor-content">
          {selectedFile ? (
            <div className="opencode-editor-code-view">
              <div className="opencode-editor-code-header">
                <span className="opencode-editor-code-path">{selectedFile}</span>
              </div>
              <div className="opencode-editor-code-content">
                {loading && <div className="opencode-editor-loading">加载中...</div>}
                {error && <div className="opencode-editor-error">{error}</div>}
                {!loading && !error && (
                  <pre className="opencode-editor-code-text">{fileContent}</pre>
                )}
              </div>
            </div>
          ) : (
            <div className="opencode-editor-placeholder">
              <h2>OpenCode 编辑器</h2>
              <p>后端: {backendId}</p>
              <p>参会者: {hostId}</p>
              <p>会话: {sessionId}</p>
              <p>目录: {cwd}</p>
              <p>从左侧文件树选择一个文件开始查看。</p>
            </div>
          )}
        </main>

        <aside className="opencode-editor-activity">
          <div className="opencode-editor-activity-title">待办</div>
          <div className="opencode-editor-activity-list">
            {panel.todos.length === 0 && (
              <div className="opencode-editor-activity-item">
                <div className="opencode-editor-activity-text">暂无待办</div>
              </div>
            )}
            {panel.todos.map((t) => (
              <div key={t.id} className="opencode-editor-activity-item">
                <div className="opencode-editor-activity-text">
                  {t.status === 'completed' ? '✅' : t.status === 'in_progress' ? '🔨' : '⬜'} {t.content}
                </div>
              </div>
            ))}
          </div>

          <div className="opencode-editor-activity-title">改动</div>
          <div className="opencode-editor-activity-list">
            {panel.diff.length === 0 && (
              <div className="opencode-editor-activity-item">
                <div className="opencode-editor-activity-text">暂无改动</div>
              </div>
            )}
            {panel.diff.map((d) => (
              <div
                key={d.file}
                className="opencode-editor-activity-item"
                role="button"
                tabIndex={0}
                title={`打开 ${d.file}`}
                onClick={() => void openFile(d.file)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    void openFile(d.file);
                  }
                }}
              >
                <div className="opencode-editor-activity-text">
                  {d.file} <span style={{ color: '#34c759' }}>+{d.additions}</span>{' '}
                  <span style={{ color: '#ff3b30' }}>−{d.deletions}</span>
                </div>
              </div>
            ))}
          </div>

          <div className="opencode-editor-activity-title">活动日志</div>
          <div className="opencode-editor-activity-list">
            {panel.activity.length === 0 && (
              <div className="opencode-editor-activity-item">
                <div className="opencode-editor-activity-text">暂无活动</div>
              </div>
            )}
            {[...panel.activity].reverse().map(renderActivityItem)}
          </div>
        </aside>
      </div>

      <footer className="opencode-editor-terminal">
        <div className="opencode-editor-terminal-title">终端</div>
        <div className="opencode-editor-terminal-content">
          <div className="opencode-editor-terminal-line">$ 终端：Phase 4 交付 PtyPanel</div>
        </div>
      </footer>
    </div>
  );
}

function activityPrefix(item: EditorActivityItem): string {
  switch (item.kind) {
    case 'tool': return '🔧 ';
    case 'text': return '💬 ';
    case 'file': return '📄 ';
    case 'status': return '⚠️ ';
    default: return '';
  }
}
