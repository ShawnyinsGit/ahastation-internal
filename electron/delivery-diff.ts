import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const DEFAULT_MAX_CHUNK_BYTES = 48 * 1024;
const DEFAULT_MAX_CHUNK_LINES = 400;
const DEFAULT_MAX_INLINE_FILE_BYTES = 512 * 1024;
const GIT_OUTPUT_LIMIT = 32 * 1024 * 1024;

export type DeliveryDiffFileStatus =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'mode-changed';

export type DeliveryDiffEvidenceKind =
  | 'text'
  | 'binary'
  | 'oversized'
  | 'secret-withheld'
  | 'symlink'
  | 'submodule'
  | 'mode-only';

export interface DeliveryDiffChunk {
  id: string;
  index: number;
  path: string;
  kind: DeliveryDiffEvidenceKind;
  hash: string;
  lineCount: number;
  byteLength: number;
  content?: string;
  requiresUserConfirmation: boolean;
}

export interface DeliveryDiffFile {
  path: string;
  previousPath?: string;
  status: DeliveryDiffFileStatus;
  additions: number | null;
  deletions: number | null;
  oldMode: string | null;
  newMode: string | null;
  kind: DeliveryDiffEvidenceKind;
  chunkIds: string[];
  requiresUserConfirmation: boolean;
}

export interface DeliveryDiffManifest {
  schemaVersion: 1;
  baseRevision: string;
  candidateRevision: string;
  diffHash: string;
  files: DeliveryDiffFile[];
  chunks: DeliveryDiffChunk[];
  totalAdditions: number;
  totalDeletions: number;
}

export interface BuildDeliveryDiffManifestInput {
  workspace: string;
  baseRevision: string;
  candidateRevision: string;
  paths?: string[];
  maxChunkBytes?: number;
  maxChunkLines?: number;
  maxInlineFileBytes?: number;
}

export async function buildDeliveryDiffManifest(
  input: BuildDeliveryDiffManifestInput,
): Promise<DeliveryDiffManifest> {
  const workspace = resolve(input.workspace);
  const maxChunkBytes = boundedPositive(
    input.maxChunkBytes,
    DEFAULT_MAX_CHUNK_BYTES,
    1_024,
    256 * 1_024,
  );
  const maxChunkLines = boundedPositive(
    input.maxChunkLines,
    DEFAULT_MAX_CHUNK_LINES,
    1,
    2_000,
  );
  const maxInlineFileBytes = boundedPositive(
    input.maxInlineFileBytes,
    DEFAULT_MAX_INLINE_FILE_BYTES,
    maxChunkBytes,
    4 * 1024 * 1024,
  );
  const requestedPaths = input.paths?.map((path) => normalizeRelativePath(workspace, path));
  const pathArgs = requestedPaths?.length ? ['--', ...requestedPaths] : ['--'];
  const renames = parseRenames(await git(workspace, [
    'diff',
    '--name-status',
    '-z',
    '--find-renames=50%',
    `${input.baseRevision}..${input.candidateRevision}`,
    ...pathArgs,
  ]));
  const changedPaths = (
    await git(workspace, [
      'diff',
      '--name-only',
      '--no-renames',
      `${input.baseRevision}..${input.candidateRevision}`,
      ...pathArgs,
    ])
  ).split(/\r?\n/u).map((path) => path.trim()).filter(Boolean).sort();
  const numstat = parseNumstat(await git(workspace, [
    'diff',
    '--numstat',
    '--no-renames',
    `${input.baseRevision}..${input.candidateRevision}`,
    ...pathArgs,
  ]));
  const chunks: DeliveryDiffChunk[] = [];
  const files: DeliveryDiffFile[] = [];
  let totalAdditions = 0;
  let totalDeletions = 0;

  for (const path of changedPaths) {
    const confinedPath = normalizeRelativePath(workspace, path);
    const previousPath = renames.get(confinedPath);
    const oldMode = await treeMode(
      workspace,
      input.baseRevision,
      previousPath ?? confinedPath,
    );
    const newMode = await treeMode(workspace, input.candidateRevision, confinedPath);
    const stats = numstat.get(confinedPath) ?? { additions: 0, deletions: 0 };
    const status = fileStatus(oldMode, newMode, previousPath);
    const specialKind = modeKind(oldMode, newMode, status);
    let diff = '';
    let kind: DeliveryDiffEvidenceKind = specialKind ?? 'text';
    let byteLength = 0;
    let lineCount = 0;
    let requiresUserConfirmation = specialKind !== null;
    try {
      diff = await git(workspace, [
        'diff',
        '--binary',
        '--no-ext-diff',
        '--no-renames',
        `${input.baseRevision}..${input.candidateRevision}`,
        '--',
        confinedPath,
      ]);
      byteLength = Buffer.byteLength(diff, 'utf8');
      lineCount = countLines(diff);
      if (stats.additions === null || stats.deletions === null || /GIT binary patch|Binary files .* differ/u.test(diff)) {
        kind = 'binary';
        requiresUserConfirmation = true;
      } else if (byteLength > maxInlineFileBytes) {
        kind = 'oversized';
        requiresUserConfirmation = true;
      } else if (containsSuspectedSecret(diff)) {
        kind = 'secret-withheld';
        requiresUserConfirmation = true;
      }
    } catch (error) {
      if (!isOutputLimitError(error)) throw error;
      kind = 'oversized';
      requiresUserConfirmation = true;
      byteLength = maxInlineFileBytes + 1;
    }

    const fileChunks = kind === 'text'
      ? splitTextChunks({
          path: confinedPath,
          text: diff,
          startIndex: chunks.length,
          maxChunkBytes,
          maxChunkLines,
        })
      : [evidenceChunk({
          path: confinedPath,
          kind,
          index: chunks.length,
          byteLength,
          lineCount,
          evidenceHash: sha256(diff || stableStringify({
            path: confinedPath,
            kind,
            oldMode,
            newMode,
            stats,
          })),
        })];
    chunks.push(...fileChunks);
    if (stats.additions !== null) totalAdditions += stats.additions;
    if (stats.deletions !== null) totalDeletions += stats.deletions;
    files.push({
      path: confinedPath,
      ...(previousPath ? { previousPath } : {}),
      status,
      additions: stats.additions,
      deletions: stats.deletions,
      oldMode,
      newMode,
      kind,
      chunkIds: fileChunks.map((chunk) => chunk.id),
      requiresUserConfirmation,
    });
  }

  const draft = {
    schemaVersion: 1 as const,
    baseRevision: input.baseRevision,
    candidateRevision: input.candidateRevision,
    files,
    chunks,
    totalAdditions,
    totalDeletions,
  };
  return {
    ...draft,
    diffHash: sha256(stableStringify(draft)),
  };
}

function splitTextChunks(input: {
  path: string;
  text: string;
  startIndex: number;
  maxChunkBytes: number;
  maxChunkLines: number;
}): DeliveryDiffChunk[] {
  if (!input.text) {
    return [textChunk(input.path, input.startIndex, '')];
  }
  const chunks: DeliveryDiffChunk[] = [];
  let current = '';
  let lines = 0;
  const flush = () => {
    if (!current) return;
    chunks.push(textChunk(input.path, input.startIndex + chunks.length, current));
    current = '';
    lines = 0;
  };
  for (const line of input.text.match(/[^\n]*\n|[^\n]+$/gu) ?? []) {
    if (Buffer.byteLength(line, 'utf8') > input.maxChunkBytes) {
      flush();
      for (const slice of splitUtf8(line, input.maxChunkBytes)) {
        chunks.push(textChunk(input.path, input.startIndex + chunks.length, slice));
      }
      continue;
    }
    if (
      lines >= input.maxChunkLines
      || Buffer.byteLength(current + line, 'utf8') > input.maxChunkBytes
    ) {
      flush();
    }
    current += line;
    lines += 1;
  }
  flush();
  return chunks;
}

function splitUtf8(value: string, maxBytes: number): string[] {
  const slices: string[] = [];
  let current = '';
  for (const character of value) {
    if (current && Buffer.byteLength(current + character, 'utf8') > maxBytes) {
      slices.push(current);
      current = '';
    }
    current += character;
  }
  if (current) slices.push(current);
  return slices;
}

function textChunk(path: string, index: number, content: string): DeliveryDiffChunk {
  const hash = sha256(content);
  return {
    id: `chunk-${index + 1}-${hash.slice(0, 12)}`,
    index,
    path,
    kind: 'text',
    hash,
    lineCount: countLines(content),
    byteLength: Buffer.byteLength(content, 'utf8'),
    content,
    requiresUserConfirmation: false,
  };
}

function evidenceChunk(input: {
  path: string;
  kind: Exclude<DeliveryDiffEvidenceKind, 'text'>;
  index: number;
  byteLength: number;
  lineCount: number;
  evidenceHash: string;
}): DeliveryDiffChunk {
  return {
    id: `chunk-${input.index + 1}-${input.evidenceHash.slice(0, 12)}`,
    index: input.index,
    path: input.path,
    kind: input.kind,
    hash: input.evidenceHash,
    lineCount: input.lineCount,
    byteLength: input.byteLength,
    requiresUserConfirmation: true,
  };
}

function parseNumstat(output: string): Map<string, {
  additions: number | null;
  deletions: number | null;
}> {
  const result = new Map<string, { additions: number | null; deletions: number | null }>();
  for (const line of output.split(/\r?\n/u)) {
    if (!line) continue;
    const [rawAdditions, rawDeletions, ...pathParts] = line.split('\t');
    const path = pathParts.join('\t');
    if (!path) continue;
    result.set(path, {
      additions: rawAdditions === '-' ? null : Number.parseInt(rawAdditions, 10),
      deletions: rawDeletions === '-' ? null : Number.parseInt(rawDeletions, 10),
    });
  }
  return result;
}

/** Parse NUL-delimited name-status output so rename metadata never depends on
 * quoting, locale, spaces, or tabs in a repository path. The manifest keeps
 * the deleted source entry for exact WorkReport coverage and annotates the
 * added destination with its immutable previous path. */
function parseRenames(output: string): Map<string, string> {
  const renames = new Map<string, string>();
  const tokens = output.split('\0');
  for (let index = 0; index < tokens.length;) {
    const status = tokens[index++];
    if (!status) continue;
    if (status.startsWith('R') || status.startsWith('C')) {
      const previousPath = tokens[index++];
      const path = tokens[index++];
      if (previousPath && path && status.startsWith('R')) {
        renames.set(path, previousPath);
      }
      continue;
    }
    index += 1;
  }
  return renames;
}

async function treeMode(workspace: string, revision: string, path: string): Promise<string | null> {
  const output = await git(workspace, ['ls-tree', revision, '--', path]);
  if (!output) return null;
  return output.slice(0, output.indexOf(' '));
}

function fileStatus(
  oldMode: string | null,
  newMode: string | null,
  previousPath?: string,
): DeliveryDiffFileStatus {
  if (previousPath) return 'renamed';
  if (oldMode === null) return 'added';
  if (newMode === null) return 'deleted';
  if (oldMode !== newMode) return 'mode-changed';
  return 'modified';
}

function modeKind(
  oldMode: string | null,
  newMode: string | null,
  status: DeliveryDiffFileStatus,
): DeliveryDiffEvidenceKind | null {
  if (oldMode === '160000' || newMode === '160000') return 'submodule';
  if (oldMode === '120000' || newMode === '120000') return 'symlink';
  if (status === 'mode-changed' || (
    oldMode !== null
    && newMode !== null
    && oldMode !== newMode
  )) return 'mode-only';
  return null;
}

function containsSuspectedSecret(value: string): boolean {
  return [
    /\bsk-[A-Za-z0-9_-]{12,}\b/u,
    /\b(?:api[_-]?key|access[_-]?token|authorization|credential)\b\s*[:=]\s*["']?[^\s"']{8,}/iu,
    /https?:\/\/[^/\s:@]+:[^@\s/]+@/iu,
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
  ].some((pattern) => pattern.test(value));
}

function normalizeRelativePath(workspace: string, path: string): string {
  if (!path || path.includes('\0')) throw new Error('delivery path is invalid');
  const absolute = isAbsolute(path) ? resolve(path) : resolve(workspace, path);
  const normalized = relative(workspace, absolute).split(sep).join('/');
  if (
    !normalized
    || normalized === '..'
    || normalized.startsWith('../')
    || isAbsolute(normalized)
  ) {
    throw new Error(`delivery path escapes workspace: ${path}`);
  }
  return normalized;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: GIT_OUTPUT_LIMIT,
    windowsHide: true,
  });
  return stdout.trimEnd();
}

function boundedPositive(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`review bound must be an integer in ${minimum}..${maximum}`);
  }
  return value;
}

function countLines(value: string): number {
  if (!value) return 0;
  return (value.match(/\n/gu) ?? []).length + (value.endsWith('\n') ? 0 : 1);
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function isOutputLimitError(error: unknown): boolean {
  return error instanceof Error
    && /maxBuffer|stdout maxBuffer length exceeded/iu.test(error.message);
}
