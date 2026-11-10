import { Hono } from 'hono';
import { AuthError } from '@xd-dash/auth.net.im/core';
import { GitHubProvider } from '@xd-dash/auth.net.im/providers/github';

const maxStateBytes = 25 * 1024 * 1024;
const prefix = 'terraform/';
const noStore = { 'cache-control': 'no-store' };
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function normalizeScope(value) {
  const scope = value.trim().replace(/^\/+|\/+$/g, '');
  if (!scope || scope.length > 400 || !/^[A-Za-z0-9._/-]+$/.test(scope)) return null;
  if (scope.split('/').some(part => !part || part === '.' || part === '..')) return null;
  return scope;
}

function scopeFromPath(path) {
  if (!path.startsWith('/tfstate/')) return null;
  try {
    return normalizeScope(path.slice('/tfstate/'.length).replace(/\/$/, '')
      .split('/').map(decodeURIComponent).join('/'));
  } catch {
    return null;
  }
}

function b64uEncode(value) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function b64uDecode(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('invalid base64url');
  const padded = value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4);
  return Uint8Array.from(atob(padded), char => char.charCodeAt(0));
}

function sessionSecret(env) {
  const secret = env.FIREKV_SESSION_SECRET;
  return secret && encoder.encode(secret).byteLength >= 32 ? secret : null;
}

function sessionTtl(env) {
  const raw = env.FIREKV_SESSION_TTL_SECONDS?.trim();
  if (!raw) return 3600;
  if (!/^\d+$/.test(raw)) return null;
  const ttl = Number(raw);
  return Number.isSafeInteger(ttl) && ttl >= 300 && ttl <= 7200 ? ttl : null;
}

async function hmacKey(secret) {
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

async function signSession(claims, secret) {
  const payload = b64uEncode(encoder.encode(JSON.stringify(claims)));
  const signature = await crypto.subtle.sign('HMAC', await hmacKey(secret), encoder.encode(payload));
  return payload + '.' + b64uEncode(signature);
}

async function verifySession(token, secret) {
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  try {
    const valid = await crypto.subtle.verify('HMAC', await hmacKey(secret), b64uDecode(parts[1]), encoder.encode(parts[0]));
    if (!valid) return null;
    const claims = JSON.parse(decoder.decode(b64uDecode(parts[0])));
    if (claims?.v !== 1 || typeof claims.scope !== 'string' ||
        typeof claims.repository !== 'string' || typeof claims.run_id !== 'string' ||
        !normalizeScope(claims.scope) || !claims.repository || !claims.run_id ||
        !Number.isInteger(claims.exp) || claims.exp <= Math.floor(Date.now() / 1000)) return null;
    return claims;
  } catch {
    return null;
  }
}

function basicToken(authorization) {
  const match = authorization?.trim().match(/^Basic\s+([A-Za-z0-9+/=]+)$/i);
  if (!match) return null;
  try {
    const decoded = atob(match[1]);
    const separator = decoded.indexOf(':');
    return separator >= 0 && decoded.slice(0, separator) === 'firekv' ? decoded.slice(separator + 1) || null : null;
  } catch {
    return null;
  }
}

async function stateIdentity(request, env, scope) {
  const secret = sessionSecret(env);
  const token = basicToken(request.headers.get('authorization'));
  if (!secret || !token) return null;
  const claims = await verifySession(token, secret);
  return claims?.scope === scope ? claims : null;
}

function bodyTooLarge(request) {
  const length = request.headers.get('content-length');
  return length !== null && (!/^\d+$/.test(length) || Number(length) > maxStateBytes);
}

export function createTfstateApp(githubProvider = new GitHubProvider()) {
  const app = new Hono({ strict: false });

  app.onError((error, c) => {
    if (error instanceof AuthError) {
      const headers = { ...noStore };
      if (error.status === 401) headers['www-authenticate'] = 'Bearer';
      return c.json({ error: error.code, message: error.message }, error.status, headers);
    }
    return c.json({ error: 'internal_error' }, 500, noStore);
  });

  app.use('/auth/github-oidc', GitHubProvider.middleware({ provider: githubProvider }));

  app.post('/auth/github-oidc', async c => {
    const secret = sessionSecret(c.env);
    const ttl = sessionTtl(c.env);
    if (!secret || ttl === null) return c.json({ error: 'session_auth_unconfigured' }, 503, noStore);

    const identity = c.get('authIdentity');
    const repository = identity.attributes.repository;
    const runId = identity.attributes.run_id;
    if (!repository || !runId) return c.json({ error: 'workload_identity_incomplete' }, 403, noStore);

    const body = await c.req.json().catch(() => ({}));
    const scope = typeof body.scope === 'string' ? normalizeScope(body.scope) : null;
    if (!scope) return c.json({ error: 'invalid_scope' }, 400, noStore);

    const exp = Math.floor(Date.now() / 1000) + ttl;
    const password = await signSession({ v: 1, exp, repository, run_id: runId, scope }, secret);
    const origin = new URL(c.req.url).origin;
    return c.json({
      username: 'firekv',
      password,
      address: origin + '/tfstate/' + scope.split('/').map(encodeURIComponent).join('/'),
      expires_at: new Date(exp * 1000).toISOString(),
      scope,
    }, 200, noStore);
  });

  app.all('/auth/github-oidc', c => c.text('Method not allowed', 405, noStore));

  app.use('/tfstate/*', async (c, next) => {
    const scope = scopeFromPath(c.req.path);
    if (!scope) return c.text('Not found', 404, noStore);
    const claims = await stateIdentity(c.req.raw, c.env, scope);
    if (!claims) return c.text('Unauthorized', 401, { ...noStore, 'www-authenticate': 'Basic realm="firekv"' });
    c.set('stateScope', scope);
    await next();
  });

  app.get('/tfstate/*', async c => {
    const key = prefix + c.get('stateScope') + '/terraform.tfstate';
    const state = await c.env.TFSTATE.get(key, 'arrayBuffer');
    return state === null
      ? new Response(null, { status: 404, headers: noStore })
      : new Response(state, { headers: { ...noStore, 'content-type': 'application/json' } });
  });

  app.post('/tfstate/*', async c => {
    if (bodyTooLarge(c.req.raw)) return c.text('State exceeds Workers KV limit', 413, noStore);
    const state = await c.req.arrayBuffer();
    if (state.byteLength > maxStateBytes) return c.text('State exceeds Workers KV limit', 413, noStore);
    const key = prefix + c.get('stateScope') + '/terraform.tfstate';
    await c.env.TFSTATE.put(key, state);
    return new Response(null, { headers: noStore });
  });

  app.delete('/tfstate/*', async c => {
    const key = prefix + c.get('stateScope') + '/terraform.tfstate';
    await c.env.TFSTATE.delete(key);
    return new Response(null, { headers: noStore });
  });

  app.all('/tfstate/*', c => c.text('Method not allowed', 405, noStore));
  app.all('*', c => c.notFound());
  return app;
}

export default createTfstateApp();
