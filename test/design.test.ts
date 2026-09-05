import assert from 'node:assert/strict'
import test from 'node:test'

import { createFireKVApp } from '../src/index'

function emptyKV() {
  return {
    async list() {
      return { keys: [], list_complete: true, cacheStatus: null }
    },
  } as unknown as KVNamespace
}

test('public root renders canonical dashxd design with metadata from the same request', async () => {
  const app = createFireKVApp()
  const request = new Request('https://firekv.example/', {
    headers: { 'cf-ray': 'firekv-test-ray-SJC' },
  })
  Object.defineProperty(request, 'cf', {
    value: {
      colo: 'SJC',
      country: 'US',
      httpProtocol: 'HTTP/3',
      tlsVersion: 'TLSv1.3',
    },
  })

  const response = await app.request(request, undefined, { FILES: emptyKV() })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')

  const html = await response.text()
  assert.match(html, /firekv is eventually consistent/)
  assert.match(html, /https:\/\/www\.dashxd\.com\/logo/)
  assert.match(html, /--cyan:\s*#25f4ee/)
  assert.match(html, /--magenta:\s*#fe2c55/)
  assert.match(html, /class="text-editor"/)
  assert.match(html, /class="action-button"/)
  assert.match(html, /placeholder="Enter key"/)
  assert.match(html, /placeholder="Enter text"/)
  assert.match(html, /\.text-editor:focus::placeholder[\s\S]*color:\s*transparent/)
  assert.match(html, /\.text-input:focus::placeholder[\s\S]*color:\s*transparent/)
  assert.match(html, /cloudflare worker · firekv · colo SJC · HTTP\/3 · TLSv1\.3 · country US · ray firekv-test-ray-SJC/)
  assert.match(html, /github\.com\/dash-xd/)
  assert.match(html, /github\.com\/xd-dash/)
  assert.doesNotMatch(html, /Terraform state is isolated/i)
  assert.doesNotMatch(html, /Public UTF-8 text values/i)
  assert.doesNotMatch(html, /fetch\(['"]\/meta/)
  assert.doesNotMatch(html, /type=["']file["']/i)
})
