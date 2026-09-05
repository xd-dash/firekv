# firekv

A Hono + Cloudflare Workers KV file editor and Terraform HTTP remote-state backend.

The primary infrastructure purpose of FireKV is to persist Terraform state in Workers KV while letting Terraform keep using its built-in `http` backend. Ordinary non-reserved KV keys can still be edited as raw string files through the small browser UI.

The `terraform/` KV prefix is reserved for Terraform state and is deliberately excluded from the public file UI.

## Terraform HTTP backend

FireKV implements the state operations needed by Terraform's built-in `http` backend:

```text
GET    /tfstate/<scope>   read current state
POST   /tfstate/<scope>   archive a revision and replace current state
DELETE /tfstate/<scope>   archive current state and remove it
```

State is stored as opaque bytes. FireKV does not interpret Terraform JSON.

For scope `cloudflare/dashxd` the storage layout is:

```text
terraform/cloudflare/dashxd/terraform.tfstate
terraform/cloudflare/dashxd/history/<revision>.tfstate
```

Every POST writes a history object before replacing the current object. DELETE also archives the previous current value. History is recovery/audit material, not a concurrency primitive.

This deployment intentionally accepts Workers KV's eventual consistency because it is a sandbox state backend. The operational invariant is one active Terraform writer per exact state scope. FireKV does not expose Terraform lock/unlock endpoints and does not implement a fake KV mutex. If stronger coordination becomes necessary, move state coordination to a strongly consistent primitive instead of layering read-then-write locking on KV.

FireKV also enforces the relevant Workers KV object limits at its boundary: state values are capped at 25 MiB and scope length is bounded with headroom under the 512-byte KV key limit for history keys.

Terraform configuration remains small and composable:

```hcl
terraform {
  backend "http" {}
}
```

Supply backend location and credentials at runtime:

```sh
export TF_HTTP_ADDRESS="$address"
export TF_HTTP_USERNAME="$username"
export TF_HTTP_PASSWORD="$password"
terraform init -reconfigure
```

This keeps state credentials out of Terraform configuration and generated source files.

## GitHub identity and FireKV capability exchange

FireKV does not implement GitHub JWT/JWKS verification itself. It composes the exact `@xd-dash/auth.net.im/providers/github` package revision declared in `package.json`.

```text
GitHub Actions OIDC assertion
        ↓
GitHubProvider.middleware()
  from auth.net.im
        ↓
verified provider-neutral AuthIdentity
        ↓
POST /auth/github-oidc
        ↓
FireKV scope authorization / session issuance
        ↓
short-lived Basic credential bound to one tfstate scope
        ↓
Terraform HTTP backend
```

`auth.net.im` owns GitHub assertion semantics: RS256, GitHub JWKS, issuer, audience, workload claims, and supplied owner/repository/ref/workflow policy. FireKV only consumes the normalized identity and issues a narrower FireKV credential.

`POST /auth/github-oidc` is protected directly by `GitHubProvider.middleware()`. `/tfstate/*` is deliberately not protected by GitHub middleware because Terraform's HTTP backend natively supports Basic authentication but does not mint a GitHub OIDC assertion for every state request.

The returned Basic-auth password is an HMAC-signed FireKV session token bound to one exact tfstate scope, GitHub repository identity, and GitHub run. It is not a Cloudflare API token.

Example GitHub Actions handoff:

```sh
set -euo pipefail

scope='cloudflare/dashxd'
oidc="$(curl -fsSL \
  -H "Authorization: bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" \
  "${ACTIONS_ID_TOKEN_REQUEST_URL}&audience=${GITHUB_AUDIENCE}" | jq -r .value)"

session="$(curl -fsSL \
  -H "Authorization: Bearer $oidc" \
  -H 'Content-Type: application/json' \
  --data "$(jq -cn --arg scope "$scope" '{scope:$scope}')" \
  "$FIREKV_URL/auth/github-oidc")"

TF_HTTP_ADDRESS="$(jq -r .address <<<"$session")"
TF_HTTP_USERNAME="$(jq -r .username <<<"$session")"
TF_HTTP_PASSWORD="$(jq -r .password <<<"$session")"
echo "::add-mask::$TF_HTTP_PASSWORD"

export TF_HTTP_ADDRESS TF_HTTP_USERNAME TF_HTTP_PASSWORD
terraform init -reconfigure
terraform apply
```

The caller needs GitHub Actions `id-token: write`.

## Policy ownership

FireKV source and `wrangler.jsonc` do not own a deployment's GitHub organization, repository, immutable IDs, refs, workflow prefix, or OIDC audience. Those values belong to the deployment/qualification authority and are supplied through the generic `GitHubEnv` bindings expected by `auth.net.im`:

```text
GITHUB_AUDIENCE
GITHUB_OWNER
GITHUB_OWNER_ID           optional tightening
GITHUB_REPOSITORIES
GITHUB_REPOSITORY_IDS     optional tightening
GITHUB_REFS               optional tightening
GITHUB_WORKFLOW_PREFIX    optional tightening
```

For the xd-dash deployment, Huram's `master` GitHub Environment owns the concrete values and maps them into these process bindings during exact-candidate qualification/deployment.

FireKV-specific runtime configuration remains separate:

```text
FIREKV_SESSION_SECRET
FIREKV_SESSION_TTL_SECONDS
FILES
```

`FIREKV_SESSION_TTL_SECONDS` must be an integer from 300 through 7200 seconds. `FIREKV_SESSION_SECRET` must contain at least 32 bytes of secret material and must never be committed as a Wrangler var.

## Cloudflare deployment

Huram ABI owns the production deployment. The intended exact Custom Domains are:

```text
https://firekv.dashxd.com
https://kv.dashxd.com
```

Both hostnames route to the same FireKV Worker and the same `FILES` Workers KV namespace. Because these are Workers Custom Domains and FireKV has no Workers Static Assets binding, every path on those hostnames enters the Worker; there is no asset-router bypass and no `assets.run_worker_first` setting required in the current deployment.

`workers.dev` and preview URLs are disabled. The session signing secret is injected as secret material during deployment. Concrete GitHub authorization policy comes from Huram's `master` Environment rather than this repository.

Cloudflare Access can independently protect a future browser UI, but it is not used as Terraform's state credential. Do not reuse a Cloudflare management API token as a FireKV data-plane credential.

## Local qualification

```sh
npm ci
npm test
npm run typecheck
npm run dry-run
```

The tests inject a synthetic GitHub `AuthProvider`, mint a FireKV scope credential, write Terraform-state bytes, read them back, and verify cross-scope rejection, malformed paths/scopes, invalid TTLs, Basic-auth parsing, and Workers KV size boundaries.

For the file UI:

```sh
npx wrangler kv key put hello.txt 'hello from kv' --binding FILES --local --persist-to .wrangler/state
npm run dev
```

See `FIREKV_IDIOMS.md` for the maintenance and deployment invariants.
