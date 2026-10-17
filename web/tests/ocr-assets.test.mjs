import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const here = dirname(fileURLToPath(import.meta.url));
const ocrRoot = join(here, '..', 'public', 'ocr');
const coreRoot = join(ocrRoot, 'core');

const expectedCoreFiles = [
  'tesseract-core-lstm.js',
  'tesseract-core-lstm.wasm',
  'tesseract-core-relaxedsimd-lstm.js',
  'tesseract-core-relaxedsimd-lstm.wasm',
  'tesseract-core-simd-lstm.js',
  'tesseract-core-simd-lstm.wasm',
];

test('self-hosted OCR bundle uses split JS/WASM LSTM cores', async () => {
  for (const path of [join(ocrRoot, 'worker.min.js'), join(ocrRoot, 'core-loader.js'), join(ocrRoot, 'lang', 'eng.traineddata.gz')]) {
    assert.ok((await stat(path)).size > 0, `${path} should not be empty`);
  }

  assert.deepEqual((await readdir(coreRoot)).sort(), expectedCoreFiles.sort());
  assert.equal((await readdir(coreRoot)).some((name) => name.endsWith('.wasm.js')), false);

  const loader = await readFile(join(ocrRoot, 'core-loader.js'), 'utf8');
  assert.match(loader, /tesseract-core-relaxedsimd-lstm/);
  assert.match(loader, /tesseract-core-simd-lstm/);
  assert.match(loader, /tesseract-core-lstm/);
  assert.match(loader, /locateFile/);
});
