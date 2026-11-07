import test from 'node:test'
import assert from 'node:assert/strict'
import { verifyGithub } from './oidc-auth.mjs'

const enc = new TextEncoder()
const b64 = bytes => Buffer.from(bytes).toString('base64url')
const config = {
  audience: 'firekv',
  repository: 'xd-dash/huram-abi-master',
  owner: 'xd-dash',
  ref: 'refs/heads/codex/smoke-auth-cloudflare-deployment-consolidation',
  environment: 'cloudflare-terraform',
  workflowRef: 'xd-dash/huram-abi-master/.github/workflows/plan-dashxd-terraform.yml@refs/heads/codex/smoke-auth-cloudflare-deployment-consolidation',
}
test('OIDC JWT verifies RS256 signature, issuer, exact workflow, environment, audience and expiry', async () => {
  const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify'])
  const jwk = { ...await crypto.subtle.exportKey('jwk', pair.publicKey), kid: 'test', use: 'sig' }
  const fetchJwks = async () => ({ ok: true, json: async () => ({ keys: [jwk] }) })
  const now = 1000000000
  const base = {
    iss: 'https://token.actions.githubusercontent.com',
    aud: 'firekv', repository: config.repository, repository_owner: config.owner,
    ref: config.ref, environment: config.environment, workflow_ref: config.workflowRef,
    run_id: '123', sha: 'a'.repeat(40), iat: 999999, exp: 1000300,
  }
  async function token(changes = {}) {
    const head = b64(JSON.stringify({ alg: 'RS256', kid: 'test', typ: 'JWT' }))
    const body = b64(JSON.stringify({ ...base, ...changes }))
    const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, enc.encode(head + '.' + body))
    return head + '.' + body + '.' + b64(new Uint8Array(signature))
  }
  assert.equal((await verifyGithub(await token(), config, fetchJwks, now)).run, '123')
  for (const claims of [
    { aud: 'other' }, { repository: 'attacker/repo' }, { environment: 'other' },
    { workflow_ref: 'attacker/workflow' }, { exp: 999999 }, { ref: 'refs/heads/main' },
  ]) await assert.rejects(verifyGithub(await token(claims), config, fetchJwks, now))
  await assert.rejects(verifyGithub((await token()).replace(/\.([A-Za-z0-9_-])/, (_, c) => '.' + (c === 'A' ? 'B' : 'A')), config, fetchJwks, now))
})
