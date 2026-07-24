import { z } from 'zod';

const boundedString = z.string().trim().min(1).max(4_096);

export const canonicalExecutionRequestSchema = z.object({
  schemaVersion: z.literal(1),
  taskId: boundedString,
  attempt: z.number().int().positive(),
  backendId: z.string().trim().min(1).max(100),
  kind: z.enum(['read', 'write', 'command', 'network', 'external']),
  workspaceRoot: boundedString,
  cwd: boundedString.optional(),
  executable: boundedString.optional(),
  argv: z.array(z.string().max(4_000)).max(1_000).optional(),
  readPaths: z.array(boundedString).max(1_000),
  writePaths: z.array(boundedString).max(1_000),
  networkHosts: z.array(z.string().trim().min(1).max(253)).max(1_000),
  environmentKeys: z.array(z.string().trim().min(1).max(500)).max(1_000),
  sideEffects: z.array(z.string().trim().min(1).max(500)).max(1_000),
  timeoutMs: z.number().int().min(1_000).max(7_200_000).optional(),
  nativeRequestId: boundedString,
}).strict().superRefine((value, ctx) => {
  if (
    value.kind === 'command'
    && (!value.executable || !Array.isArray(value.argv))
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['executable'],
      message: 'command requests require an exact executable and argv boundary',
    });
  }
});

export type CanonicalExecutionRequest = z.infer<typeof canonicalExecutionRequestSchema>;

export interface NativePermissionRequest {
  taskId: string;
  attempt: number;
  backendId: string;
  workspaceRoot: string;
  nativeRequestId: string;
  toolName: string;
  input: Record<string, unknown>;
}

export type PermissionNormalizationResult =
  | { ok: true; request: CanonicalExecutionRequest }
  | {
      ok: false;
      diagnostic:
        | 'backend-mismatch'
        | 'invalid-native-request'
        | 'opaque-shell-command'
        | 'secret-bearing-argument'
        | 'unsupported-native-tool';
      requiresUser: true;
    };

const READ_TOOLS = new Set([
  'read',
  'readfile',
  'read_file',
  'fs/read_text_file',
  'glob',
  'grep',
  'ls',
  'list',
  'search',
]);
const WRITE_TOOLS = new Set([
  'write',
  'writefile',
  'write_file',
  'fs/write_text_file',
  'edit',
  'multiedit',
  'notebookedit',
  'applypatch',
  'apply_patch',
]);
const COMMAND_TOOLS = new Set([
  'bash',
  'shell',
  'execute',
  'exec',
  'terminal',
  'runcommand',
  'run_command',
]);
const NETWORK_TOOLS = new Set([
  'webfetch',
  'web_fetch',
  'websearch',
  'web_search',
  'fetch',
]);

function normalizedToolName(toolName: string): string {
  return toolName.trim().toLowerCase().replace(/[\s-]+/g, '');
}

function uniqueSorted(values: Iterable<string>): string[] {
  return Array.from(new Set(values)).sort((left, right) => left.localeCompare(right));
}

function stringValues(value: unknown): string[] {
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    .map((entry) => entry.trim());
}

function writePaths(input: Record<string, unknown>): string[] {
  const paths = [
    ...stringValues(input.file_path),
    ...stringValues(input.filePath),
    ...stringValues(input.path),
    ...stringValues(input.paths),
    ...stringValues(input.grantRoot),
  ];
  if (input.fileChanges && typeof input.fileChanges === 'object' && !Array.isArray(input.fileChanges)) {
    paths.push(...Object.keys(input.fileChanges as Record<string, unknown>));
  }
  return uniqueSorted(paths);
}

function environmentKeys(input: Record<string, unknown>): string[] {
  const keys = stringValues(input.environmentKeys);
  if (input.env && typeof input.env === 'object' && !Array.isArray(input.env)) {
    keys.push(...Object.keys(input.env as Record<string, unknown>));
  }
  return uniqueSorted(keys);
}

function hostFromValue(value: string): string | null {
  try {
    const url = new URL(value);
    return url.hostname.toLowerCase();
  } catch {
    const host = value.trim().toLowerCase();
    return /^[a-z0-9.-]+$/.test(host) && host.includes('.') ? host : null;
  }
}

function networkHosts(input: Record<string, unknown>): string[] {
  const values = [
    ...stringValues(input.url),
    ...stringValues(input.urls),
    ...stringValues(input.host),
    ...stringValues(input.hosts),
    ...stringValues(input.networkHosts),
  ];
  return uniqueSorted(values.flatMap((value) => {
    const host = hostFromValue(value);
    return host ? [host] : [];
  }));
}

function exactCommand(
  input: Record<string, unknown>,
): { executable: string; argv: string[] } | 'opaque' | null {
  if (typeof input.executable === 'string' && input.executable.trim()) {
    if (!Array.isArray(input.argv) || !input.argv.every((entry) => typeof entry === 'string')) {
      return null;
    }
    return {
      executable: input.executable.trim(),
      argv: input.argv.map(String),
    };
  }
  if (Array.isArray(input.command) && input.command.every((entry) => typeof entry === 'string')) {
    const [executable, ...argv] = input.command.map(String);
    return executable?.trim() ? { executable: executable.trim(), argv } : null;
  }
  if (Array.isArray(input.parsedCommand)) {
    const commands = input.parsedCommand;
    if (
      commands.length === 1
      && Array.isArray(commands[0])
      && commands[0].every((entry) => typeof entry === 'string')
    ) {
      const [executable, ...argv] = commands[0].map(String);
      return executable?.trim() ? { executable: executable.trim(), argv } : null;
    }
  }
  if (typeof input.command === 'string' && input.command.trim()) return 'opaque';
  return null;
}

function commandSideEffects(
  executable: string,
  argv: readonly string[],
  envKeys: readonly string[],
): string[] {
  const effects = new Set<string>(['process']);
  const executableName = executable.replaceAll('\\', '/').split('/').at(-1)?.toLowerCase() ?? '';
  const tokens = [executableName, ...argv.map((entry) => entry.toLowerCase())];
  if (['sh', 'bash', 'zsh', 'cmd', 'cmd.exe', 'powershell', 'pwsh'].includes(executableName)) {
    effects.add('opaque-shell');
  }
  if (['sudo', 'doas', 'runas'].includes(executableName)) effects.add('administrator');
  if (
    executableName === 'git'
    && (
      argv.includes('clean')
      || (argv.includes('reset') && argv.includes('--hard'))
      || (argv.includes('push') && argv.some((arg) => arg === '--force' || arg === '-f'))
    )
  ) {
    effects.add('destructive-git');
  }
  const installTools = new Set([
    'apt',
    'apt-get',
    'brew',
    'choco',
    'dnf',
    'pacman',
    'pip',
    'pip3',
    'winget',
  ]);
  const invokesInstallTool = tokens.some((token) => installTools.has(token));
  const npmGlobalInstall = tokens.includes('npm')
    && tokens.includes('install')
    && tokens.some((token) => token === '-g' || token === '--global');
  if ((invokesInstallTool && tokens.includes('install')) || npmGlobalInstall) {
    effects.add('system-install');
  }
  if (envKeys.some((key) => /(api.?key|token|secret|password|authorization|credential)/i.test(key))) {
    effects.add('credential-access');
  }
  return uniqueSorted(effects);
}

function containsSecretBearingArgument(argv: readonly string[]): boolean {
  const secretFlag = /^(?:--?(?:api[-_]?key|auth(?:orization)?|credential|password|secret|token)|-p)$/i;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? '';
    if (secretFlag.test(argument) && index + 1 < argv.length) return true;
    if (/^--?(?:api[-_]?key|auth(?:orization)?|credential|password|secret|token)=.+/i.test(argument)) {
      return true;
    }
    try {
      const url = new URL(argument);
      if (url.username || url.password) return true;
      if (
        Array.from(url.searchParams.keys())
          .some((key) => /^(?:api[-_]?key|auth(?:orization)?|credential|password|secret|token)$/i.test(key))
      ) {
        return true;
      }
    } catch {
      // Non-URL arguments are checked only by their explicit option boundary.
    }
  }
  return false;
}

function canonicalResult(
  candidate: unknown,
): PermissionNormalizationResult {
  const parsed = canonicalExecutionRequestSchema.safeParse(candidate);
  return parsed.success
    ? { ok: true, request: parsed.data }
    : { ok: false, diagnostic: 'invalid-native-request', requiresUser: true };
}

function classifyTool(toolName: string): CanonicalExecutionRequest['kind'] | null {
  const normalized = normalizedToolName(toolName);
  if (READ_TOOLS.has(normalized)) return 'read';
  if (WRITE_TOOLS.has(normalized)) return 'write';
  if (COMMAND_TOOLS.has(normalized)) return 'command';
  if (NETWORK_TOOLS.has(normalized)) return 'network';
  if (normalized.startsWith('mcp__') || normalized === 'task' || normalized.includes('external')) {
    return 'external';
  }
  return null;
}

export function normalizeBackendPermissionRequest(
  expectedBackendId: string,
  native: NativePermissionRequest,
): PermissionNormalizationResult {
  if (native.backendId !== expectedBackendId) {
    return { ok: false, diagnostic: 'backend-mismatch', requiresUser: true };
  }
  if (
    typeof native.taskId !== 'string'
    || !native.taskId.trim()
    || !Number.isSafeInteger(native.attempt)
    || native.attempt < 1
    || typeof native.workspaceRoot !== 'string'
    || !native.workspaceRoot.trim()
    || typeof native.nativeRequestId !== 'string'
    || !native.nativeRequestId.trim()
    || typeof native.toolName !== 'string'
    || !native.toolName.trim()
    || !native.input
    || typeof native.input !== 'object'
    || Array.isArray(native.input)
  ) {
    return { ok: false, diagnostic: 'invalid-native-request', requiresUser: true };
  }

  const kind = classifyTool(native.toolName);
  if (!kind) {
    return { ok: false, diagnostic: 'unsupported-native-tool', requiresUser: true };
  }

  const input = native.input;
  const envKeys = environmentKeys(input);
  const reads = kind === 'read' ? writePaths(input) : [];
  const paths = kind === 'write' ? writePaths(input) : [];
  const hosts = kind === 'network' ? networkHosts(input) : [];
  const base = {
    schemaVersion: 1 as const,
    taskId: native.taskId.trim(),
    attempt: native.attempt,
    backendId: expectedBackendId,
    kind,
    workspaceRoot: native.workspaceRoot.trim(),
    readPaths: reads,
    writePaths: paths,
    networkHosts: hosts,
    environmentKeys: envKeys,
    sideEffects: kind === 'write'
      ? ['workspace-write']
      : kind === 'network'
        ? ['network']
        : kind === 'external'
          ? ['external-service']
          : [],
    nativeRequestId: native.nativeRequestId.trim(),
  };

  if (kind !== 'command') {
    return canonicalResult(base);
  }

  const command = exactCommand(input);
  if (command === 'opaque') {
    return { ok: false, diagnostic: 'opaque-shell-command', requiresUser: true };
  }
  if (!command) {
    return { ok: false, diagnostic: 'invalid-native-request', requiresUser: true };
  }
  if (containsSecretBearingArgument(command.argv)) {
    return { ok: false, diagnostic: 'secret-bearing-argument', requiresUser: true };
  }
  const cwd = typeof input.cwd === 'string' && input.cwd.trim()
    ? input.cwd.trim()
    : undefined;
  const timeoutMs = typeof input.timeoutMs === 'number'
    ? input.timeoutMs
    : typeof input.timeout === 'number'
      ? input.timeout
      : undefined;
  return canonicalResult({
    ...base,
    ...(cwd ? { cwd } : {}),
    executable: command.executable,
    argv: command.argv,
    sideEffects: commandSideEffects(command.executable, command.argv, envKeys),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  });
}
