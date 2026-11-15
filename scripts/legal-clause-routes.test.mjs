// The processor clause route for client CMS sites: dark by default (404 disabled before any credential
// check), site credential only (the public site key and a staff session are refused), nothing written
// on any answer, and the clauses follow the effective features.
//
// Run: node --test scripts/legal-clause-routes.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';

const dataDir = mkdtempSync(join(tmpdir(), 'asoldi-legal-clauses-'));
process.env.APP_DATA_DIR = dataDir;
process.env.DATA_DIR = '';
process.env.PERSIST_PRODUCTION_ENV = '0';

const hub = await import('../data/hub.js');
const sc = await import('../lib/site-credentials.js');
const { saveAutomationSettings, getAutomationSettings, invalidateAutomationSettingsCache } = await import('../data/automation-settings.js');
const routes = await import('../lib/routes/legal-clause-routes.js');
const clauses = await import('../lib/legal/processor-clauses.js');

const store = sc.createSiteCredentialStore({ dataDir });
sc.setSiteCredentialStoreForTests(store);

const credential = () => randomBytes(32).toString('base64url');
const enrolled = hub.createSite({ name: 'Eksempel Testbedrift', domain: 'enrolled.example.com' });
const enrolledCredential = credential();
store.enroll(enrolled.id, enrolledCredential, { proofDomain: 'enrolled.example.com', proofOrigin: 'https://enrolled.example.com' });
const revoked = hub.createSite({ name: 'Tilbakekalt Testbedrift', domain: 'revoked.example.com' });
const revokedCredential = credential();
store.enroll(revoked.id, revokedCredential, { proofDomain: 'revoked.example.com', proofOrigin: 'https://revoked.example.com' });
store.revoke(revoked.id, { by: 'test' });
// A site on a CMS version that calls shop routes with its site key alone, never enrolled.
const legacy = hub.createSite({ name: 'Eldre Testbedrift', domain: 'legacy.example.com', websitePlan: 'tier-3-ecommerce' });
hub.recordHeartbeat(legacy.site_key, { packageVersion: '2.1.3' }, { verified: true });

const app = express();
app.use(express.json());
routes.register(app);
const server = await new Promise((resolve) => {
  const s = app.listen(0, '127.0.0.1', () => resolve(s));
});
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => {
  server.close();
  sc.setSiteCredentialStoreForTests(null);
  rmSync(dataDir, { recursive: true, force: true });
});

function setSwitch(patch) {
  const current = getAutomationSettings();
  saveAutomationSettings({ ...current, legalClauses: { ...current.legalClauses, ...patch } }, { by: 'test' });
  invalidateAutomationSettingsCache?.();
}

/** Hash of every file under the data dir: a refused request must leave it as it was. */
function snapshot(dir = dataDir) {
  const hash = createHash('sha256');
  let files = 0;
  const walk = (folder) => {
    for (const name of readdirSync(folder).sort()) {
      const path = join(folder, name);
      if (statSync(path).isDirectory()) walk(path);
      else {
        files += 1;
        hash.update(`${path.slice(dataDir.length)}\0`).update(readFileSync(path));
      }
    }
  };
  walk(dir);
  return { files, digest: hash.digest('hex') };
}

async function get(query = '', headers = {}) {
  const res = await fetch(`${base}/api/hub/legal/clauses${query}`, { headers });
  const text = await res.text();
  let data = text;
  try {
    data = JSON.parse(text);
  } catch {
    /* keep text */
  }
  return { status: res.status, data };
}

const withCredential = { 'x-site-key': enrolled.site_key, 'x-site-credential': enrolledCredential };

test('the switch is off by default: shape {enabled:false, mode:shadow, paused:null}', () => {
  assert.deepEqual(getAutomationSettings().legalClauses, { enabled: false, mode: 'shadow', paused: null });
});

test('while the switch is off every request answers 404 disabled, also with a valid site credential, and writes nothing', async () => {
  const before = snapshot();
  let requests = 0;
  const cases = [
    {},
    withCredential,
    { 'x-site-key': enrolled.site_key },
    { 'x-site-key': 'unknown-key-xxxxxxxx', 'x-site-credential': enrolledCredential },
    { 'x-site-key': legacy.site_key },
  ];
  for (const headers of cases) {
    const res = await get('?features=changeRequests', headers);
    requests += 1;
    assert.equal(res.status, 404);
    assert.deepEqual(res.data, { code: 'disabled' });
  }
  assert.ok(requests > 0);
  assert.deepEqual(snapshot(), before, 'the store is equal before and after');
});

test('a paused switch counts as off', async () => {
  setSwitch({ enabled: true, paused: { reason: 'test' } });
  const res = await get('', withCredential);
  assert.equal(res.status, 404);
  assert.deepEqual(res.data, { code: 'disabled' });
  setSwitch({ enabled: true, paused: null });
});

test('with the switch on, requests without a valid site credential are refused and write nothing', async () => {
  setSwitch({ enabled: true, paused: null });
  const wrong = credential();
  const refused = [
    ['no headers', {}],
    ['site key alone, enrolled site', { 'x-site-key': enrolled.site_key }],
    ['site key alone, never enrolled legacy shop', { 'x-site-key': legacy.site_key }],
    ['wrong credential', { 'x-site-key': enrolled.site_key, 'x-site-credential': wrong }],
    ['malformed credential', { 'x-site-key': enrolled.site_key, 'x-site-credential': 'short' }],
    ['revoked credential', { 'x-site-key': revoked.site_key, 'x-site-credential': revokedCredential }],
    ['credential without a site key', { 'x-site-credential': enrolledCredential }],
    ['a staff session without a site credential', { cookie: 'asoldi_admin=session-token', authorization: 'Bearer staff-token' }],
    ['a staff session with the public site key only', { 'x-site-key': enrolled.site_key, cookie: 'asoldi_admin=session-token' }],
  ];
  let requests = 0;
  for (const [label, headers] of refused) {
    const before = snapshot();
    const res = await get('?features=changeRequests', headers);
    requests += 1;
    assert.equal(res.status, 401, label);
    assert.equal(res.data?.clauses, undefined, label);
    assert.deepEqual(snapshot(), before, `${label}: the store is equal before and after`);
  }
  assert.ok(requests >= 9);
});

test('positive control: the enrolled site gets the clauses of its effective features, marked shadow', async () => {
  setSwitch({ enabled: true, mode: 'shadow', paused: null });
  const plain = await get('?language=nb&features=shop', withCredential);
  assert.equal(plain.status, 200);
  assert.equal(plain.data.ok, true);
  assert.equal(plain.data.mode, 'shadow');
  assert.deepEqual(plain.data.clauses.map((clause) => clause.id), ['processor.base']);
  const withRequests = await get('?language=en&features=shop,changeRequests,not a key,x', withCredential);
  assert.equal(withRequests.status, 200);
  assert.deepEqual(withRequests.data.clauses.map((clause) => clause.id), ['processor.base', 'processor.changeRequests', 'processor.devAgent', 'processor.iteration']);
  assert.match(withRequests.data.clauses[0].title, /processor/i);
  assert.ok(withRequests.data.subprocessors.some((entry) => entry.id === 'hostinger'));
  assert.ok(withRequests.data.subprocessors.some((entry) => entry.id === 'anthropic'));
  assert.equal(withRequests.data.subprocessors.some((entry) => entry.id === 'deepseek'), false, 'a provider that gets no personal data is not named as a recipient');
  assert.notEqual(plain.data.hash, withRequests.data.hash);
  setSwitch({ mode: 'auto' });
  const auto = await get('?language=nb&features=shop', withCredential);
  assert.equal(auto.data.mode, 'auto');
  assert.equal(auto.data.hash, plain.data.hash, 'the mode does not change the clauses');
});

test('the same request twice gives the same answer', async () => {
  const a = await get('?language=nb&features=changeRequests', withCredential);
  const b = await get('?language=nb&features=changeRequests', withCredential);
  assert.deepEqual(a.data, b.data);
});

test('parseFeatures keeps well-formed unique keys only', () => {
  assert.deepEqual(routes.parseFeatures('a, b.c,a,,<script>,x y,' + 'z'.repeat(80)), ['a', 'b.c']);
  assert.deepEqual(routes.parseFeatures(undefined), []);
});

test('every processing feature has a clause, and the check fails when one is missing (negative control)', () => {
  assert.deepEqual(clauses.processingGaps(), []);
  for (const feature of ['changeRequests', 'devAgent', 'iterationProcessing']) {
    assert.ok(clauses.PROCESSING_FEATURES.includes(feature), feature);
  }
  const without = clauses.declaredProcessorClauses().filter((clause) => clause.id !== 'processor.devAgent');
  assert.deepEqual(clauses.processingGaps({ clauses: without }), ['devAgent']);
  const grown = [...clauses.PROCESSING_FEATURES, 'newProcessingFeature'];
  assert.deepEqual(clauses.processingGaps({ required: grown }), ['newProcessingFeature']);
});

test('a clause names only providers the register knows, and the list of AI providers with personal data is not empty', () => {
  const answer = clauses.processorClausesFor({ features: ['changeRequests'], language: 'nb' });
  const text = answer.clauses.find((clause) => clause.id === 'processor.devAgent').paragraphs.join(' ');
  assert.doesNotMatch(text, /\{providers\}/);
  assert.match(text, /Anthropic/);
  assert.doesNotMatch(text, /DeepSeek/);
});
