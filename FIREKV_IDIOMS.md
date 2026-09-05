# FireKV idioms

This file is the maintenance contract for `xd-dash/firekv`. FireKV is intentionally a small authenticated object/state service. The primary production use in this sandbox phase is Terraform HTTP remote state backed by Cloudflare Workers KV.

## Roles

```text
Huram ABI
  owns exact deployment policy, Cloudflare authority, Custom Domains,
  production bindings, and exact-candidate qualification

auth.net.im
  owns GitHub Actions OIDC verification and workload-policy semantics

FireKV
  owns FireKV capability issuance, Terraform HTTP state protocol,
  state-key layout, history, and public raw-string file behavior

Cloudflare Worker
  hosts FireKV

Workers KV
  stores opaque values

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

Do not add a custom Terraform provider/backend plugin merely to use FireKV.

Storage layout:

```text
terraform/<scope>/terraform.tfstate
terraform/<scope>/history/<revision>.tfstate
```

State is opaque bytes. FireKV must not parse, rewrite, merge, normalize, or infer Terraform state semantics.

Every successful POST writes a history revision and then the current state. DELETE archives the current state when present before deleting it.

Scopes are canonical slash-delimited ASCII paths. Empty segments, `.` segments, `..` segments, malformed percent encoding, and overlong scopes are rejected. Keep enough headroom under Workers KV's 512-byte key limit for the longest history key.

Workers KV values are limited to 25 MiB. Reject an oversized Terraform state before attempting KV persistence when possible, and verify the buffered size before `put()`.

## Sandbox consistency model

Workers KV is eventually consistent and is not a coordination primitive. That limitation is accepted for this sandbox environment.

The operational invariant is:

```text
one active Terraform writer per exact state scope
```

FireKV deliberately does not advertise `lock_address` / `unlock_address`, and it must not implement a fake lock using KV read-then-write state.

Concurrent writers may race, and propagation may be stale across locations. History is recovery/audit material; it is not locking, compare-and-swap, or transaction state.

Cloudflare also rate-limits writes to the same KV key. Avoid rapid repeated writes to one state scope. Terraform retry behavior may absorb transient failures, but FireKV must not pretend this is strongly consistent state storage.

When the sandbox requires stronger semantics, move state coordination to a strongly consistent primitive (for example a Durable Object or another backend) rather than layering ad-hoc mutex semantics on Workers KV.

## Public file surface

`/` and `/file/*` remain the simple raw-string file surface. They may never expose or mutate keys under the reserved `terraform/` prefix.

Malformed file path encoding must produce a bounded client response, never an uncaught decode exception.

If the public file surface later needs authentication, compose a separate explicit policy. Do not couple Terraform capability auth to browser editing by accident.

## Deployment

Production deployment authority lives in `xd-dash/huram-abi-master`, not this repository.

Current intended Custom Domains:

```text
kv.dashxd.com
firekv.dashxd.com
```

Both domains point directly to the same FireKV Worker. A Cloudflare Workers Custom Domain routes all paths on that hostname to the Worker, so there is no static-asset bypass and no `run_worker_first` setting to rely on. FireKV currently has no Workers Static Assets binding.

Production deployment must:

1. qualify an exact FireKV commit;
2. mint a least-privilege Cloudflare child token from Huram's master token;
3. ensure the dedicated Workers KV namespace exists;
4. upload the exact Worker module with the `FILES` KV binding and GitHub policy bindings;
5. supply `FIREKV_SESSION_SECRET` as secret material, never source/regular vars;
6. bind both exact Custom Domains;
7. disable `workers.dev` and preview URLs;
8. verify both control-plane bindings and HTTPS behavior;
9. verify unauthenticated `/auth/github-oidc` is rejected;
10. use a real GitHub Actions OIDC assertion to mint a FireKV capability and perform a Terraform state round trip;
11. revoke the deployment child token.

A deploy may rotate `FIREKV_SESSION_SECRET`; doing so invalidates outstanding FireKV capabilities. This is acceptable for the sandbox release process but must be revisited before long-lived production sessions are expected.

## Qualification

Repository CI must cover:

```text
locked install
FireKV unit/edge tests
TypeScript strict check
Wrangler dry-run
```

Huram deployment qualification must additionally cover:

```text
exact FireKV SHA
exact auth.net.im SHA pinned by FireKV
real GitHub OIDC/JWKS verification
exact deployment policy
local exact Worker smoke before production mutation
Terraform apply + fresh init recovery
cross-scope capability rejection
production Custom Domain control plane
production HTTPS auth boundary
production Terraform remote-state round trip
```

Do not promote a candidate solely because the Worker uploaded successfully.
