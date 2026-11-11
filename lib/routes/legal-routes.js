/**
 * Legal texts routes. Every route answers 404 {code:'disabled'} while legal.catalogTexts is off,
 * with one exception: once offers were sent with a legal stamp (only possible while the switch was
 * on), GET /api/legal/texts/<vilkar|personvern|databehandleravtale>?version=<number> keeps
 * answering, so the versioned links in those contracts still show the text they name. A hub that
 * never turned the switch on has no stamps and answers 404 there too.
 *
 *   GET  /api/legal/texts/:doc?version=&tier=   public: rendered legal texts (lib/legal/texts.js)
 *   GET  /api/client/legal                      client: the bound version and the DPA status
 *   POST /api/client/dpa/sign                   client: sign the current DPA (idempotent); only
 *                                               an owner or admin of the business that owns the
 *                                               resolved offer (403 otherwise)
 *   GET  /api/admin/legal/terms-update          admin: clients on an older version, with a draft
 *                                               notice per client (the list itself sends nothing),
 *                                               and the settings that differ from the published texts
 *   POST /api/admin/legal/terms-update/:id/send admin: send that client's terms-update notice
 *                                               (emails.termsUpdate; only this route sends it)
 *
 * register() also gives the offer composer the catalog's offer-letter lines
 * (setOfferTierIncludesResolver; the resolver answers null while the switch is off) and the offer
 * stamp the client's agreed keywords (setAgreedKeywordsResolver; used only while stamping, which
 * happens only while the switch is on).
 */
import * as store from '../../data/store.js';
import * as clientPortal from '../../data/client-portal.js';
import * as portalOffers from '../../data/offers.js';
import { getAutomationSettings } from '../../data/automation-settings.js';
import * as clientBusinesses from '../../data/client-businesses.js';
import { setOfferTierIncludesResolver } from '../offer-email.js';
import { CATALOG_DATE, CATALOG_VERSION, DPA_VERSION } from '../legal/catalog.js';
import { legalBindingForClient, offerHasLegalStamp, setAgreedKeywordsResolver, versionedLegalUrl } from '../legal/binding.js';
import { agreedKeywordsTextForClient } from '../legal/contract.js';
import { dpaSignPatch, dpaStatus } from '../legal/dpa.js';
import { catalogOfferIncludes } from '../legal/sales.js';
import { legalCatalogEnabled } from '../legal/switch.js';
import { clientsOnOlderVersions, draftTermsUpdateNotice } from '../legal/terms-update.js';
import { sendTermsUpdateNotice } from '../legal/terms-update-send.js';
import { LEGAL_DOC_IDS } from '../legal/render.js';
import { legalSettingsDrift, legalTextResponse } from '../legal/texts.js';
import { LEGAL_URLS } from '../legal-urls.js';

function clean(value) {
  return String(value ?? '').trim();
}

function disabled(res) {
  return res.status(404).json({ code: 'disabled' });
}

function currentSettings() {
  try {
    return getAutomationSettings();
  } catch {
    return null;
  }
}

/**
 * Whether a portal session may sign on the business's behalf: its owner or an admin. A client
 * account without business memberships is its own account holder and may sign.
 */
export function sessionCanSignForBusiness(session) {
  const membership = session?.membership;
  if (!membership) return !(Array.isArray(session?.businesses) && session.businesses.length);
  return membership.status === 'active' && clientBusinesses.canManageBilling(membership.role);
}

/** The business that owns a portal offer: the offer's business, else its sales client's portal profile. */
function offerBusinessId(offer) {
  const direct = clean(offer?.businessId);
  if (direct) return direct;
  const salesClientId = clean(offer?.salesClientId);
  if (!salesClientId) return '';
  try {
    const profile = clientPortal.listClientProfiles().find((entry) => clean(entry?.websiteBuilder?.salesClientId) === salesClientId);
    return clean(profile?.businessId || profile?.userId);
  } catch {
    return '';
  }
}

/**
 * Whether this session may sign for the business that owns the resolved offer. A collaborator, or
 * a membership that is not active, may not. An account with no business memberships keeps the
 * account-holder rule (sessionCanSignForBusiness). An offer with no business falls back to that too.
 */
export function canSignForResolvedOffer(session, offer) {
  const businesses = Array.isArray(session?.businesses) ? session.businesses : [];
  if (!businesses.length && !session?.membership) return sessionCanSignForBusiness(session);
  const businessId = offerBusinessId(offer);
  if (!businessId) return sessionCanSignForBusiness(session);
  const userId = clean(session?.user?.id);
  if (!userId) return false;
  const membership = clientBusinesses.getMembership(userId, businessId);
  return Boolean(membership) && membership.status === 'active' && clientBusinesses.canManageBilling(membership.role);
}

/**
 * The sales client behind a portal user: the user's active portal offer, else the website-builder
 * link. `canSign`: the user may sign for the business that owns that offer.
 */
async function salesClientForPortalUser(userId, sales) {
  const user = await store.getUserById(userId);
  if (!user || user.role !== 'client') return { user: null, client: null, canSign: false };
  const session = clientPortal.presentClientSession(user);
  // Active businesses first, then every other membership (including one that is not active), so an
  // offer on a business the user belongs to is still the one canSign is decided for.
  const membershipBusinessIds = [
    ...(session?.businesses || []).map((row) => row.id),
    ...clientBusinesses.getMembershipsForUser(user.id).map((row) => row.businessId),
  ];
  const offer = portalOffers.getActiveOfferForUser({
    userId: user.id,
    email: user.username,
    businessId: session?.activeBusinessId || session?.profile?.businessId || '',
    membershipBusinessIds,
  });
  const salesClientId = clean(offer?.salesClientId) || clean(clientPortal.getClientProfile(user.id)?.websiteBuilder?.salesClientId);
  const client = salesClientId ? sales.getSalesClientById(salesClientId) : null;
  return { user, client, canSign: canSignForResolvedOffer(session, offer) };
}

// Whether any offer carries a legal stamp: checked again when this process wrote offers, else at
// most every STAMP_CHECK_MS (another process may write them too). Once found, it stays true.
const STAMP_CHECK_MS = 30_000;

function stampedOffersCheck(salesOffers) {
  let checkedAt = 0;
  let checkedRevision = null;
  let found = false;
  return () => {
    if (found) return true;
    const now = Date.now();
    const revision = typeof salesOffers?.offersDataRevision === 'function' ? salesOffers.offersDataRevision() : null;
    if (revision === checkedRevision && now - checkedAt < STAMP_CHECK_MS) return false;
    checkedAt = now;
    checkedRevision = revision;
    try {
      const list = typeof salesOffers?.listSalesOffers === 'function' ? salesOffers.listSalesOffers() : [];
      found = list.some(offerHasLegalStamp);
    } catch {
      found = false;
    }
    return found;
  };
}

function isNumberedVersion(raw) {
  return /^[1-9][0-9]{0,5}$/.test(clean(raw));
}

/** The DPA text in force for a client: the version signed in the portal, else the one bound by the contract. */
function dpaLink(client, binding) {
  const signed = client?.ext?.dpa;
  if (signed && typeof signed === 'object' && String(signed.version || '').trim()) {
    return Number(signed.catalogVersion) >= 1 ? versionedLegalUrl('databehandleravtale', signed.catalogVersion) : LEGAL_URLS.databehandleravtale;
  }
  if (binding.mode === 'catalog') return versionedLegalUrl('databehandleravtale', binding.catalogVersion);
  if (binding.mode === 'legacy') return versionedLegalUrl('databehandleravtale', 'legacy');
  return LEGAL_URLS.databehandleravtale;
}

function presentBinding(client, settings, { canSign = true } = {}) {
  const binding = legalBindingForClient(client);
  return {
    canSign: canSign !== false,
    current: { catalogVersion: CATALOG_VERSION, dpaVersion: DPA_VERSION, date: CATALOG_DATE },
    binding,
    dpa: dpaStatus(client, { settings, enabled: true }),
    links: {
      vilkar: binding.mode === 'catalog' ? versionedLegalUrl('vilkar', binding.catalogVersion) : (binding.mode === 'legacy' ? versionedLegalUrl('vilkar', 'legacy') : LEGAL_URLS.vilkar),
      personvern: LEGAL_URLS.personvern,
      databehandleravtale: dpaLink(client, binding),
      databehandleravtaleCurrent: LEGAL_URLS.databehandleravtale,
    },
  };
}

export async function register(app, deps = {}) {
  const { adminAuth, clientAuth, sales, salesOffers } = deps;
  // Tests may pass their own lookup; the hub resolves the portal user's sales client.
  const resolveClient = typeof deps.resolvePortalClient === 'function'
    ? deps.resolvePortalClient
    : (userId) => salesClientForPortalUser(userId, sales);
  setOfferTierIncludesResolver((tierId) => catalogOfferIncludes(tierId));
  setAgreedKeywordsResolver(agreedKeywordsTextForClient);
  // The switch is checked before any authentication, so every route answers the same 404 while it is off.
  const gate = (req, res, next) => (legalCatalogEnabled({ settings: currentSettings() }) ? next() : disabled(res));
  // Numbered versions of the legal pages stay readable while the switch is off once stamped
  // offers exist: those contracts link them.
  const stampsExist = stampedOffersCheck(salesOffers);
  const textsGate = (req, res, next) => {
    if (legalCatalogEnabled({ settings: currentSettings() })) return next();
    const doc = clean(req.params.doc).toLowerCase();
    if (LEGAL_DOC_IDS.includes(doc) && isNumberedVersion(req.query.version) && stampsExist()) return next();
    return disabled(res);
  };

  app.get('/api/legal/texts/:doc', textsGate, (req, res) => {
    const { status, body } = legalTextResponse(req.params.doc, { version: req.query.version, tier: req.query.tier });
    res.set('Cache-Control', 'no-store');
    return res.status(status).json(body);
  });

  app.get('/api/client/legal', gate, clientAuth, async (req, res) => {
    const settings = currentSettings();
    const { user, client, canSign } = await resolveClient(req.client?.userId);
    if (!user) return res.status(401).json({ message: 'Unauthorized' });
    if (!client) return res.json({ ...presentBinding(null, settings, { canSign }), client: false });
    return res.json({ ...presentBinding(client, settings, { canSign }), client: true });
  });

  app.post('/api/client/dpa/sign', gate, clientAuth, async (req, res) => {
    const settings = currentSettings();
    const { user, client, canSign } = await resolveClient(req.client?.userId);
    if (!user) return res.status(401).json({ message: 'Unauthorized' });
    if (!client) return res.status(404).json({ code: 'no-client', message: 'Fant ingen kundeavtale på denne kontoen.' });
    // Signing binds the business: only its owner or an admin may do it.
    if (canSign === false) return res.status(403).json({ code: 'not-authorized', message: 'Bare eieren eller en administrator i bedriften kan signere databehandleravtalen.' });
    const patch = dpaSignPatch(client, {
      userId: user.id,
      ip: req.ip || req.socket?.remoteAddress || '',
      userAgent: clean(req.get('user-agent')),
    });
    const updated = patch ? (sales.updateSalesClient(client.id, patch) || client) : client;
    return res.json({ ok: true, changed: Boolean(patch), ...presentBinding(updated, settings, { canSign }) });
  });

  app.get('/api/admin/legal/terms-update', gate, adminAuth, (req, res) => {
    const clients = sales.getSalesClients();
    const byId = new Map(clients.map((client) => [client.id, client]));
    const rows = clientsOnOlderVersions(clients).map((row) => ({
      ...row,
      notice: draftTermsUpdateNotice(byId.get(row.clientId)),
    }));
    return res.json({
      current: { catalogVersion: CATALOG_VERSION, dpaVersion: DPA_VERSION, date: CATALOG_DATE },
      clients: rows,
      // Settings whose values differ from the ones the published texts were rendered with.
      settingsDrift: legalSettingsDrift(currentSettings()),
      sends: false,
    });
  });

  // A person sends one notice. Nothing here runs on a timer.
  app.post('/api/admin/legal/terms-update/:clientId/send', gate, adminAuth, async (req, res) => {
    const client = sales.getSalesClientById(clean(req.params.clientId));
    if (!client) return res.status(404).json({ code: 'no-client' });
    const result = await sendTermsUpdateNotice(client, {
      settings: currentSettings(),
      dataDir: deps.dataDir,
      deps: { sales, sendEmail: deps.sendEmail },
    });
    if (!result.ok) return res.status(result.status).json({ code: result.code });
    return res.status(result.status).json({ ok: true, mode: result.mode, recorded: result.recorded });
  });
}
