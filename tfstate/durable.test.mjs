import test from 'node:test'
import assert from 'node:assert/strict'
import { TerraformState } from './durable-state.mjs'
import { issueSession, verifySession } from './oidc-auth.mjs'

class MemoryStore {
  map = new Map()
  transaction(fn) {
    const txn = {
      get: async key => this.map.get(key),
      put: async (key, value) => { this.map.set(key, value) },
      delete: async key => { this.map.delete(key) },
    }
    return fn(txn)
  }
}
const req = (method, path = '/state', body) => new Request('https://internal' + path, {
  method, ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
})
test('state is byte-preserving, isolated and protected by a matching lock ID', async () => {
  const storage = new MemoryStore()
  const state = new TerraformState({ storage })
  const payload = '{"serial":2,"resources":[]}'
  assert.equal((await state.fetch(req('GET'))).status, 404)
  assert.equal((await state.fetch(req('POST', '/state', payload))).status, 200)
  assert.equal(await (await state.fetch(req('GET'))).text(), payload)
  const lock = { ID: 'test-lock-1', Operation: 'OperationTypePlan', Who: 'test', Version: '1.9.8', Created: '2026-11-06T00:00:00Z', Path: 'test' }
  assert.equal((await state.fetch(req('LOCK', '/lock', lock))).status, 200)
  assert.equal((await state.fetch(req('LOCK', '/lock', { ...lock, ID: 'other' }))).status, 423)
  assert.equal((await state.fetch(req('POST', '/state', '{}'))).status, 423)
  assert.equal((await state.fetch(req('DELETE'))).status, 423)
  assert.equal((await state.fetch(req('POST', '/state?ID=test-lock-1', payload))).status, 200)
  assert.equal((await state.fetch(req('UNLOCK', '/lock', { ...lock, ID: 'other' }))).status, 409)
  assert.equal((await state.fetch(req('UNLOCK', '/lock', lock))).status, 200)
  assert.equal((await state.fetch(req('DELETE'))).status, 200)
  assert.equal((await state.fetch(req('GET'))).status, 404)
})
test('HMAC sessions bind scope and expiration, reject tampering', async () => {
  const key = 'synthetic-secret-for-test-only-32-characters'
  const issued = await issueSession(key, 'cloudflare/dashxd-dns', { run: '1234' }, 1000000)
  assert.equal((await verifySession(key, issued, 'cloudflare/dashxd-dns', 1000000)).run, '1234')
  await assert.rejects(verifySession(key, issued, 'cloudflare/other', 1000000))
  await assert.rejects(verifySession(key, issued + 'x', 'cloudflare/dashxd-dns', 1000000))
  await assert.rejects(verifySession(key, issued, 'cloudflare/dashxd-dns', 2000000))
})
