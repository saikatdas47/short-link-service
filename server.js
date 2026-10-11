import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 16384) throw new Error('body must be at most 16384 bytes');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('body must be valid JSON');
  }
}

function validateUrl(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'body must be a JSON object' };
  }
  if (typeof body.url !== 'string' || body.url.trim() === '') {
    return { error: 'url is required and must be a string' };
  }
  if (body.url.length > 2048) return { error: 'url must be at most 2048 characters' };
  try {
    if (!/^https?:\/\//i.test(body.url) || /[\s\\]/.test(body.url)) throw new Error();
    const url = new URL(body.url);
    if (!url.hostname || url.username || url.password) throw new Error();
    return { url: url.href };
  } catch {
    return { error: 'url must be an absolute HTTP or HTTPS URL without credentials or whitespace' };
  }
}

export function createService(databasePath = ':memory:') {
  if (databasePath !== ':memory:') mkdirSync(dirname(resolve(databasePath)), { recursive: true });
  const db = new DatabaseSync(databasePath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS links (
      code TEXT PRIMARY KEY,
      url TEXT NOT NULL UNIQUE,
      visits INTEGER NOT NULL DEFAULT 0,
      createdAt TEXT NOT NULL
    );
  `);
  const byUrl = db.prepare('SELECT * FROM links WHERE url = ?');
  const byCode = db.prepare('SELECT * FROM links WHERE code = ?');
  const insert = db.prepare('INSERT OR IGNORE INTO links (code, url, createdAt) VALUES (?, ?, ?)');
  const follow = db.prepare('UPDATE links SET visits = visits + 1 WHERE code = ? RETURNING url');

  const server = http.createServer(async (req, res) => {
    try {
      const path = new URL(req.url, 'http://localhost').pathname;
      if (req.method === 'GET' && path === '/health') {
        return sendJson(res, 200, { ok: true });
      }
      if (req.method === 'POST' && path === '/links') {
        let body;
        try {
          body = await readBody(req);
        } catch (error) {
          return sendJson(res, 400, { error: 'validation', fields: { body: error.message } });
        }
        const validated = validateUrl(body);
        if (validated.error) {
          const field = validated.error.startsWith('body') ? 'body' : 'url';
          return sendJson(res, 400, { error: 'validation', fields: { [field]: validated.error } });
        }
        let link = byUrl.get(validated.url);
        let created = false;
        while (!link) {
          const code = randomBytes(6).toString('base64url');
          const result = insert.run(code, validated.url, new Date().toISOString());
          created = result.changes > 0;
          link = byUrl.get(validated.url);
        }
        // Keep the create response stable even if visit statistics later change.
        return sendJson(res, created ? 201 : 200, { code: link.code, url: link.url, path: '/' + link.code });
      }
      const stats = path.match(/^\/links\/([A-Za-z0-9_-]{8})\/stats$/);
      if (req.method === 'GET' && stats) {
        const link = byCode.get(stats[1]);
        return link ? sendJson(res, 200, link) : sendJson(res, 404, { error: 'not_found', message: 'code was not found' });
      }
      const lookup = path.match(/^\/([A-Za-z0-9_-]{8})$/);
      if (req.method === 'GET' && lookup) {
        const link = follow.get(lookup[1]);
        if (!link) return sendJson(res, 404, { error: 'not_found', message: 'code was not found' });
        res.writeHead(302, { Location: link.url, 'Cache-Control': 'no-store' });
        return res.end();
      }
      return sendJson(res, 404, { error: 'not_found', message: 'route or code was not found' });
    } catch (error) {
      const id = randomBytes(8).toString('hex');
      console.error(JSON.stringify({ id, error: error.name }));
      if (!res.headersSent) sendJson(res, 500, { error: 'internal', id });
      else res.end();
    }
  });
  server.on('close', () => db.close());
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const port = Number(process.env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer between 1 and 65535');
  const server = createService(process.env.DB_PATH || './data/links.db');
  server.listen(port, '0.0.0.0', () => console.log(`Short-link service listening on port ${port}`));
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(1), 10000).unref();
    });
  }
}
