// Feature-tree editor helpers. Importing the helper fails before this change, and Admin.tsx
// still had the seven inline feature checkboxes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  applyDefaultEnabled,
  applyEnumValue,
  applyLock,
  applyServiceTri,
  applyTriState,
  badgeFlagsForSite,
  diffFeatureSpecs,
  featureEditorModel,
  featureSpecSavePatch,
  flattenFeatureNodes,
  legacyFeaturesWrite,
  legacyFlagsFromEffective,
  serviceTriOf,
  showFeatureTreeEditor,
  showLegacyFeatureFlags,
  triStateOf,
} from '../lib/feature-tree-editor-helpers.js';

const admin = readFileSync(new URL('../app/pages/Admin/Admin.tsx', import.meta.url), 'utf8');
const editor = readFileSync(new URL('../app/pages/Admin/sections/FeatureTreeEditor.tsx', import.meta.url), 'utf8');
const registry = JSON.parse(readFileSync(new URL('../data/cms-feature-tree.json', import.meta.url), 'utf8'));
const meta = JSON.parse(readFileSync(new URL('../data/cms-feature-tree.meta.json', import.meta.url), 'utf8'));

test('tri-state maps both ways and round-trips', () => {
  let spec = { grant: ['shop.upsell'], revoke: ['shop.digital'], grantServices: ['ecom'], revokeServices: ['booking'] };
  assert.equal(triStateOf(spec, 'shop.upsell'), 'grant');
  assert.equal(triStateOf(spec, 'shop.digital'), 'revoke');
  assert.equal(triStateOf(spec, 'blog.posts'), 'inherit');
  assert.equal(serviceTriOf(spec, 'ecom'), 'grant');
  assert.equal(serviceTriOf(spec, 'booking'), 'revoke');

  spec = applyTriState(spec, 'shop.upsell', 'revoke');
  assert.equal(triStateOf(spec, 'shop.upsell'), 'revoke');
  assert.equal(spec.grant.includes('shop.upsell'), false);
  spec = applyTriState(spec, 'shop.upsell', 'inherit');
  assert.equal(triStateOf(spec, 'shop.upsell'), 'inherit');
  spec = applyTriState(spec, 'blog.posts', 'grant');
  assert.deepEqual(triStateOf(spec, 'blog.posts'), 'grant');

  const states = ['shop.digital', 'shop.upsell', 'blog.posts'];
  const read = Object.fromEntries(states.map((key) => [key, triStateOf(spec, key)]));
  let again = { grant: [], revoke: [] };
  for (const [key, state] of Object.entries(read)) again = applyTriState(again, key, state);
  assert.deepEqual(Object.fromEntries(states.map((key) => [key, triStateOf(again, key)])), read);

  spec = applyServiceTri(spec, 'ecom', 'inherit');
  assert.equal(serviceTriOf(spec, 'ecom'), 'inherit');
  spec = applyDefaultEnabled(spec, 'shop.bookings', false, true);
  assert.equal(spec.defaults['shop.bookings'], false);
  spec = applyDefaultEnabled(spec, 'shop.bookings', true, true);
  assert.equal(spec.defaults['shop.bookings'], undefined);
  spec = applyEnumValue(spec, 'shop.catalog', 'menu', 'normal');
  assert.equal(spec.values['shop.catalog'], 'menu');
  spec = applyLock(spec, 'shop.payments.paypal', true);
  assert.ok(spec.locks.includes('shop.payments.paypal'));
});

test('a spec diff lists only the fields that changed', () => {
  const before = { grant: ['shop.upsell'], revoke: [], defaults: { 'shop.bookings': false }, values: { 'shop.catalog': 'normal' }, locks: [] };
  const after = applyTriState(before, 'blog.posts', 'grant');
  const patch = diffFeatureSpecs(before, after);
  assert.deepEqual(patch.grant, ['shop.upsell', 'blog.posts']);
  assert.equal('values' in patch, false);
  assert.equal('defaults' in patch, false);
  const cleared = diffFeatureSpecs(before, { ...before, defaults: {} });
  assert.equal(cleared.defaults['shop.bookings'], null);
});

test('the shipped registry node count is what the editor flattens', () => {
  const flat = flattenFeatureNodes(registry);
  assert.equal(flat.count, registry.nodes.length);
  assert.equal(flat.flat.length, registry.nodes.length);
  assert.equal(flat.count, meta.keyCount);
  assert.ok(flat.count >= 81);
  const model = featureEditorModel(registry, {
    featureSpec: { grant: ['shop.subscriptions'], defaults: { 'shop.upsell': false } },
    featureEnforcement: 'log',
    tree: { plan: 'tier-1-standard', tier: 1, source: 'websitePlan', services: ['site', 'blog'], entitled: ['blog', 'blog.posts'] },
    cmsSpec: { rev: 4 },
  });
  assert.equal(model.count, flat.count);
  assert.equal(model.nodes.length, flat.count);
  assert.equal(model.nodes.find((node) => node.key === 'shop.subscriptions').tri, 'grant');
  assert.equal(model.nodes.find((node) => node.key === 'blog').entitled, true);
  assert.equal(model.nodes.find((node) => node.key === 'shop').entitled, false);
  assert.equal(model.cmsSpecRev, 4);
});

test('legacy badges follow the tree when the site carries one, and the old flags otherwise', () => {
  const flags = legacyFlagsFromEffective(['shop', 'blog', 'email.newsletter', 'users.ranks']);
  assert.equal(flags.users, true);
  assert.equal(flags.ecommerce, true);
  assert.equal(flags.blog, true);
  assert.equal(flags.emailMarketing, true);
  assert.equal(flags.general, true);
  assert.equal(flags.analytics, false);
  assert.equal(flags.socialSync, false);
  const legacy = { users: false, analytics: true, ecommerce: false, blog: true, socialSync: true, emailMarketing: false, general: false };
  assert.deepEqual(badgeFlagsForSite({ features: legacy }), legacy);
  const fromTree = badgeFlagsForSite({ features: legacy, featureTree: { effective: ['analytics'] } });
  assert.equal(fromTree.analytics, true);
  assert.equal(fromTree.socialSync, false);
  assert.equal(fromTree.users, true);
  assert.equal(badgeFlagsForSite({ features: legacy, cms: { effective: 'shop,email.campaigns' } }).ecommerce, true);
});

test('create and update still send the legacy feature keys', () => {
  assert.match(admin, /legacyFeaturesWrite\(editSiteFeatures\)/);
  assert.match(admin, /websitePlan: addSitePlan/);
  assert.match(admin, /Funksjonene settes etter at nettstedet er opprettet/);
  assert.match(admin, /<FeatureTreeEditor siteId=\{editingSiteId\}/);
  assert.match(admin, /Gamle funksjonsflagg/);
  assert.match(admin, /Ecommerce catalog type/);
  assert.match(admin, /editSiteFeatures\.ecommerce/);
  for (const key of ['users', 'analytics', 'ecommerce', 'blog', 'socialSync', 'emailMarketing', 'general']) {
    assert.match(admin, new RegExp(`${key}:`));
  }
});

test('every legacy checkbox state writes the same seven flags', () => {
  const keys = ['users', 'analytics', 'ecommerce', 'blog', 'socialSync', 'emailMarketing', 'general'];
  assert.equal(showLegacyFeatureFlags('off'), true);
  assert.equal(showLegacyFeatureFlags(''), true);
  assert.equal(showLegacyFeatureFlags(undefined), true);
  assert.equal(showFeatureTreeEditor('off'), false);
  assert.equal(showFeatureTreeEditor('shadow'), true);
  assert.equal(showFeatureTreeEditor('on'), true);
  assert.equal(showLegacyFeatureFlags('on'), false);
  for (let bits = 0; bits < 128; bits += 1) {
    const flags = {};
    keys.forEach((key, index) => { flags[key] = Boolean(bits & (1 << index)); });
    // The old checkboxes stored `{ ...previous, [key]: checked }` and the site write sent that object.
    const reference = {};
    for (const key of keys) reference[key] = flags[key] === true;
    assert.deepEqual(legacyFeaturesWrite(flags), reference);
  }
});

test('a featureSpec write includes the rev that was read', () => {
  const before = { rev: 3, grant: ['shop.upsell'], revoke: [], defaults: {}, values: {}, locks: [] };
  const after = applyTriState(before, 'blog.posts', 'grant');
  const patch = featureSpecSavePatch(before, after);
  assert.equal(patch.rev, 3);
  assert.ok(patch.grant.includes('blog.posts'));
  assert.equal(featureSpecSavePatch(before, before), null);
  assert.match(editor, /featureSpecSavePatch/);
  assert.match(editor, /status === 409/);
  assert.match(editor, /Last inn på nytt/);
});
