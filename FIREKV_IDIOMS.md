# FireKV idioms

This file is the maintenance contract for `xd-dash/firekv`. FireKV is intentionally a small authenticated object/state service. The primary infrastructure purpose in this sandbox phase is Terraform HTTP remote state backed by Cloudflare Workers KV; the non-reserved namespace is a public UTF-8 text editor.

## Roles

```text
Huram ABI
  owns exact deployment policy, Cloudflare authority, Custom Domains,
  production bindings, and deployment qualification

auth.net.im
  owns GitHub Actions OIDC verification and workload-policy semantics

FireKV
  owns FireKV capability issuance, Terraform HTTP state protocol,
  state-key layout/history, and the public text-only KV surface

Cloudflare Worker
  hosts FireKV and is the only public HTTP path to the KV binding

Workers KV
  stores opaque state bytes and public UTF-8 text values

Terraform
  consumes the standard HTTP backend contract
```

Do not move concrete GitHub org/repository/ref/workflow policy into FireKV source or `wrangler.jsonc`. Do not reimplement GitHub JWT/JWKS validation inside FireKV.

## Authentication boundaries

Preserve the two-stage boundary:

```text
GitHub Actions OIDC assertion
  -> POST /auth/github-oidc
  -> auth.net.im GitHubProvider.middleware()
  -> provider-neutral AuthIdentity
  -> FireKV issues short-lived scope-bound capability

FireKV capability
  -> Terraform Basic auth
  -> GET/POST/DELETE /tfstate/<scope>
```

The GitHub assertion is not the Terraform backend credential. `/tfstate/*` must not require a fresh GitHub OIDC assertion on every request.

Capability properties:

- HMAC-SHA256 signed by `FIREKV_SESSION_SECRET`.
- Short lived; `FIREKV_SESSION_TTL_SECONDS` must be 300..7200 seconds.
- Bound to one exact normalized state scope.
- Carries repository and GitHub run identity for attribution/history metadata.
- Bearer semantics: possession is authority until expiry. No replay ledger is maintained.

Authentication and Terraform-state responses use `Cache-Control: no-store`. Failed Basic auth returns a Basic challenge; failed GitHub bearer auth is normalized by the auth provider boundary.

## Terraform state contract

FireKV implements the built-in Terraform HTTP backend operations:

```text
GET    /tfstate/<scope>
POST   /tfstate/<scope>
DELETE /tfstate/<scope>
```

Storage layout:

```text
terraform/<scope>/terraform.tfstate
terraform/<scope>/history/<revision>.tfstate
```

State is opaque bytes. FireKV must not parse, rewrite, merge, normalize, or infer Terraform state semantics.

Every successful POST writes a history revision and then the current state. DELETE archives the current state when present before deleting it.

Scopes are canonical slash-delimited ASCII paths. Empty segments, `.` segments, `..` segments, malformed percent encoding, and overlong scopes are rejected. Keep enough headroom under Workers KV's 512-byte key limit for the longest history key.

Workers KV values are limited to 25 MiB. Reject an oversized Terraform state before attempting KV persistence when possible, and verify buffered size before `put()`.

## Sandbox consistency model

Workers KV is eventually consistent and is not a coordination primitive. That limitation is accepted for this sandbox environment.

The operational invariant is:

```text
one active Terraform writer per exact state scope
```

FireKV deliberately does not advertise `lock_address` / `unlock_address`, and it must not implement a fake lock using KV read-then-write state. History is recovery/audit material; it is not locking, compare-and-swap, or transaction state.

When stronger semantics are required, move coordination to a strongly consistent primitive rather than layering an ad-hoc mutex on KV.

## Public text surface

`/` and `/file/*` are intentionally public and may create/edit ordinary KV values. They must never expose or mutate keys under the reserved `terraform/` prefix.

The public contract is text-only:

```text
browser UI: textarea + text key field
PUT /file/<key>
Content-Type: text/plain[; charset=utf-8]
body: valid UTF-8 only
```

There is no file-upload primitive. Do not add `<input type="file">`, multipart/form-data handling, base64 file upload, binary passthrough, or an alternate public write route that bypasses the text checks. Reject non-`text/plain` bodies and invalid UTF-8.

Public keys are canonical slash-delimited paths, may not contain control characters/backslashes/empty or dot segments, must fit within the Workers KV key limit, and may not enter the reserved Terraform namespace.

Public HTML/text-edit responses use `Cache-Control: no-store` so the editor observes current sandbox values instead of a shared public cache.

Malformed file path encoding must produce a bounded client response, never an uncaught decode exception.

## Deployment

Production deployment authority lives in `xd-dash/huram-abi-master`, not this repository.

Current Custom Domains:

```text
kv.dashxd.com
firekv.dashxd.com
```

Both domains point directly to the same FireKV Worker. A Workers Custom Domain routes all paths on that hostname to the Worker, so there is no static-asset bypass and no `run_worker_first` setting to rely on. FireKV has no Workers Static Assets binding.

Production deployment must:

1. qualify the exact FireKV source revision locally;
2. deploy the exact Worker with the dedicated `FILES` KV binding, GitHub policy bindings, and secret session signing key;
3. bind both exact Custom Domains and keep `workers.dev`/previews disabled;
4. wait only until the Worker is reachable through the Custom Domains;
5. run the minimal production smoke described below;
6. stop after success and revoke temporary deployment authority.

Do not turn DNS records, TLS issuance, Custom Domain control-plane details, or Cloudflare propagation into independent release gates. A successful HTTPS request reaching FireKV already proves those layers sufficiently for this sandbox. Deeper Cloudflare inventory/diagnostics are troubleshooting tools invoked after a simple smoke fails.

A deploy may rotate `FIREKV_SESSION_SECRET`; doing so invalidates outstanding FireKV capabilities. This is acceptable for the sandbox release process.

## Qualification

Repository CI covers:

```text
locked install
unit/edge tests
TypeScript strict check
Wrangler dry-run
```

The normal production acceptance test is deliberately small and compositional:

```text
1. GET /tfstate/<scope> anonymously -> 401 + Cache-Control: no-store
2. exchange one real GitHub Actions OIDC assertion -> scoped FireKV credential
3. terraform init/apply writes remote state
4. remove local .terraform state and perform a fresh terraform init
5. recover the expected state/output from FireKV
6. one different-scope request with the same capability -> 401
```

That proves the properties this sandbox needs: the Worker is the HTTP boundary, tfstate is not publicly readable/cacheable, authentication works, scope isolation works, and state reaches/re-enters Terraform from Workers KV.

Do not separately gate on DNS appearance, TLS status, Custom Domain internals, inventory snapshots, history cleanup, or repeated alias checks after the compositional smoke succeeds. Those may be used for diagnosis, not routine qualification.

The public text smoke should separately prove one text create/edit round trip and one rejected multipart request. It does not require Terraform/OIDC credentials because the public surface is intentionally public.
