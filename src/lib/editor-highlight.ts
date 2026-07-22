// editor-highlight.ts — renderer mirror of electron/ide/editor-highlight.ts
// (hand-synced; the two tsconfigs don't share sources).

export const EXT_TO_SHIKI_LANG: Readonly<Record<string, string>> = {
  ts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'jsx',
  json: 'json',
  md: 'markdown',
  py: 'python',
  rs: 'rust',
  go: 'go',
  java: 'java',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  sh: 'shellscript',
  bash: 'shellscript',
  zsh: 'shellscript',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'toml',
  css: 'css',
  html: 'html',
  htm: 'html',
  xml: 'xml',
  sql: 'sql',
  diff: 'diff',
  patch: 'diff',
};

export function shikiLangForPath(path: string): string | null {
  const base = path.split('/').pop() ?? path;
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return null;
  const ext = base.slice(dot + 1).toLowerCase();
  return EXT_TO_SHIKI_LANG[ext] ?? null;
}
