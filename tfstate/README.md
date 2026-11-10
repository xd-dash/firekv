# Private Terraform state Worker

This Worker serves only Terraform HTTP state routes. It has a dedicated TFSTATE
KV binding that is never attached to the public FireKV editor. The preferred
hostname is tfstate.firekv.dashxd.com; it does not require Cloudflare Access.

## Authentication and isolation

The private Worker uses the same two-stage authentication as the existing
FireKV state routes:

1. Huram presents a GitHub Actions OIDC assertion to POST /auth/github-oidc.
2. auth.net.im verifies the GitHub assertion against the configured issuer,
   audience, repository, repository ID, owner, ref, and workflow policy.
3. FireKV returns a short-lived HMAC-SHA256 capability bound to exactly one
   state scope.
4. Terraform uses that capability as HTTP Basic auth for GET, POST, and DELETE
   /tfstate/<scope>.

The GitHub OIDC identity is the workflow identity. The Basic credential is only
a temporary state-route capability; it cannot mint another capability and
cannot authorize Cloudflare deployment. GitHub OIDC itself cannot read or write
state routes. Hono middleware remains route-specific: OIDC middleware is mounted
on /auth/github-oidc, and capability validation is mounted on /tfstate/*.

Set the existing GITHUB_* policy bindings to the approved Huram repository and
deployment/qualification workflow. Keep the owner and repository IDs pinned.
Use a dedicated workflow ref/prefix for production state operations. Missing or
invalid policy values fail closed.

FIREKV_SESSION_SECRET is a high-entropy Cloudflare Worker secret used to sign
the short-lived capabilities. The Terraform deployment should manage it as a
secret_text binding and generate it once, not on every run. It is sensitive
Terraform state and therefore must be stored only in the private FireKV state
backend. FIREKV_SESSION_TTL_SECONDS defaults to 3600 and may be set from 300
through 7200. Rotating the HMAC secret invalidates active capabilities.

The Worker disables workers.dev and preview URLs. There is no Access policy,
public editor route, GitHub token exchange in the state middleware, or public
Service Binding. The existing editor is bound only to FILES; this Worker is
bound only to TFSTATE. The public UI cannot list or read this namespace.

## Terraform protocol and sandbox consistency

GET, POST, and DELETE /tfstate/<scope> store opaque bytes under the single
current-state key terraform/<scope>/terraform.tfstate. There is no history,
backup, restore, compression, or fake KV lock.

Workers KV is eventually consistent. That is accepted for this sandbox.
Serialize Terraform writers per exact state scope and use bounded read-after-write
polling. Do not configure Terraform HTTP lock or unlock endpoints.

No GCS state backend is used.

## Deployment and cutover

Huram owns Cloudflare resources and policy. Manage the Worker, dedicated KV
namespace, Custom Domain, Hono module upload, and HMAC secret binding through
cfxd Terraform. Do not deploy the production Worker with Wrangler or direct API
scripts.

The existing public FireKV Worker and its current /tfstate/* routes remain
unchanged until a deliberate cutover. Current production state remains in the
existing FILES namespace until that cutover. The public editor's reserved
terraform/ filter and read/write denial must remain in place.

There is no state migration in this PR. No production namespace, hostname,
Access policy, DNS record, or Cloudflare resource is created by these files.
When a state scope is intentionally moved, pause writers, use Terraform's
backend migration with bounded consistency checks, and verify the expected
lineage, serial, and resource addresses before resuming writes. Do not make a
backup copy.

## Qualification

Run the package checks from repository root:

    npm ci --ignore-scripts --no-audit --no-fund
    npm test
    npm run typecheck
    npx wrangler deploy --config tfstate/wrangler.jsonc --dry-run

Huram's local integration qualification runs the exact Worker in Wrangler/workerd,
requests a real GitHub Actions OIDC token, exchanges it for a scope-bound FireKV
capability, and runs Terraform 1.9.8 HTTP apply plus fresh-init recovery against
local KV. It also proves the public routes are absent, OIDC and Basic credentials
cannot cross route families, scopes are isolated, and no backup/history key is
written. This proves local protocol and auth integration, not live Cloudflare
deployment or cross-edge KV consistency.
