// Forward-compatible normalizers (WS8.44, batch 0).
//
// The hub's normalizers rebuild records from explicit whitelists, so a key the running code does
// not know is deleted on the next write. Reverting a later batch would therefore drop the data that
// batch wrote (sitePlan, delivery, planSource, ...). Every normalizer passes the keys listed here
// through unchanged when they are present and the normalizer does not own them yet, plus a
// reserved `ext` object for anything not listed.
//
// Rules:
// - Append-only. A later batch that starts owning a key normalizes it itself; the normalizer's own
//   value always wins over the passthrough. Owned keys stay listed, so the batch before still keeps
//   them and the patch guards still keep them out of request bodies.
// - Owned since batch 2: client sitePlan and delivery (data/sales.js), offer and alternative plan and
//   pricing (data/sales-offers.js), makerRun materials, autopilot and previewPush (data/sales.js).
// - Pure module (no Node imports): the browser bundle imports development-phase.js, which uses it.

export const EXT_KEY = 'ext';

// Sales client (data/sales.js normalizeSalesClient).
export const FUTURE_CLIENT_KEYS = Object.freeze([
  'sitePlan', // WS8.3
  'delivery', // WS8.9
  'nurture', // WS8.38
  'isTest', // WS8.56
  'seoRecord', // WS9 seo-ops pointer
  'seoAudit', // WS8.40 / WS9.43
  'seo', // WS9.14 agreed keywords (read by the WS8 gate)
  'brandName', // WS3 / WS4 identity
  'legalName', // WS3 / WS4 identity
  'language', // WS3 / WS4
  EXT_KEY,
]);

// client.makerRun (data/sales.js normalizeMakerRun, lib/developer-card.js mergeMakerRunPatch).
export const FUTURE_MAKERRUN_KEYS = Object.freeze([
  'previewPush', // WS8.17
  'materials', // WS8.28
  'autopilot', // WS3.22
  'dev', // WS4.18
  'goLive', // WS5.21
  'step1Qa', // WS1.43
  'homepageRoute', // WS1.13
  EXT_KEY,
]);

// client.makerRun keys a batch owns and normalizes, but that only their own authenticated writer may set:
// incoming makerRun patches (mergeMakerRunPatch, updateSalesClient) never carry them.
//   aiSpend: WS0.19, written only by the Maker's run.ai.spend callback (data/sales.js setSalesMakerRunAiSpend)
export const WRITER_ONLY_MAKERRUN_KEYS = Object.freeze(['aiSpend']);

// client.makerRun.steps and step tokens beyond today's 1, 1.5, 2, 3 (WS4 chain).
export const FUTURE_MAKERRUN_STEP_KEYS = Object.freeze(['2.5', 'cms', 'dev', 'dev-verify']);

// client.hubSite (data/sales.js normalizeHubSite).
export const FUTURE_HUBSITE_KEYS = Object.freeze([
  'githubRepo', // WS8.4
  EXT_KEY,
]);

// Hub site in sites.json (data/hub-model.js normalizeSite).
export const FUTURE_SITE_KEYS = Object.freeze([
  'planSource', // WS8.4
  'isTest', // WS8.56
  'stagingDomain', // WS5.21
  'keyAliases', // WS5 rekeySite
  'featureSpec', // WS6.7
  'cmsSpec', // WS6.8
  'cmsSpecHistory', // WS6.8
  'featureEnforcement', // WS6.6 / WS6.54
  'featureOverrides', // WS8 legacy-flag overrides, converted by WS6.7
  'contactEmail', // WS7
  'blogQueue', // WS9.49
  'shopConnectionRev', // WS8.50
  EXT_KEY,
]);

// site.cms (data/hub-model.js normalizeCmsMeta), heartbeat-derived state added by WS6.7.
export const FUTURE_SITE_CMS_KEYS = Object.freeze([
  'featuresRev',
  'clientFeaturesRev',
  'settingsRevApplied',
  'settingsConflicts',
  'effective',
  'effectiveHash',
  'blockHistory',
  'migrations',
  'lastHeartbeatAt',
  EXT_KEY,
]);

// Offers (data/sales-offers.js). Kept on stored records only; offerContentHash ignores them, so
// batch 0 never changes a hash. WS8.2 / WS8.57 decide how they enter the hash.
export const FUTURE_OFFER_KEYS = Object.freeze(['plan', 'pricing', 'dpaVersion', EXT_KEY]);
export const FUTURE_OFFER_ALTERNATIVE_KEYS = Object.freeze(['plan', 'pricing', 'dpaVersion', EXT_KEY]);
export const FUTURE_OFFER_PRODUCT_KEYS = Object.freeze(['services', 'oneTimeAddOns', EXT_KEY]);

// site.deliveryPhase values a later batch writes (WS8.4 / WS8.47); kept instead of reset.
export const FUTURE_DELIVERY_PHASES = Object.freeze(['cancelled', 'archived']);

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Copies every listed key that `raw` has and `target` does not into `target`, unchanged.
 * `ext` is copied only when it is a plain object. Returns `target`.
 */
export function carryFutureKeys(target, raw, keys) {
  if (!isPlainObject(target) || !isPlainObject(raw)) return target;
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(target, key)) continue;
    if (!Object.prototype.hasOwnProperty.call(raw, key)) continue;
    const value = raw[key];
    if (value === undefined) continue;
    if (key === EXT_KEY && !isPlainObject(value)) continue;
    target[key] = value;
  }
  return target;
}

/** The listed keys `raw` carries, as a new object (used to merge step maps). */
export function pickFutureKeys(raw, keys) {
  return carryFutureKeys({}, raw, keys);
}

/**
 * A shallow copy of `raw` without the listed keys. Writers use it on incoming patches, so a key a
 * later batch owns is only ever copied from the stored record, never from a request body.
 * Anything that is not a plain object is returned unchanged.
 */
export function withoutKeys(raw, keys) {
  if (!isPlainObject(raw)) return raw;
  const out = { ...raw };
  for (const key of keys) delete out[key];
  return out;
}
