import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import Stripe from 'stripe';

const dataDir = mkdtempSync(join(tmpdir(), 'asoldi-shop-pay-'));
process.env.APP_DATA_DIR = dataDir;
process.env.APP_URL = 'https://hub.test';
process.env.STRIPE_SECRET_KEY = 'sk_live_fake_platform_key';

const hub = await import('../data/hub.js');
const shop = await import('../lib/shop-payments.js');
const { registerShopPaymentsRoutes, registerShopPaymentsWebhook } = await import('../lib/shop-payments-routes.js');
const docs = await import('../lib/shop-documents.js');

const realStripe = new Stripe('sk_test_signing_only');
const calls = [];
const accounts = new Map();
const sessions = new Map();
const subscriptions = new Map();
const invoices = new Map();
const paymentIntents = new Map();
const refunds = [];
const updatedWebhooks = [];

function scoped(map, id, opts, label) {
  const row = map.get(id);
  if (!row || row.account !== opts?.stripeAccount) throw Object.assign(new Error(`No such ${label}`), { statusCode: 404 });
  return row;
}

const platformAccounts = {
  sk_live_fake_platform_key: { id: 'acct_billing', settings: { dashboard: { display_name: 'ASOLDI.com' } }, controller: { type: 'application' } },
  sk_live_connect_key: { id: 'acct_platform', settings: { dashboard: { display_name: 'asoldi' } }, controller: { type: 'account' } },
};
const deletedWebhooks = [];

function fakeStripe(key) {
  return {
    accounts: {
      async create(params) {
        calls.push(['accounts.create', params]);
        const account = { id: `acct_${accounts.size + 1}`, charges_enabled: false, details_submitted: false, payouts_enabled: false, requirements: { currently_due: ['x'] } };
        accounts.set(account.id, account);
        return account;
      },
      async retrieve(id) {
        if (!id) return platformAccounts[key];
        const account = accounts.get(id);
        if (!account) throw Object.assign(new Error('No such account'), { code: 'account_invalid' });
        return account;
      },
      async list() {
        return { data: [] };
      },
    },
    accountLinks: {
      async create(params) {
        calls.push(['accountLinks.create', params]);
        return { url: `https://connect.stripe.test/setup/${params.account}` };
      },
    },
    checkout: {
      sessions: {
        async create(params, opts) {
          calls.push(['sessions.create', params, opts]);
          const id = `cs_test_${sessions.size + 1}`;
          const trial = params.subscription_data?.trial_period_days > 0;
          const items = params.line_items.reduce((sum, row) => sum + (trial && row.price_data.recurring ? 0 : row.price_data.unit_amount * row.quantity), 0);
          const ship = params.shipping_options?.[0]?.shipping_rate_data?.fixed_amount?.amount || 0;
          sessions.set(id, { id, account: opts.stripeAccount, mode: params.mode, metadata: params.metadata, client_reference_id: params.client_reference_id, customer_email: params.customer_email || null, amount_total: items + ship, currency: params.line_items[0].price_data.currency, payment_status: 'unpaid', status: 'open', payment_intent: null });
          return { id, url: `https://checkout.stripe.test/${id}` };
        },
        async retrieve(id, params, opts) {
          const session = scoped(sessions, id, opts, 'session');
          const expand = params?.expand || [];
          const out = { ...session };
          if (expand.includes('subscription') && typeof out.subscription === 'string') out.subscription = subscriptions.get(out.subscription);
          if (expand.includes('invoice') && typeof out.invoice === 'string') out.invoice = invoices.get(out.invoice);
          return out;
        },
      },
    },
    invoices: {
      async retrieve(id, _params, opts) {
        return scoped(invoices, id, opts, 'invoice');
      },
    },
    invoicePayments: {
      async list({ invoice }, opts) {
        const inv = scoped(invoices, invoice, opts, 'invoice');
        return { data: inv.pi ? [{ payment: { type: 'payment_intent', payment_intent: inv.pi } }] : [] };
      },
    },
    subscriptions: {
      async retrieve(id, _params, opts) {
        return scoped(subscriptions, id, opts, 'subscription');
      },
      async update(id, params, opts) {
        const sub = scoped(subscriptions, id, opts, 'subscription');
        Object.assign(sub, params);
        return sub;
      },
      async cancel(id, _params, opts) {
        const sub = scoped(subscriptions, id, opts, 'subscription');
        sub.status = 'canceled';
        return sub;
      },
    },
    paymentIntents: {
      async retrieve(id, _params, opts) {
        return scoped(paymentIntents, id, opts, 'payment_intent');
      },
    },
    refunds: {
      async create(params, opts) {
        scoped(paymentIntents, params.payment_intent, opts, 'payment_intent');
        refunds.push([params, opts]);
        return { id: `re_${refunds.length}`, status: 'succeeded', amount: params.amount };
      },
    },
    webhookEndpoints: {
      async update(id, params) {
        updatedWebhooks.push([key, id, params]);
        return { id };
      },
      async create(params) {
        calls.push(['webhookEndpoints.create', params, key]);
        return { id: `we_${calls.length}`, secret: 'whsec_test_secret' };
      },
      async del(id) {
        deletedWebhooks.push([key, id]);
        return {};
      },
    },
    webhooks: realStripe.webhooks,
  };
}

const paypalOrders = new Map();
const paypalRequests = [];
async function fakePaypalFetch(url, init = {}) {
  const u = new URL(url);
  const body = init.body && typeof init.body === 'string' && init.body.startsWith('{') ? JSON.parse(init.body) : null;
  paypalRequests.push({ method: init.method, path: u.pathname, body, headers: init.headers });
  const json = (status, data) => ({ ok: status < 400, status, json: async () => data });
  if (u.pathname === '/v1/oauth2/token') return json(200, { access_token: 'pp-token', expires_in: 3600 });
  if (u.pathname === '/v2/customer/partner-referrals') return json(201, { links: [{ rel: 'action_url', href: 'https://www.sandbox.paypal.test/onboard' }] });
  if (u.pathname.endsWith('/merchant-integrations') && u.searchParams.get('tracking_id')) return json(200, { merchant_id: 'SELLER123' });
  if (/\/merchant-integrations\/SELLER123$/.test(u.pathname)) return json(200, { payments_receivable: true, primary_email_confirmed: true, primary_email: 'seller@example.com' });
  if (u.pathname === '/v2/checkout/orders' && init.method === 'POST') {
    const id = `PPORDER${paypalOrders.size + 1}AAAA`;
    paypalOrders.set(id, { id, status: 'CREATED', purchase_units: body.purchase_units });
    return json(201, { id, links: [{ rel: 'payer-action', href: `https://www.sandbox.paypal.test/checkoutnow?token=${id}` }] });
  }
  const refundMatch = u.pathname.match(/^\/v2\/payments\/captures\/([A-Z0-9]+)\/refund$/);
  if (refundMatch) return json(201, { id: `PPREFUND${paypalRequests.length}`, status: 'COMPLETED' });
  const orderMatch = u.pathname.match(/^\/v2\/checkout\/orders\/([A-Z0-9]+)(\/capture)?$/);
  if (orderMatch) {
    const order = paypalOrders.get(orderMatch[1]);
    if (!order) return json(404, { name: 'RESOURCE_NOT_FOUND' });
    if (orderMatch[2]) {
      if (order.status === 'COMPLETED') return json(422, { name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'ORDER_ALREADY_CAPTURED' }] });
      order.status = 'COMPLETED';
      const unit = order.purchase_units[0];
      unit.payments = { captures: [{ id: 'CAPTURE1', status: 'COMPLETED', amount: { currency_code: unit.amount.currency_code, value: unit.amount.value } }] };
      order.payer = { email_address: 'buyer@example.com', name: { given_name: 'Kari', surname: 'Nordmann' } };
    }
    return json(200, order);
  }
  return json(404, {});
}

shop.setShopPaymentDeps({ stripeFactory: (key) => fakeStripe(key), fetch: fakePaypalFetch });

const site = hub.createSite({ name: 'Kafe Test', domain: 'kafe.no', websitePlan: 'tier-3-ecommerce' });
const other = hub.createSite({ name: 'Other', domain: 'other.no' });

const app = express();
registerShopPaymentsWebhook(app);
app.use(express.json());
registerShopPaymentsRoutes(app, { adminAuth: (_req, _res, next) => next() });
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;

async function call(method, path, body, siteKey = site.site_key) {
  const res = await fetch(`${base}${path}`, {
    method,
    redirect: 'manual',
    headers: { 'content-type': 'application/json', ...(siteKey ? { 'x-site-key': siteKey } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = text;
  try {
    data = JSON.parse(text);
  } catch {
    /* keep text */
  }
  return { status: res.status, data, headers: res.headers };
}

test.after(() => {
  server.close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('unknown site keys are rejected', async () => {
  assert.equal((await call('GET', '/api/hub/shop/status', null, 'nope')).status, 401);
  assert.equal((await call('GET', '/api/hub/shop/status', null, '')).status, 401);
});

test('connect key comes from env only; billing account is refused; webhook moves off the billing account', async () => {
  writeFileSync(join(dataDir, 'shop-payments-platform.json'), JSON.stringify({ stripe: { webhooks: { live: { id: 'we_old', secret: 'whsec_old', url: 'x' } } } }));
  const status = await call('GET', '/api/hub/shop/status');
  assert.equal(status.data.stripe.available, false, 'STRIPE_SECRET_KEY alone does not enable Connect');
  const blocked = await call('POST', '/api/hub/shop/stripe/connect', { returnUrl: 'https://kafe.no/admin' });
  assert.equal(blocked.data.code, 'stripe_not_configured');
  assert.match(blocked.data.message, /STRIPE_CONNECT_SECRET_KEY/);

  process.env.STRIPE_CONNECT_SECRET_KEY = 'sk_live_fake_platform_key';
  const billing = await call('POST', '/api/hub/payments-platform/stripe-webhook', {}, '');
  assert.equal(billing.status, 409);
  assert.match(billing.data.message, /ASOLDI\.com \(acct_billing\) is connected to another platform/);

  process.env.STRIPE_CONNECT_SECRET_KEY = 'sk_live_connect_key';
  const created = await call('POST', '/api/hub/payments-platform/stripe-webhook', {}, '');
  assert.equal(created.status, 200, JSON.stringify(created.data));
  assert.equal(created.data.account, 'asoldi (acct_platform)');
  assert.equal(calls.filter(([name]) => name === 'webhookEndpoints.create').at(-1)[2], 'sk_live_connect_key');
  assert.deepEqual(deletedWebhooks.at(-1), ['sk_live_fake_platform_key', 'we_old'], 'old webhook removed from the billing account');
  assert.equal(readFileSync(join(dataDir, 'shop-payments-platform.json'), 'utf8').includes('sk_live'), false, 'live key never written to disk');
  const pub = await call('GET', '/api/hub/payments-platform', null, '');
  assert.equal(JSON.stringify(pub.data).includes('sk_live_connect_key'), false, 'key is masked');
  assert.equal(pub.data.platform.stripe.webhooks.live.configured, true);

  const check = await call('GET', '/api/hub/payments-platform?check=1', null, '');
  assert.equal(check.data.check.stripe.ok, true);
  assert.match(check.data.check.stripe.message, /asoldi \(acct_platform\)/);
});

test('stripe onboarding creates one standard account and refuses foreign return urls', async () => {
  const bad = await call('POST', '/api/hub/shop/stripe/connect', { returnUrl: 'https://evil.example/admin' });
  assert.equal(bad.status, 400);
  const first = await call('POST', '/api/hub/shop/stripe/connect', { returnUrl: 'https://www.kafe.no/admin?payments=stripe' });
  assert.equal(first.status, 200, JSON.stringify(first.data));
  assert.equal(first.data.url, 'https://connect.stripe.test/setup/acct_1');
  const again = await call('POST', '/api/hub/shop/stripe/connect', { returnUrl: 'https://kafe.no/admin' });
  assert.equal(again.data.accountId, 'acct_1');
  assert.equal(calls.filter(([name]) => name === 'accounts.create').length, 1);
  const link = calls.filter(([name]) => name === 'accountLinks.create').at(-1)[1];
  assert.match(link.refresh_url, /^https:\/\/hub\.test\/api\/hub\/shop\/stripe\/refresh\/[a-f0-9]{36}$/);

  const nonce = link.refresh_url.split('/').pop();
  const refresh = await call('GET', `/api/hub/shop/stripe/refresh/${nonce}`, null, '');
  assert.equal(refresh.status, 303);
  assert.equal(refresh.headers.get('location'), 'https://connect.stripe.test/setup/acct_1');
  const reused = await call('GET', `/api/hub/shop/stripe/refresh/${nonce}`, null, '');
  assert.equal(reused.status, 404, 'a refresh nonce works once');
});

test('checkout waits for charges_enabled, then creates a direct charge on the connected account', async () => {
  const body = {
    ref: 'chk_1',
    currency: 'nok',
    lineItems: [{ name: 'Kaffe', unitAmount: 4900, quantity: 2 }],
    successUrl: 'https://kafe.no/api/cms/checkout/return?ref=chk_1&provider=stripe',
    cancelUrl: 'https://kafe.no/api/cms/checkout/cancel?ref=chk_1',
  };
  const notReady = await call('POST', '/api/hub/shop/stripe/checkout', body);
  assert.equal(notReady.status, 409);
  assert.equal(notReady.data.code, 'stripe_not_ready');

  Object.assign(accounts.get('acct_1'), { charges_enabled: true, details_submitted: true, requirements: { currently_due: [] } });
  const status = await call('GET', '/api/hub/shop/status');
  assert.equal(status.data.stripe.ready, true);

  const created = await call('POST', '/api/hub/shop/stripe/checkout', body);
  assert.equal(created.status, 200, JSON.stringify(created.data));
  const [, params, opts] = calls.filter(([name]) => name === 'sessions.create').at(-1);
  assert.equal(opts.stripeAccount, 'acct_1');
  assert.equal(params.metadata.asoldi_site_id, site.id);
  assert.match(params.success_url, /&session_id=\{CHECKOUT_SESSION_ID\}$/);

  const badPrice = await call('POST', '/api/hub/shop/stripe/checkout', { ...body, lineItems: [{ name: 'X', unitAmount: -1, quantity: 1 }] });
  assert.equal(badPrice.status, 400);

  const unpaid = await call('GET', `/api/hub/shop/stripe/session/${created.data.id}`);
  assert.equal(unpaid.data.paid, false);
  Object.assign(sessions.get(created.data.id), { payment_status: 'paid', status: 'complete', payment_intent: 'pi_1', customer_details: { name: 'Ola', email: 'ola@example.com', phone: '+4799999999' } });
  const paid = await call('GET', `/api/hub/shop/stripe/session/${created.data.id}`);
  assert.equal(paid.data.paid, true);
  assert.equal(paid.data.ref, 'chk_1');
  assert.equal(paid.data.amountMinor, 9800);
  assert.equal(paid.data.paymentRef, 'pi_1');

  const foreign = await call('GET', `/api/hub/shop/stripe/session/${created.data.id}`, null, other.site_key);
  assert.equal(foreign.status, 409, 'another site cannot read this session');
});

test('connect webhook verifies the signature and maps the session to its site', async () => {
  const created = await call('POST', '/api/hub/payments-platform/stripe-webhook', {});
  assert.equal(created.status, 200, JSON.stringify(created.data));
  assert.equal(calls.filter(([name]) => name === 'webhookEndpoints.create').at(-1)[1].connect, true);
  assert.equal(created.data.updated, true, 'same URL: events widened in place, secret kept');
  assert.ok(updatedWebhooks.at(-1)[2].enabled_events.includes('invoice.paid'));

  const payload = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed', account: 'acct_1', data: { object: { id: 'cs_test_1', metadata: { asoldi_site_id: site.id } } } });
  const unsigned = await fetch(`${base}/api/hub/shop/stripe/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=bad' }, body: payload });
  assert.equal(unsigned.status, 400);
  const header = realStripe.webhooks.generateTestHeaderString({ payload, secret: 'whsec_test_secret' });
  const parsed = shop.parseStripeConnectWebhook(Buffer.from(payload), header);
  assert.deepEqual(parsed, { type: 'checkout.session.completed', siteId: site.id, sessionId: 'cs_test_1', notify: { type: 'checkout.completed', id: 'cs_test_1' } });

  const spoof = JSON.stringify({ id: 'evt_2', type: 'checkout.session.completed', account: 'acct_1', data: { object: { id: 'cs_x', metadata: { asoldi_site_id: other.id } } } });
  const spoofParsed = shop.parseStripeConnectWebhook(Buffer.from(spoof), realStripe.webhooks.generateTestHeaderString({ payload: spoof, secret: 'whsec_test_secret' }));
  assert.equal(spoofParsed.sessionId, '');
});

test('paypal: email fallback before partner approval, login flow after, capture is idempotent', async () => {
  const unconfigured = await call('POST', '/api/hub/shop/paypal/connect', { email: 'seller@example.com' });
  assert.equal(unconfigured.status, 503);

  await shop.savePlatformSettings({ paypal: { mode: 'sandbox', clientId: 'cid', clientSecret: 'csecret' } });
  const pub = shop.publicPlatform();
  assert.equal(pub.paypal.clientSecretSet, true);
  assert.equal(JSON.stringify(pub).includes('csecret'), false, 'secret never leaves the hub');

  const login = await call('POST', '/api/hub/shop/paypal/connect', { returnUrl: 'https://kafe.no/admin' });
  assert.equal(login.data.code, 'paypal_partner_missing');

  const byEmail = await call('POST', '/api/hub/shop/paypal/connect', { email: 'Seller@Example.com' });
  assert.equal(byEmail.data.connected, true);
  let status = await call('GET', '/api/hub/shop/status');
  assert.equal(status.data.paypal.ready, true);
  assert.equal(status.data.paypal.method, 'email');

  const order = await call('POST', '/api/hub/shop/paypal/order', {
    ref: 'chk_pp',
    currency: 'nok',
    lineItems: [{ name: 'Kaffe', unitAmount: 4950, quantity: 1 }],
    successUrl: 'https://kafe.no/api/cms/checkout/return?ref=chk_pp&provider=paypal',
    cancelUrl: 'https://kafe.no/api/cms/checkout/cancel?ref=chk_pp',
  });
  assert.equal(order.status, 200, JSON.stringify(order.data));
  const sent = paypalRequests.find((r) => r.path === '/v2/checkout/orders' && r.method === 'POST').body;
  assert.deepEqual(sent.purchase_units[0].payee, { email_address: 'seller@example.com' });
  assert.equal(sent.purchase_units[0].amount.value, '49.50');

  const notApproved = await call('POST', '/api/hub/shop/paypal/capture', { orderId: order.data.id });
  assert.equal(notApproved.data.paid, false);
  paypalOrders.get(order.data.id).status = 'APPROVED';
  const captured = await call('POST', '/api/hub/shop/paypal/capture', { orderId: order.data.id });
  assert.equal(captured.data.paid, true, JSON.stringify(captured.data));
  assert.equal(captured.data.ref, 'chk_pp');
  assert.equal(captured.data.amountMinor, 4950);
  assert.equal(captured.data.customerEmail, 'buyer@example.com');
  const twice = await call('POST', '/api/hub/shop/paypal/capture', { orderId: order.data.id });
  assert.equal(twice.data.paid, true);
  const foreign = await call('POST', '/api/hub/shop/paypal/capture', { orderId: order.data.id }, other.site_key);
  assert.equal(foreign.status, 404);

  await shop.savePlatformSettings({ paypal: { partnerMerchantId: 'ASOLDIPARTNER' } });
  const referral = await call('POST', '/api/hub/shop/paypal/connect', { returnUrl: 'https://kafe.no/admin?payments=paypal' });
  assert.equal(referral.data.url, 'https://www.sandbox.paypal.test/onboard');
  status = await call('GET', '/api/hub/shop/status');
  assert.equal(status.data.paypal.method, 'login');
  assert.equal(status.data.paypal.ready, true);
  assert.equal(status.data.paypal.email, 'seller@example.com');

  await call('POST', '/api/hub/shop/paypal/order', {
    ref: 'chk_pp2',
    lineItems: [{ name: 'Te', unitAmount: 3000, quantity: 1 }],
    successUrl: 'https://kafe.no/r',
    cancelUrl: 'https://kafe.no/c',
  });
  const sent2 = paypalRequests.filter((r) => r.path === '/v2/checkout/orders' && r.method === 'POST').at(-1).body;
  assert.deepEqual(sent2.purchase_units[0].payee, { merchant_id: 'SELLER123' });
});

const urls = (ref) => ({ successUrl: `https://kafe.no/api/cms/checkout/return?ref=${ref}&provider=stripe`, cancelUrl: `https://kafe.no/api/cms/checkout/cancel?ref=${ref}` });
const lastSession = () => calls.filter(([name]) => name === 'sessions.create').at(-1);
let shipSessionId = '';

test('HP-7 shop checkout: shipping option, locked country, hold-length expiry, consented reminder, locale', async () => {
  const before = Math.floor(Date.now() / 1000);
  const res = await call('POST', '/api/hub/shop/stripe/checkout', {
    ref: 'chk_ship',
    currency: 'nok',
    lineItems: [{ name: 'Genser', unitAmount: 50000, quantity: 1 }],
    shipping: { name: 'Posten', amountMinor: 9900, estimateMinDays: 2, estimateMaxDays: 4 },
    collectShipping: true,
    allowedCountries: ['no', 'XX1', 'SE', 'NO'],
    customerEmail: 'kari@example.com',
    reminderConsent: true,
    expiresInMinutes: 10,
    locale: 'nb',
    ...urls('chk_ship'),
  });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  shipSessionId = res.data.id;
  const [, params] = lastSession();
  assert.equal(params.shipping_options[0].shipping_rate_data.fixed_amount.amount, 9900);
  assert.equal(params.shipping_options[0].shipping_rate_data.display_name, 'Posten');
  assert.equal(params.shipping_options[0].shipping_rate_data.delivery_estimate.maximum.value, 4);
  assert.deepEqual(params.shipping_address_collection.allowed_countries, ['NO', 'SE']);
  assert.ok(params.expires_at - before >= 30 * 60 && params.expires_at - before <= 30 * 60 + 5, 'Stripe minimum of 30 minutes');
  assert.equal(params.after_expiration, undefined, 'no Stripe recovery session: the CMS restores its own cart');
  assert.equal(params.metadata.reminder_consent, '1');
  assert.equal(params.payment_intent_data.metadata.asoldi_site_id, site.id, 'payment intent is tagged for refunds');
  assert.equal(params.locale, 'nb');
  assert.equal(params.customer_email, 'kari@example.com');

  await call('POST', '/api/hub/shop/stripe/checkout', { ref: 'chk_noemail', currency: 'nok', lineItems: [{ name: 'X', unitAmount: 100, quantity: 1 }], reminderConsent: true, locale: 'xx', ...urls('chk_noemail') });
  const [, noEmail] = lastSession();
  assert.equal(noEmail.metadata.reminder_consent, '0', 'no reminder without an email');
  assert.equal(noEmail.locale, 'auto');
  assert.equal(noEmail.shipping_options, undefined);

  Object.assign(sessions.get(shipSessionId), {
    payment_status: 'paid',
    status: 'complete',
    payment_intent: 'pi_ship',
    customer: 'cus_1',
    customer_details: { name: 'Kari', email: 'kari@example.com' },
    collected_information: { shipping_details: { name: 'Kari Nordmann', address: { line1: 'Storgata 1', postal_code: '0155', city: 'Oslo', country: 'NO' } } },
  });
  const paid = await call('GET', `/api/hub/shop/stripe/session/${shipSessionId}`);
  assert.equal(paid.data.amountMinor, 59900, 'shipping is part of the charged amount');
  assert.deepEqual(paid.data.shippingAddressParts, { line: 'Kari Nordmann, Storgata 1', postal: '0155', city: 'Oslo', country: 'NO' });
  assert.equal(paid.data.customerId, 'cus_1');
  assert.equal(paid.data.subscriptionId, '');
});

test('HP-8 subscriptions: recurring checkout with trial, session, renewal invoice, cancel', async () => {
  const recurringLines = [{ name: 'Kaffeabonnement', unitAmount: 19900, quantity: 1, interval: 'month', intervalCount: 1 }];
  const res = await call('POST', '/api/hub/shop/stripe/checkout', { mode: 'subscription', ref: 'chk_sub', currency: 'nok', lineItems: [], recurringLines, trialDays: 14, customerEmail: 'kari@example.com', ...urls('chk_sub') });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  const [, params] = lastSession();
  assert.equal(params.mode, 'subscription');
  assert.deepEqual(params.line_items[0].price_data.recurring, { interval: 'month', interval_count: 1 });
  assert.equal(params.subscription_data.trial_period_days, 14);
  assert.equal(params.subscription_data.metadata.asoldi_site_id, site.id);
  assert.equal(params.payment_intent_data, undefined, 'not allowed in subscription mode');
  assert.equal(params.shipping_options, undefined);

  const badInterval = await call('POST', '/api/hub/shop/stripe/checkout', { mode: 'subscription', ref: 'x', lineItems: [], recurringLines: [{ ...recurringLines[0], interval: 'hour' }], ...urls('x') });
  assert.equal(badInterval.status, 400);
  const noRecurring = await call('POST', '/api/hub/shop/stripe/checkout', { mode: 'subscription', ref: 'x', lineItems: [{ name: 'A', unitAmount: 100, quantity: 1 }], ...urls('x') });
  assert.equal(noRecurring.status, 400);
  const emptyPayment = await call('POST', '/api/hub/shop/stripe/checkout', { ref: 'x', lineItems: [], ...urls('x') });
  assert.equal(emptyPayment.status, 400, 'payment mode still needs items');

  subscriptions.set('sub_1', { id: 'sub_1', account: 'acct_1', status: 'trialing', cancel_at_period_end: false, metadata: { asoldi_site_id: site.id }, items: { data: [{ current_period_end: 1893456000 }] } });
  Object.assign(sessions.get(res.data.id), { status: 'complete', payment_status: 'no_payment_required', amount_total: 0, subscription: 'sub_1', customer: 'cus_2' });
  const session = await call('GET', `/api/hub/shop/stripe/session/${res.data.id}`);
  assert.equal(session.data.paid, true, 'a trial completes with nothing to pay');
  assert.equal(session.data.amountMinor, 0);
  assert.equal(session.data.subscriptionId, 'sub_1');
  assert.equal(session.data.subscriptionStatus, 'trialing');
  assert.equal(session.data.currentPeriodEnd, '2030-01-01T00:00:00.000Z');

  invoices.set('in_1', { id: 'in_1', account: 'acct_1', status: 'paid', billing_reason: 'subscription_cycle', amount_paid: 19900, currency: 'nok', customer_email: 'kari@example.com', parent: { subscription_details: { subscription: 'sub_1', metadata: { asoldi_site_id: site.id } } }, lines: { data: [{ period: { end: 1896134400 } }] }, pi: 'pi_renew' });
  const invoice = await call('GET', '/api/hub/shop/stripe/invoice/in_1');
  assert.equal(invoice.status, 200, JSON.stringify(invoice.data));
  assert.deepEqual(invoice.data, { id: 'in_1', paid: true, subscriptionId: 'sub_1', billingReason: 'subscription_cycle', amountMinor: 19900, currency: 'nok', customerEmail: 'kari@example.com', periodEnd: '2030-02-01T00:00:00.000Z', paymentRef: 'pi_renew' });
  invoices.set('in_2', { ...invoices.get('in_1'), id: 'in_2', parent: { subscription_details: { subscription: 'sub_9', metadata: { asoldi_site_id: other.id } } } });
  assert.equal((await call('GET', '/api/hub/shop/stripe/invoice/in_2')).status, 404, 'another site’s invoice');
  assert.equal((await call('GET', '/api/hub/shop/stripe/invoice/nope')).status, 400);
  assert.equal((await call('GET', '/api/hub/shop/stripe/invoice/in_1', null, other.site_key)).status, 409, 'site without Stripe');

  const sub = await call('GET', '/api/hub/shop/stripe/subscription/sub_1');
  assert.deepEqual(sub.data, { id: 'sub_1', status: 'trialing', cancelAtPeriodEnd: false, currentPeriodEnd: '2030-01-01T00:00:00.000Z' });
  const atEnd = await call('POST', '/api/hub/shop/stripe/subscription/sub_1/cancel', {});
  assert.equal(atEnd.data.cancelAtPeriodEnd, true);
  assert.equal(atEnd.data.status, 'trialing', 'runs until the period ends');
  const now = await call('POST', '/api/hub/shop/stripe/subscription/sub_1/cancel', { atPeriodEnd: false });
  assert.equal(now.data.status, 'canceled');
  subscriptions.set('sub_x', { id: 'sub_x', account: 'acct_1', status: 'active', metadata: { asoldi_site_id: other.id } });
  assert.equal((await call('POST', '/api/hub/shop/stripe/subscription/sub_x/cancel', {})).status, 404);
  assert.equal(subscriptions.get('sub_x').status, 'active', 'foreign subscription untouched');
});

test('HP-9 refunds: Stripe on the seller account, PayPal partner with auth assertion, PayPal email is manual', async () => {
  paymentIntents.set('pi_ship', { id: 'pi_ship', account: 'acct_1', metadata: { asoldi_site_id: site.id } });
  const direct = await call('POST', '/api/hub/shop/refund', { provider: 'stripe', providerId: shipSessionId, paymentRef: 'pi_ship', amountMinor: 9900, currency: 'nok', ref: '1001' });
  assert.equal(direct.status, 200, JSON.stringify(direct.data));
  assert.equal(direct.data.id, 're_1');
  assert.equal(refunds.at(-1)[0].amount, 9900);
  assert.equal(refunds.at(-1)[1].stripeAccount, 'acct_1');

  const viaSession = await call('POST', '/api/hub/shop/refund', { provider: 'stripe', providerId: shipSessionId, paymentRef: shipSessionId, amountMinor: 100, currency: 'nok' });
  assert.equal(viaSession.status, 200, JSON.stringify(viaSession.data));
  assert.equal(refunds.at(-1)[0].payment_intent, 'pi_ship', 'payment intent looked up from the session');

  paymentIntents.set('pi_foreign', { id: 'pi_foreign', account: 'acct_1', metadata: { asoldi_site_id: other.id } });
  assert.equal((await call('POST', '/api/hub/shop/refund', { provider: 'stripe', paymentRef: 'pi_foreign', amountMinor: 100 })).status, 404);
  assert.equal((await call('POST', '/api/hub/shop/refund', { provider: 'stripe', paymentRef: 'pi_ship', amountMinor: 0 })).status, 400);
  assert.equal((await call('POST', '/api/hub/shop/refund', { provider: 'bank', paymentRef: 'x', amountMinor: 100 })).status, 400);

  const pp = await call('POST', '/api/hub/shop/refund', { provider: 'paypal', paymentRef: 'CAPTURE1', amountMinor: 4950, currency: 'nok', ref: '1002' });
  assert.equal(pp.status, 200, JSON.stringify(pp.data));
  const sent = paypalRequests.filter((r) => /\/refund$/.test(r.path)).at(-1);
  assert.equal(sent.body.amount.value, '49.50');
  const [, payload] = sent.headers['PayPal-Auth-Assertion'].split('.');
  assert.deepEqual(JSON.parse(Buffer.from(payload, 'base64url').toString()), { iss: 'cid', payer_id: 'SELLER123' });

  await call('POST', '/api/hub/shop/paypal/connect', { email: 'other@example.com' }, other.site_key);
  const manual = await call('POST', '/api/hub/shop/refund', { provider: 'paypal', paymentRef: 'CAPTURE2', amountMinor: 100, currency: 'nok' }, other.site_key);
  assert.equal(manual.status, 409);
  assert.equal(manual.data.code, 'paypal_manual_refund');
});

test('HP-10 webhook forwards expired, invoice and subscription events to the CMS origin with their type', async () => {
  const received = [];
  const receiver = express().use(express.json()).post('/api/cms/checkout/notify', (req, res) => {
    received.push(req.body);
    res.json({ ok: true });
  });
  const cms = receiver.listen(0);
  hub.updateSite(site.id, { cms: { adminUrl: `http://127.0.0.1:${cms.address().port}/admin` } });
  const send = async (type, object) => {
    const payload = JSON.stringify({ id: `evt_${type}`, type, account: 'acct_1', data: { object } });
    const res = await fetch(`${base}/api/hub/shop/stripe/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': realStripe.webhooks.generateTestHeaderString({ payload, secret: 'whsec_test_secret' }) }, body: payload });
    assert.equal(res.status, 200);
  };
  try {
    await send('checkout.session.expired', { id: 'cs_test_9', metadata: { asoldi_site_id: site.id } });
    await send('invoice.paid', { id: 'in_1', metadata: {}, parent: { subscription_details: { metadata: { asoldi_site_id: site.id } } } });
    await send('customer.subscription.deleted', { id: 'sub_1', metadata: { asoldi_site_id: site.id } });
    await send('invoice.paid', { id: 'in_2', metadata: {}, parent: { subscription_details: { metadata: { asoldi_site_id: other.id } } } });
    await send('payment_intent.created', { id: 'pi_x', metadata: { asoldi_site_id: site.id } });
    for (let i = 0; i < 40 && received.length < 3; i += 1) await new Promise((r) => setTimeout(r, 50));
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(received, [
      { provider: 'stripe', type: 'checkout.expired', id: 'cs_test_9' },
      { provider: 'stripe', type: 'invoice.paid', id: 'in_1' },
      { provider: 'stripe', type: 'subscription.updated', id: 'sub_1' },
    ]);
  } finally {
    cms.close();
  }
});

test('HP-11 cart reminder: only an expired Stripe checkout with consent, emailed once', async () => {
  const mails = [];
  docs.setShopDocumentDeps({ sendEmail: async (m) => mails.push(m) });
  const res = await call('POST', '/api/hub/shop/stripe/checkout', { ref: 'chk_rem', currency: 'nok', lineItems: [{ name: 'Lue', unitAmount: 29900, quantity: 1 }], customerEmail: 'kari@example.com', reminderConsent: true, ...urls('chk_rem') });
  const document = { kind: 'cart-reminder', provider: 'stripe', providerId: res.data.id, siteName: 'Kafe Test', siteUrl: 'https://kafe.no', recoveryUrl: 'https://kafe.no/api/cms/cart/recover?token=abc', currency: 'nok', totalMinor: 29900, lines: [{ name: 'Lue', quantity: 1, totalMinor: 29900 }] };
  const open = await call('POST', '/api/hub/shop/document', { document });
  assert.equal(open.status, 409, 'still open');
  Object.assign(sessions.get(res.data.id), { status: 'expired' });
  const phishing = await call('POST', '/api/hub/shop/document', { document: { ...document, recoveryUrl: 'https://evil.example/cart' } });
  assert.equal(phishing.status, 400, 'the reminder link must point at the site itself');
  const sent = await call('POST', '/api/hub/shop/document', { document, to: 'attacker@example.com' });
  assert.equal(sent.status, 200, JSON.stringify(sent.data));
  assert.equal(mails.length, 1);
  assert.equal(mails[0].to, 'kari@example.com', 'recipient comes from Stripe, never from the request');
  assert.match(mails[0].html, /kafe\.no\/api\/cms\/cart\/recover\?token=abc/);
  assert.equal((await call('POST', '/api/hub/shop/document', { document })).data.skipped, true);
  assert.equal((await call('POST', '/api/hub/shop/document', { document, resend: true })).data.skipped, true, 'a reminder is never resent');
  assert.equal(mails.length, 1);

  const silent = await call('POST', '/api/hub/shop/stripe/checkout', { ref: 'chk_rem2', currency: 'nok', lineItems: [{ name: 'Lue', unitAmount: 29900, quantity: 1 }], customerEmail: 'ola@example.com', ...urls('chk_rem2') });
  Object.assign(sessions.get(silent.data.id), { status: 'expired' });
  const noConsent = await call('POST', '/api/hub/shop/document', { document: { ...document, providerId: silent.data.id } });
  assert.equal(noConsent.status, 409);
  assert.equal(noConsent.data.code, 'no_consent');
  assert.equal((await call('POST', '/api/hub/shop/document', { document }, other.site_key)).status, 409, 'another site cannot use this session');
  assert.equal(mails.length, 1);
});

test('HP-12 PayPal order puts shipping in the breakdown', async () => {
  const order = await call('POST', '/api/hub/shop/paypal/order', { ref: 'chk_pps', currency: 'nok', lineItems: [{ name: 'Kaffe', unitAmount: 4950, quantity: 1 }], shipping: { name: 'Posten', amountMinor: 9900 }, collectShipping: true, successUrl: 'https://kafe.no/r', cancelUrl: 'https://kafe.no/c' });
  assert.equal(order.status, 200, JSON.stringify(order.data));
  const unit = paypalRequests.filter((r) => r.path === '/v2/checkout/orders' && r.method === 'POST').at(-1).body.purchase_units[0];
  assert.equal(unit.amount.value, '148.50');
  assert.equal(unit.amount.breakdown.item_total.value, '49.50');
  assert.equal(unit.amount.breakdown.shipping.value, '99.00');
});

test('disconnect forgets the provider for that site only', async () => {
  await call('POST', '/api/hub/shop/disconnect', { provider: 'stripe' });
  const status = await call('GET', '/api/hub/shop/status');
  assert.equal(status.data.stripe.connected, false);
  assert.equal(status.data.paypal.connected, true);
  const admin = await call('GET', '/api/hub/payments-platform', null, '');
  assert.equal(admin.status, 200);
  assert.equal(JSON.stringify(admin.data).includes('whsec_'), false);
});
