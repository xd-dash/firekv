const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
const reply = (body, status = 200) => new Response(body, { status, headers: { 'cache-control': 'no-store' } })
const MAX = 20 * 1024 * 1024

export class TerraformState {
  constructor(state) { this.storage = state.storage }

  async fetch(request) {
    const url = new URL(request.url)
    const method = request.method
    const lockOperation = url.pathname === '/lock'
    if (lockOperation && !['LOCK', 'UNLOCK'].includes(method)) return reply('Method not allowed', 405)
    if (!lockOperation && !['GET', 'POST', 'DELETE'].includes(method)) return reply('Method not allowed', 405)
    const bytes = method === 'POST' ? await request.arrayBuffer() : null
    if (bytes && bytes.byteLength > MAX) return reply('State too large', 413)
    let supplied = null
    if (lockOperation) {
      try {
        supplied = await request.json()
        if (!supplied || typeof supplied.ID !== 'string' || !supplied.ID || supplied.ID.length > 200) return reply('Invalid lock', 400)
      } catch { return reply('Invalid lock JSON', 400) }
    }
    const lockId = url.searchParams.get('ID')
    return this.storage.transaction(async txn => {
      const held = await txn.get('lock')
      if (method === 'LOCK') {
        if (held) return json(held, 423)
        await txn.put('lock', supplied)
        return json(supplied)
      }
      if (method === 'UNLOCK') {
        if (!held || held.ID !== supplied.ID) return json(held || { error: 'No matching lock' }, 409)
        await txn.delete('lock')
        return reply(null)
      }
      if (method === 'GET') {
        const data = await txn.get('state')
        return data === undefined ? reply(null, 404) : new Response(data, { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
      }
      if (held && lockId !== held.ID) return json(held, 423)
      if (method === 'POST') {
        await txn.put('state', new Uint8Array(bytes))
        return reply(null)
      }
      await txn.delete('state')
      return reply(null)
    })
  }
}
