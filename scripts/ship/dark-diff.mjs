#!/usr/bin/env node
/**
 * Dark-diff: the gate every hub push passes. It boots two releases of the hub on two copies of the
 * same data, drives both through the same requests, and reports every difference that the intended
 * file does not list.
 *
 *   node scripts/ship/dark-diff.mjs --base <ref> --head <ref> --data <dir> [--intended <json>]
 *        [--secrets] [--rollback] [--flows <dir>] [--out <report.json>] [--keep] [--json]
 *        [--repo <git dir>] [--node-modules <dir>] [--clock-start <iso>] [--no-inventory] [--fake-secrets]
 *
 * <ref> is any git revision of --repo (default: this checkout), or dir:<path> for a hub tree that is
 * already on disk. Each ref is checked out into a temp folder with a private git index (the repo's
 * own index, HEAD and work tree are never touched) and gets a link to --node-modules.
 *
 * The data dir is copied (never written): a prep copy gets a local admin password and a local Maker
 * host token (through the base release's own data modules), and base and head each run on their own
 * copy of it. Both boot in safe mode (HUB_SAFE_MODE=1) with the egress recorder in enforce mode and
 * an empty allowlist (loopback only), from an empty working folder with a temp HOME, so no .env and
 * nothing from the operator's home is read. Both start their clock at the same instant.
 *
 * Against each it runs:
 *   - the flows in scripts/ship/flows/*.json (requests with an auth role and a body; see the README
 *     there);
 *   - GET /api/hub/site-config by site key and by domain for every site in the data;
 *   - a fake clock moved over 24 hours through each tick route listed in flows/clock.json that the
 *     release has (a 404 means it has none);
 *   - the route inventory: every literal route of either release, without credentials, recorded only
 *     as 404 or not 404.
 * Then it compares the normalized responses (times, dates, ids and tokens become placeholders), the
 * safe-mode outbox (one row per mail, with its text), the route inventory and the data folders.
 *
 * --secrets   every file under secrets/ keeps its path and sha256 after boot and at the end, and no
 *             new secret file appears (a file the source lacks that base creates as well is shared,
 *             not a failure; intended.allowNewSecrets lists others).
 * --fake-secrets  a local copy of the live data has no secrets/ (they never leave the server): this
 *             fills the live layout (signing secret, Maker token, e-mail keys, webhook file) with
 *             random values in the copies, so --secrets checks that both releases read them as they are.
 * --rollback  boots base on the data head wrote (after its flows): base must boot in safe mode and
 *             serve the site configs, keep every field head wrote (only intended.rollbackLost may be
 *             lost) and leave every reserved key head wrote unchanged.
 *
 * The intended file: { "changes": [{ "kind": "response|site-config|tick|route|outbox|data|secret",
 * "match": "<glob over the difference key>", "reason": "…" }], "ignore": [ …same… ],
 * "allowNewSecrets": ["secrets/<name>"], "rollbackLost": ["rollback <file>:<path glob>"] }.
 *
 * Exit: 0 no unlisted difference, 1 unlisted differences or a failed secret/rollback check,
 * 2 the harness could not run (bad arguments, a boot failure, safe mode not on, changed source).
 * The report (--out) can hold excerpts of the data: keep it on the operator PC.
 */
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync,
  realpathSync, rmdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  canonical, classify, deepDiff, diffSnapshots, excerpt, extractRoutes, listFiles, loadIntended,
  makeTextScrubber, normalizeValue, probePath, rollbackLosses, secretManifest, secretViolations,
  snapshotData,
} from './dark-diff-lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(HERE, '..', '..');
export const DEFAULT_FLOWS = join(HERE, 'flows');
const EGRESS_AUDIT = join(REPO, 'scripts', 'safe-mode', 'egress-audit.cjs');
const CLOCK_PRELOAD = join(HERE, 'clock-preload.cjs');
const RUN_TAG = 'dd';
const ENV_PASSTHROUGH = ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'windir', 'WINDIR', 'ComSpec', 'COMSPEC', 'PATHEXT', 'SystemDrive', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'USERNAME', 'USERDOMAIN', 'LANG'];

export class HarnessError extends Error {}

/* ------------------------------------------------------------------ arguments */

export function parseArgs(argv = []) {
  const opts = { secrets: false, rollback: false, keep: false, json: false, inventory: true, flows: DEFAULT_FLOWS, repo: REPO };
  const value = (i, name) => {
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) throw new HarnessError(`${name} needs a value`);
    return next;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--base') opts.base = value(i++, arg);
    else if (arg === '--head') opts.head = value(i++, arg);
    else if (arg === '--data') opts.data = value(i++, arg);
    else if (arg === '--intended') opts.intended = value(i++, arg);
    else if (arg === '--flows') opts.flows = value(i++, arg);
    else if (arg === '--repo') opts.repo = value(i++, arg);
    else if (arg === '--node-modules') opts.nodeModules = value(i++, arg);
    else if (arg === '--out') opts.out = value(i++, arg);
    else if (arg === '--clock-start') opts.clockStart = value(i++, arg);
    else if (arg === '--secrets') opts.secrets = true;
    else if (arg === '--rollback') opts.rollback = true;
    else if (arg === '--keep') opts.keep = true;
    else if (arg === '--json') opts.json = true;
    else if (arg === '--no-inventory') opts.inventory = false;
    else if (arg === '--fake-secrets') opts.fakeSecrets = true;
    else if (arg === '--debug') opts.debug = true;
    else throw new HarnessError(`unknown option ${arg}`);
  }
  for (const name of ['base', 'head', 'data']) if (!opts[name]) throw new HarnessError(`--${name} is required`);
  return opts;
}

/* ------------------------------------------------------------------ trees */

function git(repo, args, env = {}) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/**
 * A hub tree for a ref: dir:<path> as it is, or a git revision checked out into `dest` through a
 * private index file (read-tree + checkout-index), so the repository's HEAD, index and work tree
 * stay as they are. Returns { dir, label, commit }.
 */
export function materializeRef(repo, ref, dest) {
  if (String(ref).startsWith('dir:')) {
    const dir = resolve(String(ref).slice(4));
    if (!existsSync(join(dir, 'server.js'))) throw new HarnessError(`${ref}: no server.js there`);
    return { dir, label: ref, commit: '', linked: false };
  }
  let commit;
  try {
    commit = git(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  } catch {
    throw new HarnessError(`${ref} is not a commit in ${repo}`);
  }
  mkdirSync(dest, { recursive: true });
  const index = join(dirname(dest), `${basename(dest)}.index`);
  git(repo, ['read-tree', commit], { GIT_INDEX_FILE: index });
  git(repo, ['checkout-index', '-a', '-f', `--prefix=${dest.split(sep).join('/')}/`], { GIT_INDEX_FILE: index });
  rmSync(index, { force: true });
  return { dir: dest, label: ref, commit, linked: false };
}

/** Links <tree>/node_modules to the dependency folder (a junction on Windows). */
export function linkNodeModules(tree, nodeModules) {
  const link = join(tree, 'node_modules');
  if (existsSync(link)) return false;
  symlinkSync(realpathSync(nodeModules), link, process.platform === 'win32' ? 'junction' : 'dir');
  return true;
}

/** Removes a link without touching what it points at; true when it is gone. */
export function removeLink(link) {
  let stat;
  try {
    stat = lstatSync(link);
  } catch {
    return true;
  }
  if (!stat.isSymbolicLink()) return false;
  try {
    unlinkSync(link);
  } catch {
    try { rmdirSync(link); } catch { /* checked below */ }
  }
  try {
    lstatSync(link);
    return false;
  } catch {
    return true;
  }
}

/* ------------------------------------------------------------------ processes */

export function freePort() {
  return new Promise((resolvePromise, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolvePromise(port));
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The env of every child: a short pass-through list, a temp HOME, safe mode, enforced egress, the shared clock. */
export function childEnv(run, extra = {}) {
  const env = {};
  for (const key of ENV_PASSTHROUGH) if (process.env[key] !== undefined) env[key] = process.env[key];
  return {
    ...env,
    HOME: run.home,
    USERPROFILE: run.home,
    APPDATA: join(run.home, 'AppData'),
    LOCALAPPDATA: join(run.home, 'AppData', 'Local'),
    TEMP: run.tmp,
    TMP: run.tmp,
    TMPDIR: run.tmp,
    TZ: 'UTC',
    HUB_SAFE_MODE: '1',
    HUB_LISTEN_HOST: '127.0.0.1',
    DATA_DIR: '',
    PERSIST_PRODUCTION_ENV: '0',
    NODE_OPTIONS: `--require=${run.egressAudit} --require=${run.clockPreload}`,
    EGRESS_AUDIT_FILE: join(run.home, 'egress.jsonl'),
    EGRESS_AUDIT_ALLOW: run.allowList,
    EGRESS_AUDIT_ENFORCE: '1',
    DARK_DIFF_CLOCK_START: String(run.clockStart),
    ...extra,
  };
}

function newRunFolder(root, label, shared) {
  const home = mkdtempSync(join(root, `${label}-`));
  const tmp = join(home, 'tmp');
  mkdirSync(tmp, { recursive: true });
  mkdirSync(join(home, 'AppData', 'Local'), { recursive: true });
  return { ...shared, home, tmp };
}

function runNodeScript(script, run, extraEnv, timeoutMs = 60_000) {
  const file = join(run.home, 'prep.mjs');
  writeFileSync(file, script);
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [file], { cwd: run.home, env: childEnv(run, extraEnv), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', reject);
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolvePromise(out);
      else reject(new HarnessError(`prep failed (exit ${code}): ${err.slice(-800)}`));
    });
  });
}

const PREP_SCRIPT = `
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const tree = process.env.DD_TREE;
const mod = (rel) => import(pathToFileURL(join(tree, ...rel.split('/'))).href);
const store = await mod('data/store.js');
const admin = await store.getAdmin();
const username = (admin && admin.username) || 'dark-diff-admin';
await store.setAdminCredentials(username, process.env.DD_ADMIN_PASSWORD);
let makerToken = '';
if (existsSync(join(tree, 'data', 'maker-hosts.js'))) {
  const hosts = await mod('data/maker-hosts.js');
  if (typeof hosts.createMakerHost === 'function') makerToken = hosts.createMakerHost({ label: 'dark-diff', createdBy: 'dark-diff' }).token;
}
process.stdout.write(JSON.stringify({ username, makerToken }));
`;

/** The secret files a live data dir holds (a copy of it never does: secrets stay on the server). */
export const LIVE_SECRET_LAYOUT = Object.freeze({
  'admin-secret': () => `${randomBytes(48).toString('hex')}\n`,
  'maker-callback-token': () => `${randomBytes(32).toString('hex')}\n`,
  'email-unsub-key': () => `${randomBytes(32).toString('hex')}\n`,
  'email-webhook-token': () => `${randomBytes(24).toString('hex')}\n`,
  'webhooks.json': () => `${JSON.stringify({ version: 1, fireflies: { secret: randomBytes(32).toString('hex'), token: randomBytes(24).toString('base64url'), acceptQueryToken: true, rotatedAt: new Date(0).toISOString(), lastVerified: null } }, null, 2)}\n`,
});

/** Fills the missing live secret files with random values (in a copy only). Returns the names added. */
export function addFakeSecrets(dataDir) {
  const dir = join(dataDir, 'secrets');
  mkdirSync(dir, { recursive: true });
  const added = [];
  for (const [name, make] of Object.entries(LIVE_SECRET_LAYOUT)) {
    if (existsSync(join(dir, name))) continue;
    writeFileSync(join(dir, name), make(), { mode: 0o600 });
    added.push(name);
  }
  return added;
}

/** Boots server.js of `tree` on `dataDir`; resolves once /api/health answers. */
async function bootHub(tree, dataDir, run, { timeoutMs = 120_000 } = {}) {
  const port = await freePort();
  const child = spawn(process.execPath, [join(tree, 'server.js')], {
    cwd: run.home,
    env: childEnv(run, { PORT: String(port), APP_DATA_DIR: dataDir }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  const keep = (chunk) => {
    log += chunk;
    if (log.length > 400_000) log = log.slice(-200_000);
  };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  let exited = null;
  child.on('exit', (code, signal) => { exited = { code, signal }; });
  const base = `http://127.0.0.1:${port}`;
  const started = Date.now();
  let health = null;
  while (!health && !exited && Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(3000) });
      if (res.ok) health = await res.json();
    } catch {
      await sleep(400);
    }
  }
  const hub = {
    base,
    port,
    child,
    health,
    log: () => log,
    async stop() {
      if (exited) return;
      child.kill('SIGTERM');
      for (let i = 0; i < 25 && !exited; i += 1) await sleep(200);
      if (!exited) child.kill('SIGKILL');
      for (let i = 0; i < 25 && !exited; i += 1) await sleep(200);
    },
  };
  if (!health) {
    await hub.stop();
    throw new HarnessError(`the hub in ${tree} did not answer /api/health (${exited ? `exit ${exited.code ?? exited.signal}` : 'timeout'}): ${log.slice(-1500)}`);
  }
  if (health.safeMode !== true) {
    await hub.stop();
    throw new HarnessError(`the hub in ${tree} did not start in safe mode; nothing was run against it`);
  }
  return hub;
}

/** Waits until no file in the data dir changes for `quietMs` (at most `maxMs`). */
async function settle(dataDir, { quietMs = 1200, maxMs = 20_000 } = {}) {
  const signature = () => {
    const parts = [];
    for (const rel of listFiles(dataDir)) {
      try {
        const stat = statSync(join(dataDir, ...rel.split('/')));
        parts.push(`${rel}:${stat.size}:${stat.mtimeMs}`);
      } catch {
        parts.push(`${rel}:gone`);
      }
    }
    return parts.join('|');
  };
  const started = Date.now();
  let last = signature();
  let quietSince = Date.now();
  while (Date.now() - started < maxMs) {
    await sleep(300);
    const now = signature();
    if (now !== last) {
      last = now;
      quietSince = Date.now();
    } else if (Date.now() - quietSince >= quietMs) {
      return true;
    }
  }
  return false;
}

/* ------------------------------------------------------------------ requests and flows */

async function request(hub, { method = 'GET', path, headers = {}, body }) {
  const init = { method, headers: { ...headers }, redirect: 'manual', signal: AbortSignal.timeout(60_000) };
  if (body !== undefined && method !== 'GET' && method !== 'HEAD') {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  try {
    const res = await fetch(`${hub.base}${path}`, init);
    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = undefined;
    }
    return { status: res.status, json, text, contentType: String(res.headers.get('content-type') || '').split(';')[0] };
  } catch (error) {
    return { status: 0, json: undefined, text: `request failed: ${error?.message || error}`, contentType: '' };
  }
}

const VAR_RE = /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g;

function fill(value, vars) {
  if (typeof value === 'string') {
    const whole = value.match(/^\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}$/);
    if (whole && vars[whole[1]] !== undefined && typeof vars[whole[1]] !== 'string') return vars[whole[1]];
    return value.replace(VAR_RE, (_, name) => (vars[name] === undefined ? `{{${name}}}` : String(vars[name])));
  }
  if (Array.isArray(value)) return value.map((item) => fill(item, vars));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v, vars)]));
  return value;
}

function missingVars(value, vars, out = new Set()) {
  if (typeof value === 'string') {
    for (const [, name] of value.matchAll(VAR_RE)) {
      if (vars[name] === undefined) out.add(name);
    }
  } else if (Array.isArray(value)) {
    value.forEach((item) => missingVars(item, vars, out));
  } else if (value && typeof value === 'object') {
    Object.values(value).forEach((item) => missingVars(item, vars, out));
  }
  return out;
}

/** A dot path into a response ({ status, body, text }): body.client.id, body.meetings.0.meetingId. */
export function pick(response, path) {
  let node = { status: response.status, body: response.json, text: response.text };
  for (const part of String(path).split('.')) {
    if (node === null || node === undefined) return undefined;
    node = node[part];
  }
  return node;
}

export function loadFlows(dir) {
  if (!existsSync(dir)) throw new HarnessError(`no flows folder at ${dir}`);
  const flows = [];
  let clock = { ticks: [], hours: 24, stepMinutes: 60 };
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.json')).sort()) {
    const parsed = JSON.parse(readFileSync(join(dir, name), 'utf8'));
    if (name === 'clock.json') clock = { ...clock, ...parsed };
    else flows.push({ file: name, name: parsed.name || name.replace(/\.json$/, ''), steps: Array.isArray(parsed.steps) ? parsed.steps : [] });
  }
  return { flows, clock };
}

function authHeaders(auth, vars, credentials) {
  const role = String(auth || 'none');
  if (role === 'none') return {};
  if (role === 'admin') return credentials.adminToken ? { authorization: `Bearer ${credentials.adminToken}` } : {};
  if (role === 'maker') return credentials.makerToken ? { 'x-maker-host-token': credentials.makerToken } : {};
  if (role.startsWith('bearer:')) {
    const token = vars[role.slice(7)];
    return token ? { authorization: `Bearer ${token}` } : {};
  }
  throw new HarnessError(`unknown auth role ${role}`);
}

async function runFlows(hub, flows, credentials, normalize, dataDir) {
  const results = [];
  for (const flow of flows) {
    const vars = { run: RUN_TAG };
    for (let i = 0; i < flow.steps.length; i += 1) {
      const step = flow.steps[i];
      const key = `${flow.name}#${i}`;
      if (step.settle) {
        await settle(dataDir, { maxMs: Number(step.settle) || 10_000 });
        continue;
      }
      const missing = [...missingVars([step.path, step.body, step.headers], vars)];
      if (step.auth && String(step.auth).startsWith('bearer:') && vars[String(step.auth).slice(7)] === undefined) missing.push(String(step.auth).slice(7));
      if (missing.length) {
        results.push({ key, name: step.name || '', method: step.method || 'GET', path: step.path, skipped: `missing ${missing.join(', ')}` });
        continue;
      }
      const res = await request(hub, {
        method: String(step.method || 'GET').toUpperCase(),
        path: fill(step.path, vars),
        headers: { ...fill(step.headers || {}, vars), ...authHeaders(step.auth, vars, credentials) },
        body: step.body === undefined ? undefined : fill(step.body, vars),
      });
      for (const [name, path] of Object.entries(step.save || {})) {
        const value = pick(res, path);
        if (value !== undefined && value !== null && value !== '') vars[name] = value;
      }
      const expect = Array.isArray(step.expect) ? step.expect : step.expect ? [step.expect] : null;
      results.push({
        key,
        name: step.name || '',
        method: String(step.method || 'GET').toUpperCase(),
        path: step.path,
        status: res.status,
        body: res.json !== undefined ? normalize(res.json) : normalize(res.text.slice(0, 20_000)),
        ...(expect && !expect.includes(res.status) ? { unexpected: `wanted ${expect.join('/')}, got ${res.status}` } : {}),
      });
    }
  }
  return results;
}

function readSites(dataDir) {
  try {
    const raw = JSON.parse(readFileSync(join(dataDir, 'sites.json'), 'utf8'));
    return (Array.isArray(raw) ? raw : Array.isArray(raw?.sites) ? raw.sites : []).filter((site) => site && typeof site === 'object');
  } catch {
    return [];
  }
}

async function siteConfigProbes(hub, sites, normalize) {
  const out = [];
  for (let i = 0; i < sites.length; i += 1) {
    const site = sites[i];
    // Never the key itself in a report: the site is named by its domain or its position.
    const label = String(site.domain || '').trim() || `site#${i}`;
    if (site.site_key) {
      const res = await request(hub, { path: `/api/hub/site-config?site_key=${encodeURIComponent(site.site_key)}` });
      out.push({ key: `${label} by-key`, status: res.status, body: normalize(res.json ?? res.text.slice(0, 5000)) });
    }
    if (site.domain) {
      const res = await request(hub, { path: `/api/hub/site-config?domain=${encodeURIComponent(site.domain)}` });
      out.push({ key: `${label} by-domain`, status: res.status, body: normalize(res.json ?? res.text.slice(0, 5000)) });
    }
  }
  return out;
}

async function clockTicks(hub, clock, credentials, normalize, startMs) {
  const out = [];
  const stepMs = Math.max(1, Number(clock.stepMinutes) || 60) * 60_000;
  const count = Math.round(((Number(clock.hours) || 24) * 3_600_000) / stepMs);
  for (const tick of clock.ticks || []) {
    const method = String(tick.method || 'POST').toUpperCase();
    const headers = authHeaders(tick.auth || 'admin', {}, credentials);
    const first = await request(hub, { method, path: tick.path, headers, body: fill(tick.body || {}, { clock: new Date(startMs).toISOString(), clockMs: startMs }) });
    out.push({ key: `${method} ${tick.path} #0`, status: first.status, body: normalize(first.json ?? first.text.slice(0, 2000)) });
    if (first.status === 404) continue;
    for (let k = 1; k <= count; k += 1) {
      const at = startMs + k * stepMs;
      const res = await request(hub, { method, path: tick.path, headers, body: fill(tick.body || {}, { clock: new Date(at).toISOString(), clockMs: at }) });
      out.push({ key: `${method} ${tick.path} #${k}`, status: res.status, body: normalize(res.json ?? res.text.slice(0, 2000)) });
    }
  }
  return out;
}

/**
 * Every route answered without credentials: 'absent' for a 404 or for the catch-all page that an
 * unknown GET path gets (the app shell), 'present' for anything else. A route that is switched off
 * and answers 404 therefore reads like a route that does not exist.
 */
async function routeInventory(hub, routes) {
  const out = {};
  const signature = (res) => `${res.status}:${res.text.length}:${res.text.slice(0, 200)}`;
  const fallbacks = new Set();
  for (const path of ['/dark-diff-unknown-page', '/api/dark-diff-unknown-route']) {
    fallbacks.add(signature(await request(hub, { path })));
  }
  for (const route of routes) {
    const res = await request(hub, { method: route.method, path: probePath(route.path), body: route.method === 'GET' || route.method === 'DELETE' ? undefined : {} });
    if (res.status === 0) out[`${route.method} ${route.path}`] = 'no answer';
    else if (res.status === 404 || (route.method === 'GET' && fallbacks.has(signature(res)))) out[`${route.method} ${route.path}`] = 'absent';
    else out[`${route.method} ${route.path}`] = 'present';
  }
  return out;
}

function readOutbox(dataDir, normalize) {
  const index = join(dataDir, 'outbox', 'index.jsonl');
  if (!existsSync(index)) return [];
  const rows = [];
  for (const line of readFileSync(index, 'utf8').split('\n').filter(Boolean)) {
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    let body = {};
    try {
      body = JSON.parse(readFileSync(join(dataDir, 'outbox', String(row.day || ''), `${row.id}.body.json`), 'utf8'));
    } catch {
      body = {};
    }
    const { id, at, day, size, ...meta } = row;
    rows.push(normalize({ ...meta, text: String(body.text || ''), html: String(body.html || '') }));
  }
  return rows.sort((a, b) => (canonical(a) < canonical(b) ? -1 : 1));
}

/* ------------------------------------------------------------------ one side */

async function runSide({ label, tree, dataDir, run, flows, clock, credentials, routes, inventory, secretRef }) {
  const sideRun = newRunFolder(run.root, label, run.shared);
  const scrub = makeTextScrubber([[dataDir, '<data>'], [tree, '<tree>'], [sideRun.home, '<run>']]);
  const normalize = (value) => normalizeValue(value, { scrub });
  const hub = await bootHub(tree, dataDir, sideRun);
  const result = { label, scrub };
  try {
    await settle(dataDir, { quietMs: 800, maxMs: 8000 });
    if (secretRef) result.secretsAfterBoot = secretManifest(dataDir);
    const login = await request(hub, { method: 'POST', path: '/api/admin/login', body: { username: credentials.username, password: credentials.password } });
    const sideCredentials = { adminToken: login.json?.token || '', makerToken: credentials.makerToken };
    if (!sideCredentials.adminToken) throw new HarnessError(`${label}: the prepared admin could not sign in (HTTP ${login.status})`);
    result.flows = await runFlows(hub, flows, sideCredentials, normalize, dataDir);
    await settle(dataDir);
    result.siteConfig = await siteConfigProbes(hub, readSites(dataDir), normalize);
    result.ticks = await clockTicks(hub, clock, sideCredentials, normalize, run.shared.clockStart);
    result.inventory = inventory ? await routeInventory(hub, routes) : {};
    await settle(dataDir);
    if (secretRef) result.secretsAtEnd = secretManifest(dataDir);
    result.outbox = readOutbox(dataDir, normalize);
    result.logTail = hub.log().slice(-4000);
  } finally {
    await hub.stop();
  }
  // The egress recorder refused every connection that was not to this machine.
  try {
    const rows = readFileSync(join(sideRun.home, 'egress.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
    result.egress = { recorderRan: rows.some((row) => row.event === 'audit-start'), refused: rows.filter((row) => row.blocked).length, hosts: [...new Set(rows.filter((row) => row.blocked).map((row) => row.host))].sort() };
  } catch {
    result.egress = { recorderRan: false, refused: 0, hosts: [] };
  }
  if (!result.egress.recorderRan) throw new HarnessError(`${label}: the egress recorder did not run inside the hub; nothing can be trusted`);
  return result;
}

/* ------------------------------------------------------------------ comparisons */

function compareRecords(kind, base, head) {
  const diffs = [];
  const index = (list) => new Map(list.map((row) => [row.key, row]));
  const a = index(base);
  const b = index(head);
  for (const key of [...new Set([...a.keys(), ...b.keys()])]) {
    const x = a.get(key);
    const y = b.get(key);
    const label = x ? `${x.method ? `${x.method} ` : ''}${x.path ? `${x.path} ` : ''}`.trim() : y ? `${y.method ? `${y.method} ` : ''}${y.path ? `${y.path} ` : ''}`.trim() : '';
    const prefix = `${kind} ${key}${label ? ` ${label}` : ''}`;
    if (!x || !y) {
      diffs.push({ kind, key: prefix, detail: x ? 'only in base' : 'only in head' });
      continue;
    }
    if ((x.skipped || '') !== (y.skipped || '')) {
      diffs.push({ kind, key: `${prefix} skipped`, detail: 'skipped on one side', base: x.skipped || '(ran)', head: y.skipped || '(ran)' });
      continue;
    }
    if (x.status !== y.status) diffs.push({ kind, key: `${prefix} status`, detail: 'status differs', base: String(x.status), head: String(y.status) });
    for (const d of deepDiff(x.body, y.body, 'body', [], 30)) diffs.push({ kind, key: `${prefix} ${d.path}`, detail: 'response differs', base: d.base, head: d.head });
  }
  return diffs;
}

function compareInventory(base, head) {
  const diffs = [];
  for (const route of [...new Set([...Object.keys(base), ...Object.keys(head)])].sort()) {
    const a = base[route] ?? '(not probed)';
    const b = head[route] ?? '(not probed)';
    if (a !== b) diffs.push({ kind: 'route', key: `route ${route}`, detail: 'answers differently', base: a, head: b });
  }
  return diffs;
}

function compareOutbox(base, head) {
  const diffs = [];
  const count = (list) => {
    const map = new Map();
    for (const row of list) {
      const text = canonical(row);
      map.set(text, { row, n: (map.get(text)?.n || 0) + 1 });
    }
    return map;
  };
  const a = count(base);
  const b = count(head);
  for (const text of new Set([...a.keys(), ...b.keys()])) {
    const na = a.get(text)?.n || 0;
    const nb = b.get(text)?.n || 0;
    if (na === nb) continue;
    const row = (a.get(text) || b.get(text)).row;
    diffs.push({ kind: 'outbox', key: `outbox ${row.subject || '(no subject)'} to ${(row.to || []).join(',') || '(nobody)'}`, detail: `${na} in base, ${nb} in head`, base: String(na), head: String(nb) });
  }
  return diffs;
}

/* ------------------------------------------------------------------ the run */

function sourceFingerprint(dir) {
  return listFiles(dir).map((rel) => {
    const stat = statSync(join(dir, ...rel.split('/')));
    return `${rel}:${stat.size}:${Math.round(stat.mtimeMs)}`;
  }).join('\n');
}

function copyData(from, to) {
  cpSync(from, to, { recursive: true, dereference: false, preserveTimestamps: true });
}

/**
 * Every JSON data file, parsed. The outbox and backups/ are left out: backups/ holds the hub's own
 * rotating copies of its files, and every release prunes the oldest of them at boot.
 */
function parseJsonFiles(dir) {
  const out = {};
  for (const rel of listFiles(dir)) {
    if (!rel.endsWith('.json') || rel.startsWith('outbox/') || rel.startsWith('backups/')) continue;
    try {
      out[rel] = JSON.parse(readFileSync(join(dir, ...rel.split('/')), 'utf8'));
    } catch {
      /* not JSON: compared as files elsewhere */
    }
  }
  return out;
}

/**
 * Runs the whole comparison. Returns the report; never throws for a difference (only a
 * HarnessError when it cannot run).
 */
export async function runDarkDiff(options) {
  const opts = { flows: DEFAULT_FLOWS, repo: REPO, inventory: true, ...options };
  const source = resolve(String(opts.data || ''));
  if (!existsSync(source) || !statSync(source).isDirectory()) throw new HarnessError(`--data ${source} is not a folder`);
  const intended = loadIntended(opts.intended ? resolve(opts.intended) : '');
  const { flows, clock } = loadFlows(resolve(opts.flows));
  const nodeModules = resolve(opts.nodeModules || join(opts.repo, 'node_modules'));
  if (!existsSync(nodeModules)) throw new HarnessError(`no dependency folder at ${nodeModules} (pass --node-modules)`);
  const clockStart = opts.clockStart ? Date.parse(opts.clockStart) : Math.floor(Date.now() / 3_600_000) * 3_600_000;
  if (!Number.isFinite(clockStart)) throw new HarnessError('--clock-start is not a date');

  const root = mkdtempSync(join(tmpdir(), 'dark-diff-'));
  const links = [];
  const report = { base: opts.base, head: opts.head, startedAt: new Date().toISOString(), clockStart: new Date(clockStart).toISOString(), warnings: [] };
  const before = sourceFingerprint(source);
  try {
    // Shared files for every child, in a temp folder (no spaces in the path NODE_OPTIONS quotes).
    const sharedDir = join(root, 'shared');
    mkdirSync(sharedDir, { recursive: true });
    copyFileSync(EGRESS_AUDIT, join(sharedDir, 'egress-audit.cjs'));
    copyFileSync(CLOCK_PRELOAD, join(sharedDir, 'clock-preload.cjs'));
    writeFileSync(join(sharedDir, 'allow.json'), JSON.stringify({ note: 'loopback only', hosts: [] }));
    const run = {
      root,
      shared: { egressAudit: join(sharedDir, 'egress-audit.cjs').split(sep).join('/'), clockPreload: join(sharedDir, 'clock-preload.cjs').split(sep).join('/'), allowList: join(sharedDir, 'allow.json'), clockStart },
    };

    const trees = {};
    for (const side of ['base', 'head']) {
      const tree = materializeRef(opts.repo, opts[side], join(root, 'trees', side));
      if (linkNodeModules(tree.dir, nodeModules)) links.push(join(tree.dir, 'node_modules'));
      trees[side] = tree;
    }
    report.commits = { base: trees.base.commit || trees.base.label, head: trees.head.commit || trees.head.label };

    // Prep: one copy gets local credentials through the base release's own modules, then two copies of it.
    const prep = join(root, 'data', 'prep');
    copyData(source, prep);
    if (opts.fakeSecrets) {
      const added = addFakeSecrets(prep);
      if (added.length) report.warnings.push(`fake secrets added to the copies (random values): ${added.join(', ')}`);
    }
    const password = randomBytes(18).toString('base64url');
    const prepRun = newRunFolder(root, 'prep', run.shared);
    const prepOut = JSON.parse(await runNodeScript(PREP_SCRIPT, prepRun, { APP_DATA_DIR: prep, DD_TREE: trees.base.dir, DD_ADMIN_PASSWORD: password }));
    const credentials = { username: prepOut.username, password, makerToken: prepOut.makerToken || '' };
    const sourceSecrets = opts.secrets ? secretManifest(source) : null;
    const prepSecrets = opts.secrets ? secretManifest(prep) : null;
    if (opts.secrets) {
      for (const v of secretViolations(sourceSecrets, prepSecrets, { stage: 'prep' })) report.warnings.push(`prep touched a secret file: ${v.key}`);
    }
    const dirs = { base: join(root, 'data', 'base'), head: join(root, 'data', 'head') };
    copyData(prep, dirs.base);
    copyData(prep, dirs.head);

    const routes = opts.inventory ? (() => {
      const all = new Map();
      for (const route of [...extractRoutes(trees.base.dir), ...extractRoutes(trees.head.dir)]) all.set(`${route.method} ${route.path}`, route);
      for (const flow of flows) for (const step of flow.steps) if (step.path) all.set(`${String(step.method || 'GET').toUpperCase()} ${step.path.split('?')[0]}`, { method: String(step.method || 'GET').toUpperCase(), path: step.path.split('?')[0] });
      for (const tick of clock.ticks || []) all.set(`${String(tick.method || 'POST').toUpperCase()} ${tick.path}`, { method: String(tick.method || 'POST').toUpperCase(), path: tick.path });
      return [...all.values()];
    })() : [];

    const sides = {};
    for (const side of ['base', 'head']) {
      sides[side] = await runSide({ label: side, tree: trees[side].dir, dataDir: dirs[side], run, flows, clock, credentials, routes, inventory: opts.inventory, secretRef: opts.secrets });
    }

    const diffs = [
      ...compareRecords('response', sides.base.flows, sides.head.flows),
      ...compareRecords('site-config', sides.base.siteConfig, sides.head.siteConfig),
      ...compareRecords('tick', sides.base.ticks, sides.head.ticks),
      ...compareInventory(sides.base.inventory, sides.head.inventory),
      ...compareOutbox(sides.base.outbox, sides.head.outbox),
    ];
    const scrubBase = sides.base.scrub;
    const scrubHead = sides.head.scrub;
    const snapBase = snapshotData(dirs.base, { scrub: scrubBase, skipDirs: ['outbox'] });
    const snapHead = snapshotData(dirs.head, { scrub: scrubHead, skipDirs: ['outbox'] });
    diffs.push(...diffSnapshots(snapBase, snapHead));
    const classified = classify(diffs, intended);
    report.flows = sides.head.flows.map((row) => ({ key: row.key, name: row.name, status: row.status, skipped: row.skipped, unexpected: row.unexpected }));
    for (const side of ['base', 'head']) {
      for (const row of sides[side].flows) if (row.unexpected) report.warnings.push(`${side} ${row.key} ${row.method} ${row.path}: ${row.unexpected}`);
      for (const row of sides[side].flows) if (row.skipped) report.warnings.push(`${side} ${row.key} ${row.method} ${row.path}: skipped (${row.skipped})`);
    }
    report.counts = {
      flowSteps: sides.head.flows.length,
      siteConfigs: sides.head.siteConfig.length,
      ticks: sides.head.ticks.length,
      routesProbed: Object.keys(sides.head.inventory).length,
      outbox: { base: sides.base.outbox.length, head: sides.head.outbox.length },
      egressRefused: { base: sides.base.egress.refused, head: sides.head.egress.refused },
    };
    for (const side of ['base', 'head']) {
      if (sides[side].egress.refused) report.warnings.push(`${side}: ${sides[side].egress.refused} outbound connection(s) refused (${sides[side].egress.hosts.join(', ')})`);
    }
    if (opts.debug) report.sides = { base: { ...sides.base, scrub: undefined }, head: { ...sides.head, scrub: undefined } };
    report.listed = classified.listed;
    report.unlisted = classified.unlisted;
    report.unusedIntended = classified.unused;
    for (const match of classified.unused) report.warnings.push(`intended change never seen: ${match}`);

    report.secretFailures = [];
    if (opts.secrets) {
      const ref = prepSecrets;
      const baseViolations = [
        ...secretViolations(ref, sides.base.secretsAfterBoot, { stage: 'base after boot' }),
        ...secretViolations(ref, sides.base.secretsAtEnd, { stage: 'base at the end' }),
      ];
      const headViolations = [
        ...secretViolations(ref, sides.head.secretsAfterBoot, { stage: 'head after boot' }),
        ...secretViolations(ref, sides.head.secretsAtEnd, { stage: 'head at the end' }),
      ];
      const baseNew = new Set(baseViolations.filter((v) => v.change === 'new').map((v) => v.rel));
      const allowed = intended.allowNewSecrets.map((glob) => new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`));
      for (const v of headViolations) {
        if (v.change === 'new' && (baseNew.has(v.rel) || allowed.some((re) => re.test(v.rel)))) {
          report.warnings.push(`${v.key} (${v.detail}; ${baseNew.has(v.rel) ? 'base creates it too' : 'allowed by the intended file'})`);
          continue;
        }
        report.secretFailures.push({ key: v.key, detail: v.detail });
      }
      for (const v of baseViolations) report.warnings.push(`base: ${v.key} (${v.detail})`);
      report.secretFiles = Object.keys(ref).length;
    }

    report.rollbackFailures = [];
    if (opts.rollback) {
      const rb = join(root, 'data', 'rollback');
      copyData(dirs.head, rb);
      const written = parseJsonFiles(rb);
      const rbRun = newRunFolder(root, 'rollback', run.shared);
      let hub;
      try {
        hub = await bootHub(trees.base.dir, rb, rbRun);
      } catch (error) {
        report.rollbackFailures.push({ key: 'rollback boot', detail: `base did not boot on the data head wrote: ${error.message.slice(0, 600)}` });
      }
      if (hub) {
        try {
          await settle(rb, { quietMs: 800, maxMs: 8000 });
          const login = await request(hub, { method: 'POST', path: '/api/admin/login', body: { username: credentials.username, password: credentials.password } });
          if (!login.json?.token) report.rollbackFailures.push({ key: 'rollback admin sign-in', detail: `HTTP ${login.status}` });
          for (const site of readSites(rb)) {
            const label = String(site.domain || '').trim() || 'a site without a domain';
            const res = site.site_key ? await request(hub, { path: `/api/hub/site-config?site_key=${encodeURIComponent(site.site_key)}` }) : null;
            if (res && (res.status === 0 || res.status >= 500)) report.rollbackFailures.push({ key: `rollback site-config ${label}`, detail: `HTTP ${res.status}` });
          }
          await settle(rb);
        } finally {
          await hub.stop();
        }
        const after = parseJsonFiles(rb);
        const lostAllowed = intended.rollbackLost.map((glob) => new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`, 's'));
        for (const loss of rollbackLosses(written, after, { scrub: sides.head.scrub })) {
          if (lostAllowed.some((re) => re.test(loss.key))) report.warnings.push(`${loss.key}: ${loss.detail} (listed)`);
          else report.rollbackFailures.push(loss);
        }
      }
    }

    if (sourceFingerprint(source) !== before) throw new HarnessError('the source data folder changed during the run');
    report.ok = !report.unlisted.length && !report.secretFailures.length && !report.rollbackFailures.length;
    report.finishedAt = new Date().toISOString();
    return report;
  } finally {
    for (const link of links) {
      if (!removeLink(link)) {
        // Never delete a folder that still links to the dependency set.
        opts.keep = true;
        report.warnings.push(`could not remove the link ${link}; the temp folder ${root} is kept`);
      }
    }
    if (opts.keep) report.tempDir = root;
    else rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

export function formatReport(report) {
  const lines = [];
  lines.push(`dark-diff ${report.base} → ${report.head}: ${report.ok ? 'OK' : 'DIFFERENCES'}`);
  if (report.counts) {
    lines.push(`  ${report.counts.flowSteps} flow steps, ${report.counts.siteConfigs} site configs, ${report.counts.ticks} ticks, ${report.counts.routesProbed} routes, outbox ${report.counts.outbox.base}/${report.counts.outbox.head}`);
  }
  for (const d of report.unlisted || []) lines.push(`  UNLISTED ${d.key}: ${d.detail}${d.base !== undefined ? ` (base ${d.base} | head ${d.head})` : ''}`);
  for (const d of report.listed || []) lines.push(`  listed   ${d.key}: ${d.detail} [${d.listedBy}]`);
  for (const d of report.secretFailures || []) lines.push(`  SECRET   ${d.key}: ${d.detail}`);
  for (const d of report.rollbackFailures || []) lines.push(`  ROLLBACK ${d.key}: ${d.detail}`);
  for (const w of report.warnings || []) lines.push(`  note     ${w}`);
  return lines.join('\n');
}

export async function main(argv = process.argv.slice(2)) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (error) {
    console.error(`dark-diff: ${error.message}`);
    console.error('usage: dark-diff.mjs --base <ref> --head <ref> --data <dir> [--intended <json>] [--secrets] [--rollback] [--out <file>]');
    return 2;
  }
  try {
    const report = await runDarkDiff(opts);
    if (opts.out) writeFileSync(resolve(opts.out), `${JSON.stringify(report, null, 2)}\n`);
    console.log(opts.json ? JSON.stringify(report, null, 2) : formatReport(report));
    return report.ok ? 0 : 1;
  } catch (error) {
    console.error(`dark-diff: ${error instanceof HarnessError ? error.message : error?.stack || error}`);
    return 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }, (error) => {
    console.error(`dark-diff: ${error?.stack || error}`);
    process.exitCode = 2;
  });
}
