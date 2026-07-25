import { memo, useEffect, useMemo, useState } from 'react';
import { shikiLangForPath } from '../lib/editor-highlight';
import { highlightToHtml } from '../lib/shiki-highlighter';

interface CodePreviewProps {
  text: string;
  /** File path or name — used only for extension → language mapping. */
  path: string;
}

function countLines(text: string): number {
  if (!text) return 1;
  let n = 1;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) n++;
  }
  return n;
}

/** Read-only code preview with lazy shiki highlighting and a line gutter. */
export const CodePreview = memo(function CodePreview({ text, path }: CodePreviewProps) {
  const [html, setHtml] = useState<string | null>(null);
  const lang = useMemo(() => shikiLangForPath(path), [path]);
  const lineCount = useMemo(() => countLines(text), [text]);
  const gutter = useMemo(() => {
    const lines: string[] = new Array(lineCount);
    for (let i = 0; i < lineCount; i++) lines[i] = String(i + 1);
    return lines.join('\n');
  }, [lineCount]);

  useEffect(() => {
    if (!lang) {
      setHtml(null);
      return;
    }
    let cancelled = false;
    setHtml(null);
    void highlightToHtml(text, lang).then((next) => {
      if (!cancelled) setHtml(next);
    });
    return () => {
      cancelled = true;
    };
  }, [text, lang]);

  return (
    <div className="file-viewer-code">
      <pre className="file-viewer-code-gutter" aria-hidden="true">
        {gutter}
      </pre>
      <div className="file-viewer-code-body">
        {html ? (
          <div
            className="file-viewer-code-highlighted"
            // shiki escapes source text before emitting HTML.
            dangerouslySetInnerHTML={{ __html: html }}
          />
        ) : (
          <pre className="file-viewer-code-plain">{text}</pre>
        )}
      </div>
    </div>
  );
});
