import { memo, useEffect, useMemo, useState } from 'react';
import type {
  DeliveryDiffEvidenceKind,
  DeliveryDiffFile,
  DeliveryDiffFileStatus,
  DeliveryDiffManifest,
} from '../types';
import { basename } from './FileViewer';

interface DeliveryDiffViewProps {
  manifest: DeliveryDiffManifest;
}

const STATUS_LABEL: Record<DeliveryDiffFileStatus, string> = {
  added: '新增',
  modified: '修改',
  deleted: '删除',
  renamed: '重命名',
  'mode-changed': '权限变更',
};

const WITHHELD_COPY: Record<Exclude<DeliveryDiffEvidenceKind, 'text'>, string> = {
  binary: '二进制文件，差异内容不内联展示。',
  oversized: '差异体积超出内联上限，内容未随事件传输；可在「文件」页查看快照或到工作区核对。',
  'secret-withheld': '差异中检测到疑似敏感信息，内容已按策略扣留；请直接在工作区核对该文件。',
  symlink: '符号链接变更，仅记录指向信息。',
  submodule: '子模块指针变更，仅记录 commit 指向。',
  'mode-only': '仅文件权限位变更，没有内容差异。',
};

type DiffLineKind = 'meta' | 'hunk' | 'add' | 'del' | 'context';

interface DiffLine {
  kind: DiffLineKind;
  oldNo: number | null;
  newNo: number | null;
  text: string;
}

/** Parse a per-file unified diff into annotated lines with old/new line numbers. */
function parseUnifiedDiff(text: string): DiffLine[] {
  const lines: DiffLine[] = [];
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;
  for (const raw of text.split('\n')) {
    if (raw === '' && lines.length > 0 && !inHunk) continue;
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/u.exec(raw);
    if (hunk) {
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      inHunk = true;
      lines.push({ kind: 'hunk', oldNo: null, newNo: null, text: raw });
      continue;
    }
    if (!inHunk) {
      // diff --git / index / --- / +++ / mode headers before the first hunk.
      lines.push({ kind: 'meta', oldNo: null, newNo: null, text: raw });
      continue;
    }
    if (raw.startsWith('+')) {
      lines.push({ kind: 'add', oldNo: null, newNo: newNo++, text: raw });
    } else if (raw.startsWith('-')) {
      lines.push({ kind: 'del', oldNo: oldNo++, newNo: null, text: raw });
    } else if (raw.startsWith('\\')) {
      // "\ No newline at end of file"
      lines.push({ kind: 'meta', oldNo: null, newNo: null, text: raw });
    } else {
      lines.push({ kind: 'context', oldNo: oldNo++, newNo: newNo++, text: raw });
    }
  }
  // Drop a trailing empty context line produced by the final "\n" split.
  const last = lines[lines.length - 1];
  if (last && last.kind === 'context' && last.text === '') lines.pop();
  return lines;
}

function statCopy(file: DeliveryDiffFile): string {
  const add = file.additions === null ? '—' : `+${file.additions}`;
  const del = file.deletions === null ? '—' : `−${file.deletions}`;
  return `${add} ${del}`;
}

export const DeliveryDiffView = memo(function DeliveryDiffView({ manifest }: DeliveryDiffViewProps) {
  const files = manifest.files;
  const [activePath, setActivePath] = useState<string>(files[0]?.path ?? '');

  useEffect(() => {
    if (!files.some((file) => file.path === activePath)) {
      setActivePath(files[0]?.path ?? '');
    }
  }, [files, activePath]);

  const activeFile = useMemo(
    () => files.find((file) => file.path === activePath) ?? null,
    [files, activePath],
  );

  const diffText = useMemo(() => {
    if (!activeFile || activeFile.kind !== 'text') return '';
    const byId = new Map(manifest.chunks.map((chunk) => [chunk.id, chunk]));
    return activeFile.chunkIds
      .map((id) => byId.get(id))
      .filter((chunk) => chunk !== undefined && chunk.kind === 'text')
      .sort((a, b) => a!.index - b!.index)
      .map((chunk) => chunk!.content ?? '')
      .join('');
  }, [activeFile, manifest.chunks]);

  const diffLines = useMemo(() => (diffText ? parseUnifiedDiff(diffText) : []), [diffText]);

  if (files.length === 0) {
    return (
      <section className="delivery-evidence-panel">
        <h3>代码差异</h3>
        <p className="delivery-empty-copy">这次交付没有产生代码差异。</p>
      </section>
    );
  }

  return (
    <>
      <aside className="delivery-viewer-sidebar">
        <div className="delivery-diff-total">
          {files.length} 个文件 · <span className="is-add">+{manifest.totalAdditions}</span>{' '}
          <span className="is-del">−{manifest.totalDeletions}</span>
        </div>
        <ul className="delivery-viewer-file-list">
          {files.map((file) => {
            const isActive = file.path === activePath;
            return (
              <li key={file.path}>
                <button
                  type="button"
                  className={`delivery-viewer-file${isActive ? ' is-active' : ''}`}
                  onClick={() => setActivePath(file.path)}
                  title={file.path}
                >
                  <span className="delivery-viewer-file-name">
                    {basename(file.path)}
                    <small>{STATUS_LABEL[file.status]}</small>
                  </span>
                  <span className="delivery-viewer-file-path">
                    {file.previousPath ? `${file.previousPath} → ${file.path}` : file.path}
                  </span>
                  <span className="delivery-viewer-file-evidence">
                    {statCopy(file)}
                    {file.kind !== 'text' ? ` · ${file.kind}` : ''}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </aside>

      <section className="delivery-viewer-content delivery-diff-content">
        {!activeFile ? null : activeFile.kind !== 'text' ? (
          <div className="delivery-diff-withheld" role="note">
            <strong>{STATUS_LABEL[activeFile.status]} · {activeFile.kind}</strong>
            <span>{WITHHELD_COPY[activeFile.kind]}</span>
            {activeFile.kind === 'mode-only' && (
              <code>{activeFile.oldMode ?? '—'} → {activeFile.newMode ?? '—'}</code>
            )}
          </div>
        ) : (
          <table className="delivery-diff-table">
            <tbody>
              {diffLines.map((line, index) => (
                <tr key={index} className={`delivery-diff-line is-${line.kind}`}>
                  <td className="delivery-diff-lineno">{line.oldNo ?? ''}</td>
                  <td className="delivery-diff-lineno">{line.newNo ?? ''}</td>
                  <td className="delivery-diff-text"><pre>{line.text || ' '}</pre></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
});
