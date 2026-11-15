// The optional route list (lib/routes/optional-routes.js). Every name is a lib/routes module named
// once; a listed module the build does not contain is skipped without an error, so a build boots with
// any subset of them and server.js needs no new line when one is added; a present module must export
// register(app, deps), is called once with the deps it is given and is reported; a present module
// without register stops the registration with its name. The modules are imported statically and
// registered before the call returns (the host loads server.js with require(), so nothing may wait
// at the top level); the skip and register cases pass their own set of present modules, so they
// hold whichever modules this build contains.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const routesDir = join(here, '..', 'lib', 'routes');
const source = join(routesDir, 'optional-routes.js');
const { OPTIONAL_ROUTE_MODULES, PRESENT_ROUTE_MODULES, registerOptionalRoutes } = await import(pathToFileURL(source).href);

// Route modules reserved in the shared list for features that add their routes later.
const RESERVED = [
  './plan-lifecycle-routes.js',
  './client-booking-routes.js',
  './cms-fleet-routes.js',
  './email-owner-routes.js',
  './site-rekey-routes.js',
];

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
  const { app, calls } = recordingApp();
  const result = registerOptionalRoutes(app, {}, { present: {} });
  assert.deepEqual(result.registered, []);
  assert.deepEqual(await result.ready, []);
  assert.deepEqual(calls, []);
});

test('each reserved module the build does not contain is skipped while a present one around it registers once with its deps', async () => {
  for (const present of RESERVED) {
    const { app, calls } = recordingApp();
    const result = registerOptionalRoutes(app, { marker: 'm1' }, {
      present: { [present]: { register: async (target, deps) => { target.get(`/probe/${deps.marker}`); } } },
    });
    // The route is there when the call returns, not only once the start-up work has settled.
    assert.deepEqual(calls, [['get', '/probe/m1']]);
    assert.deepEqual(result.registered, [present]);
    assert.deepEqual(await result.ready, [present]);
  }
});

test('the modules option limits registration to the names given, absent ones skipped', () => {
  const { app, calls } = recordingApp();
  const result = registerOptionalRoutes(app, {}, {
    modules: ['./site-rekey-routes.js', './client-booking-routes.js', './no-such-routes.js'],
    present: { './client-booking-routes.js': { register: (target) => { target.post('/probe'); } } },
  });
  assert.deepEqual(result.registered, ['./client-booking-routes.js']);
  assert.deepEqual(calls, [['post', '/probe']]);
});

test('a present module without register stops the registration with its name', () => {
  const { app, calls } = recordingApp();
  assert.throws(
    () => registerOptionalRoutes(app, {}, { present: { './site-rekey-routes.js': { routes: [] } } }),
    /\.\/site-rekey-routes\.js must export register\(app, deps\)/,
  );
  assert.deepEqual(calls, []);
});

test('the real list imports every listed module the build contains and skips the names it does not', async () => {
  const onDisk = OPTIONAL_ROUTE_MODULES.filter((name) => existsSync(join(routesDir, name)));
  assert.deepEqual(Object.keys(PRESENT_ROUTE_MODULES), onDisk, 'the present modules are the listed files that exist, in list order');
  for (const name of RESERVED) {
    if (existsSync(join(routesDir, name))) assert.equal(typeof PRESENT_ROUTE_MODULES[name]?.register, 'function', `${name} is in the build but not imported`);
  }
  // The function exported by the real file honours the modules option: only unknown names given.
  const { app, calls } = recordingApp();
  const result = registerOptionalRoutes(app, {}, { modules: ['./no-such-routes.js'] });
  assert.deepEqual(result.registered, []);
  assert.deepEqual(await result.ready, []);
  assert.deepEqual(calls, []);
});

test('the list also reserves the change request, cursor prompt, dev report and legal clause route modules, after the earlier ones', () => {
  const added = ['./change-request-routes.js', './cursor-prompt-routes.js', './dev-report-routes.js', './legal-clause-routes.js'];
  const lastEarlier = Math.max(...RESERVED.map((name) => OPTIONAL_ROUTE_MODULES.indexOf(name)));
  let previous = lastEarlier;
  for (const name of added) {
    const at = OPTIONAL_ROUTE_MODULES.indexOf(name);
    assert.ok(at > previous, `${name} is missing or out of order`);
    previous = at;
  }
  // A listed module the build does not contain is skipped, so naming them changes nothing until a file exists.
  for (const name of added) {
    if (!existsSync(join(routesDir, name))) assert.equal(PRESENT_ROUTE_MODULES[name], undefined, `${name} is imported without a file`);
  }
});
