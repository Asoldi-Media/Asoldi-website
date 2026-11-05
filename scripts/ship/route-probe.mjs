#!/usr/bin/env node
/**
 * Route probe: boots a hub tree locally (safe mode, temp data folder, temp HOME, an empty working
 * folder, no .env) and calls a list of routes without credentials, then lists every data file whose
 * bytes changed because of the calls.
 *
 *   node scripts/ship/route-probe.mjs <hub tree> [--routes <file>] [--json]
 *
 * The routes file (default scripts/ship/probe-routes.json) is
 *   { "routes": [ { "method": "GET", "path": "/api/...", "body": {…}, "expect": "staff" | "dark" } ] }
 *   - "staff": a route for staff only; it must answer 401 or 403 without credentials;
 *   - "dark": a route that stays switched off; it must answer 404.
 * Exit 0 when every route answered as expected and no data file changed; 1 otherwise; 2 when the
 * hub did not start or the routes file is unusable. A routes file that lists nothing is exit 2: a
 * probe that called no route proves nothing.
 *
 * The hub is stopped and the temp folders are removed in a finally block and on an interrupt; a folder that cannot be
 * removed is named in the output.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_ROUTES = join(HERE, 'probe-routes.json');

/** Reads and checks a routes file: [{ method, path, body, expect }]. Throws on anything unusable. */
export function loadRoutes(file) {
  let data;
  try {
    data = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`cannot read the routes file ${file}: ${error?.message || error}`);
  }
  const list = Array.isArray(data?.routes) ? data.routes : [];
  if (!list.length) throw new Error(`the routes file ${file} lists no route`);
  return list.map((row, i) => {
    const method = String(row?.method || 'GET').toUpperCase();
    const path = String(row?.path || '');
    if (!/^\/[^\s]*$/.test(path)) throw new Error(`route ${i}: the path must start with /`);
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) throw new Error(`route ${i}: unknown method ${method}`);
    if (row.expect !== 'staff' && row.expect !== 'dark') throw new Error(`route ${i} (${method} ${path}): expect must be "staff" or "dark"`);
    return { method, path, body: row.body, expect: row.expect };
  });
}

/** Whether a status is what the route's kind requires without credentials. */
export function statusOk(expect, status) {
  return expect === 'dark' ? status === 404 : status === 401 || status === 403;
}

/** Data files that changed between two snapshots, leaving out logs and the safe-mode outbox. */
export function changedFiles(before, after) {
  return Object.keys({ ...before, ...after })
    .filter((k) => before[k] !== after[k] && !/^(logs?|outbox|ai)\//.test(k) && !/request-log|http-log/.test(k))
    .sort();
}

function freePort() {
  return new Promise((resolvePort, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolvePort(port));
    });
  });
}

export function snapshot(dir) {
  const out = {};
  const walk = (d, rel = '') => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const r = rel ? `${rel}/${name}` : name;
      if (statSync(p).isDirectory()) walk(p, r);
      else out[r] = createHash('sha256').update(readFileSync(p)).digest('hex');
    }
  };
  walk(dir);
  return out;
}

/** Boots the tree and probes the routes. Returns { rows, changed, problems, removalErrors }. */
export async function probeRoutes(tree, routes, { startTimeoutMs = 240_000 } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'route-probe-data-'));
  const home = mkdtempSync(join(tmpdir(), 'route-probe-home-'));
  const runDir = mkdtempSync(join(tmpdir(), 'route-probe-cwd-'));
  const folders = [dataDir, home, runDir];
  let child = null;
  const removalErrors = [];
  const cleanup = async () => {
    // The hub holds its working folder open on Windows until it has exited.
    if (child && child.exitCode === null) {
      const exited = new Promise((r) => child.once('exit', r));
      try { child.kill(); } catch { /* already gone */ }
      await Promise.race([exited, new Promise((r) => setTimeout(r, 10_000))]);
    }
    for (const d of folders) {
      try {
        rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
      } catch (error) {
        removalErrors.push(`${d} (${error?.code || error?.message || error})`);
      }
    }
  };
  const onSignal = async (signal) => {
    await cleanup();
    process.exit(signal === 'SIGINT' ? 130 : 143);
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    const port = await freePort();
    const env = {
      PATH: process.env.PATH, SystemRoot: process.env.SystemRoot || '', TEMP: process.env.TEMP || tmpdir(), TMP: process.env.TMP || tmpdir(),
      HOME: home, USERPROFILE: home, APP_DATA_DIR: dataDir, PORT: String(port), PERSIST_PRODUCTION_ENV: '0', HUB_SAFE_MODE: '1',
      HUB_LISTEN_HOST: '127.0.0.1', SALES_EMAIL_AUTOSEND: '0',
    };
    let logs = '';
    child = spawn(process.execPath, [join(tree, 'server.js')], { cwd: runDir, env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (c) => { logs += c; });
    child.stderr.on('data', (c) => { logs += c; });
    const started = Date.now();
    while (!logs.includes('Server running on port')) {
      if (Date.now() - started > startTimeoutMs || child.exitCode !== null) throw new Error(`the hub did not start (exit ${child.exitCode})`);
      await new Promise((r) => setTimeout(r, 300));
    }
    await new Promise((r) => setTimeout(r, 3000));
    const before = snapshot(dataDir);
    const base = `http://127.0.0.1:${port}`;
    const rows = [];
    for (const route of routes) {
      const res = await fetch(`${base}${route.path}`, {
        method: route.method,
        headers: route.body ? { 'content-type': 'application/json' } : {},
        body: route.body ? JSON.stringify(route.body) : undefined,
      });
      const text = await res.text();
      let note = '';
      try {
        const j = JSON.parse(text);
        note = j.code || j.message || j.error || '';
      } catch {
        note = text.slice(0, 40).replace(/\s+/g, ' ');
      }
      rows.push({ ...route, body: undefined, status: res.status, note, ok: statusOk(route.expect, res.status) });
    }
    await new Promise((r) => setTimeout(r, 1500));
    const changed = changedFiles(before, snapshot(dataDir));
    const problems = rows.filter((r) => !r.ok).length + (changed.length ? 1 : 0);
    return { rows, changed, problems, removalErrors };
  } finally {
    await cleanup();
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
}

export async function main(argv = process.argv.slice(2)) {
  const json = argv.includes('--json');
  const rIdx = argv.indexOf('--routes');
  const routesFile = rIdx >= 0 ? resolve(argv[rIdx + 1] || '') : DEFAULT_ROUTES;
  const tree = argv.filter((a, i) => !a.startsWith('--') && !(rIdx >= 0 && i === rIdx + 1))[0];
  if (!tree || !existsSync(join(resolve(tree), 'server.js'))) {
    console.error('usage: route-probe.mjs <hub tree> [--routes <file>] [--json]');
    return 2;
  }
  let routes;
  try {
    routes = loadRoutes(routesFile);
  } catch (error) {
    console.error(`route-probe: ${error.message}`);
    return 2;
  }
  let result;
  try {
    result = await probeRoutes(resolve(tree), routes);
  } catch (error) {
    console.error(`route-probe: ${error?.message || error}`);
    return 2;
  }
  if (json) console.log(JSON.stringify({ rows: result.rows, changed: result.changed, problems: result.problems }, null, 2));
  else {
    for (const r of result.rows) console.log(`${r.ok ? 'ok ' : 'BAD'} ${r.method} ${r.path} -> ${r.status} ${r.note}${r.expect === 'dark' ? ' (must be dark)' : ''}`);
    console.log(`data files changed by the calls: ${result.changed.length ? result.changed.join(', ') : 'none'}`);
    console.log(result.problems ? `probe: ${result.problems} problem(s)` : 'probe: ok');
  }
  if (result.removalErrors.length) console.error(`route-probe: could not remove ${result.removalErrors.join(', ')}; delete by hand`);
  return result.problems ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; });
}
