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

Cloudflare KV is not used for Terraform locking. Do not configure `lock_address` or `unlock_address` against this implementation. If concurrent writers to one state become necessary, add a strongly coordinated lock service such as a Durable Object rather than implementing a KV read-then-write mutex.

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

Set `FIREKV_SESSION_SECRET` as a random secret of at least 32 bytes; never commit it as a Wrangler var:

```sh
openssl rand -base64 48 | npx wrangler secret put FIREKV_SESSION_SECRET
```

Replace the placeholder `FILES` namespace id before production deployment.

## Cloudflare Access and static assets

Cloudflare Access can independently protect a browser UI or an entire production Worker/custom domain. It is separate from Terraform's state credential. Do not reuse a Cloudflare management API token as a FireKV data-plane credential.

Terraform's HTTP backend does not provide a general arbitrary-header mechanism, while Cloudflare Access service tokens normally use Cloudflare-specific headers. FireKV therefore uses the GitHub-identity-to-Basic capability exchange for Terraform state access.

If Workers Static Assets are added later, protected API paths must continue to enter the Worker first; configure `assets.run_worker_first` for `/auth/*` and `/tfstate/*` (or `true`) so an asset router cannot bypass API middleware.

## Local qualification

```sh
npm ci
npm test
npm run typecheck
npm run dry-run
```

The tests inject a synthetic GitHub `AuthProvider`, mint a FireKV scope credential, write Terraform-state bytes, read them back, and verify that the same credential cannot access another scope.

For the file UI:

```sh
npx wrangler kv key put hello.txt 'hello from kv' --binding FILES --local --persist-to .wrangler/state
npm run dev
```
