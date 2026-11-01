// The automatic-post scheduler gate (lib/local-blog-brief.js localBlogAutoPostsEnabled, the
// blogEnabled flag of the local-blog brief a client CMS polls) behind seo.jobGating:
// in auto the feature key decides, so an override {'blog.autoPosts': false} (or the older name
// 'blog.localPosts') stops the scheduler; off and shadow keep the old gate. Every business is made up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'asoldi-seo-blog-scheduler-'));
process.env.APP_DATA_DIR = dataDir;

const { buildLocalBlogBrief, legacyLocalBlogAutoPostsEnabled, localBlogAutoPostsEnabled } = await import('../lib/local-blog-brief.js');
const { normalizeSite } = await import('../data/hub-model.js');
const { saveAutomationSettings, invalidateAutomationSettingsCache } = await import('../data/automation-settings.js');
const gating = await import('../lib/seo-ops/job-gating.js');

function setGating(patch) {
  const saved = saveAutomationSettings({ seo: { jobGating: patch } }, { by: 'test' });
  assert.equal(saved.ok, true, JSON.stringify(saved.errors));
  invalidateAutomationSettingsCache();
}

const tier2 = (extra = {}) => normalizeSite({
  id: 'blog-site-1',
  site_key: 'blog-site-1',
  name: 'Eksempel Kafé',
  domain: 'kafe.example.com',
  websitePlan: 'tier-2-seo',
  features: { users: true, analytics: true, ecommerce: false, blog: true, socialSync: false, emailMarketing: false, general: true },
  ...extra,
});
const brief = (site) => buildLocalBlogBrief({ site }).blogEnabled;

test('default (off): the old gate decides, overrides are not read', () => {
  gating.resetDecisionDiffStateForTests();
  assert.equal(gating.seoJobGatingMode(), 'off');
  const site = tier2({ ext: { seoFeatureOverrides: { 'blog.autoPosts': false } } });
  assert.equal(site.ext.seoFeatureOverrides['blog.autoPosts'], false, 'ext survives the site normalizer');
  assert.equal(legacyLocalBlogAutoPostsEnabled(site), true);
  assert.equal(localBlogAutoPostsEnabled(site), true);
  assert.equal(brief(site), true);
  assert.deepEqual(gating.readDecisionDiff(), {});
});

test('auto: the override blog.autoPosts=false stops the scheduler', () => {
  setGating({ enabled: true, mode: 'auto' });
  assert.equal(gating.seoJobGatingMode(), 'auto');
  assert.equal(brief(tier2()), true, 'a tier-2 site without an override keeps automatic posts');
  assert.equal(brief(tier2({ ext: { seoFeatureOverrides: { 'blog.autoPosts': false } } })), false);
  assert.equal(brief(tier2({ ext: { seoFeatureOverrides: { 'blog.localPosts': false } } })), false, 'the older name works too');
  assert.equal(localBlogAutoPostsEnabled({ ...tier2(), seoFeatureOverrides: { 'blog.autoPosts': false } }), false, 'an override on the site itself');
  assert.equal(brief(tier2({ websitePlan: 'tier-1-standard' })), false, 'tier 1 has no automatic posts');
});

test('auto: a site whose blog module is off gets no automatic posts on any tier', () => {
  setGating({ enabled: true, mode: 'auto' });
  const blogOff = (websitePlan) => tier2({ websitePlan, features: { ...tier2().features, blog: false } });
  for (const plan of ['tier-2-seo', 'tier-3-ecommerce']) {
    const site = blogOff(plan);
    assert.equal(site.features.blog, false);
    assert.equal(brief(site), false, plan);
    const decision = gating.featureKeyDecision(site, 'blog-scheduler');
    assert.deepEqual([decision.allowed, decision.key], [false, 'blog.autoPosts']);
    assert.match(decision.reason, /blog module is off/);
  }
  assert.equal(brief(tier2({ websitePlan: 'tier-3-ecommerce' })), true, 'with the blog on, tier 3 keeps automatic posts');
  assert.equal(gating.featureKeyDecision(blogOff('tier-2-seo'), 'rank-tracker.maps').allowed, true, 'only the blog job needs the blog module');
});

test('a paused switch counts as off', () => {
  setGating({ enabled: true, mode: 'auto' });
  const settings = { seo: { jobGating: { enabled: true, mode: 'auto', paused: { at: '2026-11-01T00:00:00.000Z', reason: 'test', by: 'test' } } } };
  assert.equal(gating.seoJobGatingMode({ settings }), 'off');
  assert.equal(localBlogAutoPostsEnabled(tier2({ ext: { seoFeatureOverrides: { 'blog.autoPosts': false } } }), { settings }), true);
});

test('shadow: the old gate decides and the different decision is logged, then cleared once they agree', async () => {
  setGating({ enabled: true, mode: 'shadow' });
  gating.resetDecisionDiffStateForTests();
  const site = tier2({ ext: { seoFeatureOverrides: { 'blog.autoPosts': false } } });
  assert.equal(brief(site), true, 'the old gate still decides');
  await gating.flushDecisionDiff();
  const rows = gating.readDecisionDiff();
  assert.deepEqual(Object.keys(rows), ['blog-scheduler|blog-site-1']);
  assert.equal(rows['blog-scheduler|blog-site-1'].legacy, true);
  assert.equal(rows['blog-scheduler|blog-site-1'].next, false);
  assert.equal(rows['blog-scheduler|blog-site-1'].key, 'blog.autoPosts');
  // The same decision again within a day writes nothing new.
  brief(site);
  await gating.flushDecisionDiff();
  assert.equal(gating.readDecisionDiff()['blog-scheduler|blog-site-1'].count, 1);
  // The override goes: both gates agree and the row is removed.
  assert.equal(brief(tier2()), true);
  await gating.flushDecisionDiff();
  assert.deepEqual(gating.readDecisionDiff(), {});
  setGating({ enabled: false, mode: 'shadow' });
});
