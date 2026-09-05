import { Hono } from 'hono'
import { renderEditor, renderHome } from './public-ui'

import { AuthError } from '@xd-dash/auth.net.im/core'
import {
  GitHubProvider,
  type GitHubAuthOptions,
  type GitHubAuthVariables,
  type GitHubEnv,
} from '@xd-dash/auth.net.im/providers/github'

type Bindings = GitHubEnv & {
  FILES: KVNamespace
  FIREKV_SESSION_SECRET?: string
  FIREKV_SESSION_TTL_SECONDS?: string
}

type SessionClaims = { v: 1; exp: number; repository: string; run_id: string; scope: string }

type TextBodyResult =
  | { ok: true; value: string; bytes: number }
  | { ok: false; status: 400 | 413 | 415; message: string }

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const strictUtf8Decoder = new TextDecoder('utf-8', { fatal: true })
const reservedPrefix = 'terraform/'
const maxKvValueBytes = 25 * 1024 * 1024
// Leave headroom under Workers KV's 512-byte key limit for
// `terraform/<scope>/history/deleted-<timestamp>-<uuid>.tfstate`.
const maxScopeLength = 400
const maxPublicKeyBytes = 512

const noStore = { 'cache-control': 'no-store' }

const escapeHtml = (value: string) => value
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&#39;')

const encodeKeyPath = (key: string) => key.split('/').map(encodeURIComponent).join('/')

const normalizePublicKey = (value: string) => {
  const key = value.trim().replace(/^\/+|\/+$/g, '')
  if (!key || encoder.encode(key).byteLength > maxPublicKeyBytes) return null
  if (/[\u0000-\u001f\u007f]/.test(key) || key.includes('\\')) return null
  const segments = key.split('/')
  if (segments.some(segment => !segment || segment === '.' || segment === '..')) return null
  return key
}

const keyFromPath = (path: string) => {
  const encoded = path.slice('/file/'.length).replace(/\/$/, '')
  if (!encoded) return null
  try {
    return normalizePublicKey(encoded.split('/').map(decodeURIComponent).join('/'))
  } catch {
    return null
  }
}
const isReservedKey = (key: string) => key.startsWith(reservedPrefix)

const b64uEncode = (value: ArrayBuffer | Uint8Array) => {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

const b64uDecode = (value: string) => {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('invalid base64url')
  const padded = value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4)
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0))
}

const parsePart = <T>(value: string): T => JSON.parse(decoder.decode(b64uDecode(value))) as T
const sessionSecret = (env: Bindings) => {
  const secret = env.FIREKV_SESSION_SECRET
  return secret && encoder.encode(secret).byteLength >= 32 ? secret : null
}

const sessionTtl = (env: Bindings) => {
  const raw = env.FIREKV_SESSION_TTL_SECONDS?.trim()
  if (!raw) return 3600
  if (!/^\d+$/.test(raw)) return null
  const ttl = Number(raw)
  return Number.isSafeInteger(ttl) && ttl >= 300 && ttl <= 7200 ? ttl : null
}

const importHmacKey = (secret: string) => crypto.subtle.importKey(
  'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'],
)

const signSession = async (claims: SessionClaims, secret: string) => {
  const payload = b64uEncode(encoder.encode(JSON.stringify(claims)))
  const signature = await crypto.subtle.sign('HMAC', await importHmacKey(secret), encoder.encode(payload))
  return `${payload}.${b64uEncode(signature)}`
}

const verifySession = async (token: string, secret: string): Promise<SessionClaims | null> => {
  const [payload, signature, extra] = token.split('.')
  if (!payload || !signature || extra) return null
  try {
    const valid = await crypto.subtle.verify(
      'HMAC', await importHmacKey(secret), b64uDecode(signature), encoder.encode(payload),
    )
    if (!valid) return null
    const claims = parsePart<SessionClaims>(payload)
    if (!claims || claims.v !== 1 || typeof claims.scope !== 'string' || typeof claims.repository !== 'string' || typeof claims.run_id !== 'string') return null
    if (!normalizeScope(claims.scope) || !claims.repository || !claims.run_id) return null
    if (!Number.isInteger(claims.exp) || claims.exp <= Math.floor(Date.now() / 1000)) return null
    return claims
  } catch {
    return null
  }
}

const normalizeScope = (value: string) => {
  const scope = value.trim().replace(/^\/+|\/+$/g, '')
  if (!scope || scope.length > maxScopeLength || !/^[A-Za-z0-9._/-]+$/.test(scope)) return null
  const segments = scope.split('/')
  if (segments.some(segment => !segment || segment === '.' || segment === '..')) return null
  return scope
}

const scopeFromPath = (path: string) => {
  const encoded = path.startsWith('/tfstate/') ? path.slice('/tfstate/'.length).replace(/\/$/, '') : ''
  try {
    return encoded ? normalizeScope(encoded.split('/').map(decodeURIComponent).join('/')) : null
  } catch {
    return null
  }
}

const currentKey = (scope: string) => `${reservedPrefix}${scope}/terraform.tfstate`
const historyKey = (scope: string, revision: string) => `${reservedPrefix}${scope}/history/${revision}.tfstate`
const revisionId = () => `${new Date().toISOString().replaceAll(':', '').replaceAll('.', '')}-${crypto.randomUUID()}`

const basicToken = (authorization: string | null) => {
  if (!authorization) return null
  const match = authorization.trim().match(/^Basic\s+([A-Za-z0-9+/=]+)$/i)
  if (!match) return null
  try {
    const decoded = atob(match[1])
    const separator = decoded.indexOf(':')
    if (separator < 0 || decoded.slice(0, separator) !== 'firekv') return null
    const token = decoded.slice(separator + 1)
    return token || null
  } catch {
    return null
  }
}

const authorizeState = async (request: Request, env: Bindings, scope: string) => {
  const secret = sessionSecret(env)
  const token = basicToken(request.headers.get('authorization'))
  if (!secret || !token) return null
  const claims = await verifySession(token, secret)
  return claims?.scope === scope ? claims : null
}

const bodyTooLarge = (request: Request) => {
  const raw = request.headers.get('content-length')
  if (!raw) return false
  if (!/^\d+$/.test(raw)) return true
  return Number(raw) > maxKvValueBytes
}

const readPlainTextBody = async (request: Request): Promise<TextBodyResult> => {
  const contentType = request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase()
  if (contentType !== 'text/plain') {
    return { ok: false, status: 415, message: 'public values require text/plain UTF-8 bodies' }
  }
  if (bodyTooLarge(request)) {
    return { ok: false, status: 413, message: 'text exceeds Workers KV value limit' }
  }

  const body = await request.arrayBuffer()
  if (body.byteLength > maxKvValueBytes) {
    return { ok: false, status: 413, message: 'text exceeds Workers KV value limit' }
  }
  try {
    return { ok: true, value: strictUtf8Decoder.decode(body), bytes: body.byteLength }
  } catch {
    return { ok: false, status: 400, message: 'body must be valid UTF-8 text' }
  }
}

export function createFireKVApp(githubOptions: GitHubAuthOptions = {}) {
  const app = new Hono<{ Bindings: Bindings; Variables: GitHubAuthVariables }>({ strict: false })

  app.onError((error, c) => {
    if (error instanceof AuthError) {
      const headers: Record<string, string> = { 'cache-control': 'no-store' }
      if (error.status === 401) headers['www-authenticate'] = 'Bearer'
      return c.json({ error: error.code, message: error.message }, error.status as 401 | 403 | 500, headers)
    }
    console.error(error)
    return c.json({ error: 'internal_error', message: 'internal server error' }, 500, noStore)
  })

  app.get('/', async (c) => {
    const listed = await c.env.FILES.list({ limit: 1000 })
    const keys = listed.keys.filter(({ name }) => !isReservedKey(name))
    const items = keys.length
      ? keys.map(({ name }) => `<li><a href="/file/${encodeKeyPath(name)}/">${escapeHtml(name)}</a></li>`).join('')
      : '<li><em>KV is empty.</em></li>'
    c.header('cache-control', 'no-store')
    return c.html(renderHome(c.req.raw, items))
  })

  app.get('/file/*', async (c) => {
    const key = keyFromPath(c.req.path)
    if (!key || isReservedKey(key)) return c.notFound()
    const body = await c.env.FILES.get(key, 'arrayBuffer')
    if (body === null) return c.notFound()
    let value: string
    try {
      value = strictUtf8Decoder.decode(body)
    } catch {
      return c.text('stored value is not valid UTF-8 text', 415, noStore)
    }
    c.header('cache-control', 'no-store')
    return c.html(renderEditor(c.req.raw, key, value))
  })

  app.put('/file/*', async (c) => {
    const key = keyFromPath(c.req.path)
    if (!key) return c.text('missing, malformed, or overlong key', 400, noStore)
    if (isReservedKey(key)) return c.notFound()
    const body = await readPlainTextBody(c.req.raw)
    if (!body.ok) return c.text(body.message, body.status, noStore)
    await c.env.FILES.put(key, body.value, { metadata: { contentType: 'text/plain; charset=utf-8' } })
    return c.json({ ok: true, key, bytes: body.bytes }, 200, noStore)
  })

  app.use('/auth/github-oidc', GitHubProvider.middleware(githubOptions))

  app.post('/auth/github-oidc', async (c) => {
    const secret = sessionSecret(c.env)
    const ttl = sessionTtl(c.env)
    if (!secret || ttl === null) return c.json({ error: 'session_auth_unconfigured' }, 503, noStore)

    const identity = c.get('authIdentity')
    const repository = identity.attributes.repository
    const runID = identity.attributes.run_id
    if (!repository || !runID) {
      return c.json({ error: 'workload_identity_incomplete' }, 403, noStore)
    }

    const body: { scope?: string } = await c.req.json<{ scope?: string }>().catch(() => ({}))
    const scope = typeof body.scope === 'string' ? normalizeScope(body.scope) : null
    if (!scope) return c.json({ error: 'invalid_scope' }, 400, noStore)

    const claims: SessionClaims = {
      v: 1,
      exp: Math.floor(Date.now() / 1000) + ttl,
      repository,
      run_id: runID,
      scope,
    }
    const password = await signSession(claims, secret)
    const origin = new URL(c.req.url).origin
    return c.json({
      username: 'firekv', password,
      address: `${origin}/tfstate/${scope.split('/').map(encodeURIComponent).join('/')}`,
      expires_at: new Date(claims.exp * 1000).toISOString(), scope,
    }, 200, noStore)
  })

  app.get('/tfstate/*', async (c) => {
    const scope = scopeFromPath(c.req.path)
    if (!scope) return c.text('invalid state scope', 400, noStore)
    if (!await authorizeState(c.req.raw, c.env, scope)) return c.text('unauthorized', 401, { 'WWW-Authenticate': 'Basic realm="firekv"', ...noStore })
    const state = await c.env.FILES.get(currentKey(scope), 'arrayBuffer')
    if (state === null) return new Response(null, { status: 404, headers: noStore })
    return new Response(state, { headers: { 'content-type': 'application/json', ...noStore } })
  })

  app.post('/tfstate/*', async (c) => {
    const scope = scopeFromPath(c.req.path)
    if (!scope) return c.text('invalid state scope', 400, noStore)
    const identity = await authorizeState(c.req.raw, c.env, scope)
    if (!identity) return c.text('unauthorized', 401, { 'WWW-Authenticate': 'Basic realm="firekv"', ...noStore })
    if (bodyTooLarge(c.req.raw)) return c.text('state exceeds Workers KV value limit', 413, noStore)

    const state = await c.req.arrayBuffer()
    if (state.byteLength > maxKvValueBytes) return c.text('state exceeds Workers KV value limit', 413, noStore)

    const revision = revisionId()
    const metadata = { contentType: 'application/json', revision, repository: identity.repository, runId: identity.run_id, savedAt: new Date().toISOString() }
    await c.env.FILES.put(historyKey(scope, revision), state, { metadata })
    await c.env.FILES.put(currentKey(scope), state, { metadata })
    return c.json({ ok: true, scope, revision, bytes: state.byteLength }, 200, noStore)
  })

  app.delete('/tfstate/*', async (c) => {
    const scope = scopeFromPath(c.req.path)
    if (!scope) return c.text('invalid state scope', 400, noStore)
    const identity = await authorizeState(c.req.raw, c.env, scope)
    if (!identity) return c.text('unauthorized', 401, { 'WWW-Authenticate': 'Basic realm="firekv"', ...noStore })

    const current = await c.env.FILES.get(currentKey(scope), 'arrayBuffer')
    if (current !== null) {
      const revision = `deleted-${revisionId()}`
      await c.env.FILES.put(historyKey(scope, revision), current, {
        metadata: { contentType: 'application/json', revision, repository: identity.repository, runId: identity.run_id, savedAt: new Date().toISOString() },
      })
    }
    await c.env.FILES.delete(currentKey(scope))
    return new Response(null, { status: 200, headers: noStore })
  })

  return app
}

export default createFireKVApp()
