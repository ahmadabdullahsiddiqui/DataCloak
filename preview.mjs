// preview.mjs — zero-dependency static server for local preview of the docs/ site.
// Run: `npm run preview` (or `node preview.mjs`) then open http://localhost:8080
// GitHub Pages serves docs/ the same way; this just lets you test locally without
// installing anything (ES modules and web workers can't be loaded over file://).

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), 'docs');
const PORT = process.env.PORT || 8080;
const HOST = process.env.HOST || '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
};

createServer(async (req, res) => {
  try {
    let path = decodeURIComponent(req.url.split('?')[0]);
    if (path === '/') path = '/index.html';
    // Resolve the request inside ROOT and confirm it stays there. Comparing against
    // `ROOT + sep` (not bare ROOT) prevents a sibling like `docs-secret/` — which
    // shares the `docs` prefix — from passing the check.
    const filePath = resolve(ROOT, '.' + path);
    if (filePath !== ROOT && !filePath.startsWith(ROOT + sep)) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    const data = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[extname(filePath)] || 'application/octet-stream',
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
  }
}).listen(PORT, HOST, () => {
  console.log(`DataCloak preview: http://${HOST}:${PORT}`);
});
