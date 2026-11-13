// The production host starts the hub with require('<...>/server.js') from a CommonJS loader
// (LiteSpeed lsnode.js), not with `node server.js`. require() of an ES module refuses a module
// graph that holds a top-level await (ERR_REQUIRE_ASYNC_MODULE), so one `await` at the top level
// of server.js, or of any module it imports, keeps the hub from starting there while every test
// that runs `node server.js` still passes. These tests load the hub the way the host does:
//
//   1. no module server.js loads before it runs has a top-level await (source check);
//   2. require() of server.js works in safe mode on a throwaway data dir, the hub answers, and
//      every route is registered by the time require() returns, with the page fallback last;
//   3. the same load of a copy with one planted top-level await fails with
//      ERR_REQUIRE_ASYNC_MODULE (the check can fail);
//   4. the optional route modules are registered in list order before registerOptionalRoutes
//      returns, and every listed module file of this build is imported.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import net from 'node:net';
import { PRODUCTION_ENV_KEYS } from '../lib/persistent-env.js';
import { OPTIONAL_ROUTE_MODULES, PRESENT_ROUTE_MODULES, registerOptionalRoutes } from '../lib/routes/optional-routes.js';
import { staticModuleGraph, staticSpecifiers, topLevelAwaits } from './server-load/module-graph.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const serverPath = join(repoRoot, 'server.js');
const hostLoader = join(repoRoot, 'scripts', 'server-load', 'require-like-host.cjs');
const egressGuard = pathToFileURL(join(repoRoot, 'scripts', 'security', 'loopback-only-egress.mjs')).href;
const CREDENTIAL_KEY = /(KEY|SECRET|TOKEN|PASS|PASSWORD|AUTH|_API$|_JSON$|_LOGIN$|_USER$|_URL$|_HOST$|_SUBDOMAIN$|_ID$|_IDS$)/;
const BOOT_WAIT_MS = Number(process.env.REQUIRE_LOAD_BOOT_WAIT_MS) > 0 ? Number(process.env.REQUIRE_LOAD_BOOT_WAIT_MS) : 240_000;
// require() of an ES module needs Node 22.12 or newer; production runs Node 22.
const canRequireEsModules = process.features?.require_module === true;
const skipLoad = canRequireEsModules ? false : `this Node (${process.version}) cannot require() an ES module; run on Node 22.12 or newer, as production does`;

const rel = (file) => relative(repoRoot, file).split(sep).join('/');

/** Safe mode, a throwaway data dir and home, loopback only, every credential blanked (as the other boot tests). */
function bootEnv({ dataDir, home, port }) {
  const env = {};
  for (const key of PRODUCTION_ENV_KEYS.filter((name) => CREDENTIAL_KEY.test(name))) env[key] = '';
  for (const key of ['BREVO_API_KEY', 'ANTHROPIC_API_KEY', 'DEEPSEEK_API_KEY', 'GEMINI_API_KEY', 'OPENAI_API_KEY', 'DATAFORSEO_AUTH',
    'RESEND_API_KEY', 'SMTP_HOST', 'SMTP_PASS', 'STRIPE_SECRET_KEY', 'HOSTINGER_API_TOKEN', 'PROD_ADMIN_PASSWORD', 'GITHUB_TOKEN']) env[key] = '';
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

async function waitFor(check, { timeoutMs = BOOT_WAIT_MS, stepMs = 150, what = 'condition' } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  throw new Error(`timed out waiting for ${what}`);
}

function tempDirs(...names) {
  return names.map((name) => mkdtempSync(join(tmpdir(), `asoldi-require-load-${name}-`)));
}

function removeDirs(dirs) {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

/** One entry per Express layer, as require-like-host.cjs writes them: index, kind, methods or name, path. */
function readRoutes(file) {
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => {
    const [index, kind, third, fourth] = line.split('\t');
    return kind === 'route'
      ? { index: Number(index), kind, methods: third, path: JSON.parse(fourth), line }
      : { index: Number(index), kind, name: third, line };
  });
}

// ------------------------------------------------------------------ 1. source check

test('the top-level await finder sees every form and nothing inside a function', () => {
  const lines = (source) => topLevelAwaits(source).map((hit) => hit.line);
  assert.deepEqual(lines('const a = 1;\nawait start();\n'), [2]);
  assert.deepEqual(lines('const a = await load();\n'), [1]);
  assert.deepEqual(lines('if (ready) {\n  try { await go(); } catch {}\n}\n'), [2]);
  assert.deepEqual(lines('for await (const item of list()) use(item);\n'), [1]);
  assert.deepEqual(lines('const x = [1, await two()];\nexport default await three();\n'), [1, 2]);
  assert.deepEqual(lines('await using handle = open();\n'), [1]);
  // Not top-level: functions, arrows, methods, class members, a later import().
  assert.deepEqual(lines([
    'async function a() { await x(); for await (const y of z()) {} }',
    'const b = async () => { await x(); };',
    'const c = { async d() { await x(); } };',
    'class E { async f() { await x(); } static g = async () => { await x(); }; }',
    "const later = () => import('./late.js').then((mod) => mod.run());",
    "// await in a comment, and 'await in a string' and `await in a template`",
    "const text = 'await nothing();';",
  ].join('\n')), []);
  assert.deepEqual(
    staticSpecifiers("import a from './a.js';\nexport * from './b.js';\nexport { c } from 'pkg';\nconst late = () => import('./late.js');\n"),
    ['./a.js', './b.js', 'pkg'],
  );
});

test('no module server.js loads before it runs has a top-level await', () => {
  const graph = staticModuleGraph(serverPath);
  assert.ok(graph.files.length > 50, `the walk reached only ${graph.files.length} files`);
  assert.ok(graph.files.some((file) => rel(file) === 'lib/routes/optional-routes.js'), 'the optional route list is part of the graph');
  for (const name of Object.keys(PRESENT_ROUTE_MODULES)) {
    assert.ok(graph.files.some((file) => rel(file) === `lib/routes/${name.slice(2)}`), `${name} is part of the graph`);
  }
  assert.deepEqual(graph.missing.map((entry) => `${rel(entry.from)} -> ${entry.specifier}`), [], 'every relative import names a file');
  assert.deepEqual(
    graph.awaits.map((hit) => `${rel(hit.file)}:${hit.line}  ${hit.text}`),
    [],
    'a top-level await in a module server.js imports keeps the production host from starting the hub, because it loads server.js with require(). Move the await into a function, or return the start-up work from register(app, deps).',
  );
});

// ------------------------------------------------------------------ 2. the real load

test('require() of server.js starts the hub in safe mode, with every route registered when require() returns', { timeout: BOOT_WAIT_MS + 60_000, skip: skipLoad }, async (t) => {
  const dirs = tempDirs('data', 'home', 'cwd', 'out');
  const [dataDir, home, runDir, outDir] = dirs;
  const port = await freePort();
  const routesPrefix = join(outDir, 'routes');
  let logs = '';
  const child = spawn(process.execPath, ['--import', egressGuard, hostLoader, serverPath], {
    cwd: runDir,
    env: { ...bootEnv({ dataDir, home, port }), SERVER_LOAD_ROUTES: routesPrefix },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let exited = null;
  child.stdout.on('data', (chunk) => { logs += chunk; });
  child.stderr.on('data', (chunk) => { logs += chunk; });
  child.on('exit', (code) => { exited = code ?? -1; });
  t.after(async () => {
    // The hub goes first: it holds its working folder open.
    if (exited === null) {
      const gone = new Promise((resolve) => child.once('exit', resolve));
      child.kill();
      await Promise.race([gone, new Promise((resolve) => setTimeout(resolve, 5000))]);
    }
    removeDirs(dirs);
  });

  try {
    await waitFor(() => exited !== null || logs.includes('Server running on port'), { what: 'the hub to start through require()' });
    assert.equal(exited, null, 'the hub is still running');
    assert.match(logs, /\[require-load\] loaded/);
    assert.doesNotMatch(logs, /ERR_REQUIRE_ASYNC_MODULE/);
    assert.match(logs, /\[safe-mode\] ON/);

    const health = await fetch(`http://127.0.0.1:${port}/api/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).safeMode, true);

    // The route stack the moment require() returned, once the hub listened, and two seconds later.
    await waitFor(() => existsSync(`${routesPrefix}.settled.txt`), { timeoutMs: 30_000, what: 'the route lists' });
    const loaded = readRoutes(`${routesPrefix}.loaded.txt`);
    assert.ok(loaded.length > 100, `only ${loaded.length} layers were registered when require() returned`);
    for (const moment of ['listening', 'settled']) {
      assert.deepEqual(readRoutes(`${routesPrefix}.${moment}.txt`).map((layer) => layer.line), loaded.map((layer) => layer.line), `no route or middleware is added after require() returns (${moment})`);
    }

    // The page fallback (GET *) comes last: a route registered after it would never be reached.
    const fallback = loaded.findIndex((layer) => layer.kind === 'route' && layer.path === '*');
    assert.ok(fallback > 0, 'the page fallback route exists');
    assert.deepEqual(loaded.slice(fallback + 1).map((layer) => layer.line), [], 'nothing is registered after the page fallback');
    assert.ok(loaded.some((layer) => layer.kind === 'route' && String(layer.path).startsWith('/api/')), 'API routes are in the list');
  } catch (error) {
    error.message += `\n--- hub log ---\n${logs.slice(-4000)}`;
    throw error;
  }
});

// ------------------------------------------------------------------ 3. negative control

/**
 * A copy of server.js in a temp folder that resolves everything the real one does: the copy sits
 * beside links to the repository's folders, so './lib/x.js' and 'express' load the real files.
 * Returns the copy's path and a function that removes the links (never what they point at).
 */
function copyServer(dir, transform) {
  const links = [];
  writeFileSync(join(dir, 'server.js'), transform(readFileSync(serverPath, 'utf8')));
  copyFileSync(join(repoRoot, 'package.json'), join(dir, 'package.json'));
  for (const name of readdirSync(repoRoot)) {
    const from = join(repoRoot, name);
    if (name.startsWith('.') || !statSync(from).isDirectory()) continue;
    const link = join(dir, name);
    symlinkSync(from, link, process.platform === 'win32' ? 'junction' : 'dir');
    links.push(link);
  }
  const removeLinks = () => {
    for (const link of links.splice(0)) {
      try {
        unlinkSync(link);
      } catch {
        // Left for the temp folder cleanup.
      }
    }
  };
  return { file: join(dir, 'server.js'), removeLinks };
}

test('negative control: a copy of server.js with one planted top-level await fails the require() load', { timeout: 150_000, skip: skipLoad }, async (t) => {
  const dirs = tempDirs('data', 'home', 'cwd');
  const [dataDir, home, runDir] = dirs;
  const copyDir = mkdtempSync(join(tmpdir(), 'asoldi-require-load-copy-'));
  const planted = copyServer(copyDir, (source) => `${source}\nawait Promise.resolve();\n`);
  t.after(() => {
    // The links go first, one by one; the folder is removed only when none is left in it.
    planted.removeLinks();
    const left = readdirSync(copyDir).filter((name) => !['server.js', 'package.json'].includes(name));
    if (!left.length) rmSync(copyDir, { recursive: true, force: true });
    removeDirs(dirs);
  });
  assert.deepEqual(topLevelAwaits(readFileSync(planted.file, 'utf8')).map((hit) => hit.text), ['await Promise.resolve();'], 'the source check sees the planted await');

  const port = await freePort();
  const run = spawnSync(process.execPath, ['--import', egressGuard, hostLoader, planted.file], {
    cwd: runDir,
    env: bootEnv({ dataDir, home, port }),
    encoding: 'utf8',
    timeout: 120_000,
  });
  const output = `${run.stdout}\n${run.stderr}`;
  assert.equal(run.status, 7, `the planted copy must fail to load\n${output.slice(-2000)}`);
  assert.match(output, /\[require-load\] failed ERR_REQUIRE_ASYNC_MODULE/);
  assert.doesNotMatch(output, /Server running on port/);
});

// ------------------------------------------------------------------ 4. optional route modules

test('every listed optional route module this build contains is imported, and nothing else', () => {
  const routesDir = join(repoRoot, 'lib', 'routes');
  const onDisk = OPTIONAL_ROUTE_MODULES.filter((name) => existsSync(join(routesDir, name)));
  assert.deepEqual(Object.keys(PRESENT_ROUTE_MODULES).sort(), [...onDisk].sort(), 'PRESENT_ROUTE_MODULES in lib/routes/optional-routes.js names exactly the listed files that exist');
  assert.equal(new Set(OPTIONAL_ROUTE_MODULES).size, OPTIONAL_ROUTE_MODULES.length);
  for (const [name, mod] of Object.entries(PRESENT_ROUTE_MODULES)) assert.equal(typeof mod.register, 'function', `${name} exports register`);
});

test('registerOptionalRoutes registers in list order before it returns and reports start-up work through ready', async () => {
  const calls = [];
  const app = { get: (path) => calls.push(path) };
  let finishSlow;
  const present = {
    './a.js': { register: (target) => { target.get('/a'); } },
    './slow.js': {
      register: (target) => {
        target.get('/slow');
        return new Promise((resolve) => { finishSlow = resolve; });
      },
    },
    './c.js': { register: async (target) => { target.get('/c'); } },
  };
  const result = registerOptionalRoutes(app, {}, { modules: ['./a.js', './absent.js', './slow.js', './c.js'], present });
  assert.deepEqual(calls, ['/a', '/slow', '/c'], 'all routes are registered when the call returns');
  assert.deepEqual(result.registered, ['./a.js', './slow.js', './c.js']);
  let settled = false;
  result.ready.then(() => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, 'ready waits for the start-up work');
  finishSlow();
  assert.deepEqual(await result.ready, ['./a.js', './slow.js', './c.js']);

  const failing = registerOptionalRoutes(app, {}, { modules: ['./bad.js'], present: { './bad.js': { register: () => Promise.reject(new Error('store unavailable')) } } });
  await assert.rejects(failing.ready, /store unavailable/);
  assert.throws(() => registerOptionalRoutes(app, {}, { modules: ['./none.js'], present: { './none.js': {} } }), /must export register/);
});
