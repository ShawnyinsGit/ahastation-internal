// shiki-highlighter.ts — lazy, per-language shiki highlighter for the editor
// code viewer (Phase 4). Fine-grained API: single theme, oniguruma WASM
// engine (the editor window CSP allows 'wasm-unsafe-eval' for exactly this),
// and grammars are dynamic-imported per language on first use — no full
// language bundle lands in the renderer.

import { createHighlighterCore } from 'shiki/core';
import { createOnigurumaEngine } from 'shiki/engine/oniguruma';

type HighlighterCoreT = Awaited<ReturnType<typeof createHighlighterCore>>;

const THEME = 'github-dark-default';

type LangModule = { default: unknown };

const LANG_LOADERS: Record<string, () => Promise<LangModule>> = {
  typescript: () => import('@shikijs/langs/typescript'),
  tsx: () => import('@shikijs/langs/tsx'),
  javascript: () => import('@shikijs/langs/javascript'),
  jsx: () => import('@shikijs/langs/jsx'),
  json: () => import('@shikijs/langs/json'),
  markdown: () => import('@shikijs/langs/markdown'),
  python: () => import('@shikijs/langs/python'),
  rust: () => import('@shikijs/langs/rust'),
  go: () => import('@shikijs/langs/go'),
  java: () => import('@shikijs/langs/java'),
  c: () => import('@shikijs/langs/c'),
  cpp: () => import('@shikijs/langs/cpp'),
  shellscript: () => import('@shikijs/langs/shellscript'),
  yaml: () => import('@shikijs/langs/yaml'),
  toml: () => import('@shikijs/langs/toml'),
  css: () => import('@shikijs/langs/css'),
  html: () => import('@shikijs/langs/html'),
  xml: () => import('@shikijs/langs/xml'),
  sql: () => import('@shikijs/langs/sql'),
  diff: () => import('@shikijs/langs/diff'),
};

let highlighterPromise: Promise<HighlighterCoreT> | null = null;
const loadedLangs = new Set<string>();

function getHighlighter(): Promise<HighlighterCoreT> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighterCore({
      themes: [import('@shikijs/themes/github-dark-default')],
      langs: [], // grammars load on demand below
      engine: createOnigurumaEngine(import('shiki/wasm')),
    });
  }
  return highlighterPromise;
}

/** Render code to highlighted HTML for the given shiki lang id, or null when
 *  the language is unknown (caller falls back to a plain <pre>). */
export async function highlightToHtml(code: string, lang: string | null): Promise<string | null> {
  if (!lang || !(lang in LANG_LOADERS)) return null;
  try {
    const hl = await getHighlighter();
    if (!loadedLangs.has(lang)) {
      const mod = await LANG_LOADERS[lang]();
      await hl.loadLanguage(mod.default as never);
      loadedLangs.add(lang);
    }
    return hl.codeToHtml(code, { lang, theme: THEME });
  } catch (err) {
    console.warn('[shiki] highlight failed, falling back to plain text:', err);
    return null;
  }
}
