# firekv

A Hono + Cloudflare Workers KV text editor and Terraform HTTP remote-state backend.

The primary infrastructure purpose of FireKV is to persist Terraform state in Workers KV while letting Terraform keep using its built-in `http` backend. Ordinary non-reserved KV keys can be created and edited as public UTF-8 text through the browser UI.

The `terraform/` KV prefix is reserved for Terraform state and is deliberately excluded from the public text surface.

## Public text editor

`https://firekv.dashxd.com/` and `https://kv.dashxd.com/` expose the same Worker-backed text editor. The page accepts a key plus text in a textarea, then stores the value in the shared `FILES` Workers KV namespace.

The public write contract is intentionally text-only:

```text
PUT /file/<key>
Content-Type: text/plain[; charset=utf-8]
body: valid UTF-8
```

There is no file upload control and no multipart/binary upload route. FireKV rejects `multipart/form-data`, invalid UTF-8, unsafe key aliases, and any attempt to enter the reserved `terraform/` namespace. Public editor responses use `Cache-Control: no-store` so edits are not served from a shared public cache.

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

FireKV enforces the relevant Workers KV object limits at its boundary: state values are capped at 25 MiB and scope length is bounded with headroom under the 512-byte KV key limit for history keys.

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

## GitHub identity and FireKV capability exchange

FireKV does not implement GitHub JWT/JWKS verification itself. It composes `@xd-dash/auth.net.im/providers/github`.

```text
GitHub Actions OIDC assertion
        ↓
GitHubProvider.middleware()
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

`auth.net.im` owns GitHub assertion semantics: RS256, GitHub JWKS, issuer, audience, workload claims, and supplied owner/repository/ref/workflow policy. FireKV consumes the normalized identity and issues a narrower FireKV credential.

`POST /auth/github-oidc` is protected directly by `GitHubProvider.middleware()`. `/tfstate/*` is deliberately not protected by GitHub middleware because Terraform's HTTP backend natively supports Basic authentication but does not mint a GitHub OIDC assertion for every state request.

The returned Basic-auth password is an HMAC-signed FireKV session token bound to one exact tfstate scope, GitHub repository identity, and GitHub run. It is not a Cloudflare API token.

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

For the xd-dash deployment, Huram's `master` GitHub Environment owns the concrete values and maps them into these process bindings during deployment.

FireKV-specific runtime configuration remains separate:

```text
FIREKV_SESSION_SECRET
FIREKV_SESSION_TTL_SECONDS
FILES
```

`FIREKV_SESSION_TTL_SECONDS` must be an integer from 300 through 7200 seconds. `FIREKV_SESSION_SECRET` must contain at least 32 bytes of secret material and must never be committed as a Wrangler var.

## Cloudflare deployment

Huram ABI owns the deployment. The Custom Domains are:

```text
https://firekv.dashxd.com
https://kv.dashxd.com
```

Both hostnames route to the same FireKV Worker and the same `FILES` Workers KV namespace. Because these are Workers Custom Domains and FireKV has no Workers Static Assets binding, every path enters the Worker; there is no asset-router bypass and no `assets.run_worker_first` setting required.

`workers.dev` and preview URLs are disabled. Concrete GitHub authorization policy comes from Huram's `master` Environment.

## Qualification

Repository qualification is:

```sh
npm ci
npm test
npm run typecheck
npm run dry-run
```

Production qualification is intentionally small: anonymous tfstate must return `401` + `no-store`, one real GitHub OIDC assertion must mint a scoped capability, Terraform must write and recover the state after a fresh `init`, a wrong scope must return `401`, and the public surface must pass one UTF-8 text round trip while rejecting multipart upload.

DNS inventory, TLS status, Custom Domain internals, and other Cloudflare diagnostics are failure-analysis tools rather than independent release gates.

See `FIREKV_IDIOMS.md` for the maintenance invariants.
