// WS7.31 (hub side): the email feature keys in the one registry, the send kinds they allow, and the
// legacy-flag fallback before the feature tree reaches a site.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cmsFeatureRegistry } from '../lib/cms-entitlements.js';
import { EMAIL_FEATURE_KEYS, EMAIL_KIND_FEATURES, EMAIL_KINDS, emailKindsFor } from '../lib/email-feature-keys.js';
import { SECTION_SCHEMAS } from '../lib/cms-spec-schema.js';

const registry = cmsFeatureRegistry();
const node = (key) => registry.FEATURE_NODES.find((row) => row.key === key);

test('every email key and every send kind key is in the registry, and the registry has no standalone provider key', () => {
  for (const key of [...EMAIL_FEATURE_KEYS, ...Object.values(EMAIL_KIND_FEATURES)]) assert.ok(node(key), key);
  assert.equal(node('email.ownProvider'), undefined);
  assert.deepEqual(EMAIL_KINDS, ['cart-recovery', 'welcome', 'double-opt-in', 'back-in-stock', 'review-request', 'winback', 'campaign', 'test']);
});

test('the email rows carry the reconciled registry values (scope, default, requires, bundle)', () => {
  const expect = {
    email: { scope: 'agency', default: true },
    'email.newsletter': { scope: 'client', default: true },
    'email.doubleOptIn': { scope: 'client', default: true },
    'email.campaigns': { scope: 'client', default: true },
    'email.automations.welcome': { scope: 'client', default: true },
    'email.automations.abandonedCart': { scope: 'client', default: true, requires: ['shop.checkout'] },
    'email.automations.winback': { scope: 'client', default: false, requires: ['shop.checkout'] },
    'email.automations.reviewRequest': { scope: 'client', default: true, requires: ['shop'] },
    'email.automations.backInStock': { scope: 'client', default: true, requires: ['shop.checkout'] },
    'email.notifications.checkoutStarted': { scope: 'client', default: false, requires: ['shop.checkout'] },
    'email.customDomain': { scope: 'agency', default: false },
  };
  for (const [key, want] of Object.entries(expect)) {
    const row = node(key);
    assert.equal(row.scope, want.scope, `${key} scope`);
    assert.equal(row.default, want.default, `${key} default`);
    assert.deepEqual([...row.requires], want.requires || [], `${key} requires`);
    assert.equal(row.owner, 'WS7', `${key} owner`);
  }
  // Review requests come with the shop (ecom) or the booking add-on, not with tier 2 alone.
  assert.equal(registry.resolveFeatures({ tierId: 'tier-2-seo' }).entitled.has('email.automations.reviewRequest'), false);
  assert.equal(registry.resolveFeatures({ tierId: 'tier-3-ecommerce' }).entitled.has('email.automations.reviewRequest'), true);
  assert.equal(registry.resolveFeatures({ tierId: 'tier-2-seo', services: ['booking'] }).entitled.has('email.automations.reviewRequest'), true);
});

test('send kinds follow the entitled keys; campaigns need the caller to allow them', () => {
  const kinds = (tierId, extra = {}) => emailKindsFor({ entitled: registry.resolveFeatures({ tierId }).entitled, ...extra });
  assert.deepEqual(kinds('tier-1-standard'), { kinds: [], source: 'tree' });
  assert.deepEqual(kinds('tier-2-seo').kinds, ['welcome', 'double-opt-in', 'test']);
  assert.deepEqual(kinds('tier-2-seo', { campaignsAllowed: true }).kinds, ['welcome', 'double-opt-in', 'campaign', 'test']);
  assert.deepEqual(kinds('tier-3-ecommerce').kinds, ['cart-recovery', 'welcome', 'double-opt-in', 'back-in-stock', 'review-request', 'winback', 'test']);
});

test('before the tree reaches a site, the legacy flags decide the send kinds', () => {
  assert.deepEqual(emailKindsFor({ legacyFeatures: { emailMarketing: false, ecommerce: true } }), { kinds: [], source: 'legacy' });
  assert.deepEqual(emailKindsFor({ legacyFeatures: { emailMarketing: true } }).kinds, ['welcome', 'double-opt-in', 'test']);
  assert.deepEqual(emailKindsFor({ legacyFeatures: { emailMarketing: true, ecommerce: true }, campaignsAllowed: true }).kinds,
    ['cart-recovery', 'welcome', 'double-opt-in', 'back-in-stock', 'review-request', 'winback', 'campaign', 'test']);
});

test('the cms-spec email section only takes email keys in its features map', () => {
  const schema = SECTION_SCHEMAS.email;
  assert.equal(schema.fields.features.prefix, 'email.');
  for (const field of ['sender', 'identity', 'recovery', 'welcome', 'winback', 'reviewRequest', 'campaigns', 'ownerNotifications', 'evidence', 'features']) {
    assert.ok(schema.fields[field], field);
  }
});
