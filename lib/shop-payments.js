// Shop payments for client websites: Asoldi is the Stripe Connect platform and the
// PayPal partner. Platform secrets live only on the hub; each client site stores
// nothing but its site_key and asks the hub to onboard, create checkouts and verify.
import Stripe from 'stripe';
import { randomBytes } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { getDataFilePath, writeDataJson } from '../data/storage-path.js';

const PLATFORM_FILE = 'shop-payments-platform.json';
const SITES_FILE = 'shop-payments-sites.json';
const STRIPE_WEBHOOK_EVENTS = [
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
  'account.updated',
];
const PAYPAL_HOSTS = {
  sandbox: 'https://api-m.sandbox.paypal.com',
  live: 'https://api-m.paypal.com',
};
const ZERO_DECIMAL = new Set(['jpy', 'krw', 'vnd', 'clp', 'isk', 'huf', 'twd', 'ugx']);

const deps = {
  stripeFactory: (key) => new Stripe(key),
  fetch: (...args) => fetch(...args),
};
const stripeClients = new Map();
let paypalTokenCache = { key: '', token: '', expiresAt: 0 };

/** Tests swap the Stripe SDK and fetch for fakes. */
export function setShopPaymentDeps(next = {}) {
  Object.assign(deps, next);
  stripeClients.clear();
  paypalTokenCache = { key: '', token: '', expiresAt: 0 };
}

class ShopPaymentError extends Error {
  constructor(message, status = 400, code = '') {
    super(message);
    this.status = status;
    this.code = code;
  }
}
export { ShopPaymentError };

function clean(value) {
  return String(value ?? '').trim();
}

function readJson(file, fallback) {
  const path = getDataFilePath(file);
  if (!existsSync(path)) return fallback;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    return raw && typeof raw === 'object' ? raw : fallback;
  } catch {
    return fallback;
  }
}

// ── Platform settings (Superadmin) ────────────────────────────────────────────

function normalizePlatform(raw = {}) {
  const stripe = raw.stripe && typeof raw.stripe === 'object' ? raw.stripe : {};
  const paypal = raw.paypal && typeof raw.paypal === 'object' ? raw.paypal : {};
  const webhooks = stripe.webhooks && typeof stripe.webhooks === 'object' ? stripe.webhooks : {};
  const hook = (row) => ({
    id: clean(row?.id),
    secret: clean(row?.secret),
    url: clean(row?.url),
  });
  const fee = Number(stripe.applicationFeePercent);
  return {
    stripe: {
      mode: stripe.mode === 'test' ? 'test' : 'live',
      testSecretKey: clean(stripe.testSecretKey),
      applicationFeePercent: Number.isFinite(fee) && fee > 0 ? Math.min(fee, 20) : 0,
      webhooks: { live: hook(webhooks.live), test: hook(webhooks.test) },
    },
    paypal: {
      mode: paypal.mode === 'live' ? 'live' : 'sandbox',
      clientId: clean(paypal.clientId),
      clientSecret: clean(paypal.clientSecret),
      partnerMerchantId: clean(paypal.partnerMerchantId),
      bnCode: clean(paypal.bnCode),
    },
  };
}

export function readPlatform() {
  return normalizePlatform(readJson(PLATFORM_FILE, {}));
}

function writePlatform(platform) {
  writeDataJson(getDataFilePath(PLATFORM_FILE), normalizePlatform(platform));
}

function mask(value) {
  const text = clean(value);
  if (!text) return '';
  return text.length <= 8 ? '••••' : `${text.slice(0, 4)}…${text.slice(-4)}`;
}

/** Admin-facing view: secrets are masked, never returned. */
export function publicPlatform(platform = readPlatform()) {
  return {
    stripe: {
      mode: platform.stripe.mode,
      liveKeyPresent: Boolean(clean(process.env.STRIPE_SECRET_KEY)),
      liveKeyIsLive: clean(process.env.STRIPE_SECRET_KEY).startsWith('sk_live_') || clean(process.env.STRIPE_SECRET_KEY).startsWith('rk_live_'),
      testKeyPresent: Boolean(platform.stripe.testSecretKey),
      testKeyMasked: mask(platform.stripe.testSecretKey),
      applicationFeePercent: platform.stripe.applicationFeePercent,
      webhooks: {
        live: { configured: Boolean(platform.stripe.webhooks.live.secret), url: platform.stripe.webhooks.live.url },
        test: { configured: Boolean(platform.stripe.webhooks.test.secret), url: platform.stripe.webhooks.test.url },
      },
    },
    paypal: {
      mode: platform.paypal.mode,
      clientId: platform.paypal.clientId,
      clientSecretSet: Boolean(platform.paypal.clientSecret),
      partnerMerchantId: platform.paypal.partnerMerchantId,
      bnCode: platform.paypal.bnCode,
    },
  };
}

/** Patch from Superadmin. Empty secret fields keep the stored secret. */
export function savePlatformSettings(patch = {}) {
  const current = readPlatform();
  const next = structuredClone(current);
  const stripe = patch.stripe && typeof patch.stripe === 'object' ? patch.stripe : null;
  const paypal = patch.paypal && typeof patch.paypal === 'object' ? patch.paypal : null;
  if (stripe) {
    if (stripe.mode === 'test' || stripe.mode === 'live') next.stripe.mode = stripe.mode;
    if (clean(stripe.testSecretKey)) {
      const key = clean(stripe.testSecretKey);
      if (!/^(sk|rk)_test_/.test(key)) throw new ShopPaymentError('Test key must start with sk_test_ or rk_test_.');
      next.stripe.testSecretKey = key;
    }
    if (stripe.clearTestSecretKey === true) next.stripe.testSecretKey = '';
    if (stripe.applicationFeePercent !== undefined) next.stripe.applicationFeePercent = Number(stripe.applicationFeePercent) || 0;
  }
  if (paypal) {
    if (paypal.mode === 'live' || paypal.mode === 'sandbox') {
      if (paypal.mode !== current.paypal.mode) paypalTokenCache = { key: '', token: '', expiresAt: 0 };
      next.paypal.mode = paypal.mode;
    }
    if (paypal.clientId !== undefined) next.paypal.clientId = clean(paypal.clientId);
    if (clean(paypal.clientSecret)) next.paypal.clientSecret = clean(paypal.clientSecret);
    if (paypal.partnerMerchantId !== undefined) next.paypal.partnerMerchantId = clean(paypal.partnerMerchantId);
    if (paypal.bnCode !== undefined) next.paypal.bnCode = clean(paypal.bnCode);
  }
  writePlatform(next);
  stripeClients.clear();
  return publicPlatform(next);
}

// ── Per-site connections ──────────────────────────────────────────────────────

function readSiteRows() {
  return readJson(SITES_FILE, {});
}

function writeSiteRows(rows) {
  writeDataJson(getDataFilePath(SITES_FILE), rows);
}

export function getSiteConnection(siteId) {
  const row = readSiteRows()[siteId] || {};
  return {
    stripe: row.stripe && typeof row.stripe === 'object' ? row.stripe : {},
    paypal: row.paypal && typeof row.paypal === 'object' ? row.paypal : {},
  };
}

function patchSiteConnection(siteId, provider, patch) {
  const rows = readSiteRows();
  const row = rows[siteId] && typeof rows[siteId] === 'object' ? rows[siteId] : {};
  const prev = row[provider] && typeof row[provider] === 'object' ? row[provider] : {};
  row[provider] = patch === null ? {} : { ...prev, ...patch, updatedAt: new Date().toISOString() };
  rows[siteId] = row;
  writeSiteRows(rows);
  return row[provider];
}

function findSiteIdBy(predicate) {
  const rows = readSiteRows();
  return Object.keys(rows).find((id) => predicate(rows[id] || {})) || '';
}

export function listSiteConnections() {
  const rows = readSiteRows();
  return Object.entries(rows).map(([siteId, row]) => ({
    siteId,
    stripe: {
      connected: Boolean(row?.stripe?.accountId),
      mode: row?.stripe?.mode || '',
      chargesEnabled: Boolean(row?.stripe?.chargesEnabled),
    },
    paypal: {
      connected: Boolean(row?.paypal?.merchantId || row?.paypal?.email),
      mode: row?.paypal?.mode || '',
      paymentsReceivable: Boolean(row?.paypal?.paymentsReceivable),
      email: row?.paypal?.email || '',
    },
  }));
}

// ── Return URL guard ──────────────────────────────────────────────────────────

function isPrivateHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    host === '[::1]'
  );
}

function siteHosts(site) {
  const hosts = new Set();
  const add = (value) => {
    const raw = clean(value).toLowerCase();
    if (!raw) return;
    try {
      const host = new URL(raw.includes('://') ? raw : `https://${raw}`).hostname;
      if (!host) return;
      hosts.add(host);
      hosts.add(host.startsWith('www.') ? host.slice(4) : `www.${host}`);
    } catch {
      /* ignore bad stored value */
    }
  };
  add(site.domain);
  add(site.cms?.adminUrl);
  return hosts;
}

/**
 * Return/cancel URLs must point back at the client's own site. Loopback/LAN is
 * allowed for the Maker's local CMS sidecar; providers reject http in live mode anyway.
 */
export function assertSiteUrl(site, value, label = 'URL') {
  let url;
  try {
    url = new URL(clean(value));
  } catch {
    throw new ShopPaymentError(`${label} is not a valid URL.`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new ShopPaymentError(`${label} must be http(s).`);
  if (isPrivateHost(url.hostname)) return url.toString();
  if (url.protocol !== 'https:') throw new ShopPaymentError(`${label} must use https.`);
  if (!siteHosts(site).has(url.hostname.toLowerCase())) {
    throw new ShopPaymentError(`${label} must be on ${site.domain || 'the site domain'}.`, 400, 'bad_return_url');
  }
  return url.toString();
}

// ── Money ─────────────────────────────────────────────────────────────────────

export function normalizeLineItems(raw) {
  const rows = Array.isArray(raw) ? raw : [];
  const items = rows.slice(0, 50).map((row) => ({
    name: clean(row?.name).slice(0, 200),
    unitAmount: Math.round(Number(row?.unitAmount)),
    quantity: Math.round(Number(row?.quantity)),
  }));
  if (!items.length) throw new ShopPaymentError('No items to pay for.');
  for (const item of items) {
    if (!item.name) throw new ShopPaymentError('Every item needs a name.');
    if (!Number.isInteger(item.unitAmount) || item.unitAmount <= 0) throw new ShopPaymentError('Every item needs a positive price.');
    if (!Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 999) throw new ShopPaymentError('Quantity must be 1–999.');
  }
  return items;
}

function normalizeCurrency(value) {
  const currency = clean(value || 'nok').toLowerCase();
  if (!/^[a-z]{3}$/.test(currency)) throw new ShopPaymentError('Bad currency.');
  return currency;
}

function minorToDecimalString(minor, currency) {
  if (ZERO_DECIMAL.has(currency)) return String(minor);
  return (minor / 100).toFixed(2);
}

function decimalToMinor(value, currency) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  return ZERO_DECIMAL.has(currency) ? Math.round(num) : Math.round(num * 100);
}

// ── Stripe Connect ────────────────────────────────────────────────────────────

function stripeKeyFor(platform) {
  return platform.stripe.mode === 'test' ? platform.stripe.testSecretKey : clean(process.env.STRIPE_SECRET_KEY);
}

function stripeFor(platform = readPlatform()) {
  const key = stripeKeyFor(platform);
  if (!key) {
    throw new ShopPaymentError(
      platform.stripe.mode === 'test' ? 'Stripe test key is not saved in Superadmin.' : 'STRIPE_SECRET_KEY is not set on asoldi.com.',
      503,
      'stripe_not_configured'
    );
  }
  if (!stripeClients.has(key)) stripeClients.set(key, deps.stripeFactory(key));
  return stripeClients.get(key);
}

function stripeConnection(siteId, platform) {
  const row = getSiteConnection(siteId).stripe;
  // A test-mode account means nothing to the live key and vice versa.
  return row.accountId && row.mode === platform.stripe.mode ? row : null;
}

function stripeError(err) {
  const message = clean(err?.raw?.message || err?.message) || 'Stripe request failed.';
  if (/signed up for connect|connect platform|not.*enabled.*connect/i.test(message)) {
    return new ShopPaymentError('Stripe Connect is not activated on the Asoldi Stripe account yet.', 503, 'connect_not_enabled');
  }
  if (/branding|business name|icon/i.test(message) && /connect|account link/i.test(message)) {
    return new ShopPaymentError('Stripe Connect branding (name/icon) is missing on the Asoldi Stripe account.', 503, 'connect_branding');
  }
  return new ShopPaymentError(message, err?.statusCode && err.statusCode < 500 ? 400 : 502, clean(err?.code));
}

function accountSnapshot(account) {
  return {
    chargesEnabled: Boolean(account?.charges_enabled),
    detailsSubmitted: Boolean(account?.details_submitted),
    payoutsEnabled: Boolean(account?.payouts_enabled),
    currentlyDue: Array.isArray(account?.requirements?.currently_due) ? account.requirements.currently_due.length : 0,
    displayName: clean(account?.business_profile?.name || account?.settings?.dashboard?.display_name),
    email: clean(account?.email),
    country: clean(account?.country),
    defaultCurrency: clean(account?.default_currency),
  };
}

async function refreshStripeAccount(site, platform) {
  const conn = stripeConnection(site.id, platform);
  if (!conn) return null;
  try {
    const account = await stripeFor(platform).accounts.retrieve(conn.accountId);
    return patchSiteConnection(site.id, 'stripe', accountSnapshot(account));
  } catch (err) {
    const code = clean(err?.code);
    if (code === 'account_invalid' || /does not have access to account|no such account/i.test(clean(err?.message))) {
      // Client revoked the platform from their Stripe dashboard.
      patchSiteConnection(site.id, 'stripe', null);
      return null;
    }
    return conn;
  }
}

export async function startStripeOnboarding(site, { returnUrl, hubUrl }) {
  const platform = readPlatform();
  const stripe = stripeFor(platform);
  const back = assertSiteUrl(site, returnUrl, 'returnUrl');
  let conn = stripeConnection(site.id, platform);
  try {
    if (!conn) {
      const account = await stripe.accounts.create({
        type: 'standard',
        country: 'NO',
        business_profile: {
          name: clean(site.name).slice(0, 100) || undefined,
          url: site.domain ? `https://${clean(site.domain).replace(/^https?:\/\//, '')}` : undefined,
        },
        metadata: { asoldi_site_id: site.id },
      });
      conn = patchSiteConnection(site.id, 'stripe', {
        accountId: account.id,
        mode: platform.stripe.mode,
        ...accountSnapshot(account),
      });
    }
    const nonce = randomBytes(18).toString('hex');
    patchSiteConnection(site.id, 'stripe', { linkNonce: nonce, returnUrl: back });
    const link = await stripe.accountLinks.create({
      account: conn.accountId,
      refresh_url: `${hubUrl}/api/hub/shop/stripe/refresh/${nonce}`,
      return_url: back,
      type: 'account_onboarding',
    });
    return { url: link.url, accountId: conn.accountId };
  } catch (err) {
    if (err instanceof ShopPaymentError) throw err;
    throw stripeError(err);
  }
}

/** Stripe calls refresh_url when a link expired; mint a new one and bounce the browser. */
export async function refreshStripeOnboardingLink(nonce, { hubUrl }) {
  const key = clean(nonce);
  if (!/^[a-f0-9]{36}$/.test(key)) throw new ShopPaymentError('Link not found.', 404);
  const siteId = findSiteIdBy((row) => row?.stripe?.linkNonce === key);
  if (!siteId) throw new ShopPaymentError('Link not found.', 404);
  const platform = readPlatform();
  const conn = stripeConnection(siteId, platform);
  if (!conn) throw new ShopPaymentError('Link not found.', 404);
  const next = randomBytes(18).toString('hex');
  patchSiteConnection(siteId, 'stripe', { linkNonce: next });
  try {
    const link = await stripeFor(platform).accountLinks.create({
      account: conn.accountId,
      refresh_url: `${hubUrl}/api/hub/shop/stripe/refresh/${next}`,
      return_url: conn.returnUrl,
      type: 'account_onboarding',
    });
    return link.url;
  } catch (err) {
    throw stripeError(err);
  }
}

export async function createStripeCheckout(site, body = {}) {
  const platform = readPlatform();
  const conn = await refreshStripeAccount(site, platform);
  if (!conn?.accountId) throw new ShopPaymentError('Stripe is not connected for this site.', 409, 'stripe_not_connected');
  if (!conn.chargesEnabled) throw new ShopPaymentError('The Stripe account cannot take payments yet. Finish Stripe onboarding.', 409, 'stripe_not_ready');
  const items = normalizeLineItems(body.lineItems);
  const currency = normalizeCurrency(body.currency);
  const ref = clean(body.ref).slice(0, 80);
  if (!ref) throw new ShopPaymentError('ref is required.');
  const successUrl = assertSiteUrl(site, body.successUrl, 'successUrl');
  const cancelUrl = assertSiteUrl(site, body.cancelUrl, 'cancelUrl');
  const total = items.reduce((sum, item) => sum + item.unitAmount * item.quantity, 0);
  const feePercent = platform.stripe.applicationFeePercent;
  const params = {
    mode: 'payment',
    line_items: items.map((item) => ({
      quantity: item.quantity,
      price_data: { currency, unit_amount: item.unitAmount, product_data: { name: item.name } },
    })),
    success_url: `${successUrl}${successUrl.includes('?') ? '&' : '?'}session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: cancelUrl,
    client_reference_id: ref,
    metadata: { asoldi_site_id: site.id, checkout_ref: ref },
    phone_number_collection: { enabled: true },
    locale: 'auto',
  };
  if (clean(body.customerEmail)) params.customer_email = clean(body.customerEmail);
  if (body.collectShipping) {
    params.shipping_address_collection = { allowed_countries: ['NO', 'SE', 'DK', 'FI', 'IS', 'DE', 'NL', 'GB', 'US'] };
  }
  if (feePercent > 0) {
    params.payment_intent_data = { application_fee_amount: Math.floor((total * feePercent) / 100) };
  }
  try {
    const session = await stripeFor(platform).checkout.sessions.create(params, { stripeAccount: conn.accountId });
    return { id: session.id, url: session.url };
  } catch (err) {
    throw stripeError(err);
  }
}

function addressFromStripe(details) {
  const address = details?.address;
  if (!address) return '';
  return [details?.name, address.line1, address.line2, [address.postal_code, address.city].filter(Boolean).join(' '), address.country]
    .map(clean)
    .filter(Boolean)
    .join(', ');
}

export async function getStripeCheckout(site, sessionId) {
  const id = clean(sessionId);
  if (!/^cs_[A-Za-z0-9_]+$/.test(id)) throw new ShopPaymentError('Bad session id.');
  const platform = readPlatform();
  const conn = stripeConnection(site.id, platform);
  if (!conn) throw new ShopPaymentError('Stripe is not connected for this site.', 409, 'stripe_not_connected');
  let session;
  try {
    session = await stripeFor(platform).checkout.sessions.retrieve(id, {}, { stripeAccount: conn.accountId });
  } catch (err) {
    throw stripeError(err);
  }
  if (session?.metadata?.asoldi_site_id !== site.id) throw new ShopPaymentError('Session does not belong to this site.', 404);
  const customer = session.customer_details || {};
  const shipping = session.collected_information?.shipping_details || session.shipping_details || null;
  const currency = clean(session.currency).toLowerCase();
  return {
    provider: 'stripe',
    id: session.id,
    ref: clean(session.metadata?.checkout_ref || session.client_reference_id),
    paid: session.payment_status === 'paid',
    status: clean(session.status),
    amountMinor: Number(session.amount_total) || 0,
    currency,
    customerName: clean(customer.name),
    customerEmail: clean(customer.email),
    customerPhone: clean(customer.phone),
    shippingAddress: addressFromStripe(shipping),
    paymentRef: clean(typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id) || session.id,
  };
}

/** Verifies a Connect webhook. Returns the site + session to notify, or null. */
export function parseStripeConnectWebhook(rawBody, signature) {
  const platform = readPlatform();
  const candidates = [
    [platform.stripe.webhooks.live.secret, clean(process.env.STRIPE_SECRET_KEY)],
    [platform.stripe.webhooks.test.secret, platform.stripe.testSecretKey],
  ].filter(([secret, key]) => secret && key);
  if (!candidates.length) throw new ShopPaymentError('Connect webhook is not configured.', 503);
  let event = null;
  for (const [secret, key] of candidates) {
    try {
      if (!stripeClients.has(key)) stripeClients.set(key, deps.stripeFactory(key));
      event = stripeClients.get(key).webhooks.constructEvent(rawBody, signature, secret);
      break;
    } catch {
      /* try the other mode's secret */
    }
  }
  if (!event) throw new ShopPaymentError('Bad signature.', 400);
  const accountId = clean(event.account);
  const siteId = accountId ? findSiteIdBy((row) => row?.stripe?.accountId === accountId) : '';
  if (event.type === 'account.updated' && siteId) {
    patchSiteConnection(siteId, 'stripe', accountSnapshot(event.data?.object));
    return { type: event.type, siteId, sessionId: '' };
  }
  if (/^checkout\.session\./.test(event.type)) {
    const session = event.data?.object || {};
    const owner = clean(session.metadata?.asoldi_site_id);
    if (!siteId || owner !== siteId) return { type: event.type, siteId: '', sessionId: '' };
    return { type: event.type, siteId, sessionId: clean(session.id) };
  }
  return { type: event.type, siteId, sessionId: '' };
}

/** Creates (or replaces) the Connect webhook endpoint for the current Stripe mode. */
export async function ensureStripeConnectWebhook({ hubUrl }) {
  const platform = readPlatform();
  const stripe = stripeFor(platform);
  const mode = platform.stripe.mode;
  const url = `${hubUrl}/api/hub/shop/stripe/webhook`;
  const existing = platform.stripe.webhooks[mode];
  try {
    if (existing.id) {
      await stripe.webhookEndpoints.del(existing.id).catch(() => null);
    }
    const endpoint = await stripe.webhookEndpoints.create({
      url,
      connect: true,
      enabled_events: STRIPE_WEBHOOK_EVENTS,
      description: 'Asoldi client shops (Connect)',
    });
    const next = readPlatform();
    next.stripe.webhooks[mode] = { id: endpoint.id, secret: endpoint.secret, url };
    writePlatform(next);
    return { mode, url, id: endpoint.id };
  } catch (err) {
    throw stripeError(err);
  }
}

// ── PayPal partner ────────────────────────────────────────────────────────────

function paypalReady(platform) {
  return Boolean(platform.paypal.clientId && platform.paypal.clientSecret);
}

async function paypalToken(platform) {
  if (!paypalReady(platform)) throw new ShopPaymentError('PayPal is not configured in Superadmin.', 503, 'paypal_not_configured');
  const cacheKey = `${platform.paypal.mode}:${platform.paypal.clientId}`;
  if (paypalTokenCache.key === cacheKey && paypalTokenCache.expiresAt > Date.now() + 60_000) return paypalTokenCache.token;
  const basic = Buffer.from(`${platform.paypal.clientId}:${platform.paypal.clientSecret}`).toString('base64');
  const res = await deps.fetch(`${PAYPAL_HOSTS[platform.paypal.mode]}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
    signal: AbortSignal.timeout(15_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new ShopPaymentError(`PayPal login failed: ${clean(data.error_description || data.error) || res.status}`, 502, 'paypal_auth');
  }
  paypalTokenCache = { key: cacheKey, token: data.access_token, expiresAt: Date.now() + Number(data.expires_in || 3000) * 1000 };
  return data.access_token;
}

async function paypalRequest(platform, method, path, body, { allow404 = false } = {}) {
  const token = await paypalToken(platform);
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  if (platform.paypal.bnCode) headers['PayPal-Partner-Attribution-Id'] = platform.paypal.bnCode;
  const res = await deps.fetch(`${PAYPAL_HOSTS[platform.paypal.mode]}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const data = await res.json().catch(() => ({}));
  if (allow404 && res.status === 404) return null;
  if (!res.ok) {
    const issue = clean(data?.details?.[0]?.issue || data?.name);
    const message = clean(data?.details?.[0]?.description || data?.message) || `PayPal error ${res.status}`;
    const err = new ShopPaymentError(message, res.status === 403 || res.status === 401 ? 503 : 502, issue);
    err.paypalStatus = res.status;
    throw err;
  }
  return data;
}

function paypalConnection(siteId, platform) {
  const row = getSiteConnection(siteId).paypal;
  return (row.merchantId || row.email || row.trackingId) && row.mode === platform.paypal.mode ? row : null;
}

async function refreshPaypal(site, platform) {
  const conn = paypalConnection(site.id, platform);
  if (!conn || conn.email || !platform.paypal.partnerMerchantId || !paypalReady(platform)) return conn;
  try {
    const partner = encodeURIComponent(platform.paypal.partnerMerchantId);
    let merchantId = conn.merchantId;
    if (!merchantId && conn.trackingId) {
      const found = await paypalRequest(
        platform,
        'GET',
        `/v1/customer/partners/${partner}/merchant-integrations?tracking_id=${encodeURIComponent(conn.trackingId)}`,
        undefined,
        { allow404: true }
      );
      merchantId = clean(found?.merchant_id);
    }
    if (!merchantId) return conn;
    const info = await paypalRequest(platform, 'GET', `/v1/customer/partners/${partner}/merchant-integrations/${encodeURIComponent(merchantId)}`, undefined, { allow404: true });
    if (!info) return patchSiteConnection(site.id, 'paypal', { merchantId, paymentsReceivable: false });
    return patchSiteConnection(site.id, 'paypal', {
      merchantId,
      paymentsReceivable: Boolean(info.payments_receivable),
      emailConfirmed: Boolean(info.primary_email_confirmed),
      email: '',
      accountEmail: clean(info.primary_email),
    });
  } catch {
    return conn;
  }
}

/**
 * Starts PayPal seller onboarding. With a partner merchant id this is the
 * Partner Referrals login flow; with `email` it stores the seller's PayPal email
 * (payee by email) for platforms still waiting on PayPal partner approval.
 */
export async function startPaypalOnboarding(site, { returnUrl, email } = {}) {
  const platform = readPlatform();
  if (!paypalReady(platform)) throw new ShopPaymentError('PayPal is not configured in Superadmin.', 503, 'paypal_not_configured');
  const sellerEmail = clean(email).toLowerCase();
  if (sellerEmail) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(sellerEmail)) throw new ShopPaymentError('Enter a valid PayPal email.');
    patchSiteConnection(site.id, 'paypal', null);
    patchSiteConnection(site.id, 'paypal', { mode: platform.paypal.mode, email: sellerEmail, paymentsReceivable: true });
    return { connected: true };
  }
  if (!platform.paypal.partnerMerchantId) {
    throw new ShopPaymentError('PayPal login is not enabled yet. Enter your PayPal email instead.', 409, 'paypal_partner_missing');
  }
  const back = assertSiteUrl(site, returnUrl, 'returnUrl');
  const trackingId = `${site.id}-${randomBytes(4).toString('hex')}`.slice(0, 127);
  const data = await paypalRequest(platform, 'POST', '/v2/customer/partner-referrals', {
    tracking_id: trackingId,
    partner_config_override: { return_url: back, return_url_description: 'Tilbake til nettsiden' },
    operations: [
      {
        operation: 'API_INTEGRATION',
        api_integration_preference: {
          rest_api_integration: {
            integration_method: 'PAYPAL',
            integration_type: 'THIRD_PARTY',
            third_party_details: { features: ['PAYMENT', 'REFUND'] },
          },
        },
      },
    ],
    products: ['EXPRESS_CHECKOUT'],
    legal_consents: [{ type: 'SHARE_DATA_CONSENT', granted: true }],
  }).catch((err) => {
    if (err.paypalStatus === 403 || err.paypalStatus === 401) {
      throw new ShopPaymentError(
        'PayPal has not approved Asoldi as a partner yet. Enter your PayPal email instead.',
        409,
        'paypal_partner_not_approved'
      );
    }
    throw err;
  });
  const action = (Array.isArray(data?.links) ? data.links : []).find((link) => link.rel === 'action_url');
  if (!action?.href) throw new ShopPaymentError('PayPal did not return a login link.', 502);
  patchSiteConnection(site.id, 'paypal', null);
  patchSiteConnection(site.id, 'paypal', { mode: platform.paypal.mode, trackingId, returnUrl: back });
  return { url: action.href };
}

function paypalPayee(conn) {
  if (conn.merchantId) return { merchant_id: conn.merchantId };
  if (conn.email) return { email_address: conn.email };
  return null;
}

export async function createPaypalOrder(site, body = {}) {
  const platform = readPlatform();
  const conn = await refreshPaypal(site, platform);
  const payee = conn ? paypalPayee(conn) : null;
  if (!payee) throw new ShopPaymentError('PayPal is not connected for this site.', 409, 'paypal_not_connected');
  if (conn.merchantId && !conn.paymentsReceivable) {
    throw new ShopPaymentError('The PayPal account cannot receive payments yet.', 409, 'paypal_not_ready');
  }
  const items = normalizeLineItems(body.lineItems);
  const currency = normalizeCurrency(body.currency);
  const ref = clean(body.ref).slice(0, 80);
  if (!ref) throw new ShopPaymentError('ref is required.');
  const returnUrl = assertSiteUrl(site, body.successUrl, 'successUrl');
  const cancelUrl = assertSiteUrl(site, body.cancelUrl, 'cancelUrl');
  const code = currency.toUpperCase();
  const total = items.reduce((sum, item) => sum + item.unitAmount * item.quantity, 0);
  const data = await paypalRequest(platform, 'POST', '/v2/checkout/orders', {
    intent: 'CAPTURE',
    purchase_units: [
      {
        reference_id: ref,
        custom_id: `${site.id}:${ref}`.slice(0, 127),
        payee,
        amount: {
          currency_code: code,
          value: minorToDecimalString(total, currency),
          breakdown: { item_total: { currency_code: code, value: minorToDecimalString(total, currency) } },
        },
        items: items.map((item) => ({
          name: item.name.slice(0, 127),
          quantity: String(item.quantity),
          unit_amount: { currency_code: code, value: minorToDecimalString(item.unitAmount, currency) },
        })),
      },
    ],
    payment_source: {
      paypal: {
        experience_context: {
          brand_name: clean(site.name).slice(0, 127) || undefined,
          user_action: 'PAY_NOW',
          shipping_preference: body.collectShipping ? 'GET_FROM_FILE' : 'NO_SHIPPING',
          return_url: returnUrl,
          cancel_url: cancelUrl,
        },
      },
    },
  });
  const approve = (Array.isArray(data?.links) ? data.links : []).find((link) => link.rel === 'payer-action' || link.rel === 'approve');
  if (!approve?.href) throw new ShopPaymentError('PayPal did not return an approval link.', 502);
  return { id: data.id, url: approve.href };
}

function paypalResult(site, order) {
  const unit = order?.purchase_units?.[0] || {};
  const customId = clean(unit.custom_id);
  if (!customId.startsWith(`${site.id}:`)) throw new ShopPaymentError('Order does not belong to this site.', 404);
  const capture = unit.payments?.captures?.[0] || null;
  const currency = clean(capture?.amount?.currency_code || unit.amount?.currency_code).toLowerCase();
  const shipping = unit.shipping || {};
  const address = shipping.address || {};
  return {
    provider: 'paypal',
    id: clean(order.id),
    ref: customId.slice(site.id.length + 1),
    paid: order.status === 'COMPLETED' && capture?.status === 'COMPLETED',
    status: clean(capture?.status || order.status),
    amountMinor: decimalToMinor(capture?.amount?.value || unit.amount?.value, currency),
    currency,
    customerName: [order.payer?.name?.given_name, order.payer?.name?.surname].map(clean).filter(Boolean).join(' '),
    customerEmail: clean(order.payer?.email_address),
    customerPhone: clean(order.payer?.phone?.phone_number?.national_number),
    shippingAddress: [shipping.name?.full_name, address.address_line_1, address.address_line_2, [address.postal_code, address.admin_area_2].filter(Boolean).join(' '), address.country_code]
      .map(clean)
      .filter(Boolean)
      .join(', '),
    paymentRef: clean(capture?.id) || clean(order.id),
  };
}

export async function capturePaypalOrder(site, orderId) {
  const id = clean(orderId);
  if (!/^[A-Z0-9]{8,40}$/i.test(id)) throw new ShopPaymentError('Bad PayPal order id.');
  const platform = readPlatform();
  const path = `/v2/checkout/orders/${encodeURIComponent(id)}`;
  const before = await paypalRequest(platform, 'GET', path);
  paypalResult(site, before);
  if (before.status === 'COMPLETED') return paypalResult(site, before);
  if (before.status !== 'APPROVED') return { ...paypalResult(site, before), paid: false };
  try {
    const captured = await paypalRequest(platform, 'POST', `${path}/capture`, {});
    return paypalResult(site, captured.purchase_units?.[0]?.custom_id ? captured : await paypalRequest(platform, 'GET', path));
  } catch (err) {
    if (err.code === 'ORDER_ALREADY_CAPTURED') return paypalResult(site, await paypalRequest(platform, 'GET', path));
    throw err;
  }
}

// ── Status + disconnect ───────────────────────────────────────────────────────

/** What the client CMS shows on its Payments panel and storefront. */
export async function getSiteShopStatus(site) {
  const platform = readPlatform();
  const stripeAvailable = Boolean(stripeKeyFor(platform));
  const stripeConn = stripeAvailable ? await refreshStripeAccount(site, platform) : null;
  const paypalAvailable = paypalReady(platform);
  const paypalConn = paypalAvailable ? await refreshPaypal(site, platform) : null;
  const paypalPayeeSet = Boolean(paypalConn?.merchantId || paypalConn?.email);
  return {
    stripe: {
      available: stripeAvailable,
      mode: platform.stripe.mode,
      connected: Boolean(stripeConn?.accountId),
      chargesEnabled: Boolean(stripeConn?.chargesEnabled),
      detailsSubmitted: Boolean(stripeConn?.detailsSubmitted),
      payoutsEnabled: Boolean(stripeConn?.payoutsEnabled),
      currentlyDue: Number(stripeConn?.currentlyDue) || 0,
      displayName: clean(stripeConn?.displayName),
      email: clean(stripeConn?.email),
      ready: Boolean(stripeConn?.chargesEnabled),
    },
    paypal: {
      available: paypalAvailable,
      mode: platform.paypal.mode,
      loginAvailable: paypalAvailable && Boolean(platform.paypal.partnerMerchantId),
      connected: paypalPayeeSet,
      pending: Boolean(paypalConn?.trackingId && !paypalPayeeSet),
      method: paypalConn?.merchantId ? 'login' : paypalConn?.email ? 'email' : '',
      email: clean(paypalConn?.email || paypalConn?.accountEmail),
      paymentsReceivable: Boolean(paypalConn?.paymentsReceivable),
      ready: paypalPayeeSet && (Boolean(paypalConn?.email) || Boolean(paypalConn?.paymentsReceivable)),
    },
  };
}

export function disconnectProvider(site, provider) {
  if (provider !== 'stripe' && provider !== 'paypal') throw new ShopPaymentError('Unknown provider.');
  patchSiteConnection(site.id, provider, null);
  return { ok: true };
}

/** Superadmin "Check" button: proves each platform credential actually works. */
export async function checkPlatform() {
  const platform = readPlatform();
  const result = { stripe: { ok: false, message: '' }, paypal: { ok: false, message: '' } };
  try {
    const stripe = stripeFor(platform);
    await stripe.accounts.list({ limit: 1 });
    result.stripe = { ok: true, message: 'Stripe Connect is active.' };
  } catch (err) {
    const mapped = err instanceof ShopPaymentError ? err : stripeError(err);
    result.stripe = { ok: false, message: mapped.message, code: mapped.code };
  }
  try {
    await paypalToken(platform);
    result.paypal = {
      ok: true,
      message: platform.paypal.partnerMerchantId
        ? `PayPal ${platform.paypal.mode} credentials work.`
        : `PayPal ${platform.paypal.mode} credentials work. Add the Asoldi merchant id to enable PayPal login.`,
    };
  } catch (err) {
    result.paypal = { ok: false, message: clean(err?.message), code: clean(err?.code) };
  }
  return result;
}
