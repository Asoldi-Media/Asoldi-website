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
