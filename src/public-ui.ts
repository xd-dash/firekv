import {
  escapeHtml,
  renderDocument,
  workerMetaFromRequest,
} from '@xd-dash/dashxd.com/design'

const service = 'firekv'

const edgeMeta = (request: Request) => workerMetaFromRequest(
  request as Request & { cf?: Record<string, unknown> },
  service,
)

export const renderHome = (request: Request, items: string) => renderDocument({
  title: 'firekv',
  meta: edgeMeta(request),
  logoAlt: 'dash xd logo',
  body: `<section class="content-shell">
    <p class="body-copy">firekv is eventually consistent</p>
    <form id="create-editor" class="stack">
      <label class="sr-only" for="create-key">key</label>
      <input class="text-input" id="create-key" type="text" autocomplete="off" placeholder="Enter key" required>
      <label class="sr-only" for="create-contents">text</label>
      <textarea class="text-editor" id="create-contents" spellcheck="false" placeholder="Enter text"></textarea>
      <button class="action-button" type="submit">save text</button>
      <div class="status-line" id="create-status" aria-live="polite"></div>
    </form>
    <ul class="key-list">${items}</ul>
  </section>`,
  script: `
    const form = document.querySelector('#create-editor')
    const key = document.querySelector('#create-key')
    const contents = document.querySelector('#create-contents')
    const status = document.querySelector('#create-status')
    form.addEventListener('submit', async (event) => {
      event.preventDefault()
      status.textContent = 'saving…'
      const path = key.value.trim().split('/').map(encodeURIComponent).join('/')
      const response = await fetch('/file/' + path, {
        method: 'PUT',
        headers: { 'content-type': 'text/plain; charset=utf-8' },
        body: contents.value,
      })
      if (response.ok) {
        status.textContent = 'saved'
        location.href = '/file/' + path + '/'
      } else {
        status.textContent = 'save failed (' + response.status + '): ' + await response.text()
      }
    })
  `,
})

export const renderEditor = (request: Request, key: string, value: string) => renderDocument({
  title: `${key} · firekv`,
  meta: edgeMeta(request),
  logoAlt: 'dash xd logo',
  body: `<section class="content-shell">
    <p class="body-copy">firekv is eventually consistent</p>
    <a class="link-button" href="/">←</a>
    <p class="body-copy mono">${escapeHtml(key)}</p>
    <form id="editor" class="stack">
      <label class="sr-only" for="contents">text</label>
      <textarea class="text-editor" id="contents" spellcheck="false">${escapeHtml(value)}</textarea>
      <button class="action-button" type="submit">save text</button>
      <div class="status-line" id="status" aria-live="polite"></div>
    </form>
  </section>`,
  script: `
    const form = document.querySelector('#editor')
    const contents = document.querySelector('#contents')
    const status = document.querySelector('#status')
    form.addEventListener('submit', async (event) => {
      event.preventDefault()
      status.textContent = 'saving…'
      const response = await fetch('./', {
        method: 'PUT',
        headers: { 'content-type': 'text/plain; charset=utf-8' },
        body: contents.value,
      })
      status.textContent = response.ok
        ? 'saved'
        : 'save failed (' + response.status + '): ' + await response.text()
    })
  `,
})
