# firekv

A public Hono + Cloudflare Workers KV text editor inspired by the file-oriented idea in `joelnet/cloudflare-worker-website`, without copying its router or legacy Webpack workflow.

KV keys are treated as file paths and values as untrusted UTF-8 text. `/` lists keys. `/file/<key>/` embeds the current value into an HTML-escaped textarea. `/raw/<key>` returns the same value only as `text/plain; charset=utf-8` with `X-Content-Type-Options: nosniff`, a restrictive CSP, and `Cache-Control: no-store`.

Writes to `/file/<key>/` accept only `text/plain` with UTF-8 semantics, are limited to 256 KiB, reject malformed UTF-8 and NUL characters, and store server-owned text metadata rather than trusting request MIME metadata. Stored text is otherwise preserved exactly; strings such as `<script>alert(1)</script>` are valid text and are never interpreted as markup by the editor.

Save uses `fetch('./', { method: 'PUT' })`, so the relative browser URL re-enters the same Worker path and writes the edited string back to that KV key.

## Local CLI

```sh
npm ci
npx wrangler kv key put hello.txt 'hello from kv' --binding FILES --local --persist-to .wrangler/state
npm run dev
```

The placeholder KV namespace id is for local simulation; replace it with a real namespace id before deployment.
