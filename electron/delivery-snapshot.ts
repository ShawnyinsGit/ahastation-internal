import { createReadStream } from 'node:fs';
import { copyFile, mkdir, realpath, stat as statFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, relative, resolve as pathResolve, sep } from 'node:path';

const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;

const UNSAFE_RE = /[/\\:*?"<>|]/g;
const CTRL_RE = /[\x00-\x1f\x7f]/g;

function sanitizeTitle(raw: string): string {
  let name = raw.replace(UNSAFE_RE, '-').replace(CTRL_RE, '').trim();
  if (name.length > 60) name = name.slice(0, 60);
  if (!name) name = `delivery-${Date.now()}`;
  return name;
}

export async function snapshotDeliveryFiles(
  sourceCwd: string,
  snapshotRoot: string,
  snapshotKey: string,
  reportedPaths: string[],
): Promise<Map<string, { snapshotPath?: string; sizeBytes?: number; sha256?: string; previewStatus: 'copied' | 'too-large' | 'missing' | 'invalid' | 'copy-failed' }>> {
  const result = new Map<string, { snapshotPath?: string; sizeBytes?: number; sha256?: string; previewStatus: 'copied' | 'too-large' | 'missing' | 'invalid' | 'copy-failed' }>();
  if (reportedPaths.length === 0) return result;

  const safeKey = sanitizeTitle(snapshotKey);
  const resolvedCwd = await realpath(pathResolve(sourceCwd)).catch(() => pathResolve(sourceCwd));
  const destDir = pathResolve(snapshotRoot, safeKey);

  for (const reportedPath of reportedPaths) {
    try {
      const candidate = isAbsolute(reportedPath)
        ? pathResolve(reportedPath)
        : pathResolve(resolvedCwd, reportedPath);
      const resolved = await realpath(candidate).catch(() => candidate);
      const normalised = resolved + sep;
      const cwdNormalised = resolvedCwd + sep;
      const insideCwd = normalised.startsWith(cwdNormalised) || resolved === resolvedCwd;
      if (!insideCwd) {
        console.warn('[delivery-snapshot] rejected path outside workspace:', reportedPath);
        result.set(reportedPath, { previewStatus: 'invalid' });
        continue;
      }

      let fileStat;
      try {
        fileStat = await statFile(resolved);
      } catch {
        console.warn('[delivery-snapshot] file not found:', reportedPath);
        result.set(reportedPath, { previewStatus: 'missing' });
        continue;
      }
      if (!fileStat.isFile()) {
        result.set(reportedPath, { sizeBytes: fileStat.size, previewStatus: 'invalid' });
        continue;
      }
      if (fileStat.size > MAX_SNAPSHOT_BYTES) {
        const sha256 = await hashFile(resolved);
        console.warn('[delivery-snapshot] skipping large file:', reportedPath, fileStat.size);
        result.set(reportedPath, {
          sizeBytes: fileStat.size,
          sha256,
          previewStatus: 'too-large',
        });
        continue;
      }

      // Preserve the in-workspace path beneath meeting-private storage. Keeping
      // snapshots outside the task worktree prevents delivery evidence from
      // being accidentally committed by the workspace integrator.
      const rel = relative(resolvedCwd, resolved);
      const dest = pathResolve(destDir, rel);

      await mkdir(dirname(dest), { recursive: true });
      await copyFile(resolved, dest);
      // Hash the copied snapshot rather than the mutable source so the journal
      // digest always describes the bytes the renderer will actually inspect.
      const copiedStat = await statFile(dest);
      const sha256 = await hashFile(dest);
      result.set(reportedPath, {
        snapshotPath: dest,
        sizeBytes: copiedStat.size,
        sha256,
        previewStatus: 'copied',
      });
    } catch (err) {
      console.warn('[delivery-snapshot] copy failed for', reportedPath, err);
      result.set(reportedPath, { previewStatus: 'copy-failed' });
    }
  }

  return result;
}

function hashFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const input = createReadStream(path);
    input.on('data', (chunk) => hash.update(chunk));
    input.on('error', reject);
    input.on('end', () => resolve(hash.digest('hex')));
  });
}
