# firekv

A Hono + Cloudflare Workers KV file editor and Terraform HTTP remote-state backend.

Ordinary KV keys are treated as file paths and values as raw strings. `/` lists non-reserved keys. `/file/<key>/` embeds the current raw value in a server-rendered textarea and saves through the same Worker path.

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

Terraform configuration can remain composable and credential-free:

```hcl
terraform {
  backend "http" {}
}
```

Supply backend location and credentials through environment variables at runtime:

```sh
export TF_HTTP_ADDRESS="$address"
export TF_HTTP_USERNAME="$username"
export TF_HTTP_PASSWORD="$password"
terraform init -reconfigure
```

This avoids persisting backend credentials in Terraform configuration or generated files.

## GitHub Actions OIDC handoff

`POST /auth/github-oidc` exchanges a verified GitHub Actions OIDC assertion for a short-lived, state-scoped FireKV credential. The OIDC assertion must:

- be issued by `https://token.actions.githubusercontent.com`;
- use audience `firekv`;
- have a valid RS256 signature from GitHub's current JWKS;
- be unexpired;
- match `FIREKV_GITHUB_OWNER` and one exact repository in `FIREKV_GITHUB_REPOSITORIES`.

The Worker returns a Basic-auth username/password because Terraform's HTTP backend natively supports Basic auth. The password is an HMAC-signed FireKV session token bound to one exact tfstate scope and one GitHub run. It is not a Cloudflare API token.

Example GitHub Actions shell handoff:

```sh
set -euo pipefail

scope='cloudflare/dashxd'
oidc="$(curl -fsSL \
  -H "Authorization: bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" \
  "${ACTIONS_ID_TOKEN_REQUEST_URL}&audience=firekv" | jq -r .value)"

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

The caller needs GitHub Actions `id-token: write`. The default production policy only permits `xd-dash/huram-abi-master` to perform this exchange. Ephemeral sandbox repositories should receive the resulting short-lived credential only inside the trusted run boundary rather than becoming durable credential owners themselves.

## Worker configuration

Non-secret policy is configured in `wrangler.jsonc`:

```text
FIREKV_GITHUB_OWNER=xd-dash
FIREKV_GITHUB_REPOSITORIES=xd-dash/huram-abi-master
FIREKV_SESSION_TTL_SECONDS=3600
```

Set a random signing secret of at least 32 bytes through Wrangler secrets, never `vars` or source control:

```sh
openssl rand -base64 48 | npx wrangler secret put FIREKV_SESSION_SECRET
```

Replace the placeholder `FILES` namespace id before deployment.

## Cloudflare Access and static assets

Cloudflare Access remains useful for protecting a browser UI or an entire production Worker/custom domain. It is separate from Terraform's state credential. Do not reuse a Cloudflare management API token as a FireKV data-plane credential.

Terraform's HTTP backend does not provide a general arbitrary-header mechanism, while Cloudflare Access service tokens normally use Cloudflare-specific headers. FireKV therefore uses the OIDC-to-Basic exchange above for Terraform rather than coupling Terraform state access to Cloudflare Access service-token headers.

FireKV currently serves its UI from the Worker and has no Workers Static Assets binding. If static assets are added later, protected API paths must continue to enter the Worker first; configure `assets.run_worker_first` for `/auth/*` and `/tfstate/*` (or `true`) so the asset router cannot bypass API middleware.

## Local CLI

```sh
npm ci
npx wrangler kv key put hello.txt 'hello from kv' --binding FILES --local --persist-to .wrangler/state
npm run dev
```
