// editor-highlight.ts — extension → shiki language mapping (pure data + fn).
// Canonical copy: node tests import the compiled version of this file.
// The renderer has a hand-synced mirror in src/lib/editor-highlight.ts
// (the two tsconfigs don't share sources).

export const EXT_TO_SHIKI_LANG: Readonly<Record<string, string>> = {
  ts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'jsx',
  json: 'json',
  jsonc: 'jsonc',
  md: 'markdown',
  markdown: 'markdown',
  mdx: 'markdown',
  py: 'python',
  rs: 'rust',
  go: 'go',
  java: 'java',
  kt: 'kotlin',
  kts: 'kotlin',
  swift: 'swift',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  rb: 'ruby',
  php: 'php',
  sh: 'shellscript',
  bash: 'shellscript',
  zsh: 'shellscript',
  fish: 'shellscript',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'toml',
  ini: 'ini',
  env: 'ini',
  css: 'css',
  scss: 'scss',
  less: 'less',
  html: 'html',
  htm: 'html',
  xml: 'xml',
  vue: 'vue',
  sql: 'sql',
  graphql: 'graphql',
  gql: 'graphql',
  diff: 'diff',
  patch: 'diff',
};

/** Map a file path to a shiki language id, or null when the extension is
 *  unknown (caller renders plain text — no grammar download). */
export function shikiLangForPath(path: string): string | null {
  const base = path.split(/[/\\]/).pop() ?? path;
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return null; // no extension / dotfile
  const ext = base.slice(dot + 1).toLowerCase();
  return EXT_TO_SHIKI_LANG[ext] ?? null;
}
