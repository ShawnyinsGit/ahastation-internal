import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

async function loadHelper() {
  const source = await readFile(
    new URL('../src/lib/delivery-feedback.ts', import.meta.url),
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

test('short affirmations map to accept semantics', async () => {
  const { isAffirmativeDeliveryFeedback } = await loadHelper();
  for (const text of ['可以了', '可以了！', 'OK', 'ok.', 'LGTM', '没问题', '通过']) {
    assert.equal(isAffirmativeDeliveryFeedback(text), true, text);
  }
});

test('real revision feedback is not affirmative', async () => {
  const { isAffirmativeDeliveryFeedback } = await loadHelper();
  for (const text of ['可以再改一下', '还要补测试', '请重做', '']) {
    assert.equal(isAffirmativeDeliveryFeedback(text), false, text);
  }
});
