# FireKV Terraform state v2: Durable Objects + GitHub OIDC

This is a **separate, staged backend**, not a migration of the existing KV Worker. Source lives on `codex/tfstate-durable-oidc`. No production deployment or state mutation is authorized.

## Why the storage engine changes

The earlier `worker.mjs` stores state in Workers KV and cannot implement Terraform's atomic lock protocol or strongly consistent read-after-write. The new `durable-worker.mjs` routes one exact state scope to one SQLite-backed Cloudflare Durable Object (`TerraformState`). State and lock are updated through Durable Object storage transactions. This provides a serialized coordination point and persistent storage within Cloudflare's Durable Object model, instead of relying on KV propagation. Terraform HTTP backend `LOCK` and `UNLOCK` use the `/lock` endpoint, and state writes require the matching `?ID=` lock identifier when a lock is held. No lock TTL is imposed: interrupted writers require a separately authorized Terraform `force-unlock` after investigation.

Durable Objects are not a replacement for independent backup. Before production use, qualify a real Cloudflare deployment, concurrency across independent clients, state restart/recovery, outage behavior, backup/export/restore, and the account's plan/quota/cost. Do not migrate an existing GCS state or old FireKV state by default.

## Machine identity without Smoke or static credentials

The Huram job requests a GitHub OIDC JWT with audience `firekv`. `POST /auth/github-oidc` verifies the JWT's RS256 signature against GitHub's public JWKS and checks exact issuer, audience, repository, repository owner, branch ref, environment, workflow ref, run ID and expiry. A valid identity receives a 15-minute, HMAC-authenticated Basic password bound to the exact `cloudflare/dashxd-dns` scope. Every backend request verifies its scope and expiry. The signing key is a Cloudflare Worker secret `SESSION_SIGNING_KEY` (32+ unpredictable characters), not a GitHub secret or a Terraform variable. Never print the OIDC token, session password or Terraform state.

The configured host is `tfstate.firekv.dashxd.com`; the configuration intentionally has **no routes** and no signing secret, so it cannot be deployed as-is. Restrict Cloudflare Access or equivalent ingress policy appropriately, but do not assume browser-owner Access authentication is compatible with GitHub OIDC. Do not enable a public bypass route. If Access is placed in front, explicitly qualify the OIDC exchange and state endpoints end-to-end through that policy.

The backend session action is `.github/actions/firekv-durable-session/action.yml` on Huram's isolated migration branch. The gated `plan-dashxd-terraform.yml` uses `id-token: write`, scoped exchange, and HTTP LOCK/UNLOCK. It is **not** enabled until production backend qualification and state lineage verification.

## Offline qualification

```sh
cd tfstate
node --test durable.test.mjs oidc.test.mjs
npm ci --ignore-scripts --no-audit --no-fund
npx wrangler deploy --config wrangler.durable.jsonc --dry-run
```

The tests check lock ownership, byte preservation, session HMAC expiry and scope, and JWT signature and claim rejection. These tests are not a substitute for a real Terraform CLI integration against a local Wrangler Durable Object and two independent Terraform clients.

## Remaining gates

1. Real local Wrangler Durable Object + Terraform CLI test: init, lock contention, state round-trip, process restart, unlock and recovery.
2. Cloudflare API dry-run / deployment plan for Durable Object migration and private Custom Domain, with no public FireKV rebind.
3. Confirm actual OIDC JWT claim shape, GitHub JWKS, environment protections, Cloudflare Worker secret, and Cloudflare Access ingress policy.
4. Live disposable scope test with concurrent writers and state backups; no active DNS state.
5. Controlled migration of exact selected state with independent backup, provider lockfile and import identity, followed by read-only refresh plan.
6. Only then enable `FIREKV_TFSTATE_QUALIFIED=true` in Huram. A production apply workflow is not provided.

The earlier KV backend and GCS bootstrap state remain unchanged.
