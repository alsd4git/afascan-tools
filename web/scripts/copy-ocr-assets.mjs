import { cp, mkdir, readdir, rm, stat } from 'node:fs/promises';
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
const coreDir = packageRoot('tesseract.js-core');
for (const name of await readdir(coreDir)) {
  if (!name.startsWith('tesseract-core')) continue;
  const source = join(coreDir, name);
  if ((await stat(source)).isFile()) await cp(source, join(output, 'core', name));
}
await cp(join(packageRoot('@tesseract.js-data/eng'), '4.0.0_best_int', 'eng.traineddata.gz'), join(output, 'lang', 'eng.traineddata.gz'));
console.log(`Copied self-hosted OCR assets to ${output}`);
