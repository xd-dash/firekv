# FireKV design composition

FireKV does not own a parallel visual system.

Its public HTML imports the canonical vanilla design package from `xd-dash/dashxd.com` and pins that package to an exact Git commit. FireKV owns only its product-specific routes, forms, text values, and behavior.

## Public rendering

`src/public-ui.ts` composes:

```ts
import {
  escapeHtml,
  renderDocument,
  workerMetaFromRequest,
} from '@xd-dash/dashxd.com/design'
```

The canonical package supplies the centered shell, logo, palette, buttons, editors, GitHub footer, and Worker metadata formatting.

The public copy is deliberately minimal:

```text
firekv is eventually consistent
```

Terraform remains a protected API concern and is not advertised in the public editor UI.

## Request metadata

Footer metadata must be derived from the exact request that produces the HTML response. FireKV passes `c.req.raw` to the shared `workerMetaFromRequest` primitive during server rendering.

There is no `/meta` fetch and there should not be one. A second request could observe a different Cloudflare edge context.

Public HTML remains `Cache-Control: no-store` because it contains request-specific edge metadata and because editor views should not become stale.
