/**
 * Legal texts routes. Every route answers 404 {code:'disabled'} while legal.catalogTexts is off.
 *
 *   GET  /api/legal/texts/:doc?version=&tier=   public: rendered legal texts (lib/legal/texts.js)
 *   GET  /api/client/legal                      client: the bound version and the DPA status
 *   POST /api/client/dpa/sign                   client: sign the current DPA (idempotent)
 *   GET  /api/admin/legal/terms-update          admin: clients on an older version, with a draft
 *                                               notice per client (nothing is sent)
 *
 * register() also gives the offer composer the catalog's offer-letter lines
 * (setOfferTierIncludesResolver); the resolver answers null while the switch is off.
 */
import * as store from '../../data/store.js';
import * as clientPortal from '../../data/client-portal.js';
import * as portalOffers from '../../data/offers.js';
import { getAutomationSettings } from '../../data/automation-settings.js';
import { setOfferTierIncludesResolver } from '../offer-email.js';
import { CATALOG_DATE, CATALOG_VERSION, DPA_VERSION } from '../legal/catalog.js';
import { legalBindingForClient } from '../legal/binding.js';
import { dpaSignPatch, dpaStatus } from '../legal/dpa.js';
import { catalogOfferIncludes } from '../legal/sales.js';
import { legalCatalogEnabled } from '../legal/switch.js';
import { clientsOnOlderVersions, draftTermsUpdateNotice } from '../legal/terms-update.js';
import { legalTextResponse } from '../legal/texts.js';
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

/** The sales client behind a portal user: the user's active portal offer, else the website-builder link. */
async function salesClientForPortalUser(userId, sales) {
  const user = await store.getUserById(userId);
  if (!user || user.role !== 'client') return { user: null, client: null };
  const session = clientPortal.presentClientSession(user);
  const offer = portalOffers.getActiveOfferForUser({
    userId: user.id,
    email: user.username,
    businessId: session?.activeBusinessId || session?.profile?.businessId || '',
    membershipBusinessIds: (session?.businesses || []).map((row) => row.id),
  });
  const salesClientId = clean(offer?.salesClientId) || clean(clientPortal.getClientProfile(user.id)?.websiteBuilder?.salesClientId);
  const client = salesClientId ? sales.getSalesClientById(salesClientId) : null;
  return { user, client };
}

function presentBinding(client, settings) {
  const binding = legalBindingForClient(client);
  return {
    current: { catalogVersion: CATALOG_VERSION, dpaVersion: DPA_VERSION, date: CATALOG_DATE },
    binding,
    dpa: dpaStatus(client, { settings, enabled: true }),
    links: {
      vilkar: binding.mode === 'catalog' ? `${LEGAL_URLS.vilkar}?versjon=${binding.catalogVersion}` : (binding.mode === 'legacy' ? `${LEGAL_URLS.vilkar}?versjon=legacy` : LEGAL_URLS.vilkar),
      personvern: LEGAL_URLS.personvern,
      databehandleravtale: LEGAL_URLS.databehandleravtale,
    },
  };
}

export async function register(app, deps = {}) {
  const { adminAuth, clientAuth, sales } = deps;
  // Tests may pass their own lookup; the hub resolves the portal user's sales client.
  const resolveClient = typeof deps.resolvePortalClient === 'function'
    ? deps.resolvePortalClient
    : (userId) => salesClientForPortalUser(userId, sales);
  setOfferTierIncludesResolver((tierId) => catalogOfferIncludes(tierId));
  // The switch is checked before any authentication, so every route answers the same 404 while it is off.
  const gate = (req, res, next) => (legalCatalogEnabled({ settings: currentSettings() }) ? next() : disabled(res));

  app.get('/api/legal/texts/:doc', gate, (req, res) => {
    const settings = currentSettings();
    const { status, body } = legalTextResponse(req.params.doc, { version: req.query.version, tier: req.query.tier, settings });
    res.set('Cache-Control', 'no-store');
    return res.status(status).json(body);
  });

  app.get('/api/client/legal', gate, clientAuth, async (req, res) => {
    const settings = currentSettings();
    const { user, client } = await resolveClient(req.client?.userId);
    if (!user) return res.status(401).json({ message: 'Unauthorized' });
    if (!client) return res.json({ ...presentBinding(null, settings), client: false });
    return res.json({ ...presentBinding(client, settings), client: true });
  });

  app.post('/api/client/dpa/sign', gate, clientAuth, async (req, res) => {
    const settings = currentSettings();
    const { user, client } = await resolveClient(req.client?.userId);
    if (!user) return res.status(401).json({ message: 'Unauthorized' });
    if (!client) return res.status(404).json({ code: 'no-client', message: 'Fant ingen kundeavtale på denne kontoen.' });
    const patch = dpaSignPatch(client, {
      userId: user.id,
      ip: req.ip || req.socket?.remoteAddress || '',
      userAgent: clean(req.get('user-agent')),
    });
    const updated = patch ? (sales.updateSalesClient(client.id, patch) || client) : client;
    return res.json({ ok: true, changed: Boolean(patch), ...presentBinding(updated, settings) });
  });

  app.get('/api/admin/legal/terms-update', gate, adminAuth, (req, res) => {
    const clients = sales.getSalesClients();
    const byId = new Map(clients.map((client) => [client.id, client]));
    const rows = clientsOnOlderVersions(clients).map((row) => ({
      ...row,
      notice: draftTermsUpdateNotice(byId.get(row.clientId)),
    }));
    return res.json({ current: { catalogVersion: CATALOG_VERSION, dpaVersion: DPA_VERSION, date: CATALOG_DATE }, clients: rows, sends: false });
  });
}
