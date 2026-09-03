# firekv

A public Hono + Cloudflare Workers KV file editor inspired by the file-oriented idea in `joelnet/cloudflare-worker-website`, without copying its router or legacy Webpack workflow.

KV keys are treated as file paths and values as raw strings. `/` lists keys. `/file/<key>/` embeds the current raw value in a server-rendered textarea. Save uses `fetch('./', { method: 'PUT' })`, so the relative browser URL re-enters the same Worker path and writes the edited string back to that KV key.

## Local CLI

```sh
npm ci
npx wrangler kv key put hello.txt 'hello from kv' --binding FILES --local --persist-to .wrangler/state
npm run dev
```

The placeholder KV namespace id is for local simulation; replace it with a real namespace id before deployment.
