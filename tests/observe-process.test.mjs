import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  cmdHasBinary,
  descendantsOf,
  findClientPids,
  isExcludedCommand,
  maxDescendantCpu,
  parseLsofFieldOutput,
  parsePsOutput,
} from '../dist-electron/observe/process/darwin.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'observe');

const psText = readFileSync(join(FIXTURES, 'ps-sample.txt'), 'utf8');
const snapshot = parsePsOutput(psText, 1_000);

// ---------------------------------------------------------------------------
// parsePsOutput
// ---------------------------------------------------------------------------

test('ps parsing: pid/ppid/cpu/rss/comm/args columns', () => {
  const launchd = snapshot.byPid.get(1);
  assert.equal(launchd.ppid, 0);
  assert.equal(launchd.cpuPct, 0.2);
  assert.equal(launchd.rssKb, 15168);
  assert.equal(launchd.comm, '/sbin/launchd');
  assert.equal(launchd.command, '/sbin/launchd');
});

test('ps parsing: full args survive spaces and truncation of comm', () => {
  const claude = snapshot.byPid.get(4201);
  assert.equal(
    claude.command,
    '/usr/local/bin/claude --resume c1a0de00-0000-4000-8000-000000000001',
  );
  const helper = snapshot.byPid.get(4502);
  assert.match(helper.command, /Claude Helper \(Renderer\).*--type=renderer/);
  assert.equal(snapshot.byPid.get(4202).cpuPct, 12.5);
});

test('ps parsing: tt column (tty vs ?? for terminal-less processes)', () => {
  assert.equal(snapshot.byPid.get(4201).tty, 's003');
  assert.equal(snapshot.byPid.get(4210).tty, 's005');
  assert.equal(snapshot.byPid.get(5102).tty, 's015');
  assert.equal(snapshot.byPid.get(1).tty, '??');
  // Codex Desktop host + chat-spawned processes have no controlling terminal.
  assert.equal(snapshot.byPid.get(86693).tty, '??');
  assert.equal(snapshot.byPid.get(97611).tty, '??');
  // The tty column must not leak into comm/args.
  assert.equal(snapshot.byPid.get(97611).command, '/opt/homebrew/bin/node --test tests/onnx-session-init.test.mjs');
  assert.equal(snapshot.byPid.get(5101).comm, 'kimi-code');
});

// ---------------------------------------------------------------------------
// cmdHasBinary
// ---------------------------------------------------------------------------

test('cmdHasBinary: plain binary, shim path, node wrapper, .exe', () => {
  assert.equal(cmdHasBinary('claude --resume abc', 'claude'), true);
  assert.equal(cmdHasBinary('/usr/local/bin/claude --resume abc', 'claude'), true);
  assert.equal(
    cmdHasBinary('node /opt/homebrew/lib/node_modules/@openai/codex/bin/codex.js', 'codex'),
    true,
  );
  assert.equal(cmdHasBinary('C:\\tools\\codex.exe resume', 'codex'), true);
  assert.equal(cmdHasBinary('/usr/local/bin/codex mcp-server', 'codex'), true);
});

test('cmdHasBinary: name inside a path argument is not a match', () => {
  assert.equal(cmdHasBinary('code /Users/test/.claude/settings.json', 'claude'), false);
  assert.equal(cmdHasBinary('vim notes/claude-ideas.md', 'claude'), false);
  assert.equal(cmdHasBinary('tar czf backup.tgz .claude/', 'claude'), false);
  assert.equal(cmdHasBinary('node server.js', 'codex'), false);
});

// ---------------------------------------------------------------------------
// exclusion list
// ---------------------------------------------------------------------------

test('exclusion list: Electron helpers, .app bundles, mcp-server, grep', () => {
  assert.equal(isExcludedCommand('/Applications/Claude.app/Contents/MacOS/Claude'), true);
  assert.equal(
    isExcludedCommand(
      '/Applications/Claude.app/Contents/Frameworks/Claude Helper (Renderer).app/Contents/MacOS/Claude Helper (Renderer) --type=renderer',
    ),
    true,
  );
  assert.equal(isExcludedCommand('/foo/Electron Helper --type=gpu-process'), true);
  assert.equal(isExcludedCommand('/usr/local/bin/codex mcp-server'), true);
  assert.equal(isExcludedCommand('/x/plugins/vendor/run.sh claude'), true);
  assert.equal(isExcludedCommand('/x/app-server-broker --flag'), true);
  assert.equal(isExcludedCommand('grep -i claude'), true);
  assert.equal(isExcludedCommand('/usr/local/bin/claude'), false);
});

test('findClientPids: matches CLI processes, skips helpers/mcp/grep/args', () => {
  const claudePids = findClientPids(snapshot, ['claude']).sort((a, b) => a - b);
  assert.deepEqual(claudePids, [4201, 4210]);
  const codexPids = findClientPids(snapshot, ['codex']).sort((a, b) => a - b);
  assert.deepEqual(codexPids, [4301, 4302]);
});

// ---------------------------------------------------------------------------
// descendants / cpu
// ---------------------------------------------------------------------------

test('descendantsOf: two levels, cycle-protected', () => {
  assert.deepEqual([...descendantsOf(snapshot, 4210, 2)].sort(), [4202, 4203]);
  // One level misses the grandchild.
  assert.deepEqual([...descendantsOf(snapshot, 4210, 1)], [4202]);
  // ppid cycle must terminate.
  const cycled = descendantsOf(snapshot, 9001, 4);
  assert.deepEqual([...cycled].sort(), [9002]);
});

test('maxDescendantCpu: max over the two-level tree', () => {
  assert.equal(maxDescendantCpu(snapshot, 4210), 12.5);
  assert.equal(maxDescendantCpu(snapshot, 4201), 0);
});

// ---------------------------------------------------------------------------
// lsof -F parsing
// ---------------------------------------------------------------------------

test('parseLsofFieldOutput: cwd, files, permission-denied drop', () => {
  const text = readFileSync(join(FIXTURES, 'lsof-sample.txt'), 'utf8');
  const map = parseLsofFieldOutput(text);
  assert.equal(map.get(4201).cwd, '/Users/test/work/project-alpha');
  // Socket-style names are not files.
  assert.deepEqual(map.get(4201).files, ['/usr/local/bin/claude']);
  assert.equal(map.get(4301).cwd, '/Users/test/work/project-gamma');
  assert.match(map.get(4301).files[0], /rollout-.*d0de0000-0000-7000-8000-0000000000a1\.jsonl$/);
  // readlink permission error → cwd dropped, file entries still parsed.
  const mcp = map.get(4401);
  assert.equal(mcp.cwd, undefined);
  assert.equal(mcp.files.length, 2);
});
