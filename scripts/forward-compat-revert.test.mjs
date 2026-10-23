// WS8.44 revert test: data written by a later batch survives ordinary writes by this code.
//
// The fixture data dir holds every key in data/normalize-ext.js (what later batches write). A child
// process runs the hub data layer against it and performs one client update, makerRun and hubSite
// merges, site updates (with and without a cms patch), a heartbeat, the delivery-phase reconcile,
// an offer update and a rep-style product edit. Then every key must still be there, unchanged.
//
// By default the child runs this working tree (the code a later batch would be reverted to).
// FORWARD_COMPAT_REF=<git ref> runs that commit instead, extracted with `git archive` into
// build/forward-compat-<sha>/ (ignored), so a batch-N branch can prove its keys survive the
// batch-(N-1) commit: FORWARD_COMPAT_REF=<previous deploy> node --test scripts/forward-compat-revert.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FUTURE_CLIENT_KEYS,
  FUTURE_HUBSITE_KEYS,
  FUTURE_MAKERRUN_KEYS,
  FUTURE_MAKERRUN_STEP_KEYS,
  FUTURE_OFFER_ALTERNATIVE_KEYS,
  FUTURE_OFFER_KEYS,
  FUTURE_OFFER_PRODUCT_KEYS,
  FUTURE_SITE_CMS_KEYS,
  FUTURE_SITE_KEYS,
} from '../data/normalize-ext.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const writer = join(root, 'scripts', 'fixtures', 'forward-compat-writer.mjs');

// When a batch starts owning a key (normalizing it itself), give the key a realistic sample here,
// so the default working-tree run keeps passing; the sample must survive that batch's normalizer.
// WS6.7 / WS6.8 own the feature spec fields on a site and the CMS-reported fields in site.cms.
const AT = '2026-11-01T10:00:00.000Z';
const OWNED_SAMPLES = {
  featureSpec: {
    rev: 3, grantServices: ['ecom'], revokeServices: [], grant: ['shop.subscriptions'], revoke: [], locks: [],
    defaults: { 'shop.upsell': true }, values: { 'shop.catalog': 'normal' }, updatedAt: AT, updatedBy: 'admin:test',
  },
  cmsSpec: { rev: 2, sections: { 'shop.seller': { legalName: 'Forward Compat AS' } }, force: [], updatedAt: AT, updatedBy: 'admin:test' },
  cmsSpecHistory: [{ at: AT, by: 'admin:test', featureSpecRev: 3, cmsSpecRev: 2 }],
  featureEnforcement: 'log',
  featuresRev: 3,
  clientFeaturesRev: 1,
  settingsRevApplied: 2,
  settingsConflicts: ['shop.shipping'],
  effective: 'users,site,blog',
  effectiveHash: 'sha256:0123abcd',
  blockHistory: [{ date: '2026-11-01', count: 0, top: [] }],
  migrations: { items: [{ id: '2.3.0-features', status: 'ok', at: AT }], failed: [], pending: [], status: 'ok' },
  lastHeartbeatAt: AT,
};

function sampleFor(key) {
  if (key === 'isTest') return true;
  if (key === 'ext') return { futureBatch: { note: `ext kept (${key})`, n: 7 } };
  if (Object.hasOwn(OWNED_SAMPLES, key)) return structuredClone(OWNED_SAMPLES[key]);
  return { kept: key, nested: { list: [1, 2, 3], at: '2026-11-01T10:00:00.000Z' } };
}

function samples(keys) {
  return Object.fromEntries(keys.map((key) => [key, sampleFor(key)]));
}

const stepSamples = Object.fromEntries(FUTURE_MAKERRUN_STEP_KEYS.map((key) => [key, 'ready']));

function fixtureData() {
  const client = {
    id: 'fc-client',
    product: 'asoldi',
    businessName: 'Forward Compat AS',
    contactPerson: 'Test Person',
    status: 'active',
    progression: { meetingHeld: true, offerSent: true, contractSigned: true },
    contractSignedAt: '2026-10-28T10:02:11.000Z',
    makerRun: {
      runId: 'run-forward-compat',
      steps: { 1: 'ready', 1.5: 'ready', 2: 'partial', 3: 'idle', ...stepSamples },
      ...samples(FUTURE_MAKERRUN_KEYS),
    },
    hubSite: { siteKey: 'fc-site-key', id: 'fc-site', ...samples(FUTURE_HUBSITE_KEYS) },
    ...samples(FUTURE_CLIENT_KEYS),
  };
  const site = {
    id: 'fc-site',
    site_key: 'fc-site-key',
    name: 'Forward Compat',
    domain: 'forward-compat.test',
    websitePlan: 'tier-3-ecommerce',
    deliveryPhase: 'archived',
    cms: { githubRepo: 'org/repo', ...samples(FUTURE_SITE_CMS_KEYS) },
    ...samples(FUTURE_SITE_KEYS),
  };
  const product = (name) => ({ id: `p-${name}`, kind: 'custom', name, priceExMva: 1899, ...samples(FUTURE_OFFER_PRODUCT_KEYS) });
  const offer = {
    id: 'fc-offer',
    salesClientId: 'fc-client',
    status: 'draft',
    products: [product('Site')],
    alternatives: [
      { products: [product('Site')], billing: 'month', ...samples(FUTURE_OFFER_ALTERNATIVE_KEYS) },
      { products: [product('Site + shop')], billing: 'once', ...samples(FUTURE_OFFER_ALTERNATIVE_KEYS) },
    ],
    ...samples(FUTURE_OFFER_KEYS),
  };
  return { client, site, offer };
}

function untar(buffer, destination) {
  let offset = 0;
  let paxPath = '';
  const text = (start, length) => buffer.toString('utf8', start, start + length).replace(/\0.*$/s, '');
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = text(offset, 100);
    const size = parseInt(text(offset + 124, 12).trim() || '0', 8);
    const type = String.fromCharCode(header[156] || 48);
    const prefix = text(offset + 345, 155);
    const body = buffer.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
    if (type === 'x') {
      const match = body.toString('utf8').match(/\d+ path=([^\n]+)\n/);
      paxPath = match ? match[1] : '';
      continue;
    }
    if (type === 'g') continue;
    const path = paxPath || (prefix ? `${prefix}/${name}` : name);
    paxPath = '';
    if (path.includes('..')) throw new Error(`unsafe path in archive: ${path}`);
    const target = join(destination, path);
    if (type === '5') mkdirSync(target, { recursive: true });
    else if (type === '0' || type === '\0') {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, body);
    }
  }
}

function codeRootForRef(ref) {
  const sha = execFileSync('git', ['rev-parse', '--short=12', `${ref}^{commit}`], { cwd: root, encoding: 'utf8' }).trim();
  const destination = join(root, 'build', `forward-compat-${sha}`);
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(destination, { recursive: true });
  const tar = execFileSync('git', ['archive', '--format=tar', sha, 'data', 'lib', 'packages'], { cwd: root, maxBuffer: 256 * 1024 * 1024 });
  untar(tar, destination);
  return { codeRoot: destination, label: `${ref} (${sha})`, cleanup: () => rmSync(destination, { recursive: true, force: true }) };
}

const ref = String(process.env.FORWARD_COMPAT_REF || '').trim();

test(`keys written by later batches survive writes by ${ref ? `commit ${ref}` : 'this working tree'}`, () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'asoldi-forward-compat-'));
  const target = ref ? codeRootForRef(ref) : { codeRoot: root, label: 'working tree', cleanup: () => {} };
  try {
    const { client, site, offer } = fixtureData();
    writeFileSync(join(dataDir, 'sales-clients.json'), JSON.stringify([client], null, 2));
    writeFileSync(join(dataDir, 'sites.json'), JSON.stringify([site], null, 2));
    writeFileSync(join(dataDir, 'sales-offers.json'), JSON.stringify([offer], null, 2));

    const out = execFileSync(process.execPath, [writer, '--code-root', target.codeRoot], {
      cwd: root,
      env: { ...process.env, APP_DATA_DIR: dataDir, DATA_DIR: dataDir },
      encoding: 'utf8',
    });
    const report = JSON.parse(out.trim().split('\n').pop());
    assert.ok(report.done.includes('updateSalesClient'));
    assert.ok(report.done.includes('updateSite'));
    assert.ok(report.done.includes('updateSalesOffer'));

    const [savedClient] = JSON.parse(readFileSync(join(dataDir, 'sales-clients.json'), 'utf8'));
    const [savedSite] = JSON.parse(readFileSync(join(dataDir, 'sites.json'), 'utf8'));
    const [savedOffer] = JSON.parse(readFileSync(join(dataDir, 'sales-offers.json'), 'utf8'));

    // The writes happened.
    assert.equal(savedClient.notes, 'touched by the older code');
    assert.equal(savedClient.hubSite.liveUrl, 'https://forward-compat.test');
    assert.equal(savedSite.name, 'Touched site');
    assert.equal(savedSite.cms.githubRepo, 'org/repo-2');
    assert.equal(savedOffer.adminNote, 'touched by the older code');
    assert.equal(savedOffer.products[0].priceExMva, 2099, 'the product edit applied');

    const lost = [];
    const check = (label, holder, keys) => {
      for (const key of keys) {
        if (JSON.stringify(holder?.[key]) !== JSON.stringify(sampleFor(key))) lost.push(`${label}.${key}`);
      }
    };
    check('client', savedClient, FUTURE_CLIENT_KEYS);
    check('client.makerRun', savedClient.makerRun, FUTURE_MAKERRUN_KEYS);
    check('client.hubSite', savedClient.hubSite, FUTURE_HUBSITE_KEYS);
    for (const key of FUTURE_MAKERRUN_STEP_KEYS) {
      if (savedClient.makerRun?.steps?.[key] !== 'ready') lost.push(`client.makerRun.steps.${key}`);
    }
    check('site', savedSite, FUTURE_SITE_KEYS);
    check('site.cms', savedSite.cms, FUTURE_SITE_CMS_KEYS);
    if (savedSite.deliveryPhase !== 'archived') lost.push(`site.deliveryPhase (now ${savedSite.deliveryPhase})`);
    check('offer', savedOffer, FUTURE_OFFER_KEYS);
    savedOffer.alternatives?.forEach((alternative, index) => {
      check(`offer.alternatives[${index}]`, alternative, FUTURE_OFFER_ALTERNATIVE_KEYS);
      alternative.products?.forEach((item, productIndex) => check(`offer.alternatives[${index}].products[${productIndex}]`, item, FUTURE_OFFER_PRODUCT_KEYS));
    });
    savedOffer.products?.forEach((item, index) => check(`offer.products[${index}]`, item, FUTURE_OFFER_PRODUCT_KEYS));
    assert.equal(savedOffer.alternatives?.length, 2);
    assert.deepEqual(lost, [], `${target.label} dropped keys`);
  } finally {
    target.cleanup();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
