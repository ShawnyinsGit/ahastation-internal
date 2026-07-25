import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { ensureDir, writeAttachmentSafely, maybeAppendGitignore } from './workspace.js';

const ASSETS_DIR = '.vibe-assets';

export interface AssetEntry {
  name: string;
  sizeBytes: number;
}

export interface AuthorizedAssetReference {
  id: string;
  name: string;
  contentHash: string;
}

function timestampSuffix(): string {
  const d = new Date();
  const pad2 = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
}

function mimeToExt(mediaType: string): string {
  if (mediaType.includes('png')) return 'png';
  if (mediaType.includes('gif')) return 'gif';
  if (mediaType.includes('webp')) return 'webp';
  if (mediaType.includes('svg')) return 'svg';
  return 'jpg';
}

export async function saveImageToAssets(
  cwd: string,
  b64: string,
  mediaType: string,
): Promise<void> {
  try {
    const dir = await ensureDir(cwd, ASSETS_DIR);
    if (!dir) return;
    const ext = mimeToExt(mediaType);
    const name = `screenshot-${timestampSuffix()}.${ext}`;
    const buffer = Buffer.from(b64, 'base64');
    await writeAttachmentSafely(dir, name, buffer);
    await maybeAppendGitignore(cwd, ASSETS_DIR);
  } catch (err) {
    console.warn('[assets] saveImageToAssets failed:', err);
  }
}

export async function saveAttachmentToAssets(
  cwd: string,
  name: string,
  buffer: Buffer,
): Promise<void> {
  try {
    const dir = await ensureDir(cwd, ASSETS_DIR);
    if (!dir) return;
    await writeAttachmentSafely(dir, name, buffer);
    await maybeAppendGitignore(cwd, ASSETS_DIR);
  } catch (err) {
    console.warn('[assets] saveAttachmentToAssets failed:', err);
  }
}

export async function listAssets(cwd: string): Promise<AssetEntry[]> {
  const dir = path.join(cwd, ASSETS_DIR);
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const result: AssetEntry[] = [];
    for (const e of entries) {
      if (!e.isFile()) continue;
      try {
        const stat = await fs.stat(path.join(dir, e.name));
        result.push({ name: e.name, sizeBytes: stat.size });
      } catch { /* skip unstatable entries */ }
    }
    return result;
  } catch {
    return [];
  }
}

/** Return content-addressed references for files already admitted to the
 * Meeting asset directory. File bytes never enter the Context Package. */
export async function listAuthorizedAssetReferences(
  cwd: string,
  selectedIds?: readonly string[],
): Promise<AuthorizedAssetReference[]> {
  const dir = path.join(cwd, ASSETS_DIR);
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const files = entries
      .filter((entry) => entry.isFile())
      .sort((left, right) => left.name.localeCompare(right.name));
    const byName = new Map(files.map((entry) => [entry.name, entry]));
    const selected = selectedIds === undefined ? files.map((entry) => entry.name) : [...selectedIds];
    if (new Set(selected).size !== selected.length) {
      throw new Error('attachmentIds contains duplicate identifiers');
    }
    for (const id of selected) {
      if (!byName.has(id)) throw new Error(`attachmentIds references unauthorized or missing id: ${id}`);
    }
    const references: AuthorizedAssetReference[] = [];
    for (const id of selected) {
      const entry = byName.get(id)!;
      const absolute = path.join(dir, entry.name);
      try {
        const bytes = await fs.readFile(absolute);
        references.push({
          id: entry.name,
          name: entry.name,
          contentHash: createHash('sha256').update(bytes).digest('hex'),
        });
      } catch {
        // An attachment that changes or disappears while resolving is not
        // authorized into the source. A selected reference will then fail.
      }
    }
    return references;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('attachmentIds ')) throw error;
    return [];
  }
}
