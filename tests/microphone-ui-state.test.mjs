import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

async function loadStateModule() {
  const source = await readFile(
    new URL('../src/lib/microphone-ui-state.ts', import.meta.url),
    'utf8',
  );
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(output).toString('base64')}`);
}

test('Xunfei initialization never presents the microphone as unsupported', async () => {
  const { deriveMicrophoneUiState } = await loadStateModule();
  assert.deepEqual(
    deriveMicrophoneUiState({ mode: 'xfyun', captureStatus: 'initializing' }),
    { supported: true, retryable: false },
  );
});

test('Xunfei failures keep the microphone control available for retry', async () => {
  const { deriveMicrophoneUiState } = await loadStateModule();
  for (const captureStatus of ['permission-denied', 'failed']) {
    assert.deepEqual(
      deriveMicrophoneUiState({ mode: 'xfyun', captureStatus }),
      { supported: true, retryable: true },
    );
  }
});

test('unavailable mode (credentials missing) reports unsupported and non-retryable', async () => {
  const { deriveMicrophoneUiState } = await loadStateModule();
  assert.deepEqual(
    deriveMicrophoneUiState({ mode: 'unavailable', captureStatus: 'idle' }),
    { supported: false, retryable: false },
  );
});

test('probing mode stays supported while the ASR probe is in flight', async () => {
  const { deriveMicrophoneUiState } = await loadStateModule();
  assert.deepEqual(
    deriveMicrophoneUiState({ mode: 'probing', captureStatus: 'initializing' }),
    { supported: true, retryable: false },
  );
});

test('audio meter level distinguishes silence from an active signal', async () => {
  const { computeAudioLevel } = await loadStateModule();
  assert.equal(computeAudioLevel(new Uint8Array([128, 128, 128, 128])), 0);
  assert.ok(computeAudioLevel(new Uint8Array([64, 192, 64, 192])) > 0.4);
});

test('microphone operations wait for the previous device release', async () => {
  const { serializeMicrophoneOperation } = await loadStateModule();
  let finishRelease;
  const previous = new Promise((resolve) => { finishRelease = resolve; });
  let nextStarted = false;
  const queued = serializeMicrophoneOperation(previous, async () => {
    nextStarted = true;
  });

  await Promise.resolve();
  assert.equal(nextStarted, false);
  finishRelease();
  await queued;
  assert.equal(nextStarted, true);
});
