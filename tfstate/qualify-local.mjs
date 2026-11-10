import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.dirname(root);
const production = JSON.parse(await (await import('node:fs/promises')).readFile(path.join(root, 'wrangler.jsonc'), 'utf8'));
const wrangler = path.join(packageRoot, 'node_modules/wrangler/bin/wrangler.js');
const temp = await mkdtemp(path.join(os.tmpdir(), 'firekv-local-'));
const persist = path.join(temp, 'kv');
const host = 'tfstate.local.test';
const scope = 'qualification/firekv/terraform';
const secret = randomBytes(48).toString('base64url');
const children = new Set();
let proxy;

async function cleanup() {
  if (proxy) {
    const server = proxy;
    proxy = undefined;
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
  for (const child of children) await stop(child);
  await rm(temp, { recursive: true, force: true });
}
for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
  process.once(signal, () => { cleanup().finally(() => process.exit(code)); });
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const runEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !/TOKEN|SECRET|PASSWORD|CREDENTIAL|^CLOUDFLARE_|^CF_|^GOOGLE_|^TF_HTTP_/.test(key)));
Object.assign(runEnv, { CI: '1', WRANGLER_SEND_METRICS: 'false', FORCE_COLOR: '0' });

async function freePort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function stop(child) {
  if (!children.has(child)) return;
  const exited = child.exitCode !== null || child.signalCode !== null;
  const done = exited ? Promise.resolve() : once(child, 'exit');
  try { process.kill(-child.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  const timeout = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 5000);
  try { await done; } finally { clearTimeout(timeout); children.delete(child); }
}

function request(port, pathname, method = 'GET', body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: '127.0.0.1', port, path: pathname, method,
      rejectUnauthorized: false, headers: { host, ...extraHeaders }, timeout: 5000,
    }, res => {
      const chunks = [];
      res.on('data', data => chunks.push(data));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(Error('Local request timeout')));
    req.end(body);
  });
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw Error(name + ' must be configured for real GitHub OIDC qualification');
  return value;
}

async function start() {
  const port = await freePort();
  const vars = {};
  for (const name of [
    'GITHUB_AUDIENCE', 'GITHUB_OWNER', 'GITHUB_OWNER_ID',
    'GITHUB_REPOSITORIES', 'GITHUB_REPOSITORY_IDS', 'GITHUB_REFS',
    'GITHUB_WORKFLOW_PREFIX',
  ]) vars[name] = required(name);
  const config = {
    name: 'firekv-tfstate-local',
    main: path.join(root, 'worker.mjs'),
    compatibility_date: production.compatibility_date,
    workers_dev: false,
    preview_urls: false,
    kv_namespaces: [{ binding: 'TFSTATE', id: '11111111111111111111111111111111', remote: false }],
    vars,
  };
  const configPath = path.join(temp, 'wrangler.json');
  await writeFile(configPath, JSON.stringify(config));
  await writeFile(path.join(temp, '.dev.vars'),
    'FIREKV_SESSION_SECRET=' + secret + '\nFIREKV_SESSION_TTL_SECONDS=3600\n');
  const child = spawn(process.execPath, [wrangler, 'dev', '--config', configPath,
    '--local', '--ip', '127.0.0.1', '--port', String(port), '--inspector-port', '0',
    '--local-protocol', 'https', '--local-upstream', host, '--upstream-protocol', 'https',
    '--persist-to', persist, '--latest=false', '--show-interactive-dev-session=false'],
  { cwd: temp, env: runEnv, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  let logs = '';
  child.stdout.on('data', value => { logs = (logs + value).slice(-12000); });
  child.stderr.on('data', value => { logs = (logs + value).slice(-12000); });
  child.on('error', error => { logs += error.message; });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null || child.signalCode !== null) break;
    try {
      const response = await request(port, '/tfstate/readiness');
      if (response.status === 401) return { port, child };
    } catch {}
    await delay(200);
  }
  await stop(child);
  throw Error('Wrangler failed readiness:\n' + logs);
}

async function mintCapability(port, requestedScope) {
  const url = new URL(required('ACTIONS_ID_TOKEN_REQUEST_URL'));
  url.searchParams.set('audience', required('GITHUB_AUDIENCE'));
  const response = await fetch(url, {
    headers: { authorization: 'Bearer ' + required('ACTIONS_ID_TOKEN_REQUEST_TOKEN') },
  });
  if (!response.ok) throw Error('GitHub OIDC token request failed with status ' + response.status);
  const oidc = (await response.json()).value;
  if (!oidc) throw Error('GitHub OIDC token response had no value');
  const minted = await request(port, '/auth/github-oidc', 'POST',
    JSON.stringify({ scope: requestedScope }),
    { authorization: 'Bearer ' + oidc, 'content-type': 'application/json' });
  assert.equal(minted.status, 200, minted.body.toString());
  const result = JSON.parse(minted.body.toString());
  assert.equal(result.scope, requestedScope);
  assert.equal(result.username, 'firekv');
  return result;
}

function passed(name) { console.log('PASS ' + name); }

async function terraform(port, credentials) {
  if (!process.env.TERRAFORM_BIN) throw Error('TERRAFORM_BIN must identify a real Terraform executable');
  proxy = http.createServer((req, res) => {
    const upstream = https.request({
      hostname: '127.0.0.1', port, path: req.url, method: req.method,
      rejectUnauthorized: false, headers: { ...req.headers, host }, timeout: 5000,
    }, response => {
      res.writeHead(response.statusCode, response.headers);
      response.pipe(res);
    });
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    upstream.on('timeout', () => upstream.destroy(Error('Local upstream timeout')));
    req.pipe(upstream);
  });
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  const directory = path.join(temp, 'terraform');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(directory);
  await writeFile(path.join(directory, 'main.tf'),
    'terraform {\n  backend "http" {}\n}\noutput "qualification" {\n  value = "private-firekv-local"\n}\n');
  const env = {
    ...runEnv,
    TF_IN_AUTOMATION: '1',
    CHECKPOINT_DISABLE: '1',
    TF_HTTP_ADDRESS: 'http://127.0.0.1:' + proxy.address().port + '/tfstate/' + scope,
    TF_HTTP_USERNAME: credentials.username,
    TF_HTTP_PASSWORD: credentials.password,
    TF_HTTP_RETRY_WAIT_MIN: '1',
  };
  const command = args => new Promise((resolve, reject) => {
    const child = spawn(process.env.TERRAFORM_BIN, args, { cwd: directory, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { output += data; });
    child.on('error', reject);
    const timer = setTimeout(() => child.kill('SIGKILL'), 30000);
    child.on('exit', code => {
      clearTimeout(timer);
      code === 0 ? resolve(output.trim()) : reject(Error('Terraform ' + args[0] + ' failed: ' + output));
    });
  });
  await command(['init', '-input=false', '-reconfigure', '-no-color']);
  await command(['apply', '-input=false', '-auto-approve', '-no-color']);
  assert.equal(await command(['output', '-raw', 'qualification']), 'private-firekv-local');
  const original = JSON.parse(await command(['state', 'pull']));
  await rm(path.join(directory, '.terraform'), { recursive: true, force: true });
  await command(['init', '-input=false', '-reconfigure', '-no-color']);
  assert.equal(await command(['output', '-raw', 'qualification']), 'private-firekv-local');
  const restored = JSON.parse(await command(['state', 'pull']));
  assert.equal(restored.lineage, original.lineage);
  assert.equal(restored.serial, original.serial);
  passed('real Terraform HTTP apply and fresh-init state recovery using FireKV capability');
  await new Promise(resolve => proxy.close(resolve));
  proxy = undefined;
}

try {
  const runtime = await start();
  const credentials = await mintCapability(runtime.port, scope);
  const authorization = 'Basic ' + Buffer.from(credentials.username + ':' + credentials.password).toString('base64');

  assert.equal((await request(runtime.port, '/')).status, 404);
  assert.equal((await request(runtime.port, '/file/terraform%2Fdns%2Fprod')).status, 404);
  assert.equal((await request(runtime.port, '/tfstate/' + scope)).status, 401);
  assert.equal((await request(runtime.port, '/tfstate/' + scope, 'GET', undefined,
    { authorization: 'Bearer ' + credentials.password })).status, 401);
  assert.equal((await request(runtime.port, '/tfstate/qualification/firekv/other', 'GET', undefined,
    { authorization })).status, 401);
  assert.equal((await request(runtime.port, '/auth/github-oidc', 'POST', '{}',
    { authorization })).status, 401);
  passed('GitHub OIDC exchanges only at the auth route; scoped capability protects state routes');

  const bytes = Buffer.from([0, 255, 123, 125, 10]);
  assert.equal((await request(runtime.port, '/tfstate/' + scope, 'POST', bytes, { authorization })).status, 200);
  let response = await request(runtime.port, '/tfstate/' + scope, 'GET', undefined, { authorization });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, bytes);
  passed('owner opaque-byte state round-trip through workerd local KV');

  await terraform(runtime.port, credentials);
  await stop(runtime.child);

  const restarted = await start();
  response = await request(restarted.port, '/tfstate/' + scope, 'GET', undefined, { authorization });
  assert.equal(response.status, 200);
  const restored = JSON.parse(response.body.toString());
  assert.equal(restored.outputs.qualification.value, 'private-firekv-local');
  assert.equal((await request(restarted.port, '/tfstate/' + scope, 'DELETE', undefined, { authorization })).status, 200);
  assert.equal((await request(restarted.port, '/tfstate/' + scope, 'GET', undefined, { authorization })).status, 404);
  passed('state survives a fresh workerd process and deletes without history keys');
  await stop(restarted.child);

  const evidence = {
    schema: 1,
    kind: 'firekv-tfstate-local',
    result: 'passed',
    source_sha: process.env.SOURCE_SHA ?? null,
    harness_sha: process.env.HARNESS_SHA ?? null,
    request_blob: process.env.REQUEST_BLOB ?? null,
    github_run_id: process.env.GITHUB_RUN_ID ?? null,
    node: process.version,
    wrangler: JSON.parse(await (await import('node:fs/promises')).readFile(path.join(packageRoot, 'node_modules/wrangler/package.json'), 'utf8')).version,
    terraform: JSON.parse(execFileSync(process.env.TERRAFORM_BIN, ['version', '-json'], { env: { ...runEnv, CHECKPOINT_DISABLE: '1' } })).terraform_version,
    compatibility_date: production.compatibility_date,
    identity: 'real GitHub Actions OIDC verified by auth.net.im',
    storage: 'workerd local KV persisted between processes',
    backup: false,
    deployment: false,
  };
  if (process.env.EVIDENCE_FILE) {
    const { writeFile: save } = await import('node:fs/promises');
    await save(process.env.EVIDENCE_FILE, JSON.stringify(evidence, null, 2) + '\n');
  }
  console.log(JSON.stringify(evidence));
} finally {
  await cleanup();
}
