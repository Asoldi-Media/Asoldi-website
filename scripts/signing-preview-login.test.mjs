// Preview signing as the live site does it: the client creates an Asoldi login (or signs in to an
// existing one) on the preview and signs without a handwritten signature line. A safe-mode hub booted
// on the signing seed runs that flow with the signing switch off, in shadow and in auto: off and
// shadow sign the way the live site does, auto signs through the signer, and in every mode the login
// is created or checked, the offer is accepted under that login and one pre-workshop mail goes out.
//
// node --test scripts/signing-preview-login.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MODULE_DIR = mkdtempSync(join(tmpdir(), 'asoldi-preview-login-modules-'));
process.env.APP_DATA_DIR = MODULE_DIR;

const { bootHub } = await import('./safe-mode/hub-boot.mjs');
const flows = await import('./fixtures/signing-flows.mjs');
const { buildPreWorkshopEmail } = await import('../lib/sales-email.js');

const SEED_DIR = mkdtempSync(join(tmpdir(), 'asoldi-preview-login-seed-'));
const seed = flows.seedSigningData(SEED_DIR);
const C = seed.clients;
test.after(() => {
  rmSync(SEED_DIR, { recursive: true, force: true });
  rmSync(MODULE_DIR, { recursive: true, force: true });
});

const SIGNUP = { email: `${C.preview}-owner@example.com`, password: 'Preview-local-1234', name: 'Kari Example' };
const LOGIN = { email: `${C.portalFresh}@example.com`, password: 'Fresh-local-1234' };
const AGREED = { accepted: true, termsAccepted: true, bindingAccepted: true };
const JSON_HEADERS = { 'content-type': 'application/json' };

function settingsFor(mode) {
  if (mode === 'off') return null;
  return {
    pilotClientIds: [C.preview, C.portalFresh, C.portal],
    signing: { enabled: true, mode, paused: null },
    releases: { signing: { passedAt: '2026-10-31T10:00:00.000Z', suite: 'signing-test', evidence: '', by: 'test' } },
  };
}

function readAudit(dir) {
  const folder = join(dir, 'delivery-audit');
  if (!existsSync(folder)) return [];
  return readdirSync(folder).flatMap((name) => readFileSync(join(folder, name), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)));
}

async function post(hub, path, body, headers = JSON_HEADERS) {
  const res = await fetch(`${hub.base}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { raw: text.slice(0, 200) };
  }
  return { status: res.status, body: parsed };
}

async function runMode(mode) {
  const hub = await bootHub(flows.BOOT_ENV, {
    seed: (dir) => {
      cpSync(SEED_DIR, dir, { recursive: true });
      const settings = settingsFor(mode);
      if (settings) writeFileSync(join(dir, 'automation-settings.json'), `${JSON.stringify(settings, null, 2)}\n`);
    },
  });
  try {
    assert.equal(hub.health?.safeMode, true, hub.log().slice(-3000));
    // A login that does not exist yet is refused and signs nothing.
    const unknown = await post(hub, `/api/public/sales-preview/${C.portal}/contract/accept`, { ...AGREED, mode: 'login', email: 'nobody@example.com', password: 'Nobody-local-1234' });
    // A new login made on the preview, with no signature field in the request.
    const signup = await post(hub, `/api/public/sales-preview/${C.preview}/contract/accept`, { ...AGREED, mode: 'signup', ...SIGNUP });
    // An existing login used on the preview.
    const registered = await post(hub, '/api/client-auth/register', { email: LOGIN.email, password: LOGIN.password });
    const login = await post(hub, `/api/public/sales-preview/${C.portalFresh}/contract/accept`, { ...AGREED, mode: 'login', ...LOGIN });
    const signIn = await post(hub, '/api/client-auth/login', { email: SIGNUP.email, password: SIGNUP.password });
    const outbox = await flows.settledOutbox(hub.dataDir);
    return {
      unknown,
      signup,
      registered,
      login,
      signIn,
      outbox,
      clients: flows.readJsonFile(hub.dataDir, 'sales-clients.json', []),
      offers: flows.readJsonFile(hub.dataDir, 'client-offers.json', []),
      audit: readAudit(hub.dataDir),
    };
  } finally {
    await hub.stop();
  }
}

const runs = {};
for (const mode of ['off', 'shadow', 'auto']) {
  test(`preview signing with a new or an existing login, signing ${mode}`, async () => {
    const run = await runMode(mode);
    runs[mode] = run;
    const client = (id) => run.clients.find((entry) => entry.id === id);
    const offer = (id) => run.offers.find((entry) => entry.salesClientId === id);

    assert.equal(run.unknown.status, 404, JSON.stringify(run.unknown.body));
    assert.notEqual(client(C.portal)?.progression?.contractSigned, true, 'a refused login signs nothing');

    assert.equal(run.signup.status, 200, JSON.stringify(run.signup.body));
    assert.equal(run.registered.status, 201, JSON.stringify(run.registered.body));
    assert.equal(run.login.status, 200, JSON.stringify(run.login.body));
    assert.equal(run.signIn.status, 200, 'the login made on the preview signs in to the portal');

    for (const [id, email] of [[C.preview, SIGNUP.email], [C.portalFresh, LOGIN.email]]) {
      assert.equal(client(id)?.progression?.contractSigned, true, `${id} is signed`);
      assert.equal(offer(id)?.acceptance?.email, email, `${id}'s offer is accepted under the preview login`);
      const subject = buildPreWorkshopEmail({ businessName: client(id).businessName }, {}, { hasTime: false }).subject;
      const mails = run.outbox.filter((row) => (row.to || []).some((to) => String(to).toLowerCase() === `${id}@example.com`) && row.subject === subject);
      assert.equal(mails.length, 1, `${id} gets one pre-workshop mail`);
    }

    const signerRows = run.audit.filter((row) => row.kind === 'signing' && row.source === 'preview-accept');
    const shadowRows = run.audit.filter((row) => row.kind === 'signing-shadow' && row.source === 'preview-accept');
    if (mode === 'auto') {
      assert.deepEqual(signerRows.map((row) => row.clientId).sort(), [C.portalFresh, C.preview].sort(), 'the signer signed both preview clients');
      for (const id of [C.preview, C.portalFresh]) {
        assert.equal(client(id)?.sitePlan?.status, 'active', `${id} has the plan in force`);
        assert.ok(client(id)?.delivery?.stage, `${id} has a delivery stage`);
      }
    } else {
      assert.deepEqual(signerRows, [], `no signer write while signing is ${mode}`);
      assert.equal(client(C.preview)?.sitePlan, undefined, 'no plan written');
    }
    if (mode === 'shadow') {
      assert.deepEqual(shadowRows.map((row) => row.clientId).sort(), [C.portalFresh, C.preview].sort(), 'shadow records what the signer would do');
    } else {
      assert.deepEqual(shadowRows, []);
    }
  });
}

// Times, tokens and new user ids differ between two boots; everything else must match.
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, ['acceptedAt', 'token', 'id'].includes(key) ? typeof inner : stable(inner)]));
}

test('off and shadow answer the preview client exactly alike', () => {
  assert.ok(runs.off && runs.shadow, 'both runs finished');
  for (const key of ['unknown', 'signup', 'registered', 'login', 'signIn']) {
    assert.deepEqual(stable(runs.shadow[key]), stable(runs.off[key]), `${key} answers alike`);
  }
});
