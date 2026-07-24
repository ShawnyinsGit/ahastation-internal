// dir-list.ts — directory-listing helpers for the in-app directory picker.
//
// The picker exists because the native GTK open-directory dialog overflows
// 800px-tall handheld screens (its Open/Cancel buttons get clipped). Pure /
// fs-only module — no electron imports — so it stays unit-testable via
// dist-electron (see tests/dir-list.test.mjs).

import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

export interface DirEntry {
  name: string;
  path: string;
}

/** Hidden entries follow the dot-prefix convention (macOS/Linux). */
export function isHiddenName(name: string): boolean {
  return name.startsWith('.');
}

/** Case-insensitive name sort (returns a new array). */
export function sortDirEntries(entries: DirEntry[]): DirEntry[] {
  return [...entries].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
  );
}

/** List the immediate subdirectories of dirPath, sorted by name. Files are
 *  excluded; dot-prefixed directories are excluded unless showHidden.
 *  Symlinks that resolve to a directory are included; broken or unreadable
 *  ones are silently skipped. Throws if dirPath itself is unreadable. */
export async function listSubdirs(dirPath: string, showHidden: boolean): Promise<DirEntry[]> {
  const dirents = await readdir(dirPath, { withFileTypes: true });
  const entries: DirEntry[] = [];
  for (const d of dirents) {
    if (!showHidden && isHiddenName(d.name)) continue;
    if (d.isDirectory()) {
      entries.push({ name: d.name, path: join(dirPath, d.name) });
    } else if (d.isSymbolicLink()) {
      const stats = await stat(join(dirPath, d.name)).catch(() => null);
      if (stats?.isDirectory()) {
        entries.push({ name: d.name, path: join(dirPath, d.name) });
      }
    }
  }
  return sortDirEntries(entries);
}
