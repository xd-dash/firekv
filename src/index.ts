import { Hono } from 'hono'

type Bindings = { FILES: KVNamespace }
const app = new Hono<{ Bindings: Bindings }>({ strict: false })

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
  return c.json({ ok: true, key, bytes: new TextEncoder().encode(value).byteLength })
})

export default app
