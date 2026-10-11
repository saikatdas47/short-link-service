import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createService } from '../server.js';

async function start(path) {
  const server = createService(path);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}
async function stop(server) {
  const closed = once(server, 'close');
  server.close();
  await closed;
}
function create(base, body) {
  return fetch(base + '/links', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
}

test('invalid inputs return field errors and leave no stored link', async () => {
  const { server, base } = await start();
  try {
    for (const body of ['{', '', 'null', '[]', '{}', '{"url":2}', '{"url":""}', '{"url":"bad"}', '{"url":"javascript:alert(1)"}', '{"url":"https://user:password@example.com"}', '{"url":" https://example.com"}', JSON.stringify({ url: 'https://example.com/' + 'x'.repeat(2048) }), 'x'.repeat(17000)]) {
      const response = await create(base, body);
      assert.equal(response.status, 400, body.slice(0, 50));
      const result = await response.json();
      assert.equal(result.error, 'validation');
      assert.ok(result.fields.url || result.fields.body);
    }
    assert.equal((await fetch(base + '/unknown1', { redirect: 'manual' })).status, 404);
    assert.equal((await fetch(base + '/links/unknown1/stats')).status, 404);
    // A rejected credential URL must not become the valid URL's first record.
    assert.equal((await create(base, JSON.stringify({ url: 'https://example.com/' }))).status, 201);
  } finally { await stop(server); }
});

test('concurrent creates return one code, redirects count, retries retain their response', async () => {
  const { server, base } = await start();
  try {
    const responses = await Promise.all(Array.from({ length: 20 }, () => create(base, '{"url":"https://example.com"}')));
    assert.equal(responses.filter(response => response.status === 201).length, 1);
    const bodies = await Promise.all(responses.map(response => response.json()));
    for (const body of bodies) assert.deepEqual(body, bodies[0]);
    const link = bodies[0];
    assert.equal((await fetch(base + `/links/${link.code}/stats`).then(res => res.json())).visits, 0);
    const redirects = await Promise.all(Array.from({ length: 10 }, () => fetch(base + link.path, { redirect: 'manual' })));
    for (const response of redirects) {
      assert.equal(response.status, 302);
      assert.equal(response.headers.get('location'), 'https://example.com/');
      assert.equal(response.headers.get('cache-control'), 'no-store');
    }
    assert.equal((await fetch(base + `/links/${link.code}/stats`).then(res => res.json())).visits, 10);
    const retry = await create(base, '{"url":"https://example.com/"}');
    assert.equal(retry.status, 200);
    assert.deepEqual(await retry.json(), link);
  } finally { await stop(server); }
});

test('links and counts survive a service restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'short-link-test-'));
  const database = join(directory, 'links.db');
  let service = await start(database);
  try {
    const link = await create(service.base, '{"url":"https://example.org"}').then(res => res.json());
    await fetch(service.base + link.path, { redirect: 'manual' });
    await stop(service.server);
    service = await start(database);
    assert.deepEqual(await create(service.base, '{"url":"https://example.org"}').then(res => res.json()), link);
    assert.equal((await fetch(service.base + `/links/${link.code}/stats`).then(res => res.json())).visits, 1);
  } finally {
    await stop(service.server);
    rmSync(directory, { recursive: true, force: true });
  }
});
