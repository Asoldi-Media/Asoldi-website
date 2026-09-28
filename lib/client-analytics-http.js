import { randomBytes } from 'crypto';
import {
  analyticsAccessFor,
  buildAnalyticsDashboard,
  ensureMapsRanking,
  findHubSiteForProfile,
  findProfileForSiteKey,
  ingestHubTraffic,
  ingestHubCommerce,
} from './client-analytics-service.js';
import {
  clearGoogleBusinessConnection,
  getGoogleBusinessConnection,
  publicGbpStatus,
} from '../data/client-analytics.js';
import {
  createGoogleBusinessAuthUrl,
  exchangeGoogleBusinessCode,
  isGoogleBusinessConfigured,
  renderGoogleBusinessOAuthResultHtml,
  resolveGoogleBusinessRedirectUri,
  selectGoogleBusinessLocation,
} from './google-business.js';
import { mapsSpendSummary } from './dataforseo-maps.js';

const oauthStates = new Map();

function compact(value = '') {
  return String(value ?? '').trim();
}

function putState(payload) {
  const state = randomBytes(16).toString('hex');
  oauthStates.set(state, { ...payload, at: Date.now() });
  return state;
}

function takeState(state) {
  const key = compact(state);
  const row = oauthStates.get(key);
  oauthStates.delete(key);
  if (!row) return null;
  if (Date.now() - row.at > 15 * 60 * 1000) return null;
  return row;
}

export function mountClientAnalyticsRoutes(app, { clientAuth, loadClientUser, clientPortal }) {
  app.get('/api/client/analytics', clientAuth, async (req, res) => {
    const user = await loadClientUser(req, res);
    if (!user) return;
    const session = clientPortal.presentClientSession(user);
    const profile = session.profile;
    const hubSite = findHubSiteForProfile(profile);
    const access = analyticsAccessFor(profile, hubSite);
    if (!access.allowed) {
      return res.status(403).json({
        message: 'Analyse er inkludert fra SEO-nivå (tier 2).',
        access,
      });
    }
    try {
      const dashboard = await buildAnalyticsDashboard({
        profile,
        hubSite,
        range: compact(req.query.range) || '30d',
        from: compact(req.query.from),
        to: compact(req.query.to),
        includeMapsRun: req.query.refresh === '1',
      });
      return res.json(dashboard);
    } catch (error) {
      return res.status(500).json({ message: error.message || 'Kunne ikke laste analyse.' });
    }
  });

  app.post('/api/client/analytics/maps/refresh', clientAuth, async (req, res) => {
    const user = await loadClientUser(req, res);
    if (!user) return;
    const session = clientPortal.presentClientSession(user);
    const hubSite = findHubSiteForProfile(session.profile);
    const access = analyticsAccessFor(session.profile, hubSite);
    if (!access.allowed) return res.status(403).json({ message: 'Analyse er ikke inkludert i planen.' });
    try {
      const record = await ensureMapsRanking(session.profile, hubSite, { force: true });
      return res.json({ ok: true, record });
    } catch (error) {
      return res.status(500).json({ message: error.message || 'Kunne ikke oppdatere Maps-rangering.' });
    }
  });

  app.get('/api/client/google-business/status', clientAuth, async (req, res) => {
    const user = await loadClientUser(req, res);
    if (!user) return;
    const session = clientPortal.presentClientSession(user);
    const businessId = compact(session.activeBusinessId || session.profile?.businessId);
    return res.json({
      configured: isGoogleBusinessConfigured(),
      ...publicGbpStatus(getGoogleBusinessConnection(businessId)),
    });
  });

  app.get('/api/client/google-business/connect', clientAuth, async (req, res) => {
    const user = await loadClientUser(req, res);
    if (!user) return;
    if (!isGoogleBusinessConfigured()) {
      return res.status(503).json({ message: 'Google Business Profile er ikke konfigurert hos Asoldi ennå.' });
    }
    const session = clientPortal.presentClientSession(user);
    const businessId = compact(session.activeBusinessId || session.profile?.businessId);
    const redirectUri = resolveGoogleBusinessRedirectUri(req);
    const state = putState({ businessId, userId: user.id });
    const authUrl = createGoogleBusinessAuthUrl(state, redirectUri);
    if (req.query.redirect === '1') return res.redirect(authUrl);
    return res.json({ authUrl });
  });

  app.get('/api/client/google-business/callback', async (req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    const oauthError = compact(req.query.error);
    if (oauthError) {
      return res.status(400).send(renderGoogleBusinessOAuthResultHtml({
        ok: false,
        error: oauthError === 'access_denied' ? 'Du avbrøt Google-tilkoblingen.' : `Google returnerte feil: ${oauthError}`,
      }));
    }
    const row = takeState(req.query.state);
    if (!row?.businessId) {
      return res.status(400).send(renderGoogleBusinessOAuthResultHtml({
        ok: false,
        error: 'Ugyldig eller utløpt tilkobling. Prøv igjen.',
      }));
    }
    try {
      const saved = await exchangeGoogleBusinessCode(
        compact(req.query.code),
        resolveGoogleBusinessRedirectUri(req),
        row.businessId
      );
      return res.send(renderGoogleBusinessOAuthResultHtml({
        ok: true,
        googleEmail: saved?.googleEmail,
        locationTitle: saved?.locationTitle,
      }));
    } catch (error) {
      return res.status(500).send(renderGoogleBusinessOAuthResultHtml({
        ok: false,
        error: error.message || 'Google Business-tilkoblingen feilet.',
      }));
    }
  });

  app.post('/api/client/google-business/location', clientAuth, async (req, res) => {
    const user = await loadClientUser(req, res);
    if (!user) return;
    const session = clientPortal.presentClientSession(user);
    const businessId = compact(session.activeBusinessId || session.profile?.businessId);
    try {
      const saved = await selectGoogleBusinessLocation(businessId, compact(req.body?.locationName));
      return res.json(publicGbpStatus(saved));
    } catch (error) {
      return res.status(400).json({ message: error.message || 'Kunne ikke lagre lokasjon.' });
    }
  });

  app.post('/api/client/google-business/disconnect', clientAuth, async (req, res) => {
    const user = await loadClientUser(req, res);
    if (!user) return;
    const session = clientPortal.presentClientSession(user);
    const businessId = compact(session.activeBusinessId || session.profile?.businessId);
    clearGoogleBusinessConnection(businessId);
    return res.json({ connected: false });
  });

  app.get('/api/hub/analytics', (req, res) => {
    const siteKey = compact(req.query.site_key || req.get('x-cms-site-key'));
    if (!siteKey) return res.status(400).json({ message: 'site_key required' });
    const { site, profile } = findProfileForSiteKey(siteKey);
    if (!site) return res.status(404).json({ message: 'Site not found' });
    const access = analyticsAccessFor(profile || {}, site);
    if (!access.allowed) return res.status(403).json({ message: 'Analytics is not enabled for this plan.', access });
    buildAnalyticsDashboard({
      profile: profile || { businessName: site.name, clientDataBank: { generalInfo: { websiteUrl: site.domain, companyName: site.name } } },
      hubSite: site,
      range: compact(req.query.range) || '30d',
      from: compact(req.query.from),
      to: compact(req.query.to),
      includeMapsRun: req.query.refresh === '1',
    })
      .then((dashboard) => res.json(dashboard))
      .catch((error) => res.status(500).json({ message: error.message || 'Analytics failed.' }));
  });

  app.post('/api/hub/analytics/collect', (req, res) => {
    const siteKey = compact(req.body?.site_key || req.query.site_key);
    if (!siteKey) return res.status(400).json({ message: 'site_key required' });
    const site = findProfileForSiteKey(siteKey).site;
    if (!site) return res.status(404).json({ message: 'Site not found' });
    const events = Array.isArray(req.body?.events) ? req.body.events : [];
    const accepted = ingestHubTraffic(siteKey, events);
    return res.json({ ok: true, accepted });
  });

  app.post('/api/hub/analytics/commerce', (req, res) => {
    const siteKey = compact(req.body?.site_key || req.query.site_key);
    if (!siteKey) return res.status(400).json({ message: 'site_key required' });
    const site = findProfileForSiteKey(siteKey).site;
    if (!site) return res.status(404).json({ message: 'Site not found' });
    const payload = req.body && typeof req.body === 'object' ? req.body : {};
    ingestHubCommerce(siteKey, {
      orders: payload.orders,
      cancelled: payload.cancelled,
      revenue: payload.revenue,
      aov: payload.aov,
      unitsSold: payload.unitsSold,
      itemsPerOrder: payload.itemsPerOrder,
      conversionRate: payload.conversionRate,
      customers: payload.customers,
      returningCustomers: payload.returningCustomers,
      newCustomers: payload.newCustomers,
      returningRate: payload.returningRate,
      topProducts: payload.topProducts,
      series: payload.series,
      funnel: payload.funnel,
      abandonment: payload.abandonment,
      range: payload.range,
    });
    return res.json({ ok: true });
  });

  app.get('/api/hub/analytics/spend', (req, res) => {
    const siteKey = compact(req.query.site_key);
    if (!siteKey) return res.status(400).json({ message: 'site_key required' });
    if (!findProfileForSiteKey(siteKey).site) return res.status(404).json({ message: 'Site not found' });
    return res.json(mapsSpendSummary());
  });
}
