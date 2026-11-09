const limit = 25 * 1024 * 1024;
const headers = { 'cache-control': 'no-store' };
const reply = (body, status = 200) => new Response(body, { status, headers });

function scopeFrom(path) {
  if (!path.startsWith('/tfstate/')) return null;
  try {
    const scope = path.slice(9).split('/').map(decodeURIComponent).join('/');
    if (!scope || scope.length > 400 || !/^[A-Za-z0-9._/-]+$/.test(scope)) return null;
    if (scope.split('/').some(part => !part || part === '.' || part === '..')) return null;
    return scope;
  } catch { return null; }
}

async function readBody(request) {
  const raw = request.headers.get('content-length');
  if (raw !== null && (!/^\d+$/.test(raw) || Number(raw) > limit)) return null;
  if (!request.body) return new ArrayBuffer(0);
  const reader = request.body.getReader();
  const parts = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); return null; }
      parts.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
  return bytes.buffer;
}

export default {
  async fetch(request, env, ctx) {
    try {
      // Deployment authority supplies exact owner, Access audience, and hostname.
      if (!env.OWNER_EMAIL || !env.ACCESS_AUD || !env.STATE_HOST || !env.TFSTATE) return reply('Unconfigured', 503);
      const url = new URL(request.url);
      if (url.hostname !== env.STATE_HOST || url.protocol !== 'https:') return reply('Forbidden', 403);
      if (!ctx.access || ctx.access.aud !== env.ACCESS_AUD) return reply('Forbidden', 403);
      const identity = await ctx.access.getIdentity();
      if (identity?.email !== env.OWNER_EMAIL) return reply('Forbidden', 403);
      const scope = scopeFrom(url.pathname);
      if (!scope) return reply('Not found', 404);
      const key = `terraform/${scope}/terraform.tfstate`;
      if (!['GET', 'POST', 'DELETE'].includes(request.method)) return reply('Method not allowed', 405);
      if (request.method === 'GET') {
        const state = await env.TFSTATE.get(key, 'arrayBuffer');
        return state === null ? reply(null, 404) : new Response(state, { headers: { ...headers, 'content-type': 'application/json' } });
      }
      const state = request.method === 'POST'
        ? await readBody(request)
        : await env.TFSTATE.get(key, 'arrayBuffer');
      if (state === null && request.method === 'POST') return reply('State exceeds KV limit', 413);
      if (request.method === 'POST') await env.TFSTATE.put(key, state);
      else await env.TFSTATE.delete(key);
      return reply(null);
    } catch {
      // State and identity material must not enter application logs.
      return reply('State operation failed', 500);
    }
  },
};
