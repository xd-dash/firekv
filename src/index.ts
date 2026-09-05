import { Hono } from 'hono'

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

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const reservedPrefix = 'terraform/'

const escapeHtml = (value: string) => value
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&#39;')

const encodeKeyPath = (key: string) => key.split('/').map(encodeURIComponent).join('/')
const keyFromPath = (path: string) => {
  const encoded = path.slice('/file/'.length).replace(/\/$/, '')
  return encoded ? encoded.split('/').map(decodeURIComponent).join('/') : ''
}
const isReservedKey = (key: string) => key.startsWith(reservedPrefix)

const b64uEncode = (value: ArrayBuffer | Uint8Array) => {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

const b64uDecode = (value: string) => {
  const padded = value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4)
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0))
}

const parsePart = <T>(value: string): T => JSON.parse(decoder.decode(b64uDecode(value))) as T
const sessionSecret = (env: Bindings) => {
  const secret = env.FIREKV_SESSION_SECRET
  return secret && encoder.encode(secret).byteLength >= 32 ? secret : null
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
    if (claims.v !== 1 || !claims.scope || !claims.repository || !claims.run_id) return null
    if (!Number.isInteger(claims.exp) || claims.exp <= Math.floor(Date.now() / 1000)) return null
    return claims
  } catch {
    return null
  }
}

const normalizeScope = (value: string) => {
  const scope = value.trim().replace(/^\/+|\/+$/g, '')
  if (!scope || scope.length > 512 || scope.includes('..') || !/^[A-Za-z0-9._/-]+$/.test(scope)) return null
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

const authorizeState = async (request: Request, env: Bindings, scope: string) => {
  const secret = sessionSecret(env)
  const authorization = request.headers.get('authorization')
  if (!secret || !authorization?.startsWith('Basic ')) return null
  try {
    const decoded = atob(authorization.slice(6))
    const separator = decoded.indexOf(':')
    if (separator < 0 || decoded.slice(0, separator) !== 'firekv') return null
    const claims = await verifySession(decoded.slice(separator + 1), secret)
    return claims?.scope === scope ? claims : null
  } catch {
    return null
  }
}

const shell = (title: string, body: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} · firekv</title>
<style>:root{color-scheme:light dark;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}body{max-width:1100px;margin:0 auto;padding:2rem}a{color:inherit}textarea{width:100%;min-height:65vh;box-sizing:border-box;padding:1rem;font:inherit;tab-size:2}.bar{display:flex;gap:.75rem;align-items:center;margin:1rem 0}button{padding:.55rem .9rem;font:inherit;cursor:pointer}#status{opacity:.75}</style>
</head><body>${body}</body></html>`

export function createFireKVApp(githubOptions: GitHubAuthOptions = {}) {
  const app = new Hono<{ Bindings: Bindings; Variables: GitHubAuthVariables }>({ strict: false })

  app.onError((error, c) => {
    if (error instanceof AuthError) {
      const headers: Record<string, string> = { 'cache-control': 'no-store' }
      if (error.status === 401) headers['www-authenticate'] = 'Bearer'
      return c.json({ error: error.code, message: error.message }, error.status as 401 | 403 | 500, headers)
    }
    console.error(error)
    return c.json({ error: 'internal_error', message: 'internal server error' }, 500, { 'cache-control': 'no-store' })
  })

  app.get('/', async (c) => {
    const listed = await c.env.FILES.list({ limit: 1000 })
    const keys = listed.keys.filter(({ name }) => !isReservedKey(name))
    const items = keys.length
      ? keys.map(({ name }) => `<li><a href="/file/${encodeKeyPath(name)}/">${escapeHtml(name)}</a></li>`).join('')
      : '<li><em>KV is empty.</em></li>'
    return c.html(shell('files', `<h1>firekv</h1><p>Raw string values stored in <code>FILES</code>.</p><ul>${items}</ul>`))
  })

  app.get('/file/*', async (c) => {
    const key = keyFromPath(c.req.path)
    if (!key || isReservedKey(key)) return c.notFound()
    const value = await c.env.FILES.get(key, 'text')
    if (value === null) return c.notFound()
    return c.html(shell(key, `
      <p><a href="/">← files</a></p><h1>${escapeHtml(key)}</h1>
      <form id="editor"><textarea id="contents" spellcheck="false">${escapeHtml(value)}</textarea>
      <div class="bar"><button type="submit">Save to KV</button><span id="status"></span></div></form>
      <script type="module">
        const form = document.querySelector('#editor')
        const contents = document.querySelector('#contents')
        const status = document.querySelector('#status')
        form.addEventListener('submit', async (event) => {
          event.preventDefault(); status.textContent = 'saving…'
          const response = await fetch('./', { method: 'PUT', headers: { 'content-type': 'text/plain; charset=utf-8' }, body: contents.value })
          status.textContent = response.ok ? 'saved' : 'save failed (' + response.status + ')'
        })
      </script>`))
  })

  app.put('/file/*', async (c) => {
    const key = keyFromPath(c.req.path)
    if (!key) return c.text('missing key', 400)
    if (isReservedKey(key)) return c.notFound()
    const value = await c.req.text()
    await c.env.FILES.put(key, value, { metadata: { contentType: c.req.header('content-type') || 'text/plain; charset=utf-8' } })
    return c.json({ ok: true, key, bytes: encoder.encode(value).byteLength })
  })

  app.use('/auth/github-oidc', GitHubProvider.middleware(githubOptions))

  app.post('/auth/github-oidc', async (c) => {
    const secret = sessionSecret(c.env)
    if (!secret) return c.json({ error: 'session_auth_unconfigured' }, 503, { 'cache-control': 'no-store' })

    const identity = c.get('authIdentity')
    const repository = identity.attributes.repository
    const runID = identity.attributes.run_id
    if (!repository || !runID) {
      return c.json({ error: 'workload_identity_incomplete' }, 403, { 'cache-control': 'no-store' })
    }

    const body: { scope?: string } = await c.req.json<{ scope?: string }>().catch(() => ({}))
    const scope = body.scope ? normalizeScope(body.scope) : null
    if (!scope) return c.json({ error: 'invalid_scope' }, 400, { 'cache-control': 'no-store' })

    const configured = Number.parseInt(c.env.FIREKV_SESSION_TTL_SECONDS || '3600', 10)
    const ttl = Number.isFinite(configured) ? Math.min(Math.max(configured, 300), 7200) : 3600
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
    }, 200, { 'cache-control': 'no-store' })
  })

  app.get('/tfstate/*', async (c) => {
    const scope = scopeFromPath(c.req.path)
    if (!scope) return c.text('invalid state scope', 400)
    if (!await authorizeState(c.req.raw, c.env, scope)) return c.text('unauthorized', 401, { 'WWW-Authenticate': 'Basic realm="firekv"', 'cache-control': 'no-store' })
    const state = await c.env.FILES.get(currentKey(scope), 'arrayBuffer')
    if (state === null) return new Response(null, { status: 404, headers: { 'cache-control': 'no-store' } })
    return new Response(state, { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
  })

  app.post('/tfstate/*', async (c) => {
    const scope = scopeFromPath(c.req.path)
    if (!scope) return c.text('invalid state scope', 400)
    const identity = await authorizeState(c.req.raw, c.env, scope)
    if (!identity) return c.text('unauthorized', 401, { 'WWW-Authenticate': 'Basic realm="firekv"', 'cache-control': 'no-store' })

    const state = await c.req.arrayBuffer()
    const revision = revisionId()
    const metadata = { contentType: 'application/json', revision, repository: identity.repository, runId: identity.run_id, savedAt: new Date().toISOString() }
    await c.env.FILES.put(historyKey(scope, revision), state, { metadata })
    await c.env.FILES.put(currentKey(scope), state, { metadata })
    return c.json({ ok: true, scope, revision, bytes: state.byteLength }, 200, { 'cache-control': 'no-store' })
  })

  app.delete('/tfstate/*', async (c) => {
    const scope = scopeFromPath(c.req.path)
    if (!scope) return c.text('invalid state scope', 400)
    const identity = await authorizeState(c.req.raw, c.env, scope)
    if (!identity) return c.text('unauthorized', 401, { 'WWW-Authenticate': 'Basic realm="firekv"', 'cache-control': 'no-store' })

    const current = await c.env.FILES.get(currentKey(scope), 'arrayBuffer')
    if (current !== null) {
      const revision = `deleted-${revisionId()}`
      await c.env.FILES.put(historyKey(scope, revision), current, {
        metadata: { contentType: 'application/json', revision, repository: identity.repository, runId: identity.run_id, savedAt: new Date().toISOString() },
      })
    }
    await c.env.FILES.delete(currentKey(scope))
    return new Response(null, { status: 200, headers: { 'cache-control': 'no-store' } })
  })

  return app
}

export default createFireKVApp()
