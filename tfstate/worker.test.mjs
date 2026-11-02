import assert from 'node:assert/strict';
import test from 'node:test';
import worker from './worker.mjs';

function fixture() {
  const entries = new Map();
  const env = {
    OWNER_EMAIL: 'owner@example.test', ACCESS_AUD: 'aud-test', STATE_HOST: 'tfstate.example.test',
    TFSTATE: {
      async get(key) { return entries.get(key) ?? null; },
      async put(key, bytes) { entries.set(key, bytes); },
      async delete(key) { entries.delete(key); },
    },
  };
  const ctx = { access: { aud: 'aud-test', async getIdentity() { return { email: env.OWNER_EMAIL }; } } };
  const call = (path, init = {}, context = ctx, bindings = env) => worker.fetch(new Request(`https://tfstate.example.test${path}`, init), bindings, context);
  return { entries, env, ctx, call };
}

test('anonymous, spoofed header, wrong owner and audience cannot access KV', async () => {
  const { call, entries } = fixture();
  for (const method of ['GET', 'POST', 'DELETE']) {
    assert.equal((await call('/tfstate/a', { method, headers: { 'Cf-Access-Jwt-Assertion': 'spoofed' } }, {})).status, 403);
  }
  assert.equal((await call('/tfstate/a', {}, { access: { aud: 'other', getIdentity() { throw Error(); } } })).status, 403);
  assert.equal((await call('/tfstate/a', {}, { access: { aud: 'aud-test', async getIdentity() { return { email: 'other@example.test' }; } } })).status, 403);
  assert.equal(entries.size, 0);
});

test('owner round-trips exact bytes, archives and deletes in dedicated namespace', async () => {
  const { call, entries } = fixture();
  const bytes = new Uint8Array([0, 255, 123, 125]);
  assert.equal((await call('/tfstate/agni/leader')).status, 404);
  assert.equal((await call('/tfstate/agni/leader', { method: 'POST', body: bytes })).status, 200);
  const read = await call('/tfstate/agni/leader');
  assert.equal(read.headers.get('cache-control'), 'no-store');
  assert.deepEqual(new Uint8Array(await read.arrayBuffer()), bytes);
  assert.equal((await call('/tfstate/agni/other')).status, 404);
  assert.equal((await call('/tfstate/agni/leader', { method: 'DELETE' })).status, 200);
  assert.equal((await call('/tfstate/agni/leader')).status, 404);
  assert.equal(entries.size, 2);
  assert([...entries.keys()].every(key => key.startsWith('terraform/agni/leader/history/')));
});

test('no editor, auth exchange, lock emulation, or malformed scope routes', async () => {
  const { call } = fixture();
  for (const path of ['/', '/file/a', '/auth/github-oidc', '/tfstate/a//b', '/tfstate/%FF', '/tfstate/' + 'a'.repeat(401)]) {
    assert.equal((await call(path)).status, 404, path);
  }
  assert.equal((await call('/tfstate/a', { method: 'LOCK' })).status, 405);
});

test('missing deployment policy fails closed and oversized writes do not persist', async () => {
  const { call, env, ctx, entries } = fixture();
  assert.equal((await call('/tfstate/a', {}, ctx, { ...env, OWNER_EMAIL: '' })).status, 503);
  assert.equal((await call('/tfstate/a', {}, ctx, { ...env, STATE_HOST: 'other.example.test' })).status, 403);
  assert.equal((await call('/tfstate/a', { method: 'POST', headers: { 'content-length': String(25 * 1024 * 1024 + 1) }, body: 'x' })).status, 413);
  assert.equal(entries.size, 0);
});

test('history failure prevents replacement of current state', async () => {
  const { call, env } = fixture();
  await call('/tfstate/a', { method: 'POST', body: 'original' });
  env.TFSTATE.put = async () => { throw Error('storage failure'); };
  assert.equal((await call('/tfstate/a', { method: 'POST', body: 'replacement' })).status, 500);
  assert.equal(await (await call('/tfstate/a')).text(), 'original');
});
