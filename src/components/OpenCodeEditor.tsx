// OpenCodeEditor — independent editor window for a digital employee.
// Provides file tree browsing, code viewing, activity log, and terminal placeholder.

import { useCallback, useEffect, useState } from 'react';
import { ChevronRight, ChevronDown, File, Folder, RefreshCw } from 'lucide-react';
import type { FileEntry } from '../types';

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

export function OpenCodeEditor({ hostId, backendId, sessionId, cwd }: OpenCodeEditorProps) {
  const [files, setFiles] = useState<FileNode[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  const handleSelectFile = async (node: FileNode) => {
    if (node.isDir) {
      await toggleDir(node);
      return;
    }

    setSelectedFile(node.path);
    setLoading(true);
    setError(null);
    try {
      const result = await window.vibeMeet.ideFiles.read(node.path);
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
          <span className="opencode-editor-backend">{backendId}</span>
          <span className="opencode-editor-session">{hostId}</span>
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
          <div className="opencode-editor-activity-title">活动日志</div>
          <div className="opencode-editor-activity-list">
            <div className="opencode-editor-activity-item">
              <div className="opencode-editor-activity-time">刚刚</div>
              <div className="opencode-editor-activity-text">编辑器窗口已打开</div>
            </div>
            <div className="opencode-editor-activity-item">
              <div className="opencode-editor-activity-time">会话</div>
              <div className="opencode-editor-activity-text">{sessionId}</div>
            </div>
            <div className="opencode-editor-activity-item">
              <div className="opencode-editor-activity-text">活动日志功能将在后续版本完善</div>
            </div>
          </div>
        </aside>
      </div>

      <footer className="opencode-editor-terminal">
        <div className="opencode-editor-terminal-title">终端</div>
        <div className="opencode-editor-terminal-content">
          <div className="opencode-editor-terminal-line">$ 终端功能将在后续版本完善</div>
        </div>
      </footer>
    </div>
  );
}
