/**
 * The `email` block of a client site's site-config answer, and the rules the relay shares with it.
 *
 * The block is added only for a site whose email is switched on: the email platform is on
 * (email setting `enabled`) and the rollout lists the site. Every other site gets no block, so its
 * site-config answer stays exactly as it was. A client CMS that sees no block on two good answers
 * in a row keeps its old email behaviour.
 *
 *   { api: 1, enabled, provisioned, kinds, campaigns: { allowed, reason }, sender: { mode,
 *     fromName, fromAddress }, suspended, paused, reason? }
 *
 *  - enabled: the hub would relay mail for the site apart from its key: Brevo is configured, the
 *    data processing agreement is accepted or attested, and the site may send at least one kind.
 *    `reason` names the first missing one ('not_configured', 'dpa_missing', 'not_entitled').
 *  - provisioned: the site's emailKey is confirmed (docs/email-credential.md). A CMS that sees
 *    provisioned:false pulls its key with a provision request.
 *  - kinds: the send kinds the site is entitled to, from the feature tree when the site-config
 *    carries one, else from the legacy flags (lib/email-feature-keys.js). `campaign` only when
 *    campaigns are allowed.
 *  - campaigns.allowed: the site is entitled to email.campaigns, the Brevo plan is known and not
 *    the free plan (or campaigns on the free plan are switched on), and the Brevo terms check is
 *    recorded (brevo.termsConfirmedAt).
 *  - paused: the kill switch is on (sends answer 503 paused); suspended: the site is suspended.
 * The block never holds a key, an address list or anything about other sites.
 */
import { readEmailSettings, readEmailSite, resolveBrevoKey } from '../data/email-store.js';
import { EMAIL_KIND_FEATURES, emailKindsFor } from './email-feature-keys.js';
import { currentEmailKey, emailPlatformEnabled, siteInRollout } from './email-site-auth.js';

export const EMAIL_CONFIG_API = 1;

function clean(value, max = 500) {
  return String(value ?? '').trim().slice(0, max);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Whether the Brevo plan and terms allow campaigns at all: { allowed, reason } with reason
 * 'free_plan', 'plan_unknown' or 'terms_unconfirmed'. An unknown plan counts as not paid.
 */
export function campaignsPlanAllows(settings) {
  const brevo = settings?.brevo || {};
  const tier = clean(brevo.planTier, 40).toLowerCase();
  const onFree = brevo.campaignsOnFree === true;
  if (!onFree && tier === 'free') return { allowed: false, reason: 'free_plan' };
  if (!onFree && (!tier || tier === 'unknown')) return { allowed: false, reason: 'plan_unknown' };
  if (!clean(brevo.termsConfirmedAt, 40)) return { allowed: false, reason: 'terms_unconfirmed' };
  return { allowed: true, reason: '' };
}

/**
 * Campaigns for one site: the plan rule above, and the site must be entitled to email.campaigns
 * (the feature tree when `entitled` is given, else the legacy emailMarketing flag).
 */
export function campaignsFor(site, settings, { entitled = null } = {}) {
  const set = entitled ? (entitled instanceof Set ? entitled : new Set(entitled)) : null;
  const entitledToCampaigns = set ? set.has(EMAIL_KIND_FEATURES.campaign) : site?.features?.emailMarketing === true;
  if (!entitledToCampaigns) return { allowed: false, reason: 'not_entitled' };
  return campaignsPlanAllows(settings);
}

/** The kinds a site may send (feature tree when `entitled` is given, else its legacy flags). */
export function emailKindsForSite(site, settings, { entitled = null, legacyFeatures = null } = {}) {
  const campaigns = campaignsFor(site, settings, { entitled });
  return emailKindsFor({ entitled, legacyFeatures: legacyFeatures || site?.features || {}, campaignsAllowed: campaigns.allowed }).kinds;
}

/**
 * The From display name: the hub's own name for the site (Asoldi sets it), never the name a CMS
 * sends, so the shared sender address cannot carry another brand. At most 60 characters, without
 * quotes, angle brackets, backslashes or control characters.
 */
export function senderDisplayName(site, settings) {
  const tidy = (value) => String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f"<>\\]/g, ' ').replace(/\s+/g, ' ').trim();
  const name = (tidy(site?.name) || tidy(site?.domain) || 'Nettbutikk').slice(0, 60).trim();
  return `${name}${tidy(settings?.sender?.nameSuffix).slice(0, 60)}`;
}

/** True when the site sends from its own verified domain. */
export function clientDomainSender(emailSite) {
  const sender = emailSite?.sender || {};
  return sender.mode === 'client-domain' && Boolean(clean(sender.brevoDomainVerifiedAt, 40)) && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(clean(sender.domain, 253));
}

/** The From address: post@<the site's verified domain>, else the shared default address. */
export function fromAddress(emailSite, settings) {
  if (clientDomainSender(emailSite)) return `post@${clean(emailSite.sender.domain, 253).toLowerCase()}`;
  return clean(settings?.sender?.defaultAddress, 320) || 'kunder@asoldi.com';
}

/** The data processing agreement is accepted, or a superadmin attested it. */
export function dpaAccepted(emailSite) {
  const dpa = emailSite?.dpa || {};
  return Boolean(clean(dpa.acceptedAt, 40) || clean(dpa.attestedBy, 120));
}

/** The entitled keys a site-config answer carries (its feature tree), or null without one. */
export function entitledFromConfig(config) {
  const list = config?.featureTree?.entitled;
  return Array.isArray(list) ? new Set(list.map(String)) : null;
}

/**
 * The email block for a site, or null when the site's email is not switched on (the platform is
 * off or the rollout does not list the site): then the site-config answer gets no block at all.
 * `config` is the site-config answer the block goes into (its feature tree and flags decide the
 * kinds). Never throws. When the site's email state cannot be read, the block says paused with
 * reason 'unavailable', so the CMS holds its mail instead of falling back to its old behaviour.
 */
export function emailConfigForSite(site, { config = null, settings = null, emailSite = null, env = process.env } = {}) {
  const siteId = clean(site?.id, 80);
  if (!siteId) return null;
  let cfg;
  try {
    cfg = settings || readEmailSettings();
    if (!emailPlatformEnabled(cfg) || !siteInRollout(siteId, cfg)) return null;
  } catch {
    return null;
  }
  try {
    const row = emailSite || readEmailSite(siteId);
    const entitled = entitledFromConfig(config);
    const legacyFeatures = isPlainObject(config?.features) ? config.features : site?.features || {};
    const campaigns = campaignsFor({ ...site, features: legacyFeatures }, cfg, { entitled });
    const kinds = emailKindsFor({ entitled, legacyFeatures, campaignsAllowed: campaigns.allowed }).kinds;
    const brevo = Boolean(resolveBrevoKey({ env }));
    const dpa = dpaAccepted(row);
    const reason = !brevo ? 'not_configured' : !dpa ? 'dpa_missing' : !kinds.length ? 'not_entitled' : '';
    return {
      api: EMAIL_CONFIG_API,
      enabled: !reason,
      provisioned: Boolean(currentEmailKey(siteId)),
      kinds,
      campaigns,
      sender: { mode: clientDomainSender(row) ? 'client-domain' : 'asoldi', fromName: senderDisplayName(site, cfg), fromAddress: fromAddress(row, cfg) },
      suspended: Boolean(row?.suspended),
      paused: cfg.killSwitch === true,
      ...(reason ? { reason } : {}),
    };
  } catch {
    return {
      api: EMAIL_CONFIG_API,
      enabled: false,
      provisioned: false,
      kinds: [],
      campaigns: { allowed: false, reason: 'unavailable' },
      sender: { mode: 'asoldi', fromName: senderDisplayName(site, cfg), fromAddress: fromAddress(null, cfg) },
      suspended: false,
      paused: true,
      reason: 'unavailable',
    };
  }
}
