import assert from 'node:assert/strict';
import test from 'node:test';
import { AuthError } from '@xd-dash/auth.net.im/core';
import { createTfstateApp } from './worker.mjs';

function fixture() {
  const entries = new Map();
  const env = {
    GITHUB_AUDIENCE: 'firekv-test',
    GITHUB_OWNER: 'xd-dash',
    GITHUB_OWNER_ID: '271412537',
    GITHUB_REPOSITORIES: 'xd-dash/huram-abi-master',
    GITHUB_REPOSITORY_IDS: '1343039009',
    GITHUB_REFS: 'refs/heads/worktree-automation',
    GITHUB_WORKFLOW_PREFIX: 'xd-dash/huram-abi-master/.github/workflows/',
    FIREKV_SESSION_SECRET: 'test-only-secret-with-more-than-32-bytes',
    FIREKV_SESSION_TTL_SECONDS: '3600',
    TFSTATE: {
      async get(key) { return entries.get(key) ?? null; },
      async put(key, value) { entries.set(key, value); },
      async delete(key) { entries.delete(key); },
    },
  };
  const provider = {
    async authenticate({ request }) {
      if (request.headers.get('authorization') !== 'Bearer valid-github-oidc') {
        throw new AuthError(403, 'invalid_assertion', 'GitHub OIDC assertion is invalid');
      }
      return {
        provider: 'github',
        subject: 'repo:xd-dash/huram-abi-master:ref:refs/heads/worktree-automation',
        attributes: {
          repository: 'xd-dash/huram-abi-master',
          repository_id: '1343039009',
          run_id: '12345',
        },
      };
    },
  };
  const app = createTfstateApp(provider);
  const call = (path, init = {}, bindings = env) =>
    app.request('https://tfstate.example.test' + path, init, bindings);
  return { app, call, entries, env };
}

test('GitHub OIDC mints a short-lived scope-bound Terraform capability', async () => {
  const { call } = fixture();
  const denied = await call('/auth/github-oidc', { method: 'POST', headers: { authorization: 'Basic ZmlyZXdrdjpleGFtcGxl' }, body: JSON.stringify({ scope: 'dns/prod' }) });
  assert.equal(denied.status, 403);

  const minted = await call('/auth/github-oidc', {
    method: 'POST',
    headers: { authorization: 'Bearer valid-github-oidc', 'content-type': 'application/json' },
    body: JSON.stringify({ scope: 'dns/prod' }),
  });
  assert.equal(minted.status, 200);
  const result = await minted.json();
  assert.equal(result.username, 'firekv');
  assert.equal(result.scope, 'dns/prod');
  assert.match(result.password, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.equal(result.address, 'https://tfstate.example.test/tfstate/dns/prod');
  assert.ok(Date.parse(result.expires_at) > Date.now());
});

test('only the scoped Basic capability accesses Terraform state', async () => {
  const { call, entries } = fixture();
  const exchange = await call('/auth/github-oidc', {
    method: 'POST',
    headers: { authorization: 'Bearer valid-github-oidc', 'content-type': 'application/json' },
    body: JSON.stringify({ scope: 'dns/prod' }),
  });
  const { username, password } = await exchange.json();
  const authorization = 'Basic ' + btoa(username + ':' + password);

  const bytes = new Uint8Array([0, 255, 123, 125]);
  assert.equal((await call('/tfstate/dns/prod', { method: 'POST', headers: { authorization }, body: bytes })).status, 200);
  const read = await call('/tfstate/dns/prod', { headers: { authorization } });
  assert.equal(read.status, 200);
  assert.equal(read.headers.get('cache-control'), 'no-store');
  assert.deepEqual(new Uint8Array(await read.arrayBuffer()), bytes);
  assert.equal((await call('/tfstate/dns/other', { headers: { authorization } })).status, 401);

  const oidcCannotRead = await call('/tfstate/dns/prod', { headers: { authorization: 'Bearer valid-github-oidc' } });
  assert.equal(oidcCannotRead.status, 401);
  const capabilityCannotMint = await call('/auth/github-oidc', {
    method: 'POST',
    headers: { authorization, 'content-type': 'application/json' },
    body: JSON.stringify({ scope: 'dns/other' }),
  });
  assert.equal(capabilityCannotMint.status, 403);

  assert.deepEqual([...entries.keys()], ['terraform/dns/prod/terraform.tfstate']);
  assert.equal((await call('/tfstate/dns/prod', { method: 'DELETE', headers: { authorization } })).status, 200);
  assert.equal(entries.size, 0);
});

test('public UI routes and unsupported state methods are absent', async () => {
  const { call } = fixture();
  assert.equal((await call('/')).status, 404);
  assert.equal((await call('/file/terraform%2Fdns%2Fprod')).status, 404);
  assert.equal((await call('/tfstate/dns/prod', { method: 'LOCK' })).status, 405);
});

test('malformed scopes and missing session secret fail closed', async () => {
  const { call, env } = fixture();
  const invalid = await call('/auth/github-oidc', {
    method: 'POST',
    headers: { authorization: 'Bearer valid-github-oidc', 'content-type': 'application/json' },
    body: JSON.stringify({ scope: '../private' }),
  });
  assert.equal(invalid.status, 400);

  const unconfigured = await call('/auth/github-oidc', {
    method: 'POST',
    headers: { authorization: 'Bearer valid-github-oidc', 'content-type': 'application/json' },
    body: JSON.stringify({ scope: 'dns/prod' }),
  }, { ...env, FIREKV_SESSION_SECRET: '' });
  assert.equal(unconfigured.status, 503);
});
