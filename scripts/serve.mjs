// Минимальный статический сервер для dist/ на http://localhost:8080 (камере нужен localhost или HTTPS).
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.map': 'application/json',
  '.task': 'application/octet-stream',
};
const port = Number(process.env.PORT) || 8080;

http
  .createServer(async (req, res) => {
    try {
      let p = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname));
      if (p.endsWith('/') || p === '') p = join(p, 'index.html');
      if (p.includes('..')) throw new Error('bad path');
      const data = await readFile(join('dist', p));
      res.writeHead(200, { 'Content-Type': TYPES[extname(p)] ?? 'application/octet-stream' });
      res.end(data);
    } catch {
      res.writeHead(404);
      res.end('Not found');
    }
  })
  .listen(port, () => console.log(`http://localhost:${port}`));
