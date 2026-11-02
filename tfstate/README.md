# Private Terraform state Worker

This is a separate deployment from the public FireKV editor. Preferred hostname:
`tfstate.firekv.dashxd.com`. Workers Custom Domains support multi-level hostnames;
the existing `firekv.dashxd.com` exact-host binding does not conflict.

## Authority and isolation

Huram owns Cloudflare deployment and exact policy. Create a fresh KV namespace
named `firekv-tfstate`; bind it only to this Worker as `TFSTATE`. Never bind that
namespace to the public editor. Replace the zero namespace ID in a generated
deployment configuration, not with the public `FILES` namespace ID.

Deployment must supply `OWNER_EMAIL` (the owner's exact verified IdP email),
`ACCESS_AUD` (the Access application audience), and `STATE_HOST` (the exact
hostname). Missing settings fail closed. Do not guess the owner's email.

Configure an Access self-hosted application for the entire hostname, allowing
only the owner through the chosen identity provider. Do not add Everyone,
Bypass, or service-token policies. The Worker independently checks native
`ctx.access`, its audience, and the owner's email on every request. Spoofed
identity headers do not authenticate. Disable workers.dev and preview URLs.
There are no public editor routes, GitHub credential exchange, or public
Service Bindings. No credentials or state enter logs.

The Wrangler file intentionally has no live route or owner policy until Huram
provisions and verifies Access. Its zero namespace ID is not deployable state.
Bind the Custom Domain through a generated `routes` entry with
`{"pattern":"tfstate.firekv.dashxd.com","custom_domain":true}` only after
the Access application/policy exists. Verify anonymous and wrong-user requests
are denied before copying any state.

## Terraform protocol

`GET`, `POST`, and `DELETE /tfstate/<scope>` preserve opaque state bytes and
history under `terraform/<scope>/`. There is no compression or fake KV lock.
This is the existing sandbox consistency model: KV can return stale state even
with sequential writers. This split does not qualify KV for production state.
Keep GCS authoritative until a separate consistency/locking decision is made.

Terraform's HTTP backend does not perform an Access browser login. Before live
qualification, provide a local authenticated transport that logs the owner in
and attaches their Access authorization to each Terraform request. Do not
silently introduce a machine token to bypass the owner-only requirement.

## Cutover

1. Deploy exact source with a new namespace and owner-only Access policy.
2. Prove owner read/write/fresh-process recovery, wrong-user/anonymous denial,
   and denial through alternate hosts. Test exact-byte preservation with
   disposable state before introducing real state.
3. Inventory old FireKV and GCS state privately. Preserve object generations,
   lineage, serial, resource addresses, workspaces, and rollback copies.
4. Pause writers. Migrate each explicitly selected state and compare source and
   destination. Update all backend clients and leader remote-state readers.
5. Only after successful cutover, remove state/auth routes and state credentials
   from the public Worker. Preserve the reserved `terraform/` filter until old
   state has been safely removed from its namespace. Never expose legacy state
   by removing the filter during the split.

No active state is migrated by these source files. GCS and the legacy FireKV
state routes remain unchanged until deployment and cutover are verified.

## Checks

`node --test tfstate/worker.test.mjs`

For the full disposable local Wrangler/workerd proof:

```sh
cd tfstate
npm ci --ignore-scripts --no-audit --no-fund
TERRAFORM_BIN="$(command -v terraform)" npm run qualify-local
```

The local harness starts the exact production handler on loopback HTTPS with
Wrangler's native `access.dev` identities and a fresh local KV persistence
directory. It proves real Terraform HTTP apply/fresh-init recovery, exact-byte
storage, restart recovery, scope isolation, deletion, and read/write/delete
denial for anonymous, wrong-owner and wrong-audience profiles. Only the local
test client accepts the disposable self-signed certificate. No production auth
bypass is added. A loopback HTTP proxy adapts Terraform to that local certificate;
it is test infrastructure, not a production credential bridge.

No Cloudflare account/token, live Access application, GCS, or deployed Worker is
used. Native local Access simulation is not evidence of real IdP authentication
or deployed policy correctness. Local KV does not reproduce edge eventual
consistency. All child processes and temporary state are cleaned in finally.

From the repository root after the locked dependencies are installed:
`npx wrangler deploy --config tfstate/wrangler.jsonc --dry-run`

The tests use an in-memory KV double; they verify authorization and byte
handling, not real Access policy, distributed consistency, or deployment.
