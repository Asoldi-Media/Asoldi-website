// Contract signing: one signer for every signing path (portal and preview accept, the Kontrakt tick on
// the sales card, got-client, the signed contract from e-mail, and a Stripe checkout for an accepted
// offer), behind the `signing` automation switch.
//
//   off     every path runs exactly as before (the default).
//   shadow  every path runs as before, plus a record of what the signer would write: a line in the
//           delivery audit log and client.delivery.sitePlanShadow. No plan, hub site or planSource
//           is written, and entitlements never read the shadow plan.
//   auto    markContractSigned runs, for pilot clients only (lib/spine-mode.js); every other client
//           of an auto switch runs in shadow.
//
// markContractSigned(clientId, {source, offerId, alternativeIndex, actor}) holds the lease
// `sign:<clientId>` (data/email-store.js acquireLease, 30 s) while it works, so two hub processes sign
// a client once. A website client then ends in the same state on every path: contractSigned and
// contractSignedAt, client.sitePlan from the accepted offer, one hub site with planSource
// {kind:'offer'}, the delivery stage `signed` (then `gathering` once the pre-workshop mail is out), one
// pre-workshop mail and the Informasjon action. A non-website product (SSU) gets only the signing
// stamp. A dual offer without a chosen alternative changes nothing. A second call sends nothing.
import { existsSync } from 'node:fs';
import * as sales from '../data/sales.js';
import * as hub from '../data/hub.js';
import * as salesOffers from '../data/sales-offers.js';
import * as clientPortal from '../data/client-portal.js';
import { listOffers as listPortalOffers } from '../data/offers.js';
import { acquireLease } from '../data/email-store.js';
import { effectiveSwitchMode, getAutomationSettings } from '../data/automation-settings.js';
import { spineModeForClient } from './spine-mode.js';
import { chosenWebsiteTier, makerSitePlanPayload, planFromOfferAlternative, resolveSitePlan, catalogTypeFromBank, DEFAULT_ONE_TIME_MONTHS } from './site-plan.js';
import { activeSitePlan, normalizeSitePlan } from './site-plan-model.js';
import { adminPlanSourceForEdit, applySitePlanToHub, findSiteForClient } from './site-plan-apply.js';
import { appendDeliveryAudit } from './delivery-audit.js';
import { sendPreWorkshopAfterContractSigned } from './workshop-prep-send.js';
import { normalizeNextAction } from './sales-next-actions.js';
import { findLinkedSalesClient } from './development-phase.js';
import { CUSTOM_TIER_ID, resolveTier, servicesForTier, tierById } from './website-tiers.js';
import { changesPerMonthForTier, expandServices } from '../packages/suite/core/delivery/vocab.js';

export const SIGNING_SWITCH = 'signing';
export const SIGNING_LEASE_MS = 30_000;
export const SIGNING_LEASE_WAIT_MS = 35_000;
export const SIGNING_SOURCES = Object.freeze([
  'portal-accept',
  'preview-accept',
  'progression',
  'inbox-contract',
  'got-client',
  'stripe-checkout',
]);
export const MISSING_ACCEPTANCE_ACTION_NAME = 'Mangler tilbudsaksept';

function text(value, max = 200) {
  return String(value ?? '').trim().slice(0, max);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function indexOrNull(value) {
  if (value === 0 || value === 1) return value;
  if (value === '0' || value === '1') return Number(value);
  return null;
}

function sourceOf(value) {
  const source = text(value, 40);
  return SIGNING_SOURCES.includes(source) ? source : 'progression';
}

/** True for a client whose product is a website (everything but SSU and other non-website products). */
export function isWebsiteClient(client) {
  const product = text(client?.product, 40).toLowerCase();
  return !product || product === 'asoldi';
}

// ---------------------------------------------------------------- mode

/** The switch for the whole hub: off, shadow, paused or auto. */
export function signingSwitchMode({ settings } = {}) {
  try {
    return effectiveSwitchMode(SIGNING_SWITCH, { settings: settings || getAutomationSettings() });
  } catch {
    return 'off';
  }
}

/**
 * off, shadow or auto for one client. A paused switch runs in shadow (today's paths keep working).
 * A settings file that cannot be read means off.
 */
export function signingModeForClient(client, { settings } = {}) {
  let mode;
  try {
    mode = spineModeForClient(SIGNING_SWITCH, client || {}, { settings: settings || getAutomationSettings() });
  } catch (error) {
    console.warn('[signing] settings unreadable; signing runs as before:', error?.message || error);
    return 'off';
  }
  if (mode === 'auto') return 'auto';
  if (mode === 'shadow' || mode === 'paused') return 'shadow';
  return 'off';
}

// ---------------------------------------------------------------- plans

function latestSentOffer(clientId) {
  const sent = salesOffers.listSalesOffers({ salesClientId: clientId, status: 'sent' });
  return sent.sort((a, b) => String(b.sentAt || b.updatedAt || '').localeCompare(String(a.sentAt || a.updatedAt || '')))[0] || null;
}

function unlimitedTerms(plan, signedAt, oneTimeMonths) {
  if (plan.billing !== 'once' || !plan.services.includes('unlimited')) return { unlimited: null };
  const start = Date.parse(text(signedAt, 40));
  if (!Number.isFinite(start)) return { unlimited: null };
  const until = new Date(start);
  until.setUTCMonth(until.getUTCMonth() + oneTimeMonths);
  return { unlimited: { until: until.toISOString() } };
}

/** The plan a superadmin picked by tier id (got-client), or null for an unknown tier. */
function superadminPlan(tierValue) {
  const raw = text(tierValue, 40);
  if (!raw) return null;
  const tier = resolveTier(raw);
  if (tier) {
    return { tierId: tier.id, services: servicesForTier(tier.id), pages: tier.pages, oneTimeAddOns: [], billing: 'month', catalogType: null, derived: false, needsConfirmation: false };
  }
  if (raw === CUSTOM_TIER_ID) {
    return { tierId: CUSTOM_TIER_ID, services: expandServices(['site']), pages: 0, oneTimeAddOns: [], billing: 'month', catalogType: null, derived: true, needsConfirmation: true };
  }
  return null;
}

/**
 * What a signing would store as the client's plan, without writing anything. Order: a superadmin's
 * tier (got-client only), the offer named by the path, the newest sent offer, then the resolver's
 * evidence. Returns { plan, needsChoice, offer, offerId, alternativeIndex, offerHash, dpaVersion,
 * priceExMva, evidence }; plan is null when nothing proves one.
 */
export function resolveSigningPlan(client = {}, { offerId = '', alternativeIndex = null, superadminTierId = '' } = {}) {
  const none = { plan: null, needsChoice: false, offer: null, offerId: '', alternativeIndex: null, offerHash: '', dpaVersion: '', priceExMva: 0, evidence: '' };
  const picked = superadminPlan(superadminTierId);
  if (picked) return { ...none, plan: picked, evidence: 'superadmin' };
  const named = text(offerId, 120) ? salesOffers.getSalesOfferById(offerId) : null;
  const offer = named && text(named.salesClientId) === text(client.id) ? named : latestSentOffer(client.id);
  if (offer) {
    const result = planFromOfferAlternative(offer, indexOrNull(alternativeIndex));
    if (result.needsChoice) return { ...none, needsChoice: true, offer, offerId: text(offer.id), evidence: 'offer' };
    if (result.ok) {
      return {
        plan: result.plan,
        needsChoice: false,
        offer,
        offerId: result.offerId,
        alternativeIndex: result.alternativeIndex,
        offerHash: result.offerHash,
        dpaVersion: result.dpaVersion,
        priceExMva: result.priceExMva,
        evidence: offer === named ? 'named-offer' : 'offer',
      };
    }
  }
  const resolved = resolveSitePlan({ ...client, sitePlan: null }, {
    offers: salesOffers.listSalesOffers({ salesClientId: client.id }),
    portalOffers: listPortalOffers(),
    hubSite: findSiteForClient(client),
  });
  if (resolved.needsChoice) return { ...none, needsChoice: true, offerId: text(resolved.offerId), evidence: resolved.evidence };
  if (!resolved.plan) return none;
  const plan = resolved.plan;
  return {
    ...none,
    plan: {
      tierId: plan.tierId,
      services: plan.services,
      pages: plan.pages,
      oneTimeAddOns: plan.oneTimeAddOns,
      billing: plan.billing,
      catalogType: plan.catalogType,
      derived: plan.derived,
      needsConfirmation: plan.needsConfirmation,
    },
    offerId: plan.offerId,
    alternativeIndex: plan.alternativeIndex,
    offerHash: plan.offerHash,
    dpaVersion: plan.dpaVersion,
    priceExMva: plan.priceExMva,
    evidence: resolved.evidence,
  };
}

/** client.sitePlan for a resolution (status active). */
export function sitePlanFromResolution(resolution, { source, signedAt = '', bank = null, oneTimeMonths = DEFAULT_ONE_TIME_MONTHS } = {}) {
  if (!resolution?.plan) return null;
  const services = expandServices(resolution.plan.services);
  const catalogType = resolution.plan.catalogType
    || (services.includes('ecom') || services.includes('catalog') ? catalogTypeFromBank(bank) : null);
  return normalizeSitePlan({
    status: 'active',
    tierId: resolution.plan.tierId,
    services,
    pages: resolution.plan.pages,
    oneTimeAddOns: resolution.plan.oneTimeAddOns,
    billing: resolution.plan.billing,
    priceExMva: resolution.priceExMva || 0,
    catalogType,
    languages: ['nb'],
    changesPerMonth: changesPerMonthForTier(resolution.plan.tierId),
    serviceTerms: unlimitedTerms({ ...resolution.plan, services }, signedAt, oneTimeMonths),
    source: resolution.evidence === 'superadmin' ? 'superadmin' : source,
    evidence: resolution.evidence,
    offerId: resolution.offerId || '',
    alternativeIndex: resolution.alternativeIndex ?? null,
    offerHash: resolution.offerHash || '',
    dpaVersion: resolution.dpaVersion || '',
    signedAt,
    derived: resolution.plan.derived === true,
    needsConfirmation: resolution.plan.needsConfirmation === true,
    conflicts: [],
    history: [],
  });
}

// ---------------------------------------------------------------- offer-scoped tier (portal)

const STANDARD_TIERS = ['tier-1-standard', 'tier-2-seo', 'tier-3-ecommerce'];

/**
 * The portal tier of one offer alternative: its own tier, or for a custom plan the smallest standard
 * tier whose services cover the plan's tier services. null when the offer has no plan.
 */
export function offerScopedTier(offer, index = null) {
  if (!offer) return null;
  const result = planFromOfferAlternative(offer, indexOrNull(index));
  if (!result.ok) return null;
  const direct = resolveTier(result.plan.tierId);
  if (direct) return direct;
  const top = new Set(servicesForTier('tier-3-ecommerce'));
  const wanted = result.plan.services.filter((service) => top.has(service));
  const id = STANDARD_TIERS.find((tierId) => {
    const own = new Set(servicesForTier(tierId));
    return wanted.every((service) => own.has(service));
  }) || 'tier-3-ecommerce';
  return tierById(id);
}

/**
 * The tier the portal paths (publish, accept, connect-portal) use. In auto: the offer's own plan
 * (never an older offer, the meeting quote or portalTierId). Otherwise exactly as before.
 */
export function signingTierForOffer(client, offer, index = null, options = {}) {
  if (signingModeForClient(client, options) !== 'auto') return chosenWebsiteTier(client, offer);
  return offerScopedTier(offer, index) || chosenWebsiteTier(client, offer);
}

/** For create-maker-run in auto: a void or ended plan goes to the Maker with its status. */
export function endedSitePlanForMaker(client, options = {}) {
  if (!client?.sitePlan || signingModeForClient(client, options) !== 'auto') return null;
  return makerSitePlanPayload(client.sitePlan, { includeEnded: true });
}

// ---------------------------------------------------------------- lease

/** Waits for the client's signing lease (another process may hold it). null after `waitMs`. */
export async function takeSigningLease(clientId, { waitMs = SIGNING_LEASE_WAIT_MS } = {}) {
  const deadline = Date.now() + Math.max(0, Number(waitMs) || 0);
  for (;;) {
    const lease = await acquireLease(`sign:${clientId}`, SIGNING_LEASE_MS);
    if (lease) return lease;
    if (Date.now() >= deadline) return null;
    await delay(40 + Math.floor(Math.random() * 60));
  }
}

/** Runs fn while holding the client's signing lease; { ok:false, reason:'busy' } when it cannot be had. */
export async function withSigningLease(clientId, fn, options = {}) {
  const lease = await takeSigningLease(clientId, options);
  if (!lease) return { ok: false, status: 409, reason: 'busy' };
  try {
    return await fn();
  } finally {
    await lease.release().catch(() => false);
  }
}

// ---------------------------------------------------------------- optional hooks

async function optionalModule(relative) {
  const url = new URL(relative, import.meta.url);
  if (!existsSync(url)) return null;
  try {
    return await import(url.href);
  } catch (error) {
    console.warn(`[signing] ${relative} could not be loaded:`, error?.message || error);
    return null;
  }
}

/** Gate lines for the pre-workshop mail when emails.preWorkshop.lines is 'gate' and the gate exists. */
async function gateNeedLines(client, settings) {
  if (settings?.emails?.preWorkshop?.lines !== 'gate') return null;
  const mod = await optionalModule('./delivery-gate.js');
  if (typeof mod?.askableLines !== 'function') return null;
  try {
    const lines = await mod.askableLines(client, { settings });
    return Array.isArray(lines) ? lines : null;
  } catch (error) {
    console.warn('[signing] gate lines failed; the legacy lines are used:', error?.message || error);
    return null;
  }
}

async function freezeAgreedKeywordsHook(clientId, { by }) {
  const mod = await optionalModule('./seo-ops/record.js');
  if (typeof mod?.freezeAgreedKeywords !== 'function') return false;
  try {
    await mod.freezeAgreedKeywords(clientId, { by, reason: 'contract-signed' });
    return true;
  } catch (error) {
    console.warn('[signing] keyword freeze failed:', error?.message || error);
    return false;
  }
}

// ---------------------------------------------------------------- shadow

/**
 * Shadow: what markContractSigned would write, recorded in the delivery audit log and in
 * client.delivery.sitePlanShadow. Writes no plan, site or planSource.
 */
export async function recordSigningShadow(clientId, options = {}) {
  const client = sales.getSalesClientById(clientId);
  if (!client) return { ok: false, mode: 'shadow', reason: 'not-found' };
  const source = sourceOf(options.source);
  const at = new Date().toISOString();
  const website = isWebsiteClient(client);
  const resolution = website ? resolveSigningPlan(client, options) : { plan: null, needsChoice: false };
  const site = website ? findSiteForClient(client) : null;
  const shadow = {
    at,
    source,
    product: text(client.product, 40) || 'asoldi',
    tierId: resolution.plan?.tierId || '',
    services: resolution.plan ? expandServices(resolution.plan.services) : [],
    billing: resolution.plan?.billing || '',
    offerId: text(resolution.offerId, 120),
    alternativeIndex: resolution.alternativeIndex ?? null,
    needsChoice: resolution.needsChoice === true,
    siteId: text(site?.id, 80),
    wouldCreateSite: Boolean(website && resolution.plan && !site),
    wouldSendPreWorkshop: Boolean(website && !client.progression?.contractSigned && !resolution.needsChoice),
  };
  appendDeliveryAudit({
    at,
    kind: 'signing-shadow',
    clientId: client.id,
    by: text(options.actor, 120) || source,
    source,
    product: shadow.product,
    tierId: shadow.tierId,
    offerId: shadow.offerId,
    needsChoice: shadow.needsChoice,
    siteId: shadow.siteId,
    wouldCreateSite: shadow.wouldCreateSite,
    ...(isPlainObject(options.note) ? options.note : {}),
  });
  if (website && resolution.plan) sales.setSalesDelivery(client.id, { sitePlanShadow: shadow });
  return { ok: true, mode: 'shadow', shadow };
}

// ---------------------------------------------------------------- auto

function auditSigning(entry) {
  appendDeliveryAudit({ kind: 'signing', ...entry });
}

function copyDpaVersion(clientId, dpaVersion) {
  const version = text(dpaVersion, 80);
  if (!version) return;
  const client = sales.getSalesClientById(clientId);
  const ext = isPlainObject(client?.ext) ? client.ext : {};
  const dpa = isPlainObject(ext.dpa) ? ext.dpa : {};
  if (dpa.offerVersion === version) return;
  sales.updateSalesClient(clientId, { ext: { ...ext, dpa: { ...dpa, offerVersion: version } } });
}

function samePlanChoice(plan, resolution) {
  return text(plan?.offerId) === text(resolution.offerId)
    && (plan?.alternativeIndex ?? null) === (resolution.alternativeIndex ?? null);
}

/** An accepted offer for a client that already has a plan: the new offer's plan replaces it. */
function applyOfferUpgrade(client, current, resolution, { source, actor, now }) {
  const next = sitePlanFromResolution(resolution, { source: 'offer-upgrade', signedAt: now });
  if (!next) return { changed: false };
  const keep = { ...next, signedAt: current.signedAt || now, confirmedBy: '', confirmedAt: '' };
  const updated = sales.setSalesSitePlan(client.id, keep, { by: actor, reason: `offer-upgrade:${source}`, now });
  const applied = applySitePlanToHub(client.id, { by: 'contract-signing', now });
  auditSigning({ clientId: client.id, by: actor, source, upgrade: true, from: current.tierId, tierId: keep.tierId, offerId: keep.offerId, siteId: applied.site?.id || '' });
  return { changed: true, client: updated, site: applied.site || null };
}

async function signLocked(clientId, options) {
  const source = sourceOf(options.source);
  const actor = text(options.actor, 120) || source;
  const now = new Date().toISOString();
  const settings = options.settings || getAutomationSettings();
  const warnings = [];
  let client = sales.getSalesClientById(clientId);
  if (!client) return { ok: false, status: 404, mode: 'auto', reason: 'not-found' };
  const alreadySigned = client.progression?.contractSigned === true;

  // Not a website product: only the signing stamp.
  if (!isWebsiteClient(client)) {
    if (!alreadySigned) {
      client = sales.setSalesProgress(clientId, 'contractSigned', true, { fastTrack: true }) || client;
      auditSigning({ clientId, by: actor, source, product: text(client.product, 40) });
    }
    return { ok: true, mode: 'auto', signed: true, alreadySigned, product: text(client.product, 40), client, site: null, plan: null, mailed: false, warnings };
  }

  const current = activeSitePlan(client);
  const named = text(options.offerId, 120);
  if (alreadySigned && current) {
    if (named) {
      const resolution = resolveSigningPlan(client, options);
      if (resolution.needsChoice) return { ok: false, status: 409, mode: 'auto', needsChoice: true, offerId: resolution.offerId, client };
      if (resolution.plan && !samePlanChoice(current, resolution)) {
        const upgraded = applyOfferUpgrade(client, current, resolution, { source, actor, now });
        if (upgraded.changed) {
          copyDpaVersion(clientId, resolution.dpaVersion);
          return { ok: true, mode: 'auto', signed: true, alreadySigned: true, upgraded: true, client: sales.getSalesClientById(clientId), site: upgraded.site, plan: activeSitePlan(sales.getSalesClientById(clientId)), mailed: false, warnings };
        }
      }
    }
    // Same plan: make sure it is applied, send nothing.
    const site = findSiteForClient(client);
    const applied = !site || current.appliedSiteId !== site.id ? applySitePlanToHub(clientId, { by: 'contract-signing', now }) : { site };
    return { ok: true, mode: 'auto', signed: true, alreadySigned: true, client: sales.getSalesClientById(clientId), site: applied.site || site, plan: current, mailed: false, warnings };
  }

  const resolution = resolveSigningPlan(client, {
    offerId: named,
    alternativeIndex: options.alternativeIndex,
    superadminTierId: options.superadminTierId,
  });
  if (resolution.needsChoice) {
    return { ok: false, status: 409, mode: 'auto', needsChoice: true, offerId: resolution.offerId, client };
  }

  if (!alreadySigned) {
    const offerProves = resolution.offer?.status === 'sent';
    client = sales.setSalesProgress(clientId, 'contractSigned', true, { fastTrack: options.fastTrack === true || offerProves }) || client;
  }
  const signedAt = text(client.contractSignedAt, 40) || now;
  const plan = sitePlanFromResolution(resolution, { source, signedAt, oneTimeMonths: Number(settings?.pricing?.oneTimeMonths) || DEFAULT_ONE_TIME_MONTHS });
  if (plan) client = sales.setSalesSitePlan(clientId, plan, { by: actor, reason: source, now }) || client;
  else warnings.push('plan-missing');

  let site = null;
  let created = false;
  if (activeSitePlan(client)) {
    const applied = applySitePlanToHub(clientId, { by: 'contract-signing', now });
    site = applied.site || null;
    created = applied.created === true;
    if (!applied.ok) warnings.push(`plan-apply:${applied.reason}`);
  }
  copyDpaVersion(clientId, resolution.dpaVersion);
  sales.syncSalesDeliveryStage(clientId, { by: actor, reason: source });

  let mailed = false;
  if (!alreadySigned) {
    const fresh = sales.getSalesClientById(clientId);
    const needLines = await gateNeedLines(fresh, settings);
    try {
      const result = await sendPreWorkshopAfterContractSigned(fresh, {
        previousSigned: false,
        sender: options.sender || {},
        ...(needLines ? { needLines } : {}),
      });
      mailed = Boolean(result?.sent);
      if (result?.warning) warnings.push(result.warning);
      if (Array.isArray(result?.warnings)) warnings.push(...result.warnings.filter(Boolean));
    } catch (error) {
      warnings.push(`Workshop-e-post etter kontrakt feilet: ${error?.message || error}`);
    }
    sales.syncSalesDeliveryStage(clientId, { by: actor, reason: 'pre-workshop' });
  }
  await freezeAgreedKeywordsHook(clientId, { by: actor });
  auditSigning({
    clientId,
    by: actor,
    source,
    tierId: plan?.tierId || '',
    offerId: plan?.offerId || '',
    siteId: site?.id || '',
    created,
    mailed,
    alreadySigned,
  });
  const after = sales.getSalesClientById(clientId);
  return { ok: true, mode: 'auto', signed: true, alreadySigned, client: after, site, plan: activeSitePlan(after), mailed, warnings };
}

/**
 * The signer. Options: source (SIGNING_SOURCES), offerId, alternativeIndex, actor, sender (the rep's
 * mail sender), fastTrack, superadminTierId (got-client by a superadmin), settings.
 * Returns { ok, mode, ... }: mode 'off' does nothing (the caller runs its own path), 'shadow' records,
 * 'auto' signs. { needsChoice:true, status:409 } for a dual offer without a chosen alternative.
 */
export async function markContractSigned(clientId, options = {}) {
  const id = text(clientId, 80);
  const client = id ? sales.getSalesClientById(id) : null;
  if (!client) return { ok: false, status: 404, mode: 'off', reason: 'not-found' };
  const mode = signingModeForClient(client, options);
  if (mode === 'off') return { ok: false, mode, skipped: 'switch-off', client };
  if (mode === 'shadow') return recordSigningShadow(id, options);
  const result = await withSigningLease(id, () => signLocked(id, options), options);
  if (result?.reason === 'busy') return { ...result, mode: 'auto', client };
  return result;
}

// ---------------------------------------------------------------- in-flight signings

const inFlight = new Map();

/** Remembers a signing started without waiting (markClientSoldFromSignedContract), per client. */
export function trackContractSigning(clientId, promise) {
  const id = text(clientId, 80);
  const tracked = Promise.resolve(promise).catch((error) => {
    console.error('[signing] failed', id, error?.message || error);
    return { ok: false, reason: 'error' };
  });
  inFlight.set(id, tracked);
  tracked.finally(() => {
    if (inFlight.get(id) === tracked) inFlight.delete(id);
  });
  return tracked;
}

/** Resolves when the client's last tracked signing is done (at once when there is none). */
export function contractSigningSettled(clientId) {
  return inFlight.get(text(clientId, 80)) || Promise.resolve(null);
}

// ---------------------------------------------------------------- Stripe

function addMissingAcceptanceAction(clientId, { now = new Date().toISOString() } = {}) {
  const client = sales.getSalesClientById(clientId);
  if (!client) return null;
  const id = `missing-offer-acceptance-${clientId}`;
  const actions = Array.isArray(client.nextActions) ? client.nextActions : [];
  if (actions.some((action) => action?.id === id && !action.doneAt)) return client;
  const action = normalizeNextAction({
    id,
    goalKey: 'contractSigned',
    presetKey: 'custom',
    name: MISSING_ACCEPTANCE_ACTION_NAME,
    note: 'Kunden har betalt med kort uten et akseptert tilbud. Send tilbudslenken og få aksepten før oppstart.',
    format: 'ring',
    dueAt: now,
    createdAt: now,
    addToCalendar: false,
  }, 'contractSigned');
  return sales.updateSalesClient(clientId, { nextActions: [...actions.filter((row) => row?.id !== id), action] });
}

function addPlanConflict(client, { source, tierId, at }) {
  const plan = activeSitePlan(client);
  const tier = resolveTier(tierId);
  if (!plan || !tier || tier.id === plan.tierId) return client;
  if (plan.conflicts.some((row) => row.source === source && row.tierId === tier.id && row.status === 'open')) return client;
  return sales.setSalesSitePlan(client.id, { ...plan, conflicts: [...plan.conflicts, { source, tierId: tier.id, at, status: 'open' }] }, { by: source, reason: 'conflict' }) || client;
}

/**
 * checkout.session.completed. Signs only when the session's metadata carries the offerId and the
 * contractHash (offerContentHash) of an offer of this client. Otherwise it adds the next action
 * "Mangler tilbudsaksept" for the rep. The payment itself is recorded by the caller, as before.
 */
export async function signFromStripeCheckout(session = {}, options = {}) {
  const metadata = isPlainObject(session?.metadata) ? session.metadata : {};
  const userId = text(session?.client_reference_id || metadata.userId, 120);
  let salesClientId = text(metadata.salesClientId, 80);
  if (!salesClientId && userId) {
    try {
      salesClientId = text(clientPortal.getClientProfile(userId)?.websiteBuilder?.salesClientId, 80);
    } catch {
      salesClientId = '';
    }
  }
  const client = salesClientId ? sales.getSalesClientById(salesClientId) : null;
  if (!client) return { ok: false, mode: 'off', reason: 'no-client' };
  const mode = signingModeForClient(client, options);
  if (mode === 'off') return { ok: false, mode, skipped: 'switch-off' };
  const offerId = text(metadata.offerId, 120);
  const contractHash = text(metadata.contractHash, 80);
  const offer = offerId ? salesOffers.getSalesOfferById(offerId) : null;
  const matched = Boolean(offer && text(offer.salesClientId) === client.id && contractHash && contractHash === salesOffers.offerContentHash(offer));
  const alternativeIndex = indexOrNull(metadata.chosenOfferIndex);
  if (mode === 'shadow') {
    return recordSigningShadow(client.id, { source: 'stripe-checkout', offerId: matched ? offerId : '', alternativeIndex, actor: 'stripe', note: { offerMatched: matched } });
  }
  if (matched) {
    return markContractSigned(client.id, { ...options, source: 'stripe-checkout', offerId, alternativeIndex, actor: 'stripe', fastTrack: true });
  }
  const at = new Date().toISOString();
  if (client.progression?.contractSigned) {
    const updated = await withSigningLease(client.id, async () => addPlanConflict(sales.getSalesClientById(client.id), { source: 'stripe', tierId: metadata.planId, at }));
    return { ok: true, mode, signed: false, reason: 'already-signed', client: updated?.id ? updated : client };
  }
  const updated = addMissingAcceptanceAction(client.id, { now: at });
  appendDeliveryAudit({ at, kind: 'signing-refused', clientId: client.id, by: 'stripe', source: 'stripe-checkout', reason: offer ? 'contract-hash-mismatch' : 'no-offer-metadata' });
  return { ok: true, mode, signed: false, reason: 'offer-not-accepted', client: updated };
}

// ---------------------------------------------------------------- superadmin site edit

/**
 * A superadmin websitePlan edit on a hub site linked to an auto client: the site's planSource becomes
 * { kind:'admin' } with the new tier. Returns the saved site, or null (nothing written).
 */
export function markAdminPlanEdit(before, after, { by = 'superadmin', settings } = {}) {
  if (!before || !after || before.websitePlan === after.websitePlan) return null;
  const client = findLinkedSalesClient(after, sales.getSalesClients());
  if (!client || signingModeForClient(client, { settings }) !== 'auto') return null;
  const planSource = adminPlanSourceForEdit(before, after, { by, salesClientId: client.id });
  if (!planSource) return null;
  const stored = hub.setSitePlanSource(after.id, planSource);
  if (!stored.ok) return null;
  appendDeliveryAudit({ kind: 'plan-source', clientId: client.id, siteId: after.id, by: text(by, 120), source: 'superadmin', to: planSource.tierId });
  return stored.site;
}
