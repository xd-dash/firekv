import assert from 'node:assert/strict'
import test from 'node:test'

import type { AuthProvider } from '@xd-dash/auth.net.im/core'
import type { GitHubEnv } from '@xd-dash/auth.net.im/providers/github'

import { createFireKVApp } from '../src/index'

function memoryKV() {
  const entries = new Map<string, ArrayBuffer>()

  const namespace = {
    async get(key: string, type?: string) {
      const value = entries.get(key)
      if (!value) return null
      if (type === 'arrayBuffer') return value.slice(0)
      if (type === 'text' || !type) return new TextDecoder().decode(value)
      throw new Error(`unsupported memory KV get type: ${type}`)
    },
    async put(key: string, value: string | ArrayBuffer | ArrayBufferView) {
      if (typeof value === 'string') {
        entries.set(key, new TextEncoder().encode(value).buffer)
      } else if (value instanceof ArrayBuffer) {
        entries.set(key, value.slice(0))
      } else {
        entries.set(key, value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer)
      }
    },
    async delete(key: string) {
      entries.delete(key)
    },
    async list(options: { prefix?: string } = {}) {
      const keys = [...entries.keys()]
        .filter(key => !options.prefix || key.startsWith(options.prefix))
        .map(name => ({ name }))
      return { keys, list_complete: true, cacheStatus: null }
    },
  } as unknown as KVNamespace

  return { namespace, entries }
}

const provider: AuthProvider<GitHubEnv> = {
  name: 'github',
  async authenticate() {
    return {
      provider: 'github',
      subject: 'repo:example-org/iac:ref:refs/heads/main',
      attributes: {
        repository: 'example-org/iac',
        run_id: '12345',
      },
    }
  },
}

const sessionSecret = '0123456789abcdef0123456789abcdef'

async function mint(app: ReturnType<typeof createFireKVApp>, namespace: KVNamespace, scope = 'terraform/example', ttl = '600') {
  const response = await app.request('https://firekv.example/auth/github-oidc', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer synthetic' },
    body: JSON.stringify({ scope }),
  }, {
    FILES: namespace,
    FIREKV_SESSION_SECRET: sessionSecret,
    FIREKV_SESSION_TTL_SECONDS: ttl,
  })
  return response
}

test('GitHub identity mints a scope-bound Terraform credential that persists tfstate', async () => {
  const { namespace, entries } = memoryKV()
  const app = createFireKVApp({ provider })
  const env = {
    FILES: namespace,
    FIREKV_SESSION_SECRET: sessionSecret,
    FIREKV_SESSION_TTL_SECONDS: '600',
  }

  const exchange = await mint(app, namespace)
  assert.equal(exchange.status, 200)
  assert.equal(exchange.headers.get('cache-control'), 'no-store')
  const session = await exchange.json() as {
    username: string
    password: string
    address: string
    scope: string
  }
  assert.equal(session.username, 'firekv')
  assert.equal(session.scope, 'terraform/example')
  assert.equal(session.address, 'https://firekv.example/tfstate/terraform/example')

  const basic = `Basic ${btoa(`${session.username}:${session.password}`)}`
  const state = JSON.stringify({ version: 4, serial: 1, outputs: { qualification: { value: 'firekv' } } })

  const write = await app.request(session.address, {
    method: 'POST',
    headers: { authorization: basic, 'content-type': 'application/json' },
    body: state,
  }, env)
  assert.equal(write.status, 200)

  const read = await app.request(session.address, {
    headers: { authorization: basic.toLowerCase().replace('basic', 'basic') },
  }, env)
  assert.equal(read.status, 200)
  assert.equal(await read.text(), state)

  const wrongScope = await app.request('https://firekv.example/tfstate/terraform/other', {
    headers: { authorization: basic },
  }, env)
  assert.equal(wrongScope.status, 401)

  assert(entries.has('terraform/terraform/example/terraform.tfstate'))
  assert([...entries.keys()].some(key => key.startsWith('terraform/terraform/example/history/')))
})

test('state scope rejects aliases and overlong keys before touching KV', async () => {
  const { namespace } = memoryKV()
  const app = createFireKVApp({ provider })

  for (const scope of ['terraform//example', 'terraform/./example', 'terraform/../example', 'x'.repeat(401)]) {
    const response = await mint(app, namespace, scope)
    assert.equal(response.status, 400, scope)
    assert.equal(response.headers.get('cache-control'), 'no-store')
  }
})

test('malformed file percent encoding is bounded instead of becoming a 500', async () => {
  const { namespace } = memoryKV()
  const app = createFireKVApp({ provider })
  const response = await app.request('https://firekv.example/file/%E0%A4%A/', {}, { FILES: namespace })
  assert.equal(response.status, 404)
})

test('invalid session TTL is deployment misconfiguration', async () => {
  const { namespace } = memoryKV()
  const app = createFireKVApp({ provider })

  for (const ttl of ['299', '7201', '600seconds']) {
    const response = await mint(app, namespace, 'terraform/example', ttl)
    assert.equal(response.status, 503, ttl)
    assert.deepEqual(await response.json(), { error: 'session_auth_unconfigured' })
  }
})

test('state upload rejects a declared value larger than Workers KV permits', async () => {
  const { namespace } = memoryKV()
  const app = createFireKVApp({ provider })
  const env = {
    FILES: namespace,
    FIREKV_SESSION_SECRET: sessionSecret,
    FIREKV_SESSION_TTL_SECONDS: '600',
  }

  const exchange = await mint(app, namespace)
  const session = await exchange.json() as { username: string; password: string; address: string }
  const basic = `Basic ${btoa(`${session.username}:${session.password}`)}`
  const response = await app.request(session.address, {
    method: 'POST',
    headers: {
      authorization: basic,
      'content-length': String(25 * 1024 * 1024 + 1),
    },
    body: 'small body; declared size is rejected before KV write',
  }, env)

  assert.equal(response.status, 413)
  assert.equal(response.headers.get('cache-control'), 'no-store')
})

test('GitHub provider middleware rejects a missing bearer before capability issuance', async () => {
  const { namespace } = memoryKV()
  const app = createFireKVApp()
  const response = await app.request('https://firekv.example/auth/github-oidc', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ scope: 'terraform/example' }),
  }, {
    FILES: namespace,
    FIREKV_SESSION_SECRET: sessionSecret,
    GITHUB_AUDIENCE: 'https://audience.example',
    GITHUB_OWNER: 'example-org',
    GITHUB_REPOSITORIES: 'example-org/iac',
  })

  assert.equal(response.status, 401)
  assert.equal(response.headers.get('www-authenticate'), 'Bearer')
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.deepEqual(await response.json(), {
    error: 'missing_bearer',
    message: 'missing bearer token',
  })
})
