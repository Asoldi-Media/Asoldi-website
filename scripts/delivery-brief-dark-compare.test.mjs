// Negative control for the brief switch: with every new switch off, this tree must answer and write
// exactly like an earlier commit. Both trees boot the real hub (server.js, safe mode, no credentials,
// loopback-only egress) on identical seeded data dirs, run the same requests, and the answers and
// the data dirs are compared. Values that differ between any two boots (times, tokens, random ids,
// ports) are masked. The only difference allowed is the `brief` switch node itself: in the
// automation-settings defaults, settings and release-gated list, and in the saved settings file.
//
// Opt-in, like the forward-compat revert test: DARK_COMPARE_REF=<git ref> node --test
// scripts/delivery-brief-dark-compare.test.mjs. The ref is extracted with `git archive` into
// build/dark-compare-<sha>/ (ignored), so it finds this checkout's node_modules.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import net from 'node:net';
import { PRODUCTION_ENV_KEYS } from '../lib/persistent-env.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const egressGuard = pathToFileURL(join(root, 'scripts', 'security', 'loopback-only-egress.mjs')).href;
const ref = String(process.env.DARK_COMPARE_REF || '').trim();
const CREDENTIAL_KEY = /(KEY|SECRET|TOKEN|PASS|PASSWORD|AUTH|_API$|_JSON$|_LOGIN$|_USER$|_URL$|_HOST$|_SUBDOMAIN$|_ID$|_IDS$)/;
const EXTRA_KEYS = ['PROD_ADMIN_URL', 'PROD_ADMIN_PASSWORD', 'WEBSITE_MAKER_API_KEY', 'WEBSITEMAKER_API_KEY', 'GITHUB_TOKEN', 'ANTHROPIC_API_KEY', 'DEEPSEEK_API_KEY', 'GEMINI_API_KEY', 'AI_PROFILE'];
const NEW_ROUTES = new Set(['maker-brief', 'board-brief']);
const CLIENT_ID = 'syn-dark-compare';
const RUN_ID = 'run-dark-compare';

function untar(buffer, destination) {
  let offset = 0;
  let paxPath = '';
  const field = (start, length) => buffer.toString('utf8', start, start + length).replace(/\0.*$/s, '');
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = field(offset, 100);
    const size = parseInt(field(offset + 124, 12).trim() || '0', 8);
    const type = String.fromCharCode(header[156] || 48);
    const prefix = field(offset + 345, 155);
    const body = buffer.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
    if (type === 'x') {
      const match = body.toString('utf8').match(/\d+ path=([^\n]+)\n/);
      paxPath = match ? match[1] : '';
      continue;
    }
    if (type === 'g') continue;
    const path = paxPath || (prefix ? `${prefix}/${name}` : name);
    paxPath = '';
    if (path.includes('..')) throw new Error(`unsafe path in archive: ${path}`);
    const target = join(destination, path);
    if (type === '5') mkdirSync(target, { recursive: true });
    else if (type === '0' || type === '\0') {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, body);
    }
  }
}

function treeForRef(value) {
  const sha = execFileSync('git', ['rev-parse', '--short=12', `${value}^{commit}`], { cwd: root, encoding: 'utf8' }).trim();
  const destination = join(root, 'build', `dark-compare-${sha}`);
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(destination, { recursive: true });
  untar(execFileSync('git', ['archive', '--format=tar', sha], { cwd: root, maxBuffer: 512 * 1024 * 1024 }), destination);
  return { codeRoot: destination, sha, cleanup: () => rmSync(destination, { recursive: true, force: true }) };
}

function bootEnv({ dataDir, home, port }) {
  const env = {};
  for (const key of new Set([...PRODUCTION_ENV_KEYS.filter((key) => CREDENTIAL_KEY.test(key)), ...EXTRA_KEYS])) env[key] = '';
  return {
    ...env,
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot || '',
    TEMP: process.env.TEMP || tmpdir(),
    TMP: process.env.TMP || tmpdir(),
    HOME: home,
    USERPROFILE: home,
    APP_DATA_DIR: dataDir,
    PORT: String(port),
    PERSIST_PRODUCTION_ENV: '0',
    SALES_EMAIL_AUTOSEND: '0',
    MYPHONER_WEBHOOK_RECONCILE_ENABLED: '0',
    MYPHONER_SSU_WINS_SYNC_ENABLED: '0',
    MYPHONER_RECORDING_DOWNLOAD_ENABLED: '0',
    HUB_SAFE_MODE: '1',
    WEBSITE_MAKER_LOCAL_URL: 'http://127.0.0.1:9',
  };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// BRIEF_BOOT_WAIT_MS (optional) changes how long each hub start may take.
const BOOT_WAIT_MS = Number(process.env.BRIEF_BOOT_WAIT_MS) > 0 ? Number(process.env.BRIEF_BOOT_WAIT_MS) : 240_000;

async function waitFor(check, { timeoutMs = 120_000, stepMs = 150, what = 'condition' } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  throw new Error(`timed out waiting for ${what}`);
}

function seed(dataDir) {
  writeFileSync(join(dataDir, 'sales-clients.json'), JSON.stringify([{
    id: CLIENT_ID,
    businessName: 'Eksempel Sammenligning AS',
    industry: 'Bad',
    product: 'asoldi',
    makerRun: { runId: RUN_ID },
    sitePlan: { status: 'active', tierId: 'tier-1-standard', services: ['site', 'changes', 'blog'], pages: 5, billing: 'month', signedAt: '2026-10-02T10:00:00.000Z' },
    meetings: [{ meetingId: 'syn-m-compare', purpose: 'sales', startedAt: '2026-10-01T10:00:00.000Z', hasTranscript: true }],
  }]));
}

/** Boots one tree, runs the request script, stops it. Returns { responses, dataDir, logs }. */
async function runTree(codeRoot, label) {
  const dataDir = mkdtempSync(join(tmpdir(), `asoldi-dark-${label}-`));
  const home = mkdtempSync(join(tmpdir(), `asoldi-dark-${label}-home-`));
  const cwd = mkdtempSync(join(tmpdir(), `asoldi-dark-${label}-cwd-`));
  seed(dataDir);
  const port = await freePort();
  let logs = '';
  const child = spawn(process.execPath, ['--import', egressGuard, join(codeRoot, 'server.js')], { cwd, env: bootEnv({ dataDir, home, port }), stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (chunk) => { logs += chunk; });
  child.stderr.on('data', (chunk) => { logs += chunk; });
  const responses = [];
  try {
    await waitFor(() => logs.includes('Server running on port'), { timeoutMs: BOOT_WAIT_MS, what: `${label} start` });
    const passwordFile = join(dataDir, 'secrets', 'initial-admin-password');
    await waitFor(() => existsSync(passwordFile) && existsSync(join(dataDir, 'admin.json')), { what: `${label} admin` });
    const base = `http://127.0.0.1:${port}`;
    const json = { 'content-type': 'application/json' };
    const call = async (name, method, path, { headers = {}, body } = {}) => {
      const response = await fetch(`${base}${path}`, { method, headers: { ...(body !== undefined ? json : {}), ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      const text = await response.text();
      let parsed = text;
      try {
        parsed = JSON.parse(text);
      } catch {
        // Not JSON: compared as text.
      }
      responses.push({ name, status: response.status, body: parsed });
      return parsed;
    };
    const login = await call('login', 'POST', '/api/admin/login', { body: { username: 'asoldi.com', password: readFileSync(passwordFile, 'utf8').trim() } });
    const admin = { authorization: `Bearer ${login.token}` };
    const host = await call('maker-host-create', 'POST', '/api/admin/maker-hosts', { headers: admin, body: { label: 'Compare host' } });
    const maker = { 'x-maker-host-token': host.token };
    await call('maker-heartbeat', 'POST', '/api/maker/hosts/heartbeat', { headers: maker, body: { runIds: [RUN_ID] } });
    await call('settings-get', 'GET', '/api/admin/automation-settings', { headers: admin });
    await call('settings-put', 'PUT', '/api/admin/automation-settings', { headers: admin, body: { alerts: { hostOfflineHours: 3 } } });
    await call('settings-get-after', 'GET', '/api/admin/automation-settings', { headers: admin });
    await call('development-board', 'GET', '/api/admin/development', { headers: admin });
    await call('development-handoff', 'GET', `/api/admin/development/${CLIENT_ID}/handoff`, { headers: admin });
    await call('maker-hosts', 'GET', '/api/admin/maker-hosts', { headers: admin });
    await call('maker-access-log', 'GET', `/api/admin/maker-hosts/access-log?clientId=${CLIENT_ID}`, { headers: admin });
    await call('maker-brief', 'GET', `/api/maker/clients/${CLIENT_ID}/brief`, { headers: maker });
    await call('board-brief', 'GET', `/api/admin/development/${CLIENT_ID}/brief`, { headers: admin });
    // Let background writes settle before the data dir is read.
    await new Promise((resolve) => setTimeout(resolve, 1500));
  } finally {
    child.kill();
    await new Promise((resolve) => child.once('exit', resolve));
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
  return { responses, dataDir, logs };
}

// ---------------------------------------------------------------- masking

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const RANDOM_RE = /^(?=[A-Za-z0-9_.:-]*\d)(?=[A-Za-z0-9_.:-]*[A-Za-z])[A-Za-z0-9_.:-]{16,}$/;
const PREFIXED_ID_RE = /^[a-z]{1,8}_[A-Za-z0-9]{6,}$/;
const BCRYPT_RE = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/;
// A token, hash or key of any alphabet: one word, mixed letters and digits, not a URL.
const OPAQUE_RE = /^(?!.*:\/\/)(?=\S*\d)(?=\S*[A-Za-z])\S{20,}$/;

function maskString(value) {
  let out = String(value).replace(/127\.0\.0\.1:\d+/g, '127.0.0.1:<port>');
  if (ISO_RE.test(out)) return '<time>';
  if (/^\d{12,14}$/.test(out)) return '<ms>';
  if (BCRYPT_RE.test(out)) return '<hash>';
  if (PREFIXED_ID_RE.test(out)) return '<id>';
  if (RANDOM_RE.test(out) || OPAQUE_RE.test(out)) return '<random>';
  out = out.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, '<time>');
  out = out.replace(/\b[a-z]{1,8}_[A-Za-z0-9]{6,}\b/g, '<id>');
  out = out.replace(/\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{24,}\b/g, '<random>');
  return out;
}

function mask(value) {
  if (typeof value === 'string') return maskString(value);
  if (typeof value === 'number') return value > 1e12 ? '<ms>' : value;
  if (Array.isArray(value)) return value.map(mask);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const key of Object.keys(value).sort()) out[maskString(key)] = mask(value[key]);
  return out;
}

/** The brief switch node is the one allowed difference: removed from this tree's settings views. */
function withoutBrief(value) {
  if (Array.isArray(value)) return value.filter((item) => item !== 'brief').map(withoutBrief);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === 'brief') continue;
    out[key] = withoutBrief(child);
  }
  return out;
}

function snapshot(dataDir) {
  const files = new Map();
  const walk = (path) => {
    for (const name of readdirSync(path)) {
      const full = join(path, name);
      if (statSync(full).isDirectory()) walk(full);
      else {
        const rel = maskString(relative(dataDir, full).split('\\').join('/'));
        const raw = readFileSync(full, 'utf8');
        let content;
        try {
          content = { json: mask(JSON.parse(raw)) };
        } catch {
          const lines = raw.split(/\r?\n/).filter(Boolean);
          const jsonLines = lines.map((line) => {
            try {
              return mask(JSON.parse(line));
            } catch {
              return null;
            }
          });
          content = jsonLines.every(Boolean) && lines.length ? { lines: jsonLines } : { text: lines.length };
        }
        files.set(rel, content);
      }
    }
  };
  walk(dataDir);
  return files;
}

test(`with the brief switch off, answers and data writes match ${ref || 'an earlier commit (set DARK_COMPARE_REF)'}`, { skip: ref ? false : 'set DARK_COMPARE_REF=<git ref> to compare with that commit', timeout: Math.max(600_000, 2 * BOOT_WAIT_MS + 240_000) }, async () => {
  const base = treeForRef(ref);
  let baseRun = null;
  let ownRun = null;
  try {
    [baseRun, ownRun] = await Promise.all([runTree(base.codeRoot, 'base'), runTree(root, 'own')]);
    // A brief route is new: the earlier tree has no such route, this one answers 404 brief-disabled.
    const existing = (rows) => rows.filter((row) => !NEW_ROUTES.has(row.name)).map((row) => `${row.name} ${row.status}`);
    assert.deepEqual(existing(ownRun.responses), existing(baseRun.responses), 'the same status codes');

    for (let i = 0; i < baseRun.responses.length; i += 1) {
      const name = baseRun.responses[i].name;
      const own = ownRun.responses[i].body;
      const theirs = baseRun.responses[i].body;
      if (name.startsWith('settings-')) {
        // The only allowed difference: the brief node, off by default, and its place on the release-gated list.
        assert.deepEqual(own.defaults?.brief ?? own.settings?.brief, { enabled: false, mode: 'shadow' }, `${name}: brief is off by default`);
        assert.ok(!('brief' in (theirs.defaults || theirs.settings || {})), `${name}: the base has no brief node`);
        assert.deepEqual(mask(withoutBrief(own)), mask(theirs), `${name}: equal apart from the brief node`);
      } else if (NEW_ROUTES.has(name)) {
        assert.equal(ownRun.responses[i].status, 404, name);
        assert.equal(own.code, 'brief-disabled', `${name}: the new route is dark`);
      } else {
        assert.deepEqual(mask(own), mask(theirs), `${name}: the same answer`);
      }
    }

    const ownFiles = snapshot(ownRun.dataDir);
    const baseFiles = snapshot(baseRun.dataDir);
    assert.deepEqual([...ownFiles.keys()].sort(), [...baseFiles.keys()].sort(), 'the same files in the data dir');
    for (const [path, content] of baseFiles) {
      const own = ownFiles.get(path);
      if (/automation-settings/.test(path) && own.json) {
        assert.deepEqual(mask(withoutBrief(own.json)), content.json, `${path}: equal apart from the brief node`);
        continue;
      }
      assert.deepEqual(own, content, `${path}: the same content`);
    }
    assert.equal(existsSync(join(ownRun.dataDir, 'delivery-briefs')), false, 'no brief folder');
    for (const run of [baseRun, ownRun]) {
      assert.deepEqual(run.logs.split(/\r?\n/).filter((line) => line.startsWith('[egress-guard] blocked')), [], 'no outbound call');
    }
  } finally {
    for (const run of [baseRun, ownRun]) if (run) rmSync(run.dataDir, { recursive: true, force: true });
    base.cleanup();
  }
});
