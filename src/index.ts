import { Hono } from 'hono'

type Bindings = { FILES: KVNamespace }
const app = new Hono<{ Bindings: Bindings }>({ strict: false })

const MAX_TEXT_BYTES = 256 * 1024
const TEXT_CONTENT_TYPE = 'text/plain; charset=utf-8'

const escapeHtml = (value: string) => value
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#39;')

const encodeKeyPath = (key: string) => key.split('/').map(encodeURIComponent).join('/')
const keyFromPath = (path: string, prefix: string) => {
  const encoded = path.slice(prefix.length).replace(/\/$/, '')
  return encoded ? encoded.split('/').map(decodeURIComponent).join('/') : ''
}

const plainTextHeaders = () => ({
  'content-type': TEXT_CONTENT_TYPE,
  'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'none'",
  'cache-control': 'no-store'
})

const shell = (title: string, body: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} · firekv</title>
<style>:root{color-scheme:light dark;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}body{max-width:1100px;margin:0 auto;padding:2rem}a{color:inherit}textarea{width:100%;min-height:65vh;box-sizing:border-box;padding:1rem;font:inherit;tab-size:2}.bar{display:flex;gap:.75rem;align-items:center;margin:1rem 0}button{padding:.55rem .9rem;font:inherit;cursor:pointer}#status{opacity:.75}</style>
</head><body>${body}</body></html>`

const isUtf8TextContentType = (value: string | undefined) => {
  if (!value) return false
  const parts = value.toLowerCase().split(';').map((part) => part.trim())
  if (parts[0] !== 'text/plain') return false
  const charset = parts.slice(1).find((part) => part.startsWith('charset='))
  return charset === undefined || charset === 'charset=utf-8' || charset === 'charset=utf8'
}

const readValidatedText = async (request: Request) => {
  if (!isUtf8TextContentType(request.headers.get('content-type') || undefined)) {
    return { ok: false as const, status: 415 as const, message: 'content-type must be text/plain; charset=utf-8' }
  }

  const declaredLength = request.headers.get('content-length')
  if (declaredLength !== null) {
    const size = Number(declaredLength)
    if (!Number.isFinite(size) || size < 0 || size > MAX_TEXT_BYTES) {
      return { ok: false as const, status: 413 as const, message: `text exceeds ${MAX_TEXT_BYTES} byte limit` }
    }
  }

  const bytes = new Uint8Array(await request.arrayBuffer())
  if (bytes.byteLength > MAX_TEXT_BYTES) {
    return { ok: false as const, status: 413 as const, message: `text exceeds ${MAX_TEXT_BYTES} byte limit` }
  }

  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return { ok: false as const, status: 400 as const, message: 'body must be valid UTF-8 text' }
  }

  if (text.includes('\0')) {
    return { ok: false as const, status: 400 as const, message: 'NUL characters are not allowed' }
  }

  return { ok: true as const, text, bytes: bytes.byteLength }
}

app.get('/', async (c) => {
  const listed = await c.env.FILES.list({ limit: 1000 })
  const items = listed.keys.length
    ? listed.keys.map(({ name }) => `<li><a href="/file/${encodeKeyPath(name)}/">${escapeHtml(name)}</a></li>`).join('')
    : '<li><em>KV is empty.</em></li>'
  return c.html(shell('files', `<h1>firekv</h1><p>UTF-8 text values stored in <code>FILES</code>.</p><ul>${items}</ul>`))
})

app.get('/raw/*', async (c) => {
  const key = keyFromPath(c.req.path, '/raw/')
  if (!key) return c.notFound()
  const value = await c.env.FILES.get(key, 'text')
  if (value === null) return c.notFound()
  return new Response(value, { status: 200, headers: plainTextHeaders() })
})

app.get('/file/*', async (c) => {
  const key = keyFromPath(c.req.path, '/file/')
  if (!key) return c.notFound()
  const value = await c.env.FILES.get(key, 'text')
  if (value === null) return c.notFound()
  return c.html(shell(key, `
    <p><a href="/">← files</a> · <a href="/raw/${encodeKeyPath(key)}">raw text</a></p><h1>${escapeHtml(key)}</h1>
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
        status.textContent = response.ok ? 'saved' : await response.text()
      })
    </script>`))
})

app.put('/file/*', async (c) => {
  const key = keyFromPath(c.req.path, '/file/')
  if (!key) return c.text('missing key', 400)

  const result = await readValidatedText(c.req.raw)
  if (!result.ok) {
    return c.text(result.message, result.status)
  }

  await c.env.FILES.put(key, result.text, {
    metadata: {
      contentType: TEXT_CONTENT_TYPE,
      encoding: 'utf-8',
      kind: 'text'
    }
  })

  return c.json({ ok: true, key, bytes: result.bytes })
})

export default app
