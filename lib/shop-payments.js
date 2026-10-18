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
  'checkout.session.expired',
  'invoice.paid',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'account.updated',
];
/** Stripe event → what the client CMS `/api/cms/checkout/notify` understands. */
const CMS_NOTIFY_TYPES = {
  'checkout.session.completed': 'checkout.completed',
  'checkout.session.async_payment_succeeded': 'checkout.completed',
  'checkout.session.expired': 'checkout.expired',
  'invoice.paid': 'invoice.paid',
  'customer.subscription.updated': 'subscription.updated',
  'customer.subscription.deleted': 'subscription.updated',
};
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

// Live Connect key lives only in hPanel env, never in the data dir. Separate from
// STRIPE_SECRET_KEY (plan billing), whose account cannot run Connect.
function connectLiveKey() {
  return clean(process.env.STRIPE_CONNECT_SECRET_KEY);
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
      liveKeyPresent: Boolean(connectLiveKey()),
      liveKeyMasked: mask(connectLiveKey()),
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

/** Deletes a webhook endpoint with the key that created it. Best effort. */
async function dropWebhook(key, id) {
  if (!key || !id) return;
  try {
    if (!stripeClients.has(key)) stripeClients.set(key, deps.stripeFactory(key));
    await stripeClients.get(key).webhookEndpoints.del(id);
  } catch {
    /* already gone or other account */
  }
}

/**
 * Patch from Superadmin. Empty secret fields keep the stored secret. Swapping the
 * test key removes the old test webhook. Returns the modes whose key changed so
 * the caller can create the new webhook.
 */
export async function savePlatformSettings(patch = {}) {
  const current = readPlatform();
  const next = structuredClone(current);
  const stripe = patch.stripe && typeof patch.stripe === 'object' ? patch.stripe : null;
  const paypal = patch.paypal && typeof patch.paypal === 'object' ? patch.paypal : null;
  const changedModes = [];
  if (stripe) {
    if (stripe.mode === 'test' || stripe.mode === 'live') next.stripe.mode = stripe.mode;
    const key = clean(stripe.testSecretKey);
    if (key && key !== current.stripe.testSecretKey) {
      if (!/^(sk|rk)_test_/.test(key)) throw new ShopPaymentError('Test key must start with sk_test_ or rk_test_.');
      await dropWebhook(current.stripe.testSecretKey, current.stripe.webhooks.test.id);
      next.stripe.testSecretKey = key;
      next.stripe.webhooks.test = { id: '', secret: '', url: '' };
      changedModes.push('test');
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
  return { platform: publicPlatform(next), changedModes };
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

const INTERVALS = new Set(['day', 'week', 'month', 'year']);

export function normalizeLineItems(raw, { allowEmpty = false, recurring = false } = {}) {
  const rows = Array.isArray(raw) ? raw : [];
  const items = rows.slice(0, 50).map((row) => ({
    name: clean(row?.name).slice(0, 200),
    unitAmount: Math.round(Number(row?.unitAmount)),
    quantity: Math.round(Number(row?.quantity)),
    ...(recurring ? { interval: clean(row?.interval), intervalCount: Math.round(Number(row?.intervalCount) || 1) } : {}),
  }));
  if (!items.length && !allowEmpty) throw new ShopPaymentError('No items to pay for.');
  for (const item of items) {
    if (!item.name) throw new ShopPaymentError('Every item needs a name.');
    if (!Number.isInteger(item.unitAmount) || item.unitAmount <= 0) throw new ShopPaymentError('Every item needs a positive price.');
    if (!Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 999) throw new ShopPaymentError('Quantity must be 1–999.');
    if (recurring && (!INTERVALS.has(item.interval) || item.intervalCount < 1 || item.intervalCount > 12)) throw new ShopPaymentError('Bad subscription interval.');
  }
  return items;
}

function normalizeShipping(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const amountMinor = Math.round(Number(raw.amountMinor));
  if (!Number.isInteger(amountMinor) || amountMinor <= 0) return null;
  const days = (v) => Math.max(0, Math.min(90, Math.round(Number(v) || 0)));
  return { name: clean(raw.name).slice(0, 100) || 'Frakt', amountMinor, minDays: days(raw.estimateMinDays), maxDays: days(raw.estimateMaxDays) };
}

function normalizeCountries(raw) {
  const list = (Array.isArray(raw) ? raw : []).map((c) => clean(c).toUpperCase()).filter((c) => /^[A-Z]{2}$/.test(c));
  return [...new Set(list)].slice(0, 50);
}

const STRIPE_LOCALES = new Set(['auto', 'nb', 'sv', 'da', 'fi', 'en', 'de', 'fr', 'es', 'it', 'nl', 'pl']);

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
  return platform.stripe.mode === 'test' ? platform.stripe.testSecretKey : connectLiveKey();
}

function stripeFor(platform = readPlatform()) {
  const key = stripeKeyFor(platform);
  if (!key) {
    throw new ShopPaymentError(
      platform.stripe.mode === 'test'
        ? 'Stripe Connect test key is not saved in Superadmin (Admin → Clients → Shop payments).'
        : 'Stripe Connect live key is missing: set STRIPE_CONNECT_SECRET_KEY in hPanel → Environment variables.',
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
  const subscription = body.mode === 'subscription';
  const recurring = subscription ? normalizeLineItems(body.recurringLines, { recurring: true }) : [];
  const items = normalizeLineItems(body.lineItems, { allowEmpty: subscription });
  const currency = normalizeCurrency(body.currency);
  const ref = clean(body.ref).slice(0, 80);
  if (!ref) throw new ShopPaymentError('ref is required.');
  const successUrl = assertSiteUrl(site, body.successUrl, 'successUrl');
  const cancelUrl = assertSiteUrl(site, body.cancelUrl, 'cancelUrl');
  const shipping = subscription ? null : normalizeShipping(body.shipping);
  const total = items.reduce((sum, item) => sum + item.unitAmount * item.quantity, 0) + (shipping?.amountMinor || 0);
  const feePercent = platform.stripe.applicationFeePercent;
  const reminder = Boolean(body.reminderConsent && clean(body.customerEmail));
  const metadata = { asoldi_site_id: site.id, checkout_ref: ref, reminder_consent: reminder ? '1' : '0' };
  const params = {
    mode: subscription ? 'subscription' : 'payment',
    line_items: [
      ...recurring.map((item) => ({
        quantity: item.quantity,
        price_data: { currency, unit_amount: item.unitAmount, product_data: { name: item.name }, recurring: { interval: item.interval, interval_count: item.intervalCount } },
      })),
      ...items.map((item) => ({
        quantity: item.quantity,
        price_data: { currency, unit_amount: item.unitAmount, product_data: { name: item.name } },
      })),
    ],
    success_url: `${successUrl}${successUrl.includes('?') ? '&' : '?'}session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: cancelUrl,
    client_reference_id: ref,
    metadata,
    phone_number_collection: { enabled: true },
    locale: STRIPE_LOCALES.has(clean(body.locale)) ? clean(body.locale) : 'auto',
    // Stripe allows 30 min – 24 h; the CMS holds stock for the same window.
    expires_at: Math.floor(Date.now() / 1000) + Math.max(30, Math.min(1440, Math.round(Number(body.expiresInMinutes) || 60))) * 60,
  };
  if (clean(body.customerEmail)) params.customer_email = clean(body.customerEmail);
  if (body.collectShipping) {
    const countries = normalizeCountries(body.allowedCountries);
    params.shipping_address_collection = { allowed_countries: countries.length ? countries : ['NO'] };
  }
  if (shipping) {
    const estimate = shipping.maxDays ? { minimum: { unit: 'business_day', value: shipping.minDays || 1 }, maximum: { unit: 'business_day', value: shipping.maxDays } } : undefined;
    params.shipping_options = [{ shipping_rate_data: { type: 'fixed_amount', fixed_amount: { amount: shipping.amountMinor, currency }, display_name: shipping.name, delivery_estimate: estimate } }];
  }
  if (subscription) {
    const trial = Math.round(Number(body.trialDays) || 0);
    params.subscription_data = { metadata, ...(trial >= 1 && trial <= 730 ? { trial_period_days: trial } : {}), ...(feePercent > 0 ? { application_fee_percent: feePercent } : {}) };
  } else {
    params.payment_intent_data = { metadata, ...(feePercent > 0 ? { application_fee_amount: Math.floor((total * feePercent) / 100) } : {}) };
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

function idOf(value) {
  return clean(typeof value === 'string' ? value : value?.id);
}

function isoFromUnix(seconds) {
  const n = Number(seconds);
  return n > 0 ? new Date(n * 1000).toISOString() : '';
}

/** current_period_end moved from the subscription to its items in newer Stripe API versions. */
function periodEnd(sub) {
  return isoFromUnix(sub?.current_period_end || sub?.items?.data?.[0]?.current_period_end);
}

function connectedStripe(site, platform = readPlatform()) {
  const conn = stripeConnection(site.id, platform);
  if (!conn) throw new ShopPaymentError('Stripe is not connected for this site.', 409, 'stripe_not_connected');
  return { stripe: stripeFor(platform), opts: { stripeAccount: conn.accountId } };
}

/** Payment intent behind an invoice: legacy field first, then the InvoicePayments list. */
async function invoicePaymentIntent(stripe, invoice, opts) {
  const legacy = idOf(invoice?.payment_intent);
  if (legacy) return legacy;
  try {
    const list = await stripe.invoicePayments.list({ invoice: invoice.id, limit: 3 }, opts);
    return idOf(list?.data?.find((p) => p.payment?.payment_intent)?.payment?.payment_intent);
  } catch {
    return '';
  }
}

export async function getStripeCheckout(site, sessionId) {
  const id = clean(sessionId);
  if (!/^cs_[A-Za-z0-9_]+$/.test(id)) throw new ShopPaymentError('Bad session id.');
  const { stripe, opts } = connectedStripe(site);
  let session;
  try {
    session = await stripe.checkout.sessions.retrieve(id, { expand: ['subscription', 'invoice'] }, opts);
  } catch (err) {
    throw stripeError(err);
  }
  if (session?.metadata?.asoldi_site_id !== site.id) throw new ShopPaymentError('Session does not belong to this site.', 404);
  const customer = session.customer_details || {};
  const shipping = session.collected_information?.shipping_details || session.shipping_details || null;
  const address = shipping?.address || null;
  const currency = clean(session.currency).toLowerCase();
  const sub = session.subscription && typeof session.subscription === 'object' ? session.subscription : null;
  let paymentRef = idOf(session.payment_intent);
  if (!paymentRef && session.invoice && typeof session.invoice === 'object') paymentRef = await invoicePaymentIntent(stripe, session.invoice, opts);
  return {
    provider: 'stripe',
    id: session.id,
    ref: clean(session.metadata?.checkout_ref || session.client_reference_id),
    // A trial subscription completes with nothing to pay.
    paid: session.payment_status === 'paid' || (session.status === 'complete' && session.payment_status === 'no_payment_required'),
    status: clean(session.status),
    amountMinor: Number(session.amount_total) || 0,
    currency,
    customerName: clean(customer.name),
    customerEmail: clean(customer.email || session.customer_email),
    customerPhone: clean(customer.phone),
    shippingAddress: addressFromStripe(shipping),
    shippingAddressParts: address ? { line: [shipping?.name, address.line1, address.line2].map(clean).filter(Boolean).join(', '), postal: clean(address.postal_code), city: clean(address.city), country: clean(address.country) } : null,
    paymentRef: paymentRef || session.id,
    customerId: idOf(session.customer),
    subscriptionId: idOf(session.subscription),
    subscriptionStatus: clean(sub?.status),
    currentPeriodEnd: periodEnd(sub),
    reminderConsent: session.metadata?.reminder_consent === '1',
  };
}

export async function getStripeInvoice(site, invoiceId) {
  const id = clean(invoiceId);
  if (!/^in_[A-Za-z0-9_]+$/.test(id)) throw new ShopPaymentError('Bad invoice id.');
  const { stripe, opts } = connectedStripe(site);
  let invoice;
  try {
    invoice = await stripe.invoices.retrieve(id, {}, opts);
  } catch (err) {
    throw stripeError(err);
  }
  const details = invoice.parent?.subscription_details || invoice.subscription_details || {};
  const owner = clean(details.metadata?.asoldi_site_id);
  if (owner && owner !== site.id) throw new ShopPaymentError('Invoice does not belong to this site.', 404);
  return {
    id: invoice.id,
    paid: invoice.status === 'paid',
    subscriptionId: idOf(details.subscription || invoice.subscription),
    billingReason: clean(invoice.billing_reason),
    amountMinor: Number(invoice.amount_paid) || 0,
    currency: clean(invoice.currency).toLowerCase(),
    customerEmail: clean(invoice.customer_email),
    periodEnd: isoFromUnix(invoice.lines?.data?.[0]?.period?.end),
    paymentRef: (await invoicePaymentIntent(stripe, invoice, opts)) || invoice.id,
  };
}

async function ownSubscription(site, subscriptionId) {
  const id = clean(subscriptionId);
  if (!/^sub_[A-Za-z0-9_]+$/.test(id)) throw new ShopPaymentError('Bad subscription id.');
  const { stripe, opts } = connectedStripe(site);
  let sub;
  try {
    sub = await stripe.subscriptions.retrieve(id, {}, opts);
  } catch (err) {
    throw stripeError(err);
  }
  if (sub?.metadata?.asoldi_site_id !== site.id) throw new ShopPaymentError('Subscription does not belong to this site.', 404);
  return { stripe, opts, sub };
}

function subscriptionView(sub) {
  return { id: sub.id, status: clean(sub.status), cancelAtPeriodEnd: Boolean(sub.cancel_at_period_end), currentPeriodEnd: periodEnd(sub) };
}

export async function getStripeSubscription(site, subscriptionId) {
  return subscriptionView((await ownSubscription(site, subscriptionId)).sub);
}

export async function cancelStripeSubscription(site, subscriptionId, { atPeriodEnd = true } = {}) {
  const { stripe, opts, sub } = await ownSubscription(site, subscriptionId);
  try {
    const next = atPeriodEnd ? await stripe.subscriptions.update(sub.id, { cancel_at_period_end: true }, opts) : await stripe.subscriptions.cancel(sub.id, {}, opts);
    return subscriptionView(next);
  } catch (err) {
    throw stripeError(err);
  }
}

/** Refund on the seller's own account (Stripe direct charge or PayPal partner capture). */
export async function refundShopPayment(site, body = {}) {
  const amountMinor = Math.round(Number(body.amountMinor));
  if (!Number.isInteger(amountMinor) || amountMinor <= 0) throw new ShopPaymentError('Refund amount must be positive.');
  const currency = normalizeCurrency(body.currency);
  const reason = clean(body.ref).slice(0, 80);
  if (body.provider === 'stripe') {
    const { stripe, opts } = connectedStripe(site);
    let paymentIntent = clean(body.paymentRef);
    if (!/^pi_/.test(paymentIntent)) {
      const sessionId = clean(body.providerId);
      if (!/^cs_/.test(sessionId)) throw new ShopPaymentError('No Stripe payment to refund.', 409);
      paymentIntent = (await getStripeCheckout(site, sessionId)).paymentRef;
      if (!/^pi_/.test(paymentIntent)) throw new ShopPaymentError('No Stripe payment to refund.', 409);
    }
    try {
      const pi = await stripe.paymentIntents.retrieve(paymentIntent, {}, opts);
      if (pi?.metadata?.asoldi_site_id && pi.metadata.asoldi_site_id !== site.id) throw new ShopPaymentError('Payment does not belong to this site.', 404);
      const refund = await stripe.refunds.create({ payment_intent: paymentIntent, amount: amountMinor, metadata: { asoldi_site_id: site.id, order: reason } }, opts);
      return { id: refund.id, status: clean(refund.status), amountMinor: Number(refund.amount) || amountMinor };
    } catch (err) {
      if (err instanceof ShopPaymentError) throw err;
      throw stripeError(err);
    }
  }
  if (body.provider === 'paypal') {
    const platform = readPlatform();
    const conn = paypalConnection(site.id, platform);
    if (!conn?.merchantId) {
      throw new ShopPaymentError('PayPal-betalinger tatt imot med e-postadresse må refunderes i din egen PayPal-konto.', 409, 'paypal_manual_refund');
    }
    const captureId = clean(body.paymentRef);
    if (!/^[A-Z0-9]{8,40}$/i.test(captureId)) throw new ShopPaymentError('Bad PayPal capture id.');
    const b64 = (v) => Buffer.from(JSON.stringify(v)).toString('base64url');
    const assertion = `${b64({ alg: 'none' })}.${b64({ iss: platform.paypal.clientId, payer_id: conn.merchantId })}.`;
    const data = await paypalRequest(platform, 'POST', `/v2/payments/captures/${encodeURIComponent(captureId)}/refund`, {
      amount: { currency_code: currency.toUpperCase(), value: minorToDecimalString(amountMinor, currency) },
      note_to_payer: reason ? `Refusjon ${reason}`.slice(0, 255) : undefined,
    }, { headers: { 'PayPal-Auth-Assertion': assertion } });
    return { id: clean(data?.id), status: clean(data?.status), amountMinor };
  }
  throw new ShopPaymentError('Unknown provider.');
}

/** Verifies a Connect webhook. Returns the site + session to notify, or null. */
export function parseStripeConnectWebhook(rawBody, signature) {
  const platform = readPlatform();
  const candidates = [
    [platform.stripe.webhooks.live.secret, connectLiveKey()],
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
  const none = { type: event.type, siteId: '', sessionId: '', notify: null };
  if (event.type === 'account.updated' && siteId) {
    patchSiteConnection(siteId, 'stripe', accountSnapshot(event.data?.object));
    return { ...none, siteId };
  }
  const notifyType = CMS_NOTIFY_TYPES[event.type];
  if (!notifyType || !siteId) return none;
  const object = event.data?.object || {};
  // Invoices carry the subscription's metadata; sessions and subscriptions their own.
  const meta = object.metadata?.asoldi_site_id !== undefined ? object.metadata : object.parent?.subscription_details?.metadata || object.subscription_details?.metadata || {};
  const owner = clean(meta.asoldi_site_id);
  if (owner !== siteId) return none;
  const id = clean(object.id);
  return { type: event.type, siteId, sessionId: /^checkout\.session\./.test(event.type) ? id : '', notify: { type: notifyType, id } };
}

/**
 * Names the account a key belongs to and refuses accounts that are themselves
 * connected to another platform (Stripe: "Connect is not available for this account").
 */
async function assertConnectPlatform(stripe) {
  let self;
  try {
    self = await stripe.accounts.retrieve();
  } catch (err) {
    throw stripeError(err);
  }
  const name = clean(self?.settings?.dashboard?.display_name || self?.business_profile?.name) || 'Stripe account';
  const label = `${name} (${clean(self?.id)})`;
  if (self?.controller?.type === 'application') {
    throw new ShopPaymentError(
      `${label} is connected to another platform and cannot run Stripe Connect. Paste the secret key of the Stripe account that has Connect.`,
      409,
      'not_a_platform'
    );
  }
  return { id: clean(self?.id), label };
}

/** Creates (or replaces) the Connect webhook endpoint for the current Stripe mode. */
export async function ensureStripeConnectWebhook({ hubUrl }) {
  const platform = readPlatform();
  const stripe = stripeFor(platform);
  const mode = platform.stripe.mode;
  const url = `${hubUrl}/api/hub/shop/stripe/webhook`;
  const existing = platform.stripe.webhooks[mode];
  const self = await assertConnectPlatform(stripe);
  if (existing.id && existing.secret && existing.url === url && stripe.webhookEndpoints.update) {
    // Same endpoint: widen its events in place so the signing secret stays valid.
    const updated = await stripe.webhookEndpoints.update(existing.id, { enabled_events: STRIPE_WEBHOOK_EVENTS }).catch(() => null);
    if (updated?.id) return { mode, url, id: updated.id, account: self.label, updated: true };
  }
  try {
    if (existing.id) {
      await stripe.webhookEndpoints.del(existing.id).catch(() => null);
      // The first live webhook was created with the billing key; ids are per account, so this only hits that one.
      if (mode === 'live') await dropWebhook(clean(process.env.STRIPE_SECRET_KEY), existing.id);
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
    return { mode, url, id: endpoint.id, account: self.label };
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

async function paypalRequest(platform, method, path, body, { allow404 = false, headers: extra = {} } = {}) {
  const token = await paypalToken(platform);
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...extra };
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
  const itemTotal = items.reduce((sum, item) => sum + item.unitAmount * item.quantity, 0);
  const shipping = normalizeShipping(body.shipping);
  const money = (minor) => ({ currency_code: code, value: minorToDecimalString(minor, currency) });
  const data = await paypalRequest(platform, 'POST', '/v2/checkout/orders', {
    intent: 'CAPTURE',
    purchase_units: [
      {
        reference_id: ref,
        custom_id: `${site.id}:${ref}`.slice(0, 127),
        payee,
        amount: {
          ...money(itemTotal + (shipping?.amountMinor || 0)),
          breakdown: { item_total: money(itemTotal), ...(shipping ? { shipping: money(shipping.amountMinor) } : {}) },
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
    shippingAddressParts: address.country_code
      ? { line: [shipping.name?.full_name, address.address_line_1, address.address_line_2].map(clean).filter(Boolean).join(', '), postal: clean(address.postal_code), city: clean(address.admin_area_2), country: clean(address.country_code) }
      : null,
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
    const self = await assertConnectPlatform(stripe);
    await stripe.accounts.list({ limit: 1 });
    // shortcut: listing accounts can succeed before Connect is activated; the first Connect click is the real proof.
    result.stripe = {
      ok: true,
      message: `Key belongs to ${self.label}. Connect activation is confirmed on the first "Connect Stripe" click.`,
      account: self.label,
    };
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
