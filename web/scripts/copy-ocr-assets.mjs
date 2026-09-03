import { cp, mkdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = dirname(here);
const output = join(webRoot, 'public', 'ocr');
const require = createRequire(import.meta.url);
const packageRoot = (name) => dirname(require.resolve(`${name}/package.json`));

await rm(output, { recursive: true, force: true });
await mkdir(join(output, 'core'), { recursive: true });
await mkdir(join(output, 'lang'), { recursive: true });
await mkdir(join(webRoot, 'public'), { recursive: true });
await cp(join(webRoot, '..', 'favicon.svg'), join(webRoot, 'public', 'favicon.svg'));
await cp(join(packageRoot('tesseract.js'), 'dist', 'worker.min.js'), join(output, 'worker.min.js'));
await cp(join(webRoot, 'static', 'ocr-core-loader.js'), join(output, 'core-loader.js'));

const coreDir = packageRoot('tesseract.js-core');
const variants = [
  'tesseract-core-lstm',
  'tesseract-core-simd-lstm',
  'tesseract-core-relaxedsimd-lstm',
];
for (const variant of variants) {
  await cp(join(coreDir, `${variant}.js`), join(output, 'core', `${variant}.js`));
  await cp(join(coreDir, `${variant}.wasm`), join(output, 'core', `${variant}.wasm`));
}

await cp(join(packageRoot('@tesseract.js-data/eng'), '4.0.0_best_int', 'eng.traineddata.gz'), join(output, 'lang', 'eng.traineddata.gz'));
console.log(`Copied self-hosted OCR assets to ${output}`);
