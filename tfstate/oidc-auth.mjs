const enc = new TextEncoder()
const dec = new TextDecoder()
const b64 = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const unb64 = str => Uint8Array.from(atob(str.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - str.length % 4) % 4)), c => c.charCodeAt(0))
const parse = str => JSON.parse(dec.decode(unb64(str)))
const fail = () => { throw new Error('Authentication rejected') }

async function hmac(secret, value) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return b64(new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(value))))
}
function equal(a, b) {
  const aa = enc.encode(a), bb = enc.encode(b)
  let diff = aa.length ^ bb.length
  for (let i = 0; i < Math.max(aa.length, bb.length); i++) diff |= (aa[i] || 0) ^ (bb[i] || 0)
  return diff === 0
}

export async function verifyGithub(jwt, config, fetchJwks = fetch, now = Date.now()) {
  if (typeof jwt !== 'string' || jwt.length > 12000) fail()
  const parts = jwt.split('.')
  if (parts.length !== 3) fail()
  const header = parse(parts[0]), claims = parse(parts[1])
  if (header.alg !== 'RS256' || typeof header.kid !== 'string' || !/^[\w.-]{1,200}$/.test(header.kid)) fail()
  const seconds = Math.floor(now / 1000)
  if (claims.iss !== 'https://token.actions.githubusercontent.com' ||
      claims.aud !== config.audience ||
      claims.repository !== config.repository ||
      claims.ref !== config.ref ||
      claims.environment !== config.environment ||
      claims.repository_owner !== config.owner ||
      claims.workflow_ref !== config.workflowRef ||
      !Number.isInteger(claims.iat) || !Number.isInteger(claims.exp) ||
      claims.iat > seconds + 30 || claims.exp <= seconds || claims.exp > seconds + 600 ||
      claims.exp - claims.iat > 600 ||
      !/^[0-9]+$/.test(String(claims.run_id || ''))) fail()
  const response = await fetchJwks('https://token.actions.githubusercontent.com/.well-known/jwks', { signal: AbortSignal.timeout(5000) })
  if (!response.ok) fail()
  const keys = (await response.json()).keys
  const jwk = Array.isArray(keys) && keys.find(k => k.kid === header.kid && k.kty === 'RSA' && k.use === 'sig')
  if (!jwk) fail()
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify'])
  if (!await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, unb64(parts[2]), enc.encode(parts[0] + '.' + parts[1]))) fail()
  return { run: claims.run_id, job: claims.job_workflow_ref || '', sha: claims.sha }
}

export async function issueSession(secret, scope, identity, now = Date.now()) {
  if (!secret || secret.length < 32) fail()
  const body = b64(enc.encode(JSON.stringify({ scope, run: identity.run, exp: Math.floor(now / 1000) + 900 })))
  return body + '.' + await hmac(secret, body)
}

export async function verifySession(secret, token, scope, now = Date.now()) {
  if (!secret || secret.length < 32 || typeof token !== 'string' || token.length > 4096) fail()
  const parts = token.split('.')
  if (parts.length !== 2 || !equal(await hmac(secret, parts[0]), parts[1])) fail()
  const body = parse(parts[0])
  if (body.scope !== scope || !Number.isInteger(body.exp) || body.exp <= Math.floor(now / 1000) || body.exp > Math.floor(now / 1000) + 900) fail()
  return body
}
