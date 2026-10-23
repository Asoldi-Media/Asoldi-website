import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import test from 'node:test';
import assert from 'node:assert/strict';

const dataDir = mkdtempSync(join(tmpdir(), 'asoldi-hub-'));
process.env.APP_DATA_DIR = dataDir;

const hub = await import('../data/hub.js');

test('createSite from tier 3 defaults ecommerce and catalog type', () => {
  const site = hub.createSite({
    name: 'Mong Sushi',
    domain: 'mongsushi.no',
    websitePlan: 'tier-3-ecommerce',
    ecommerceCatalogType: 'menu',
    githubRepo: 'damianhch/website---mong-sushi',
  });
  assert.equal(site.features.ecommerce, true);
  assert.equal(site.features.analytics, true);
  assert.equal(site.ecommerceCatalogType, 'menu');
  assert.equal(site.cms.githubRepo, 'damianhch/website---mong-sushi');

  const config = hub.getSiteConfig(site.site_key, false, { includeAdmin: true });
  assert.equal(config.ecommerceCatalogType, 'menu');
  assert.equal(config.websitePlan, 'tier-3-ecommerce');
});

test('createSite reuses an existing site_key or domain', () => {
  const first = hub.createSite({
    name: 'Cafe',
    domain: 'cafe.no',
    site_key: 'fixed-key-cafe',
    websitePlan: 'tier-2-seo',
  });
  const again = hub.createSite({
    name: 'Cafe',
    domain: 'cafe.no',
    site_key: 'fixed-key-cafe',
  });
  assert.equal(again.id, first.id);
  assert.equal(again.site_key, 'fixed-key-cafe');
  assert.equal(again.features.socialSync, true);

  const withRepo = hub.createSite({
    name: 'Cafe',
    domain: 'cafe.no',
    site_key: 'fixed-key-cafe',
    githubRepo: 'Damianhch/website---cafe',
  });
  assert.equal(withRepo.id, first.id);
  assert.equal(withRepo.cms.githubRepo, 'Damianhch/website---cafe');
});

test('heartbeat stores package version and lastSeenAt', () => {
  const site = hub.createSite({ name: 'Shop', domain: 'shop.no', websitePlan: 'tier-1-standard' });
  const result = hub.recordHeartbeat(site.site_key, {
    packageVersion: '1.1.0',
    adminUrl: 'https://shop.no/admin',
  }, { verified: true });
  assert.equal(result.ok, true);
  assert.equal(result.site.cms.packageVersion, '1.1.0');
  assert.equal(result.site.cms.adminUrl, 'https://shop.no/admin');
  assert.ok(result.site.cms.lastSeenAt);

  const missing = hub.recordHeartbeat('not-a-key', { packageVersion: '1.1.0' });
  assert.equal(missing.ok, false);
});

test.after(() => {
  rmSync(dataDir, { recursive: true, force: true });
});
