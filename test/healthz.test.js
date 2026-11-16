const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const { healthz } = require('..');

const version = { name: 'strona', version: '1.2.3', commit: 'abc1234', date: '2026-11-16' };

async function call(checks, opts = {}) {
  const app = express();
  app.get('/healthz', healthz({ version, checks, ...opts }));
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/healthz`);
    return { status: res.status, cache: res.headers.get('cache-control'), body: await res.json() };
  } finally {
    server.close();
  }
}

test('wszystko działa: 200 i pełny opis wersji', async () => {
  const r = await call({ db: () => 1, api: async () => true });
  assert.equal(r.status, 200);
  assert.equal(r.cache, 'no-store');
  assert.equal(r.body.status, 'ok');
  assert.equal(r.body.app, 'strona');
  assert.equal(r.body.version, '1.2.3');
  assert.equal(r.body.commit, 'abc1234');
  assert.equal(r.body.node, process.versions.node);
  assert.equal(typeof r.body.uptime, 'number');
  assert.deepEqual(r.body.checks, { db: 'ok', api: 'ok' });
});

test('check rzuca, zwraca false albo nie zdąży: 503', async (t) => {
  t.mock.method(console, 'error', () => {});
  const r = await call(
    { db: () => { throw new Error('baza'); }, flag: () => false, slow: () => new Promise((res) => setTimeout(res, 500)), ok: () => 1 },
    { timeoutMs: 50 }
  );
  assert.equal(r.status, 503);
  assert.equal(r.body.status, 'error');
  assert.deepEqual(r.body.checks, { db: 'error', flag: 'error', slow: 'error', ok: 'ok' });
});

test('bez checków: 200', async () => {
  const r = await call(undefined);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.checks, {});
});
