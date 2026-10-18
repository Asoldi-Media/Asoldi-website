import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

const realStripe = new Stripe('sk_test_signing_only');
const calls = [];
const accounts = new Map();
const sessions = new Map();

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
          const total = params.line_items.reduce((sum, row) => sum + row.price_data.unit_amount * row.quantity, 0);
          sessions.set(id, { id, account: opts.stripeAccount, metadata: params.metadata, client_reference_id: params.client_reference_id, amount_total: total, currency: params.line_items[0].price_data.currency, payment_status: 'unpaid', status: 'open', payment_intent: null });
          return { id, url: `https://checkout.stripe.test/${id}` };
        },
        async retrieve(id, _params, opts) {
          const session = sessions.get(id);
          if (!session || session.account !== opts.stripeAccount) throw Object.assign(new Error('No such session'), { statusCode: 404 });
          return session;
        },
      },
    },
    webhookEndpoints: {
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

test('connect never uses the billing key; saving the connect key moves the webhook to that account', async () => {
  writeFileSync(join(dataDir, 'shop-payments-platform.json'), JSON.stringify({ stripe: { webhooks: { live: { id: 'we_old', secret: 'whsec_old', url: 'x' } } } }));
  const status = await call('GET', '/api/hub/shop/status');
  assert.equal(status.data.stripe.available, false, 'STRIPE_SECRET_KEY alone does not enable Connect');
  const blocked = await call('POST', '/api/hub/shop/stripe/connect', { returnUrl: 'https://kafe.no/admin' });
  assert.equal(blocked.data.code, 'stripe_not_configured');

  const billing = await call('PUT', '/api/hub/payments-platform', { stripe: { liveSecretKey: 'sk_live_fake_platform_key' } }, '');
  assert.match(billing.data.webhookError, /ASOLDI\.com \(acct_billing\) is connected to another platform/);
  assert.deepEqual(deletedWebhooks.at(-1), ['sk_live_fake_platform_key', 'we_old'], 'old webhook removed from the billing account');

  const bad = await call('PUT', '/api/hub/payments-platform', { stripe: { liveSecretKey: 'sk_test_wrong' } }, '');
  assert.equal(bad.status, 400);

  const saved = await call('PUT', '/api/hub/payments-platform', { stripe: { liveSecretKey: 'sk_live_connect_key' } }, '');
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.equal(saved.data.webhook.account, 'asoldi (acct_platform)');
  assert.equal(calls.filter(([name]) => name === 'webhookEndpoints.create').at(-1)[2], 'sk_live_connect_key');
  assert.equal(saved.data.platform.stripe.webhooks.live.configured, true);
  assert.equal(JSON.stringify(saved.data).includes('sk_live_connect_key'), false, 'key is masked');

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

  const payload = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed', account: 'acct_1', data: { object: { id: 'cs_test_1', metadata: { asoldi_site_id: site.id } } } });
  const unsigned = await fetch(`${base}/api/hub/shop/stripe/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=bad' }, body: payload });
  assert.equal(unsigned.status, 400);
  const header = realStripe.webhooks.generateTestHeaderString({ payload, secret: 'whsec_test_secret' });
  const parsed = shop.parseStripeConnectWebhook(Buffer.from(payload), header);
  assert.deepEqual(parsed, { type: 'checkout.session.completed', siteId: site.id, sessionId: 'cs_test_1' });

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

test('disconnect forgets the provider for that site only', async () => {
  await call('POST', '/api/hub/shop/disconnect', { provider: 'stripe' });
  const status = await call('GET', '/api/hub/shop/status');
  assert.equal(status.data.stripe.connected, false);
  assert.equal(status.data.paypal.connected, true);
  const admin = await call('GET', '/api/hub/payments-platform', null, '');
  assert.equal(admin.status, 200);
  assert.equal(JSON.stringify(admin.data).includes('whsec_'), false);
});
