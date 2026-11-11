// seo.jobGating may reach auto only after a release pass whose evidence names the reviewed
// gating diff. Shadow and off need nothing. Automatic posts still need the site's blog module.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'asoldi-seo-gating-release-'));
process.env.APP_DATA_DIR = dataDir;

const settings = await import('../data/automation-settings.js');
const { localBlogAutoPostsEnabled } = await import('../lib/local-blog-brief.js');
const { normalizeSite } = await import('../data/hub-model.js');
const gating = await import('../lib/seo-ops/job-gating.js');

const { saveAutomationSettings, recordReleasePass, validateAutomationSettings, unreleasedAutoSwitches, defaultAutomationSettings, invalidateAutomationSettingsCache } = settings;

function saveGating(patch) {
  const saved = saveAutomationSettings({ seo: { jobGating: patch } }, { by: 'test' });
  invalidateAutomationSettingsCache();
  return saved;
}

const blogSite = (blog) => normalizeSite({
  id: 'blog-gate-1',
  site_key: 'blog-gate-1',
  name: 'Eksempel Kafé',
  domain: 'kafe.example.com',
  websitePlan: 'tier-2-seo',
  features: { users: true, analytics: true, ecommerce: false, blog, socialSync: false, emailMarketing: false, general: true },
});

test('auto without a release pass is refused', () => {
  const saved = saveGating({ enabled: true, mode: 'auto' });
  assert.equal(saved.ok, false);
  assert.ok(saved.errors.some((error) => error.path === 'seo.jobGating'));
  const current = defaultAutomationSettings();
  current.releases['seo.jobGating'] = { passedAt: '2026-11-01T00:00:00.000Z', suite: 'gating-diff', evidence: '', by: 'test' };
  const bare = validateAutomationSettings({ seo: { jobGating: { enabled: true, mode: 'auto' } } }, { current, by: 'test' });
  assert.equal(bare.ok, false);
  assert.ok(unreleasedAutoSwitches(bare.value).includes('seo.jobGating'));
});

test('a pass with empty evidence is refused and does not unlock auto', () => {
  const recorded = recordReleasePass('seo.jobGating', { suite: 'gating-diff', evidence: '   ' });
  assert.equal(recorded.ok, false);
  assert.match(recorded.error, /seo-gating-diff/);
  const saved = saveGating({ enabled: true, mode: 'auto' });
  assert.equal(saved.ok, false);
});

test('shadow and off need no release pass', () => {
  const shadow = saveGating({ enabled: true, mode: 'shadow' });
  assert.equal(shadow.ok, true, JSON.stringify(shadow.errors));
  const off = saveGating({ enabled: false, mode: 'shadow' });
  assert.equal(off.ok, true, JSON.stringify(off.errors));
  const enabledOff = validateAutomationSettings({ seo: { jobGating: { enabled: false, mode: 'auto' } } }, { by: 'test' });
  assert.equal(enabledOff.ok, true, JSON.stringify(enabledOff.errors));
});

test('a pass with evidence allows auto', () => {
  const recorded = recordReleasePass('seo.jobGating', { suite: 'gating-diff', evidence: 'scripts/seo-gating-diff.mjs reviewed: no differing sites' });
  assert.equal(recorded.ok, true, recorded.error || '');
  const saved = saveGating({ enabled: true, mode: 'auto' });
  assert.equal(saved.ok, true, JSON.stringify(saved.errors));
  assert.equal(saved.settings.seo.jobGating.mode, 'auto');
  assert.equal(saved.settings.seo.jobGating.enabled, true);
  assert.equal(unreleasedAutoSwitches(saved.settings).includes('seo.jobGating'), false);
});

test('blog-scheduler stays off for a site whose blog module is off, in auto', () => {
  assert.equal(gating.seoJobGatingMode(), 'auto');
  const off = blogSite(false);
  assert.equal(off.features.blog, false);
  assert.equal(localBlogAutoPostsEnabled(off), false);
  assert.equal(gating.featureKeyDecision(off, 'blog-scheduler').allowed, false);
  assert.match(gating.featureKeyDecision(off, 'blog-scheduler').reason, /blog module is off/);
  assert.equal(localBlogAutoPostsEnabled(blogSite(true)), true);
});
