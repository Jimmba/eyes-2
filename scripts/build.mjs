// Сборка: esbuild-бандл + копирование wasm, модели и статики в dist/.
import { build } from 'esbuild';
import { cp, mkdir, rm, access, writeFile } from 'node:fs/promises';

const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
const MODEL_CACHE = '.cache/face_landmarker.task';

const exists = (p) => access(p).then(() => true, () => false);

async function ensureModel() {
  if (await exists(MODEL_CACHE)) return;
  console.log('Скачиваю модель face_landmarker.task ...');
  const res = await fetch(MODEL_URL);
  if (!res.ok) throw new Error(`Не удалось скачать модель: HTTP ${res.status}`);
  await mkdir('.cache', { recursive: true });
  await writeFile(MODEL_CACHE, Buffer.from(await res.arrayBuffer()));
}

await rm('dist', { recursive: true, force: true });
await mkdir('dist', { recursive: true });

await build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  format: 'esm',
  target: 'es2020',
  sourcemap: true,
  outfile: 'dist/app.js',
});

await cp('static', 'dist', { recursive: true });
await cp('node_modules/@mediapipe/tasks-vision/wasm', 'dist/wasm', { recursive: true });
await ensureModel();
await cp(MODEL_CACHE, 'dist/face_landmarker.task');

console.log('Готово: dist/');
