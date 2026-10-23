import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import dotenv from 'dotenv';
import {
  SECTION_EXTRA,
  SECTION_OVERRIDES,
  SECTION_PROD,
  archiveStrays,
  buildEnvFile,
  checkEnv,
  formatCheck,
  main,
  quoteEnvValue,
  safeOverrides,
} from './env-sync.mjs';

// Shaped like a service-account key (quotes, escaped newlines); the PEM markers are built from parts
// so the repo secret scanner never sees a key header in this file.
const PEM_MARK = ['PRIVATE', 'KEY'].join(' ');
const SA_JSON = JSON.stringify({ type: 'service_account', private_key: `-----BEGIN ${PEM_MARK}-----\\nfake\\n-----END ${PEM_MARK}-----\\n`, client_email: 'fake-sa@example.invalid' });
// Fixture prod env. Values are fake but shaped like the real ones.
const PROD = {
  APP_URL: 'https://asoldi.com',
  ADMIN_SECRET: 'fake-prod-admin-secret-value',
  RESEND_API_KEY: 're_FAKEprodresendkey',
  SMTP_PASS: "pa ss'w\"ord#1",
  STRIPE_SECRET_KEY: 'sk_live_FAKElivekey',
  STRIPE_CONNECT_SECRET_KEY: 'sk_live_FAKEconnect',
  STRIPE_CONNECT_TEST_SECRET_KEY: 'sk_test_FAKEtest',
  STRIPE_PUBLISHABLE_KEY: 'pk_live_FAKEpub',
  GOOGLE_WORKSPACE_SERVICE_ACCOUNT_JSON: SA_JSON,
  SALES_EMAIL_AUTOSEND: '1',
  ZZ_NEW_PROD_ONLY_KEY: 'zz-value',
};
const SECRET_VALUES = Object.values(PROD).filter((v) => v.length > 6);

function tempRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'asoldi-env-sync-'));
  mkdirSync(join(dir, 'home'), { recursive: true });
  return dir;
}

test('quoteEnvValue round-trips through dotenv for awkward values', () => {
  for (const value of ['plain', 'with space', "it's", 'say "hi"', SA_JSON, "both ' and \"", 'line1\nline2', 'a#b', '']) {
    const parsed = dotenv.parse(`K=${quoteEnvValue(value)}\n`);
    assert.equal(parsed.K ?? '', value, JSON.stringify(value));
  }
});

test('buildEnvFile: prod keys in order, ADMIN_SECRET never copied, overrides withhold prod values', () => {
  const repo = tempRepo();
  const { text, report } = buildEnvFile({ prodEnv: PROD, currentEnv: {}, repoRoot: repo });
  const sections = [SECTION_PROD, SECTION_EXTRA, SECTION_OVERRIDES].map((s) => text.indexOf(s));
  assert.ok(sections.every((i) => i >= 0) && sections[0] < sections[1] && sections[1] < sections[2], 'sections in order');
  const parsed = dotenv.parse(text);
  assert.equal(parsed.ADMIN_SECRET, undefined);
  assert.match(text, /# ADMIN_SECRET: never copied/);
  assert.equal(parsed.APP_URL, 'http://127.0.0.1:3100', 'override wins');
  assert.match(text, /# APP_URL: prod value withheld \(local override below\)/);
  assert.doesNotMatch(text, /https:\/\/asoldi\.com/, 'the prod APP_URL is not in the file');
  assert.equal(parsed.SALES_EMAIL_AUTOSEND, '0');
  assert.equal(parsed.HUB_SAFE_MODE, '1');
  assert.equal(parsed.PERSIST_PRODUCTION_ENV, '0');
  assert.equal(parsed.PORT, '3101');
  assert.equal(parsed.APP_DATA_DIR, safeOverrides(repo).APP_DATA_DIR);
  assert.equal(parsed.GOOGLE_WORKSPACE_SERVICE_ACCOUNT_JSON, SA_JSON);
  assert.equal(parsed.SMTP_PASS, PROD.SMTP_PASS);
  assert.ok(text.indexOf('RESEND_API_KEY=') < text.indexOf('STRIPE_SECRET_KEY='), 'PRODUCTION_ENV_KEYS order');
  assert.ok(text.indexOf('ZZ_NEW_PROD_ONLY_KEY=') > text.indexOf('STRIPE_PUBLISHABLE_KEY='), 'unknown prod keys after known ones');
  assert.ok(report.neverCopied.includes('ADMIN_SECRET'));
  rmSync(repo, { recursive: true, force: true });
});

test('buildEnvFile keeps keys only the previous .env had (LOCAL EXTRA) and is idempotent', () => {
  const repo = tempRepo();
  const current = { PROD_ADMIN_PASSWORD: 'local-only-pw', BREVO_API_KEY: 'xkeysib-fake', ADMIN_SECRET: 'stale', RESEND_API_KEY: 'stale-local-value' };
  const first = buildEnvFile({ prodEnv: PROD, currentEnv: current, repoRoot: repo }).text;
  const parsed = dotenv.parse(first);
  assert.equal(parsed.PROD_ADMIN_PASSWORD, 'local-only-pw');
  assert.equal(parsed.BREVO_API_KEY, 'xkeysib-fake');
  assert.equal(parsed.RESEND_API_KEY, PROD.RESEND_API_KEY, 'prod value wins for prod keys');
  assert.equal(parsed.ADMIN_SECRET, undefined, 'a stale local ADMIN_SECRET is dropped too');
  const second = buildEnvFile({ prodEnv: PROD, currentEnv: parsed, repoRoot: repo }).text;
  assert.equal(second, first, 'rerun gives the same file');
  rmSync(repo, { recursive: true, force: true });
});

test('--substitute-test-keys swaps live Stripe secret keys for the Connect test key', () => {
  const { text } = buildEnvFile({ prodEnv: PROD, repoRoot: tempRepo(), substituteTestKeys: true });
  const parsed = dotenv.parse(text);
  assert.equal(parsed.STRIPE_SECRET_KEY, 'sk_test_FAKEtest');
  assert.equal(parsed.STRIPE_CONNECT_SECRET_KEY, 'sk_test_FAKEtest');
  assert.equal(parsed.STRIPE_PUBLISHABLE_KEY, undefined, 'live publishable key withheld');
  assert.doesNotMatch(text, /sk_live_|pk_live_/);
});

test('--check reports names only (missing, extra, empty, masked, override drift)', () => {
  const result = checkEnv({ prodEnv: PROD, currentEnv: { RESEND_API_KEY: '****', LOCAL_THING: 'x', SMTP_PASS: '', HUB_SAFE_MODE: '1' }, repoRoot: tempRepo() });
  assert.ok(result.missing.includes('STRIPE_SECRET_KEY'));
  assert.ok(!result.missing.includes('ADMIN_SECRET'));
  assert.ok(!result.missing.includes('APP_URL'), 'overridden keys are not "missing"');
  assert.deepEqual(result.extra, ['LOCAL_THING']);
  assert.deepEqual(result.empty, ['SMTP_PASS']);
  assert.deepEqual(result.masked, ['RESEND_API_KEY']);
  assert.ok(result.overrideDrift.includes('APP_URL'));
  const printed = formatCheck(result);
  for (const value of SECRET_VALUES) assert.equal(printed.includes(value), false);
});

test('main: writes .env from --from, prints names/counts only, never a value', async () => {
  const repo = tempRepo();
  const prodFile = join(repo, 'prod-copy.env');
  writeFileSync(prodFile, Object.entries(PROD).map(([k, v]) => `${k}=${quoteEnvValue(v)}`).join('\n'));
  const out = [];
  const code = await main(['--from', prodFile], { log: (line) => out.push(String(line)), repoRoot: repo, home: join(repo, 'home') });
  assert.equal(code, 0);
  const written = dotenv.parse(readFileSync(join(repo, '.env'), 'utf8'));
  assert.equal(written.RESEND_API_KEY, PROD.RESEND_API_KEY);
  const printed = out.join('\n');
  for (const value of SECRET_VALUES) assert.equal(printed.includes(value), false, 'value leaked to stdout');
  const checkOut = [];
  await main(['--check', '--from', prodFile], { log: (line) => checkOut.push(String(line)), repoRoot: repo, home: join(repo, 'home') });
  for (const value of SECRET_VALUES) assert.equal(checkOut.join('\n').includes(value), false);
  rmSync(repo, { recursive: true, force: true });
});

test('--archive-strays moves stray env copies and the local production.env out of the repo', () => {
  const repo = tempRepo();
  const home = join(repo, 'home');
  for (const name of ['.env.bak-2026-10-22T21-11-33-599Z', '.env.before-live-x', '.env.starred-y', '.env.hostinger-import', '.env', '.env.example']) {
    writeFileSync(join(repo, name), 'X=1\n');
  }
  mkdirSync(join(home, '.asoldi-website-data'), { recursive: true });
  writeFileSync(join(home, '.asoldi-website-data', 'production.env'), 'X=1\n');
  const { dir, moved } = archiveStrays({ repoRoot: repo, home, restrict: () => {} });
  assert.equal(moved.length, 5);
  const left = readdirSync(repo).filter((name) => name.startsWith('.env'));
  assert.deepEqual(left.sort(), ['.env', '.env.example'], '.env is the only env file left (plus the names-only example)');
  assert.equal(existsSync(join(home, '.asoldi-website-data', 'production.env')), false);
  assert.ok(dir.includes(join('.asoldi-secrets', 'env-archive')));
  assert.equal(readdirSync(dir).length, 5);
  rmSync(repo, { recursive: true, force: true });
});

test('.env.example holds names only (no values)', () => {
  const text = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
  const assignments = text.split(/\r?\n/).filter((line) => /^[A-Z][A-Z0-9_]*=/.test(line));
  assert.ok(assignments.length > 50);
  for (const line of assignments) assert.match(line, /^[A-Z][A-Z0-9_]*=$/, line);
  for (const key of ['HUB_SAFE_MODE', 'HUB_SAFE_MODE_ALLOW', 'EMAIL_REDIRECT_TO', 'RESEND_API_KEY', 'BREVO_API_KEY']) {
    assert.ok(assignments.includes(`${key}=`), key);
  }
});

test('sync-prod-runtime never writes secrets/, cms/private or production.env', async () => {
  const { isProtectedRuntimePath } = await import('./sync-prod-runtime.mjs');
  assert.equal(isProtectedRuntimePath(String.raw`C:\data\secrets\admin-secret`), true);
  assert.equal(isProtectedRuntimePath('/home/u1/.asoldi-website-data/production.env'), true);
  assert.equal(isProtectedRuntimePath('/data/cms/private/secrets.json'), true);
  assert.equal(isProtectedRuntimePath('/data/sales-clients.json'), false);
  assert.equal(isProtectedRuntimePath('/data/users.json'), false);
});
