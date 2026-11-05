// The optional route list (lib/routes/optional-routes.js). Every name is a lib/routes module named
// once; a listed module the build does not contain is skipped without an error, so a build boots with
// any subset of them and server.js needs no new line when one is added; a present module must export
// register(app, deps), is called once with the deps it is given and is reported; a present module
// without register stops the registration with its name. The skip and register cases run on a copy
// of the real file in a temp folder, so they hold whichever modules this build contains.
import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const routesDir = join(here, '..', 'lib', 'routes');
const source = join(routesDir, 'optional-routes.js');
const { OPTIONAL_ROUTE_MODULES, registerOptionalRoutes } = await import(pathToFileURL(source).href);

// Route modules reserved in the shared list for features that add their routes later.
const RESERVED = [
  './plan-lifecycle-routes.js',
  './client-booking-routes.js',
  './cms-fleet-routes.js',
  './email-owner-routes.js',
  './site-rekey-routes.js',
];

const temps = [];
test.after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

// A copy of optional-routes.js in an empty routes folder, plus the given modules, imported fresh.
async function isolatedCopy(files = {}) {
  const root = mkdtempSync(join(tmpdir(), 'asoldi-optional-routes-'));
  temps.push(root);
  writeFileSync(join(root, 'package.json'), '{"type":"module"}\n');
  const dir = join(root, 'routes');
  mkdirSync(dir);
  copyFileSync(source, join(dir, 'optional-routes.js'));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return import(pathToFileURL(join(dir, 'optional-routes.js')).href);
}

function recordingApp() {
  const calls = [];
  const app = new Proxy({ calls }, {
    get: (target, key) => (key === 'calls' ? calls : (...args) => { calls.push([String(key), args[0]]); }),
  });
  return { app, calls };
}

test('the list names each route module once, as ./<name>-routes.js, and cannot be changed at run time', () => {
  assert.ok(Object.isFrozen(OPTIONAL_ROUTE_MODULES));
  assert.equal(new Set(OPTIONAL_ROUTE_MODULES).size, OPTIONAL_ROUTE_MODULES.length, 'a module is listed twice');
  for (const name of OPTIONAL_ROUTE_MODULES) assert.match(name, /^\.\/[a-z0-9-]+-routes\.js$/, name);
  assert.ok(!OPTIONAL_ROUTE_MODULES.includes('./optional-routes.js'));
});

test('the list reserves the plan lifecycle, client booking, CMS fleet, owner email and site rekey route modules', () => {
  for (const name of RESERVED) assert.ok(OPTIONAL_ROUTE_MODULES.includes(name), `${name} is not in the list`);
  // Added after the modules that were already listed, so their registration order is unchanged.
  const firstReserved = Math.min(...RESERVED.map((name) => OPTIONAL_ROUTE_MODULES.indexOf(name)));
  for (const name of ['./signing-routes.js', './email-site-routes.js', './promotion-routes.js']) {
    assert.ok(OPTIONAL_ROUTE_MODULES.indexOf(name) < firstReserved, `${name} moved behind the reserved names`);
  }
});

test('every listed module this build contains exports register(app, deps)', () => {
  let present = 0;
  for (const name of OPTIONAL_ROUTE_MODULES) {
    const file = join(routesDir, name);
    if (!existsSync(file)) continue;
    present += 1;
    const text = readFileSync(file, 'utf8');
    assert.match(text, /export\s+(async\s+)?function\s+register\s*\(|export\s*\{[^}]*\bregister\b[^}]*\}/, `${name} has no register export`);
  }
  assert.ok(present > 0, 'no listed module found; the routes folder moved');
});

test('a build that contains none of the listed modules registers nothing and does not throw', async () => {
  const copy = await isolatedCopy();
  assert.deepEqual([...copy.OPTIONAL_ROUTE_MODULES], [...OPTIONAL_ROUTE_MODULES]);
  const { app, calls } = recordingApp();
  assert.deepEqual(await copy.registerOptionalRoutes(app, {}), []);
  assert.deepEqual(calls, []);
});

test('each reserved module the build does not contain is skipped while a present one around it registers once with its deps', async () => {
  for (const present of RESERVED) {
    const copy = await isolatedCopy({
      [present.slice(2)]: 'export async function register(app, deps) { app.get(`/probe/${deps.marker}`); }\n',
    });
    const { app, calls } = recordingApp();
    const registered = await copy.registerOptionalRoutes(app, { marker: 'm1' });
    assert.deepEqual(registered, [present]);
    assert.deepEqual(calls, [['get', '/probe/m1']]);
  }
});

test('the modules option limits registration to the names given, absent ones skipped', async () => {
  const copy = await isolatedCopy({ 'client-booking-routes.js': 'export function register(app) { app.post("/probe"); }\n' });
  const { app, calls } = recordingApp();
  const registered = await copy.registerOptionalRoutes(app, {}, { modules: ['./site-rekey-routes.js', './client-booking-routes.js', './no-such-routes.js'] });
  assert.deepEqual(registered, ['./client-booking-routes.js']);
  assert.deepEqual(calls, [['post', '/probe']]);
});

test('a present module without register stops the registration with its name', async () => {
  const copy = await isolatedCopy({ 'site-rekey-routes.js': 'export const routes = [];\n' });
  const { app, calls } = recordingApp();
  await assert.rejects(copy.registerOptionalRoutes(app, {}), /\.\/site-rekey-routes\.js must export register\(app, deps\)/);
  assert.deepEqual(calls, []);
});

test('the real list registers the same way through the shared function', async () => {
  // The function exported by the real file honours the modules option: only absent names given.
  const { app, calls } = recordingApp();
  const absent = RESERVED.filter((name) => !existsSync(join(routesDir, name)));
  assert.deepEqual(await registerOptionalRoutes(app, {}, { modules: absent }), []);
  assert.deepEqual(calls, []);
});
