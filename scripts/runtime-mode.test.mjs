import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'asoldi-runtime-mode-'));
process.env.APP_DATA_DIR = dataDir;

const { isHostingerRuntime, parseSafeModeAllow, safeModeState, SAFE_MODE_ALLOW_KEYS } = await import('../lib/runtime-mode.js');
const persistentEnv = await import('../lib/persistent-env.js');

const PC = { cwd: 'C:\\Asoldi\\asoldi code\\asoldi-website', home: 'C:\\Users\\Damian' };

test('isHostingerRuntime: 6-case matrix', () => {
  // 1. Windows PC, no flag
  assert.equal(isHostingerRuntime({ env: {}, ...PC }), false);
  // 2. HOSTINGER flag
  assert.equal(isHostingerRuntime({ env: { HOSTINGER: '1' }, ...PC }), true);
  // 3. Hostinger app cwd
  assert.equal(isHostingerRuntime({ env: {}, cwd: '/home/u1/domains/asoldi.com/nodejs', home: '/root' }), true);
  // 4. Hostinger home only (real account id shape)
  assert.equal(isHostingerRuntime({ env: {}, cwd: '/srv/app', home: '/home/u123456789/domains/asoldi.com' }), true);
  // 5. Linux dev box / Docker container: not Hostinger
  assert.equal(isHostingerRuntime({ env: {}, cwd: '/app', home: '/root' }), false);
  // 6. A user called "ubuntu" is not a Hostinger account
  assert.equal(isHostingerRuntime({ env: {}, cwd: '/home/ubuntu/asoldi', home: '/home/ubuntu' }), false);
  // APP_URL=https://asoldi.com is no signal at all
  assert.equal(isHostingerRuntime({ env: { APP_URL: 'https://asoldi.com' }, ...PC }), false);
  // A data dir on the Hostinger account is a third, independent signal
  assert.equal(isHostingerRuntime({ env: { APP_DATA_DIR: '/home/u123456789/domains/asoldi.com/.asoldi-website-data' }, cwd: '/srv/x', home: '/root' }), true);
  assert.equal(isHostingerRuntime({ env: { APP_DATA_DIR: 'C:/Asoldi/asoldi code/asoldi-website/.local-data/default' }, ...PC }), false);
});

// The live asoldi.com process (October 2026): Hostinger's git deploy runs each build from
// <home>/hbuilds/versions/<build uuid>/, HOME is the site folder, the data dir is HOME/.asoldi-website-data,
// and the panel env has no HOSTINGER, APP_DATA_DIR or DATA_DIR. <home>/nodejs is an older, unused copy.
const LIVE_HOME = '/home/u412345678/domains/asoldi.com';
const LIVE_BUILD = `${LIVE_HOME}/hbuilds/versions/6f1c2a9e-3b7d-4c11-9a52-0e8d7f4b2c13`;
const LIVE_SHAPES = [
  { what: 'build folder cwd, site HOME', cwd: LIVE_BUILD, home: LIVE_HOME },
  { what: 'build folder cwd with a trailing slash', cwd: `${LIVE_BUILD}/`, home: LIVE_HOME },
  { what: 'build folder cwd, HOME unknown', cwd: LIVE_BUILD, home: '' },
  { what: 'site HOME only (cwd somewhere else)', cwd: '/tmp', home: LIVE_HOME },
  { what: 'old nodejs folder', cwd: `${LIVE_HOME}/nodejs`, home: LIVE_HOME },
  { what: 'old nodejs folder, HOME unknown', cwd: `${LIVE_HOME}/nodejs`, home: '' },
  { what: 'nodejs folder of a site outside /home/u<digits>', cwd: '/var/www/domains/asoldi.com/nodejs', home: '' },
];

test('isHostingerRuntime: the live asoldi.com path shapes count as Hostinger with an empty env', () => {
  for (const shape of LIVE_SHAPES) {
    assert.equal(isHostingerRuntime({ env: {}, cwd: shape.cwd, home: shape.home }), true, shape.what);
    const state = safeModeState({ APP_URL: 'https://asoldi.com' }, { cwd: shape.cwd, home: shape.home });
    assert.equal(state.on, false, `${shape.what}: safe mode off`);
    assert.equal(state.reason, 'Hostinger runtime', shape.what);
    assert.equal(persistentEnv.isDurableEnvHost({}, { cwd: shape.cwd, home: shape.home }), true, `${shape.what}: production.env kept`);
  }
});

test('isHostingerRuntime: Windows paths and ordinary /home/<name> paths are never Hostinger', () => {
  const notHostinger = [
    { cwd: 'C:\\Asoldi\\asoldi code\\asoldi-website', home: 'C:\\Users\\Damian' },
    { cwd: 'C:/Asoldi/asoldi code/_wt/w1b/hub-ship/asoldi-website', home: 'C:/Users/Damian' },
    // Windows paths that copy the Hostinger layout are still Windows paths.
    { cwd: 'C:\\home\\u412345678\\domains\\asoldi.com\\hbuilds\\versions\\x', home: 'C:\\Users\\Damian' },
    { cwd: 'C:\\Users\\Damian\\domains\\asoldi.com\\nodejs', home: 'C:\\Users\\Damian' },
    { cwd: 'D:/home/u412345678/domains/asoldi.com/nodejs', home: 'D:/home/u412345678' },
    { cwd: '\\\\server\\share\\home\\u1\\domains\\asoldi.com\\nodejs', home: 'C:\\Users\\Damian' },
    { cwd: 'domains/asoldi.com/nodejs', home: '' },
    { cwd: '/home/damian/asoldi-website', home: '/home/damian' },
    { cwd: '/home/ubuntu/domains/asoldi.com/hbuilds/versions/abc', home: '/home/ubuntu' },
    { cwd: '/home/user/domains/asoldi.com', home: '/home/user' },
    { cwd: '/home/u/domains/asoldi.com', home: '/home/u' },
    { cwd: '/home/u412345678x/app', home: '/home/u412345678x' },
    { cwd: '/srv/home/u412345678/app', home: '/root' },
    { cwd: '/app', home: '/root' },
  ];
  for (const ctx of notHostinger) {
    assert.equal(isHostingerRuntime({ env: {}, ...ctx }), false, `${ctx.cwd} | ${ctx.home}`);
    assert.equal(safeModeState({ APP_URL: 'https://asoldi.com' }, ctx).on, true, `${ctx.cwd}: safe mode on`);
  }
  // A Windows data dir is no signal either, whatever its folder names.
  assert.equal(isHostingerRuntime({ env: { APP_DATA_DIR: 'C:\\home\\u412345678\\.asoldi-website-data' }, cwd: '/app', home: '/root' }), false);
});

test('safeModeState: on by default on a PC, even with the live APP_URL', () => {
  const state = safeModeState({ APP_URL: 'https://asoldi.com', RESEND_API_KEY: 're_x' }, PC);
  assert.equal(state.on, true);
  assert.equal(state.reason, 'not Hostinger');
});

test('safeModeState: off on Hostinger unless HUB_SAFE_MODE=1', () => {
  assert.equal(safeModeState({ HOSTINGER: '1' }, PC).on, false);
  assert.equal(safeModeState({}, { cwd: '/home/u1/domains/asoldi.com/nodejs', home: '/home/u1' }).on, false);
  assert.equal(safeModeState({ HOSTINGER: '1', HUB_SAFE_MODE: '1' }, PC).on, true);
});

test('safeModeState: HUB_SAFE_MODE=0 switches it off explicitly', () => {
  const state = safeModeState({ HUB_SAFE_MODE: '0' }, PC);
  assert.equal(state.on, false);
  assert.equal(state.reason, 'HUB_SAFE_MODE=0');
});

test('HUB_SAFE_MODE_ALLOW: known keys kept, unknown reported, paymentsTest on by default', () => {
  const state = safeModeState({ HUB_SAFE_MODE_ALLOW: 'prodPublish, lan,nonsense' }, PC);
  assert.deepEqual(state.explicitAllow, ['prodPublish', 'lan']);
  assert.deepEqual(state.unknownAllow, ['nonsense']);
  assert.equal(state.allow.has('paymentsTest'), true);
  assert.equal(state.allow.has('aiCalls'), false);
  assert.deepEqual(parseSafeModeAllow('').known, []);
  for (const key of ['aiCalls', 'firefliesIngest', 'accountingWrite', 'stripeWebhookAdmin', 'paidApi', 'imapFlags', 'calendarWrite', 'firefliesLiveJoin', 'prodPublish', 'emailRedirect', 'brevoSend']) {
    assert.ok(SAFE_MODE_ALLOW_KEYS[key], `${key} is documented`);
  }
});

test('isDurableEnvHost: a PC with APP_URL=https://asoldi.com is not production', () => {
  assert.equal(persistentEnv.isDurableEnvHost({ APP_URL: 'https://asoldi.com' }, PC), false);
  assert.equal(persistentEnv.isDurableEnvHost({ APP_URL: 'https://asoldi.com', HOSTINGER: '1' }, PC), true);
  assert.equal(persistentEnv.isDurableEnvHost({}, { cwd: '/home/u1/domains/asoldi.com/nodejs', home: '/home/u1' }), true);
  assert.equal(persistentEnv.isDurableEnvHost({ PERSIST_PRODUCTION_ENV: '1' }, PC), true);
  assert.equal(persistentEnv.isDurableEnvHost({ PERSIST_PRODUCTION_ENV: '0', HOSTINGER: '1' }, PC), false);
});

test('applyPersistentProductionEnv does not write production.env on a PC with the live .env', () => {
  const filePath = join(dataDir, 'production.env');
  const env = { APP_URL: 'https://asoldi.com', RESEND_API_KEY: 're_live_like' };
  const result = persistentEnv.applyPersistentProductionEnv({ env, filePath });
  assert.equal(result.applied, false);
  assert.equal(existsSync(filePath), false);
});

test.after(() => {
  rmSync(dataDir, { recursive: true, force: true });
});
