import { Hono } from 'hono'

type Bindings = {
  FILES: KVNamespace
  FIREKV_SESSION_SECRET?: string
  FIREKV_GITHUB_OWNER?: string
  FIREKV_GITHUB_REPOSITORIES?: string
  FIREKV_SESSION_TTL_SECONDS?: string
}

type SessionClaims = {
  v: 1
  exp: number
  repository: string
  run_id: string
  scope: string
}

type GitHubClaims = {
  iss?: string
  aud?: string | string[]
  exp?: number
  nbf?: number
  repository?: string
  repository_owner?: string
  run_id?: string
}

type Jwk = JsonWebKey & { kid?: string }

const app = new Hono<{ Bindings: Bindings }>({ strict: false })
const encoder = new TextEncoder()
const decoder = new TextDecoder()
const githubIssuer = 'https://token.actions.githubusercontent.com'
const githubJwks = `${githubIssuer}/.well-known/jwks`
const githubAudience = 'firekv'

const escapeHtml = (value: string) => value
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#39;')

const encodeKeyPath = (key: string) => key.split('/').map(encodeURIComponent).join('/')
const keyFromPath = (path: string) => {
  const encoded = path.slice('/file/'.length).replace(/\/$/, '')
  return encoded ? encoded.split('/').map(decodeURIComponent).join('/') : ''
}

const base64UrlEncode = (value: ArrayBuffer | Uint8Array) => {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

const base64UrlDecode = (value: string) => {
  const padded = value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4)
  const binary = atob(padded)
  return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}

const parseJsonPart = <T>(value: string): T => JSON.parse(decoder.decode(base64UrlDecode(value))) as T

const importHmacKey = (secret: string) => crypto.subtle.importKey(
  'raw',
  encoder.encode(secret),
  { name: 'HMAC', hash: 'SHA-256' },
  false,
  ['sign', 'verify'],
)

const signSession = async (claims: SessionClaims, secret: string) => {
  const payload = base64UrlEncode(encoder.encode(JSON.stringify(claims)))
  const key = await importHmacKey(secret)
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(payload))
  return `${payload}.${base64UrlEncode(signature)}`
}

const verifySession = async (token: string, secret: string): Promise<SessionClaims | null> => {
  const [payload, signature, extra] = token.split('.')
  if (!payload || !signature || extra) return null

  try {
    const key = await importHmacKey(secret)
    const valid = await crypto.subtle.verify('HMAC', key, base64UrlDecode(signature), encoder.encode(payload))
    if (!valid) return null

    const claims = parseJsonPart<SessionClaims>(payload)
    if (claims.v !== 1 || !claims.scope || !claims.repository || !claims.run_id) return null
    if (!Number.isInteger(claims.exp) || claims.exp <= Math.floor(Date.now() / 1000)) return null
    return claims
  } catch {
    return null
  }
}

const verifyGitHubOidc = async (token: string, env: Bindings): Promise<GitHubClaims | null> => {
  const [encodedHeader, encodedPayload, encodedSignature, extra] = token.split('.')
  if (!encodedHeader || !encodedPayload || !encodedSignature || extra) return null

  try {
    const header = parseJsonPart<{ alg?: string; kid?: string }>(encodedHeader)
    const claims = parseJsonPart<GitHubClaims>(encodedPayload)
    if (header.alg !== 'RS256' || !header.kid) return null
    if (claims.iss !== githubIssuer) return null

    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
    if (!audiences.includes(githubAudience)) return null

    const now = Math.floor(Date.now() / 1000)
    if (!claims.exp || claims.exp <= now) return null
    if (claims.nbf && claims.nbf > now + 30) return null
    if (!claims.repository || !claims.repository_owner || !claims.run_id) return null

    if (env.FIREKV_GITHUB_OWNER && claims.repository_owner !== env.FIREKV_GITHUB_OWNER) return null
    const allowed = (env.FIREKV_GITHUB_REPOSITORIES || '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)
    if (allowed.length && !allowed.includes(claims.repository)) return null

    const response = await fetch(githubJwks, { headers: { accept: 'application/json' } })
    if (!response.ok) return null
    const jwks = await response.json<{ keys: Jwk[] }>()
    const jwk = jwks.keys.find((candidate) => candidate.kid === header.kid)
    if (!jwk) return null

    const key = await crypto.subtle.importKey(
      'jwk',
      jwk,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    )
    const signed = encoder.encode(`${encodedHeader}.${encodedPayload}`)
    const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, base64UrlDecode(encodedSignature), signed)
    return valid ? claims : null
  } catch {
    return null
  }
}

const normalizeScope = (value: string) => {
  const scope = value.trim().replace(/^\/+|\/+$/g, '')
  if (!scope || scope.length > 512 || scope.includes('..')) return null
  if (!/^[A-Za-z0-9._/-]+$/.test(scope)) return null
  return scope
}

const scopeFromTfstatePath = (path: string) => {
  if (!path.startsWith('/tfstate/')) return null
  const encoded = path.slice('/tfstate/'.length).replace(/\/$/, '')
  try {
    return normalizeScope(encoded.split('/').map(decodeURIComponent).join('/'))
  } catch {
    return null
  }
}

const currentStateKey = (scope: string) => `terraform/${scope}/terraform.tfstate`
const historyStateKey = (scope: string, revision: string) => `terraform/${scope}/history/${revision}.tfstate`
const revisionId = () => `${new Date().toISOString().replaceAll(':', '').replaceAll('.', '')}-${crypto.randomUUID()}`

const authorizeTfstate = async (request: Request, env: Bindings, scope: string): Promise<SessionClaims | null> => {
  if (!env.FIREKV_SESSION_SECRET) return null
  const authorization = request.headers.get('authorization')
  if (!authorization?.startsWith('Basic ')) return null

  try {
    const decoded = atob(authorization.slice('Basic '.length))
    const separator = decoded.indexOf(':')
    if (separator < 0 || decoded.slice(0, separator) !== 'firekv') return null
    const claims = await verifySession(decoded.slice(separator + 1), env.FIREKV_SESSION_SECRET)
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

app.get('/', async (c) => {
  const listed = await c.env.FILES.list({ limit: 1000 })
  const items = listed.keys.length
    ? listed.keys.map(({ name }) => `<li><a href="/file/${encodeKeyPath(name)}/">${escapeHtml(name)}</a></li>`).join('')
    : '<li><em>KV is empty.</em></li>'
  return c.html(shell('files', `<h1>firekv</h1><p>Raw string values stored in <code>FILES</code>.</p><ul>${items}</ul>`))
})

app.get('/file/*', async (c) => {
  const key = keyFromPath(c.req.path)
  if (!key) return c.notFound()
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
        event.preventDefault()
        status.textContent = 'saving…'
        const response = await fetch('./', {
          method: 'PUT',
          headers: { 'content-type': 'text/plain; charset=utf-8' },
          body: contents.value
        })
        status.textContent = response.ok ? 'saved' : 'save failed (' + response.status + ')'
      })
    </script>`))
})

app.put('/file/*', async (c) => {
  const key = keyFromPath(c.req.path)
  if (!key) return c.text('missing key', 400)
  const value = await c.req.text()
  await c.env.FILES.put(key, value, {
    metadata: { contentType: c.req.header('content-type') || 'text/plain; charset=utf-8' }
  })
  return c.json({ ok: true, key, bytes: encoder.encode(value).byteLength })
})

app.post('/auth/github-oidc', async (c) => {
  if (!c.env.FIREKV_SESSION_SECRET) return c.json({ error: 'session auth is not configured' }, 503)

  const authorization = c.req.header('authorization')
  if (!authorization?.startsWith('Bearer ')) return c.json({ error: 'missing GitHub OIDC bearer token' }, 401)
  const identity = await verifyGitHubOidc(authorization.slice('Bearer '.length), c.env)
  if (!identity?.repository || !identity.run_id) return c.json({ error: 'invalid GitHub OIDC identity' }, 403)

  const body = await c.req.json<{ scope?: string }>().catch(() => ({}))
  const scope = body.scope ? normalizeScope(body.scope) : null
  if (!scope) return c.json({ error: 'invalid scope' }, 400)

  const configuredTtl = Number.parseInt(c.env.FIREKV_SESSION_TTL_SECONDS || '3600', 10)
  const ttl = Number.isFinite(configuredTtl) ? Math.min(Math.max(configuredTtl, 300), 7200) : 3600
  const claims: SessionClaims = {
    v: 1,
    exp: Math.floor(Date.now() / 1000) + ttl,
    repository: identity.repository,
    run_id: identity.run_id,
    scope,
  }
  const password = await signSession(claims, c.env.FIREKV_SESSION_SECRET)
  const origin = new URL(c.req.url).origin

  return c.json({
    username: 'firekv',
    password,
    address: `${origin}/tfstate/${scope.split('/').map(encodeURIComponent).join('/')}`,
    expires_at: new Date(claims.exp * 1000).toISOString(),
    scope,
  })
})

app.get('/tfstate/*', async (c) => {
  const scope = scopeFromTfstatePath(c.req.path)
  if (!scope) return c.text('invalid state scope', 400)
  const identity = await authorizeTfstate(c.req.raw, c.env, scope)
  if (!identity) return c.text('unauthorized', 401, { 'WWW-Authenticate': 'Basic realm="firekv"' })

  const state = await c.env.FILES.get(currentStateKey(scope), 'arrayBuffer')
  if (state === null) return new Response(null, { status: 404 })
  return new Response(state, {
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
    },
  })
})

app.post('/tfstate/*', async (c) => {
  const scope = scopeFromTfstatePath(c.req.path)
  if (!scope) return c.text('invalid state scope', 400)
  const identity = await authorizeTfstate(c.req.raw, c.env, scope)
  if (!identity) return c.text('unauthorized', 401, { 'WWW-Authenticate': 'Basic realm="firekv"' })

  const state = await c.req.arrayBuffer()
  const revision = revisionId()
  const metadata = {
    contentType: 'application/json',
    revision,
    repository: identity.repository,
    runId: identity.run_id,
    savedAt: new Date().toISOString(),
  }

  await c.env.FILES.put(historyStateKey(scope, revision), state, { metadata })
  await c.env.FILES.put(currentStateKey(scope), state, { metadata })
  return c.json({ ok: true, scope, revision, bytes: state.byteLength })
})

app.delete('/tfstate/*', async (c) => {
  const scope = scopeFromTfstatePath(c.req.path)
  if (!scope) return c.text('invalid state scope', 400)
  const identity = await authorizeTfstate(c.req.raw, c.env, scope)
  if (!identity) return c.text('unauthorized', 401, { 'WWW-Authenticate': 'Basic realm="firekv"' })

  const current = await c.env.FILES.get(currentStateKey(scope), 'arrayBuffer')
  if (current !== null) {
    const revision = `deleted-${revisionId()}`
    await c.env.FILES.put(historyStateKey(scope, revision), current, {
      metadata: {
        contentType: 'application/json',
        revision,
        repository: identity.repository,
        runId: identity.run_id,
        savedAt: new Date().toISOString(),
      },
    })
  }
  await c.env.FILES.delete(currentStateKey(scope))
  return new Response(null, { status: 200 })
})

export default app
