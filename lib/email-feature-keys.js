/**
 * Email feature keys and send kinds (WS7.31, hub side of the contract).
 *
 * The email keys live in the one feature registry (website-cms server/feature-tree.json, synced to
 * data/cms-feature-tree.json); WS7 adds no registry of its own. This file maps the hub relay's send
 * kinds to those keys, so the email engine (WS7.15) can say which kinds a site may send:
 *   - with the feature tree: a kind is allowed when its key is entitled for the site;
 *   - before the tree reaches a site: the legacy flags decide (`emailMarketing` gives welcome,
 *     double-opt-in and test; `ecommerce` adds cart-recovery, review-request, winback and back-in-stock).
 * `campaign` is added only when the caller says campaigns are allowed (WS7.37: plan and terms checks).
 * The settings that go with the keys travel in the cms-spec `email` section (lib/cms-spec-schema.js).
 */

/** Registry keys owned by WS7 (table 3.7), plus forms.lists, which WS7 uses for list sign-ups. */
export const EMAIL_FEATURE_KEYS = Object.freeze([
  'email',
  'email.newsletter',
  'email.doubleOptIn',
  'email.campaigns',
  'email.automations',
  'email.automations.welcome',
  'email.automations.abandonedCart',
  'email.automations.winback',
  'email.automations.reviewRequest',
  'email.automations.backInStock',
  'email.notifications',
  'email.notifications.checkoutStarted',
  'email.notifications.repeatCustomer',
  'email.customDomain',
  'forms.lists',
]);

/** Relay send kind -> the feature key that must be entitled. `test` needs only the email parent. */
export const EMAIL_KIND_FEATURES = Object.freeze({
  'cart-recovery': 'email.automations.abandonedCart',
  welcome: 'email.automations.welcome',
  'double-opt-in': 'email.doubleOptIn',
  'back-in-stock': 'email.automations.backInStock',
  'review-request': 'email.automations.reviewRequest',
  winback: 'email.automations.winback',
  campaign: 'email.campaigns',
  test: 'email',
});

export const EMAIL_KINDS = Object.freeze(Object.keys(EMAIL_KIND_FEATURES));

const LEGACY_EMAIL_KINDS = Object.freeze(['welcome', 'double-opt-in', 'test']);
const LEGACY_SHOP_EMAIL_KINDS = Object.freeze(['cart-recovery', 'review-request', 'winback', 'back-in-stock']);

/**
 * Kinds a site may send.
 * @param {{ entitled?: Iterable<string>|null, legacyFeatures?: object, campaignsAllowed?: boolean }} input
 *   entitled: the site's entitled keys from the resolved tree (null when the tree does not apply yet)
 * @returns {{ kinds: string[], source: 'tree'|'legacy' }}
 */
export function emailKindsFor({ entitled = null, legacyFeatures = {}, campaignsAllowed = false } = {}) {
  if (entitled) {
    const set = entitled instanceof Set ? entitled : new Set(entitled);
    const kinds = EMAIL_KINDS.filter((kind) => set.has(EMAIL_KIND_FEATURES[kind]) && (kind !== 'campaign' || campaignsAllowed));
    return { kinds, source: 'tree' };
  }
  const kinds = [];
  if (legacyFeatures?.emailMarketing === true) {
    kinds.push(...LEGACY_EMAIL_KINDS);
    if (legacyFeatures?.ecommerce === true) kinds.push(...LEGACY_SHOP_EMAIL_KINDS);
    if (campaignsAllowed) kinds.push('campaign');
  }
  return { kinds: EMAIL_KINDS.filter((kind) => kinds.includes(kind)), source: 'legacy' };
}
