// Тесты математики: esbuild собирает tests/*.test.ts в .cache/tests, дальше встроенный раннер node --test.
import { build } from 'esbuild';
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const names = readdirSync('tests').filter((f) => f.endsWith('.test.ts'));
await build({
  entryPoints: names.map((f) => `tests/${f}`),
  bundle: true,
  platform: 'node',
  format: 'esm',
  outdir: '.cache/tests',
  outExtension: { '.js': '.mjs' },
  logLevel: 'warning',
});
const files = names.map((f) => `.cache/tests/${f.replace(/\.ts$/, '.mjs')}`);
const r = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(r.status ?? 1);
