// lib/site-auth.js: the shop routes' site checks, moved out of lib/shop-payments-routes.js with no
// change. moneyAuth needs the site credential always; siteAuth also lets an unenrolled shop on a
// trusted 2.0.0-2.2.1 CMS call with its site key alone.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';

const dataDir = mkdtempSync(join(tmpdir(), 'asoldi-site-auth-'));
process.env.APP_DATA_DIR = dataDir;
writeFileSync(join(dataDir, 'sites.json'), JSON.stringify([
  { id: 'site_enrolled', site_key: 'pk-enrolled-1', domain: 'enrolled.example.com', name: 'Enrolled', features: { ecommerce: true } },
  { id: 'site_legacy', site_key: 'pk-legacy-2', domain: 'legacy.example.com', name: 'Legacy', features: { ecommerce: true }, cms: { packageVersion: '2.2.1' } },
  { id: 'site_new', site_key: 'pk-new-3', domain: 'new.example.com', name: 'New', features: { ecommerce: true }, cms: { packageVersion: '2.3.0' } },
], null, 2));

const { moneyAuth, siteAuth } = await import('../lib/site-auth.js');
const { siteCredentialStore } = await import('../lib/site-credentials.js');
const CREDENTIAL = randomBytes(32).toString('base64url');
siteCredentialStore().enroll('site_enrolled', CREDENTIAL, { proofDomain: 'enrolled.example.com', proofOrigin: 'https://enrolled.example.com' });

async function probe(middleware, headers) {
  const app = express();
  app.get('/probe', middleware, (req, res) => res.json({ siteId: req.shopSite?.id || '' }));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/probe`, { headers });
    return { status: res.status, body: await res.json() };
  } finally {
    server.close();
  }
}

test('moneyAuth: the site credential always, never the site key alone', async () => {
  assert.equal((await probe(moneyAuth, { 'x-site-key': 'pk-enrolled-1', 'x-site-credential': CREDENTIAL })).body.siteId, 'site_enrolled');
  assert.notEqual((await probe(moneyAuth, { 'x-site-key': 'pk-enrolled-1' })).status, 200);
  assert.notEqual((await probe(moneyAuth, { 'x-site-key': 'pk-legacy-2' })).status, 200, 'not even for a legacy shop');
  assert.equal((await probe(moneyAuth, { 'x-site-key': 'unknown' })).status, 401);
});

test('siteAuth: the credential, or the site key alone for an unenrolled shop on a 2.0.0-2.2.1 CMS', async () => {
  assert.equal((await probe(siteAuth, { 'x-site-key': 'pk-enrolled-1', 'x-site-credential': CREDENTIAL })).status, 200);
  assert.notEqual((await probe(siteAuth, { 'x-site-key': 'pk-enrolled-1' })).status, 200, 'an enrolled site needs its credential');
  assert.equal((await probe(siteAuth, { 'x-site-key': 'pk-legacy-2' })).body.siteId, 'site_legacy');
  assert.notEqual((await probe(siteAuth, { 'x-site-key': 'pk-new-3' })).status, 200, 'a newer CMS must enroll');
});

test('the shop routes use the shared checks and keep no copy of their own', () => {
  const source = readFileSync(new URL('../lib/shop-payments-routes.js', import.meta.url), 'utf8');
  assert.match(source, /import \{ moneyAuth, siteAuth \} from '\.\/site-auth\.js';/);
  assert.doesNotMatch(source, /requireSiteCredential\(/);
});
