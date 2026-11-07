import { issueSession, verifyGithub, verifySession } from './oidc-auth.mjs'
export { TerraformState } from './durable-state.mjs'

const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
const scopeValid = scope => typeof scope === 'string' && scope.length < 200 && /^[a-z0-9][a-z0-9._/-]+$/.test(scope) && !scope.split('/').some(x => !x || x === '..' || x === '.')
function config(env) {
  if (!env.TFSTATE_DURABLE || !env.SESSION_SIGNING_KEY || !env.OIDC_AUDIENCE ||
      !env.GITHUB_REPOSITORY || !env.GITHUB_REF || !env.GITHUB_ENVIRONMENT ||
      !env.GITHUB_OWNER || !env.STATE_HOST || !env.STATE_SCOPE) throw new Error('Unconfigured')
  return { audience: env.OIDC_AUDIENCE, repository: env.GITHUB_REPOSITORY, ref: env.GITHUB_REF, environment: env.GITHUB_ENVIRONMENT, owner: env.GITHUB_OWNER }
}

export default {
  async fetch(request, env) {
    try {
      const cfg = config(env)
      const url = new URL(request.url)
      if (url.protocol !== 'https:' || url.hostname !== env.STATE_HOST) return response({ error: 'Forbidden host' }, 403)
      if (!scopeValid(env.STATE_SCOPE)) return response({ error: 'Unconfigured' }, 503)
      if (url.pathname === '/auth/github-oidc' && request.method === 'POST') {
        const bearer = request.headers.get('authorization')?.match(/^Bearer (.+)$/)
        if (!bearer) return response({ error: 'Unauthorized' }, 401)
        const identity = await verifyGithub(bearer[1], cfg)
        const requested = await request.json()
        if (requested?.scope !== env.STATE_SCOPE) return response({ error: 'Wrong scope' }, 403)
        const password = await issueSession(env.SESSION_SIGNING_KEY, env.STATE_SCOPE, identity)
        return response({
          address: 'https://' + env.STATE_HOST + '/tfstate/' + env.STATE_SCOPE,
          lock_address: 'https://' + env.STATE_HOST + '/tfstate/' + env.STATE_SCOPE + '/lock',
          unlock_address: 'https://' + env.STATE_HOST + '/tfstate/' + env.STATE_SCOPE + '/lock',
          username: 'github-oidc',
          password,
          scope: env.STATE_SCOPE,
          expires_at: new Date(Date.now() + 900000).toISOString(),
        })
      }
      const prefix = '/tfstate/' + env.STATE_SCOPE
      const isLock = url.pathname === prefix + '/lock'
      if (url.pathname !== prefix && !isLock) return response({ error: 'Not found' }, 404)
      const auth = request.headers.get('authorization')?.match(/^Basic (.+)$/)
      if (!auth) return response({ error: 'Unauthorized' }, 401)
      const credentials = atob(auth[1])
      const separator = credentials.indexOf(':')
      if (separator < 0 || credentials.slice(0, separator) !== 'github-oidc') return response({ error: 'Unauthorized' }, 401)
      await verifySession(env.SESSION_SIGNING_KEY, credentials.slice(separator + 1), env.STATE_SCOPE)
      const stub = env.TFSTATE_DURABLE.get(env.TFSTATE_DURABLE.idFromName(env.STATE_SCOPE))
      return stub.fetch(new Request('https://internal' + (isLock ? '/lock' : '/state') + url.search, request))
    } catch {
      return response({ error: 'Unauthorized or state unavailable' }, 401)
    }
  },
}
