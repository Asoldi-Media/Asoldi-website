import express from 'express';
import * as hub from '../data/hub.js';
import {
  ShopPaymentError,
  capturePaypalOrder,
  checkPlatform,
  createPaypalOrder,
  createStripeCheckout,
  disconnectProvider,
  ensureStripeConnectWebhook,
  getSiteShopStatus,
  getStripeCheckout,
  listSiteConnections,
  parseStripeConnectWebhook,
  publicPlatform,
  refreshStripeOnboardingLink,
  savePlatformSettings,
  startPaypalOnboarding,
  startStripeOnboarding,
} from './shop-payments.js';

function hubBaseUrl(req) {
  const fromEnv = String(process.env.APP_URL || '').trim().replace(/\/+$/, '');
  if (fromEnv) return fromEnv;
  return `${req.protocol}://${req.get('host')}`;
}

function sendError(res, err) {
  const status = err instanceof ShopPaymentError ? err.status : 500;
  if (status >= 500 && !(err instanceof ShopPaymentError)) console.error('[shop-payments]', err);
  res.status(status).json({ message: err?.message || 'Payment request failed.', code: err?.code || '' });
}

// Client CMS → hub calls are server-to-server; the site_key never reaches a browser.
function siteAuth(req, res, next) {
  const siteKey = String(req.get('x-site-key') || '').trim();
  const site = siteKey ? hub.getSiteByKey(siteKey) : null;
  if (!site) return res.status(401).json({ message: 'Unknown site.' });
  req.shopSite = site;
  next();
}

function wrap(handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (err) {
      sendError(res, err);
    }
  };
}

async function notifySite(siteId, sessionId) {
  const site = hub.getSiteById(siteId);
  const domain = String(site?.domain || '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!domain) return;
  try {
    await fetch(`https://${domain}/api/cms/checkout/notify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'stripe', id: sessionId }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    console.warn('[shop-payments] notify failed', domain, err?.message || err);
  }
}

/** Must be registered before express.json(): Stripe signs the raw body. */
export function registerShopPaymentsWebhook(app) {
  app.post('/api/hub/shop/stripe/webhook', express.raw({ type: 'application/json', limit: '1mb' }), (req, res) => {
    let parsed;
    try {
      parsed = parseStripeConnectWebhook(req.body, req.get('stripe-signature'));
    } catch (err) {
      return sendError(res, err);
    }
    res.json({ received: true });
    if (parsed.siteId && parsed.sessionId) void notifySite(parsed.siteId, parsed.sessionId);
  });
}

export function registerShopPaymentsRoutes(app, { adminAuth }) {
  app.get('/api/hub/shop/status', siteAuth, wrap(async (req, res) => {
    res.json(await getSiteShopStatus(req.shopSite));
  }));

  app.post('/api/hub/shop/stripe/connect', siteAuth, wrap(async (req, res) => {
    res.json(await startStripeOnboarding(req.shopSite, { returnUrl: req.body?.returnUrl, hubUrl: hubBaseUrl(req) }));
  }));

  app.get('/api/hub/shop/stripe/refresh/:nonce', async (req, res) => {
    try {
      res.redirect(303, await refreshStripeOnboardingLink(req.params.nonce, { hubUrl: hubBaseUrl(req) }));
    } catch (err) {
      res.status(err?.status || 500).type('text/plain').send(`${err?.message || 'Could not open Stripe.'} Go back to your website admin and click "Connect Stripe" again.`);
    }
  });

  app.post('/api/hub/shop/stripe/checkout', siteAuth, wrap(async (req, res) => {
    res.json(await createStripeCheckout(req.shopSite, req.body || {}));
  }));

  app.get('/api/hub/shop/stripe/session/:id', siteAuth, wrap(async (req, res) => {
    res.json(await getStripeCheckout(req.shopSite, req.params.id));
  }));

  app.post('/api/hub/shop/paypal/connect', siteAuth, wrap(async (req, res) => {
    res.json(await startPaypalOnboarding(req.shopSite, { returnUrl: req.body?.returnUrl, email: req.body?.email }));
  }));

  app.post('/api/hub/shop/paypal/order', siteAuth, wrap(async (req, res) => {
    res.json(await createPaypalOrder(req.shopSite, req.body || {}));
  }));

  app.post('/api/hub/shop/paypal/capture', siteAuth, wrap(async (req, res) => {
    res.json(await capturePaypalOrder(req.shopSite, req.body?.orderId));
  }));

  app.post('/api/hub/shop/disconnect', siteAuth, wrap(async (req, res) => {
    res.json(disconnectProvider(req.shopSite, String(req.body?.provider || '')));
  }));

  // ── Superadmin ──
  app.get('/api/hub/payments-platform', adminAuth, wrap(async (req, res) => {
    const sites = new Map(hub.getAllSites().map((site) => [site.id, site]));
    const connections = listSiteConnections()
      .filter((row) => sites.has(row.siteId))
      .map((row) => ({ ...row, name: sites.get(row.siteId).name, domain: sites.get(row.siteId).domain }));
    const body = { platform: publicPlatform(), connections, webhookUrl: `${hubBaseUrl(req)}/api/hub/shop/stripe/webhook` };
    if (req.query.check === '1') body.check = await checkPlatform();
    res.json(body);
  }));

  app.put('/api/hub/payments-platform', adminAuth, wrap(async (req, res) => {
    res.json({ platform: savePlatformSettings(req.body || {}) });
  }));

  app.post('/api/hub/payments-platform/stripe-webhook', adminAuth, wrap(async (req, res) => {
    res.json(await ensureStripeConnectWebhook({ hubUrl: hubBaseUrl(req) }));
  }));
}
