// WS6.8 cms-spec endpoint, validator and prompt; WS7.31 email section. Runs the real routes and data
// modules on a temp data dir behind a fake adminAuth and a fake Maker token check.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'asoldi-cms-spec-'));
process.env.APP_DATA_DIR = DATA_DIR;

const express = (await import('express')).default;
const hub = await import('../data/hub.js');
const { registerCmsFeatureRoutes } = await import('../lib/routes/cms-feature-routes.js');
const { cmsFeatureRegistry } = await import('../lib/cms-entitlements.js');
const { cmsSpecPrompt, mergeFeatureSpec, mergeSections, PROMPT_LIMIT } = await import('../lib/cms-spec.js');
const { SECTION_NAMES, SECTION_OWNERS, validateCmsSpec, validateSection } = await import('../lib/cms-spec-schema.js');
const registry = cmsFeatureRegistry();
const quiet = { warn() {}, error() {}, log() {} };

const ALL_ON = { users: true, analytics: true, ecommerce: true, blog: true, socialSync: true, emailMarketing: true, general: true };
function seedSites() {
  writeFileSync(join(DATA_DIR, 'sites.json'), JSON.stringify([
    { id: 't3', site_key: 'key-t3', domain: 'shop.test', name: 'Shop', websitePlan: 'tier-3-ecommerce', features: ALL_ON, ecommerceCatalogType: 'normal' },
    { id: 't1', site_key: 'key-t1', domain: 'plain.test', name: 'Plain', websitePlan: 'tier-1-standard', features: { users: true } },
  ], null, 2));
}
seedSites();

const app = express();
app.use(express.json({ limit: '2mb' }));
const adminAuth = (req, res, next) => {
  if (req.get('authorization') !== 'Bearer admin') return res.status(401).json({ message: 'Unauthorized' });
  req.admin = { username: 'superadmin' };
  next();
};
registerCmsFeatureRoutes(app, {
  adminAuth,
  hub,
  sales: { getSalesClients: () => [] },
  isMakerAuthorized: (req) => req.get('x-maker-callback-token') === 'maker-ok',
  log: quiet,
});
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => {
  server.close();
  rmSync(DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function call(method, path, body, headers = { authorization: 'Bearer admin' }) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { json = null; }
  return { status: res.status, body: json };
}
const put = (body, headers) => call('PUT', '/api/hub/sites/t3/cms-spec', body, headers);
const paths = (res) => (res.body?.errors || []).map((e) => e.path);
const storedSite = () => JSON.parse(readFileSync(join(DATA_DIR, 'sites.json'), 'utf8')).find((s) => s.id === 't3');

test('unknown feature keys and service ids are refused with the exact path (a)', async () => {
  const key = await put({ featureSpec: { defaults: { 'shop.foo': true } } });
  assert.equal(key.status, 400);
  assert.deepEqual(paths(key), ['featureSpec.defaults.shop.foo']);
  const service = await put({ featureSpec: { grantServices: ['nettbutikk'] } });
  assert.equal(service.status, 400);
  assert.deepEqual(paths(service), ['featureSpec.grantServices[0]']);
  assert.equal('featureSpec' in storedSite(), false, 'nothing stored');
});

test('only canonical values pass: an alias value or an alias key is refused and the answer names the real one (b)', async () => {
  const value = await put({ featureSpec: { values: { 'shop.catalog': 'meny' } } });
  assert.equal(value.status, 400);
  assert.deepEqual(paths(value), ['featureSpec.values.shop.catalog']);
  assert.match(value.body.errors[0].message, /normal, tiers, menu/);
  const alias = await put({ featureSpec: { defaults: { 'blog.localPosts': false } } });
  assert.equal(alias.status, 400);
  assert.match(alias.body.errors[0].message, /Use blog\.autoPosts/);
});

test('a testimonial in content.seed needs evidence (c)', async () => {
  const none = await put({ sections: { 'content.seed': { testimonials: [{ quote: 'Veldig fornøyd', author: 'Kari' }] } } });
  assert.equal(none.status, 400);
  assert.deepEqual(paths(none), ['sections.content.seed.testimonials[0].evidence']);
  const half = await put({ sections: { 'content.seed': { testimonials: [{ fields: { quote: 'Bra', evidence: { type: 'quote' } } }] } } });
  assert.deepEqual(paths(half), ['sections.content.seed.testimonials[0].evidence.transcriptRef']);
  const badUrl = await put({ sections: { 'content.seed': { testimonials: [{ quote: 'Bra', evidence: { type: 'url', url: 'http://example.test/review' } }] } } });
  assert.deepEqual(paths(badUrl), ['sections.content.seed.testimonials[0].evidence.url']);
  const ok = await put({ sections: { 'content.seed': {
    testimonials: [{ quote: 'Bra', author: 'Kari', evidence: { type: 'review', reviewId: 'rv_1' } }],
    faq: [{ question: 'Åpent?', answer: 'Ja' }],
  } } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
});

test('21 changes keep the last 20 history rows, and each part\'s rev goes up only when it changed (d)', async () => {
  seedSites();
  const first = await put({ featureSpec: { grant: ['shop.subscriptions'] }, reason: 'first write' });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.featureSpecRev, 2, 'the lazily migrated spec is rev 1');
  assert.equal(storedSite().cmsSpecHistory[0].migratedFrom, 'legacy flags');
  for (let i = 0; i < 20; i += 1) {
    const res = await put({ sections: { blog: { categories: [`Kategori ${i}`] } }, reason: `change ${i}` });
    assert.equal(res.status, 200);
    assert.equal(res.body.cmsSpecRev, i + 1);
    assert.equal(res.body.featureSpecRev, 2);
  }
  const site = storedSite();
  assert.equal(site.cmsSpecHistory.length, 20);
  assert.equal(site.cmsSpecHistory.at(-1).reason, 'change 19');
  assert.equal(site.cmsSpecHistory[0].reason, 'change 0', 'the first row fell off');
  assert.equal(site.cmsSpec.updatedBy, 'admin:superadmin');
  const same = await put({ sections: { blog: { categories: ['Kategori 19'] } } });
  assert.equal(same.body.changed, false);
  assert.equal(same.body.cmsSpecRev, 20);
  assert.equal(storedSite().cmsSpecHistory.length, 20);
});

test('the prompt for a tier-3 site is at most 12,000 characters and lists the tree and every section (e)', async () => {
  const res = await call('GET', '/api/hub/sites/t3/cms-spec/prompt');
  assert.equal(res.status, 200);
  assert.ok(res.body.length <= 12000, `prompt is ${res.body.length} characters`);
  assert.equal(PROMPT_LIMIT, 12000);
  const { prompt } = res.body;
  assert.match(prompt, /^CMS features v1 rev \d+ plan tier-3-ecommerce/);
  assert.match(prompt, /shop\.checkout \[bool\] E\/on -> ON/);
  assert.equal(prompt.includes('(truncated)'), false);
  for (const name of SECTION_NAMES) assert.ok(prompt.includes(`${name}:`), name);
  assert.match(prompt, /recovery \{enabled bool, steps \[\{delayMinutes\* int 30-43200/);
  for (const plan of ['tier-1-standard', 'tier-2-seo']) {
    assert.ok(cmsSpecPrompt({ id: plan, websitePlan: plan, features: {} }, { registry }).length <= 12000, plan);
  }
});

test('merge rules: lists replace, a grant clears the same revoke, null removes, sections merge and lists in them replace', () => {
  const merged = mergeFeatureSpec(
    { rev: 3, revoke: ['shop.subscriptions', 'shop.giftcards'], defaults: { 'shop.upsell': true, 'shop.preorder': false }, locks: ['shop.upsell'] },
    { grant: ['shop.subscriptions'], defaults: { 'shop.preorder': null, 'shop.discounts': false }, locks: [] },
  );
  assert.deepEqual(merged.grant, ['shop.subscriptions']);
  assert.deepEqual(merged.revoke, ['shop.giftcards']);
  assert.deepEqual(merged.defaults, { 'shop.upsell': true, 'shop.discounts': false });
  assert.deepEqual(merged.locks, []);
  const sections = mergeSections(
    { email: { recovery: { enabled: true, steps: [{ delayMinutes: 60 }, { delayMinutes: 1440 }] }, sender: { name: 'A', replyTo: 'a@b.no' } }, blog: { categories: ['x'] } },
    { email: { recovery: { steps: [{ delayMinutes: 60 }] }, sender: { replyTo: null } }, blog: null, social: { facebook: 'https://facebook.com/x' } },
  );
  assert.deepEqual(sections, {
    email: { recovery: { enabled: true, steps: [{ delayMinutes: 60 }] }, sender: { name: 'A' } },
    social: { facebook: 'https://facebook.com/x' },
  });
});

test('a write based on an old rev gets 409; a contradictory, empty or unknown write gets 400', async () => {
  seedSites();
  assert.equal((await put({ featureSpec: { grant: ['shop.digital'] } })).status, 200);
  const stale = await put({ featureSpec: { rev: 1, grant: [] } });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.revs.featureSpec, 2);
  assert.equal((await put({ featureSpec: { rev: 2, grant: [] } })).status, 200);
  assert.equal((await put({ sections: { email: { recovery: { steps: [{ delayMinutes: 60 }, { delayMinutes: 1440 }] } } } })).status, 200);
  assert.equal((await put({ sections: { blog: { categories: ['a'] } }, cmsSpecRev: 0 })).status, 409);
  // A list inside a section replaces the stored list, so one new step is valid on its own.
  assert.equal((await put({ sections: { email: { recovery: { steps: [{ delayMinutes: 120 }] } } } })).status, 200);
  // A key both granted and revoked is refused.
  assert.equal((await put({ featureSpec: { grant: ['shop.digital'] } })).status, 200);
  const both = await put({ featureSpec: { revoke: ['shop.digital'], grant: ['shop.digital'] } });
  assert.equal(both.status, 400);
  assert.equal((await put({})).status, 400);
  assert.equal((await put({ unknownPart: {} })).status, 400);
});

test('the email section (WS7.31): a cart recovery spec with two steps passes, and each constraint names its path', async () => {
  seedSites();
  const spec = {
    email: {
      rev: 2,
      sender: { name: 'Testbutikken', replyTo: 'kontakt@testbutikken.test' },
      identity: { legalName: 'Testbutikken AS', orgNumber: '123456789', address: 'Gate 1, 8000 Bodø', email: 'kontakt@testbutikken.test' },
      recovery: { enabled: true, steps: [{ delayMinutes: 60 }, { delayMinutes: 20160 }], discount: null },
      ownerNotifications: { checkoutStarted: 'instant' },
      winback: { enabled: true, afterDays: 90 },
      reviewRequest: { enabled: true },
      evidence: { 'recovery.steps': 'Kunden ba om en påminnelse rett etter og en til etter to uker' },
      features: { 'email.automations.winback': true, 'email.notifications.checkoutStarted': true },
    },
  };
  assert.deepEqual(validateCmsSpec({ sections: spec }, { registry }), { ok: true, errors: [] });
  const saved = await put({ sections: spec });
  assert.equal(saved.status, 200);
  assert.deepEqual(storedSite().cmsSpec.sections.email.recovery.steps.map((s) => s.delayMinutes), [60, 20160]);
  assert.equal(storedSite().cmsSpec.sections.email.ownerNotifications.checkoutStarted, 'instant');
  const bad = validateSection('email', {
    recovery: { steps: [{ delayMinutes: 10 }, { delayMinutes: 5000 }, { delayMinutes: 4000 }, { delayMinutes: 50000 }], discount: { type: 'percent', value: 10, validDays: 40 } },
    ownerNotifications: { checkoutStarted: 'sometimes' },
    sender: { replyTo: 'not-an-address' },
    features: { 'shop.discounts': true, 'email.foo': true, 'email.automations.welcome': 'yes' },
    ownProvider: { key: 'x' },
  }, { registry });
  const got = bad.map((e) => e.path).sort();
  for (const path of [
    'sections.email.recovery.steps',
    'sections.email.recovery.steps[0].delayMinutes',
    'sections.email.recovery.steps[2].delayMinutes',
    'sections.email.recovery.discount.validDays',
    'sections.email.ownerNotifications.checkoutStarted',
    'sections.email.sender.replyTo',
    'sections.email.features.shop.discounts',
    'sections.email.features.email.foo',
    'sections.email.features.email.automations.welcome',
    'sections.email.ownProvider',
  ]) assert.ok(got.includes(path), `${path} in ${got.join(', ')}`);
  assert.equal(SECTION_OWNERS.email, 'WS7');
});

test('every route needs Superadmin, or the Maker token once Superadmin allows it; only Superadmin sets enforcement', async () => {
  seedSites();
  for (const [method, path] of [
    ['GET', '/api/hub/sites/t3/cms-spec'], ['GET', '/api/hub/sites/t3/cms-spec/prompt'], ['PUT', '/api/hub/sites/t3/cms-spec'],
    ['GET', '/api/admin/cms-features'], ['PUT', '/api/admin/cms-features/settings'], ['GET', '/api/admin/cms-features/preview'],
  ]) {
    assert.equal((await call(method, path, method === 'PUT' ? {} : undefined, {})).status, 401, `${method} ${path}`);
  }
  const maker = { 'x-maker-callback-token': 'maker-ok' };
  assert.equal((await put({ sections: { blog: { categories: ['a'] } } }, { 'x-maker-callback-token': 'wrong' })).status, 401);
  assert.equal((await put({ sections: { blog: { categories: ['a'] } } }, maker)).status, 403, 'switched off by default');
  assert.equal((await call('GET', '/api/hub/sites/t3/cms-spec', undefined, maker)).status, 403);
  const bad = await call('PUT', '/api/admin/cms-features/settings', { cmsSpec: { makerAccess: 'yes' } });
  assert.equal(bad.status, 400);
  const on = await call('PUT', '/api/admin/cms-features/settings', { settings: { cmsSpec: { makerAccess: true } }, reason: 'spec writer test' });
  assert.equal(on.status, 200);
  assert.equal(on.body.settings.cmsSpec.makerAccess, true);
  const byMaker = await put({ sections: { blog: { categories: ['a'] } } }, maker);
  assert.equal(byMaker.status, 200);
  assert.equal(storedSite().cmsSpec.updatedBy, 'maker');
  assert.equal((await put({ featureEnforcement: 'on' }, maker)).status, 403);
  assert.equal((await put({ featureEnforcement: 'loud' })).status, 400);
  // Setting the mode the site already has changes nothing and writes nothing.
  const sitesBefore = readFileSync(join(DATA_DIR, 'sites.json'), 'utf8');
  const same = await put({ featureEnforcement: 'log' });
  assert.equal(same.status, 200);
  assert.equal(same.body.changed, false);
  assert.equal(readFileSync(join(DATA_DIR, 'sites.json'), 'utf8'), sitesBefore);
  const enforce = await put({ featureEnforcement: 'on', reason: 'seven quiet days' });
  assert.equal(enforce.status, 200);
  assert.equal(enforce.body.featureEnforcement, 'on');
  assert.deepEqual(storedSite().cmsSpecHistory.at(-1).featureEnforcement, { from: 'log', to: 'on' });
  await call('PUT', '/api/admin/cms-features/settings', { cmsSpec: { makerAccess: false } });
});

test('GET cms-spec returns the spec (lazily migrated when none is stored), the resolved tree and what the CMS reported', async () => {
  seedSites();
  hub.recordHeartbeat('key-t1', { packageVersion: '2.3.0', report: { featuresRev: 1, effective: 'users,site', settingsRevApplied: 0 } });
  const res = await call('GET', '/api/hub/sites/t1/cms-spec');
  assert.equal(res.status, 200);
  assert.equal(res.body.featureSpecMigrated, true);
  assert.deepEqual(res.body.featureSpec, { rev: 1 });
  assert.equal(res.body.tree.plan, 'tier-1-standard');
  assert.equal(res.body.tree.legacy.blog, true);
  assert.deepEqual(res.body.cmsReported.effective, ['users', 'site']);
  assert.equal(res.body.siteConfigMode, 'off');
  assert.equal(res.body.featureEnforcement, 'log');
  assert.equal((await call('GET', '/api/hub/sites/nope/cms-spec')).status, 404);
  const preview = await call('GET', '/api/admin/cms-features/preview');
  assert.equal(preview.status, 200);
  assert.equal(preview.body.sites.length, 2);
  for (const row of preview.body.sites) {
    assert.deepEqual(row.lostFlags, [], row.siteId);
    assert.equal(JSON.stringify(row).includes('key-t'), false, 'no site keys in the preview');
  }
});

test('a cms spec larger than 256 kB is refused with 413', async () => {
  seedSites();
  const entries = Array.from({ length: 200 }, (_, i) => ({ question: `Q${i}`, answer: 'x'.repeat(1500) }));
  const res = await put({ sections: { 'content.seed': { faq: entries } } });
  assert.equal(res.status, 413);
  assert.equal('cmsSpec' in storedSite(), false);
});

test('only own section and field names count, and __proto__, constructor and prototype are refused anywhere and never merged', async () => {
  seedSites();
  // Names found only through Object.prototype are unknown sections.
  const force = validateCmsSpec({ force: ['__proto__', 'constructor', 'toString'] }, { registry });
  assert.deepEqual(force.errors.map((e) => e.path), ['force[0]', 'force[1]', 'force[2]']);
  const removals = validateCmsSpec({ sections: { toString: null, hasOwnProperty: null } }, { registry });
  assert.deepEqual(removals.errors.map((e) => e.path), ['sections.toString', 'sections.hasOwnProperty']);
  assert.match(validateSection('constructor', {})[0].message, /Unknown section/);
  assert.deepEqual(validateSection('general', { toString: 'x' }).map((e) => e.path), ['sections.general.toString']);

  // A JSON body can carry these names as own keys, in any section and in featureSpec.
  const body = JSON.parse('{"sections":{"content.seed":{"__proto__":[{"title":"x"}]},"email":{"evidence":{"constructor":"a"}},'
    + '"wizards":[{"id":"w","__proto__":{"open":true}}],"general":{"__proto__":{"siteName":"x"}}},'
    + '"featureSpec":{"defaults":{"__proto__":true}}}');
  const checked = validateCmsSpec(body, { registry });
  assert.equal(checked.ok, false);
  for (const path of ['featureSpec.defaults.__proto__', 'sections.content.seed.__proto__', 'sections.email.evidence.constructor', 'sections.wizards[0].__proto__', 'sections.general.__proto__']) {
    assert.ok(checked.errors.some((e) => e.path === path), `${path} in ${JSON.stringify(checked.errors)}`);
  }

  // Merges skip them, so merged objects keep the plain prototype and only real keys.
  const merged = mergeSections({ general: { siteName: 'A' } }, JSON.parse('{"general":{"__proto__":{"extra":true},"phone":"1"},"__proto__":{"x":1}}'));
  assert.equal(Object.getPrototypeOf(merged), Object.prototype);
  assert.equal(Object.getPrototypeOf(merged.general), Object.prototype);
  assert.equal(merged.general.extra, undefined);
  assert.deepEqual(merged, { general: { siteName: 'A', phone: '1' } });
  const features = mergeFeatureSpec({}, JSON.parse('{"defaults":{"__proto__":{"x":true},"shop.upsell":true}}'));
  assert.equal(Object.getPrototypeOf(features.defaults), Object.prototype);
  assert.deepEqual(features.defaults, { 'shop.upsell': true });

  // Through the route: refused with the path, nothing stored.
  const res = await put(JSON.parse('{"sections":{"general":{"__proto__":{"siteName":"x"}}},"force":["general"]}'));
  assert.equal(res.status, 400);
  assert.deepEqual(paths(res), ['sections.general.__proto__']);
  assert.equal('cmsSpec' in storedSite(), false);
  const forced = await put({ sections: { general: { siteName: 'Shop' } }, force: ['toString'] });
  assert.equal(forced.status, 400);
  assert.deepEqual(paths(forced), ['force[0]']);
  assert.equal('cmsSpec' in storedSite(), false);
});
