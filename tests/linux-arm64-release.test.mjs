import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);

test('RK3588 release script keeps build, verification and manifest gates in order', async () => {
  const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
  const command = pkg.scripts['dist:linux:arm64'];
  assert.match(command, /electron-builder --linux --arm64 --publish never/);
  assert.match(command, /verify-linux-arm64-package/);
  assert.match(command, /generate-release-manifest/);
  assert.ok(
    command.indexOf('verify-linux-arm64-package')
      < command.indexOf('generate-release-manifest'),
    'manifest must be generated only after package verification',
  );
});

test('Linux package declares both arm64 artifacts and Electron desktop dependencies', async () => {
  const config = JSON.parse(await readFile(new URL('electron-builder.json', root), 'utf8'));
  assert.deepEqual(config.linux.target, ['AppImage', 'deb']);
  // Arch must NOT be pinned per target: a pinned x64+arm64 list made every
  // `--arm64` run also build a wasted ~1 GB x64 package. Arch selection
  // lives in the CLI flags (--x64 / --arm64) instead.
  for (const target of config.linux.target) assert.equal(typeof target, 'string');
  for (const dependency of ['libasound2', 'libgbm1', 'libgtk-3-0', 'libnotify4', 'libxtst6', 'xdg-utils']) {
    assert.ok(config.deb.depends.includes(dependency), `${dependency} must be declared`);
  }
});

test('Linux CI jobs select their arch explicitly via CLI flags', async () => {
  const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
  assert.match(pkg.scripts['dist:linux:arm64'], /--linux --arm64/);
  const workflow = await readFile(new URL('.github/workflows/build-matrix.yml', root), 'utf8');
  // x64 ubuntu runner must not rely on the config default either.
  assert.match(workflow, /electron-builder --linux --x64 --publish never/);
  // linux-arm64 job keeps its explicit arm64 flag.
  assert.match(workflow, /electron-builder --linux --arm64 --publish never/);
});

test('arm64 CI is built inside Debian 11 and signed releases depend on it', async () => {
  const workflow = await readFile(new URL('.github/workflows/build-matrix.yml', root), 'utf8');
  assert.match(workflow, /linux-arm64:/);
  assert.match(workflow, /container:\s*debian:11/);
  assert.doesNotMatch(workflow, /container:\s*debian:12/);
  assert.match(workflow, /runs-on:\s*ubuntu-24\.04-arm/);
  assert.match(workflow, /needs:\s*\[build, linux-arm64\]/);
  assert.match(workflow, /--require-signature/);
  assert.match(workflow, /AHASTATION_RELEASE_GPG_PRIVATE_KEY/);
});

test('board gate checks packaged runtimes; Kimi and strict versions are opt-in', async () => {
  const gate = await readFile(new URL('scripts/board/verify-rk3588.sh', root), 'utf8');
  const versions = await readFile(new URL('scripts/board/runtime-versions.env', root), 'utf8');
  assert.match(gate, /\/opt\/AhaStation\/resources/);
  assert.match(gate, /claude-agent-sdk-linux-arm64/);
  assert.match(gate, /codex-linux-arm64/);
  assert.match(gate, /opencode-linux-arm64/);
  assert.match(gate, /AHASTATION_GATE_STRICT/);
  assert.match(gate, /AHASTATION_GATE_REQUIRE_KIMI/);
  assert.match(versions, /CLAUDE_VERSION=2\.1\.150/);
  assert.match(versions, /CODEX_VERSION=0\.144\.1/);
  assert.match(versions, /OPENCODE_VERSION=1\.18\.3/);
  assert.match(versions, /KIMI_VERSION=0\.24\.1/);
});
