import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';

const dataDir = mkdtempSync(join(tmpdir(), 'asoldi-unsubscribe-'));
process.env.APP_DATA_DIR = dataDir;

const unsub = await import('../lib/asoldi-unsubscribe.js');
const store = await import('../data/email-store.js');
const { renderSalesUnsubscribePage, unsubscribeUrl } = await import('../lib/sales-email.js');
const { renderResponsiveSalesEmailHtml } = await import('../lib/sales-email-layout.js');
const { stripMarketingUnsubscribe } = await import('../lib/email-merge.js');

const clients = {
  c_1: { id: 'c_1', businessName: 'Bakeri Eksempel', contactPerson: 'Ola Nordmann', contactEmail: 'Ola@Example.no', clientEmail: 'ola.privat@example.no' },
  c_2: { id: 'c_2', businessName: 'Annen Kunde', contactEmail: 'per@example.no' },
  c_3: { id: 'c_3', businessName: 'Uten e-post', contactEmail: '' },
};
const suppressionsPath = join(dataDir, 'email-suppressions.json');

function signedQuery(clientId) {
  return `c=${encodeURIComponent(clientId)}&s=${unsub.signAsoldiUnsubscribe(clientId)}`;
}

async function withServer(fn, { limiter } = {}) {
  const app = express();
  app.use(express.json());
  unsub.registerAsoldiUnsubscribeRoutes(app, {
    getSalesClientById: (id) => clients[id] || null,
    ...(limiter ? { limiter } : {}),
  });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async (path) => {
    const response = await fetch(`${base}${path}`);
    return { status: response.status, html: await response.text(), headers: response.headers };
  };
  const post = async (path, form = {}) => {
    const response = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
    });
    return { status: response.status, html: await response.text() };
  };
  try {
    await fn({ get, post });
  } finally {
    server.close();
  }
}

test('WS7.14: sales mail links are signed with the unsubKey and verify only for the same client', () => {
  const url = unsub.asoldiUnsubscribeUrl('c_1');
  const match = url.match(/^https:\/\/asoldi\.com\/email\/avmeld\?c=c_1&s=([A-Za-z0-9_-]{32})$/);
  assert.ok(match, url);
  assert.equal(unsub.verifyAsoldiUnsubscribe('c_1', match[1]), true);
  assert.equal(unsub.verifyAsoldiUnsubscribe('c_2', match[1]), false);
  assert.equal(unsub.verifyAsoldiUnsubscribe('c_1', `${match[1].slice(0, -1)}x`), false);
  assert.equal(unsub.verifyAsoldiUnsubscribe('c_1', ''), false);
  assert.equal(unsub.asoldiUnsubscribeUrl(''), 'https://asoldi.com/email/avmeld');
  assert.equal(unsub.asoldiUnsubscribeUrl('c 1', 'http://127.0.0.1:3001/'), `http://127.0.0.1:3001/email/avmeld?c=c%201&s=${unsub.signAsoldiUnsubscribe('c 1')}`);
});

test('WS7.14: unsubscribeUrl() in sales-email emits the signed link, and merge stripping still removes it', () => {
  const url = unsubscribeUrl({ id: 'c_1' });
  assert.equal(url, `https://asoldi.com/email/avmeld?${signedQuery('c_1')}`);
  assert.equal(unsubscribeUrl({ id: 'c_1' }, 'http://127.0.0.1:3001'), `http://127.0.0.1:3001/email/avmeld?${signedQuery('c_1')}`);
  assert.equal(unsubscribeUrl({}), 'https://asoldi.com/email/avmeld');
  // A layout that shows the footer link (marketing mail) carries the signed URL; merge stripping removes it.
  const html = renderResponsiveSalesEmailHtml({ title: 'T', bodyHtml: '<p>Hei</p>', assets: {}, footerLinks: { unsubscribe: url }, showUnsubscribe: true, year: 2026 });
  assert.ok(html.includes(url.replace('&', '&amp;')) || html.includes(url), 'the footer carries the signed link');
  assert.equal(stripMarketingUnsubscribe(html).includes('/email/avmeld'), false);
});

test('WS7.14 (b): the page no longer says "kobles snart"', () => {
  assert.equal(renderSalesUnsubscribePage({ clientId: 'c_1' }).includes('kobles snart'), false);
  assert.equal(unsub.renderAsoldiUnsubscribePage({ state: 'confirm' }).includes('kobles snart'), false);
  assert.match(renderSalesUnsubscribePage(), /name="email"/, 'the legacy export renders the address form');
});

test('WS7.14 (d): GET alone changes nothing, even on a valid signed link', async () => {
  await withServer(async ({ get }) => {
    const page = await get(`/email/avmeld?${signedQuery('c_1')}`);
    assert.equal(page.status, 200);
    assert.match(page.html, /Meld meg av/);
    assert.match(page.html, /o\*\*\*@example\.no/, 'the confirm page shows the masked address');
    assert.equal(page.html.includes('Ola@Example.no') || page.html.includes('ola@example.no'), false);
    assert.equal(page.html.includes('kobles snart'), false);
    assert.equal(page.headers.get('x-robots-tag'), 'noindex, nofollow');
    for (let i = 0; i < 3; i += 1) await get(`/email/avmeld?${signedQuery('c_1')}`);
    assert.equal(existsSync(suppressionsPath), false, 'no suppression file was written');
    assert.equal(unsub.isAsoldiMarketingSuppressed('ola@example.no'), false);
  });
});

test('WS7.14 (a)+(c): confirming a signed link records the suppression and isAsoldiMarketingSuppressed is true', async () => {
  await withServer(async ({ post }) => {
    const done = await post(`/email/avmeld?${signedQuery('c_1')}`, {});
    assert.equal(done.status, 200);
    assert.match(done.html, /Du er meldt av/);
    const rows = JSON.parse(readFileSync(suppressionsPath, 'utf8'));
    assert.equal(rows.asoldi['ola@example.no'].scope, 'marketing');
    assert.equal(rows.asoldi['ola@example.no'].source, 'unsubscribe-link');
    assert.equal(rows.asoldi['ola@example.no'].clientId, 'c_1');
    assert.ok(rows.asoldi['ola.privat@example.no'], 'every address on the card is suppressed');
    assert.equal(unsub.isAsoldiMarketingSuppressed('ola@example.no'), true);
    assert.equal(unsub.isAsoldiMarketingSuppressed('  OLA@example.no '), true);
    assert.equal(unsub.isAsoldiMarketingSuppressed('per@example.no'), false);
    assert.equal(existsSync(join(dataDir, 'backups', 'email-suppressions.json.latest.json')), true, 'the opt-out record has a backup');
    const firstAt = rows.asoldi['ola@example.no'].at;
    await post(`/email/avmeld?${signedQuery('c_1')}`, {});
    assert.equal(JSON.parse(readFileSync(suppressionsPath, 'utf8')).asoldi['ola@example.no'].at, firstAt, 'idempotent');
  });
});

test('WS7.14: a legacy unsigned ?c= link asks for the address and never reveals the card email', async () => {
  await withServer(async ({ get, post }) => {
    const page = await get('/email/avmeld?c=c_2');
    assert.equal(page.status, 200);
    assert.match(page.html, /name="email"/);
    assert.equal(page.html.includes('p***@example.no') || page.html.includes('per@example.no'), false);
    assert.equal(page.html.includes('name="c"'), false, 'an unsigned id is not carried forward');
    const forged = await get(`/email/avmeld?c=c_2&s=${unsub.signAsoldiUnsubscribe('c_1')}`);
    assert.match(forged.html, /name="email"/, 'a signature for another card counts as unsigned');
    const empty = await post('/email/avmeld?c=c_2', {});
    assert.equal(empty.status, 400);
    assert.match(empty.html, /Skriv e-postadressen/);
    const bad = await post('/email/avmeld?c=c_2', { email: 'ikke-en-adresse' });
    assert.equal(bad.status, 400);
    assert.match(bad.html, /gyldig e-postadresse/);
    assert.equal(unsub.isAsoldiMarketingSuppressed('per@example.no'), false, 'the unsigned id alone suppresses nothing');
    const ok = await post('/email/avmeld?c=c_2', { email: 'Per@Example.no' });
    assert.equal(ok.status, 200);
    assert.equal(unsub.isAsoldiMarketingSuppressed('per@example.no'), true);
    const row = JSON.parse(readFileSync(suppressionsPath, 'utf8')).asoldi['per@example.no'];
    assert.equal(row.source, 'unsubscribe-form');
    assert.equal(row.clientId, undefined, 'unsigned requests do not attach a card');
  });
});

test('WS7.14: a signed card without an address falls back to the form; one-click POST works', async () => {
  await withServer(async ({ get, post }) => {
    const page = await get(`/email/avmeld?${signedQuery('c_3')}`);
    assert.match(page.html, /name="email"/);
    const typed = await post(`/email/avmeld?${signedQuery('c_3')}`, { email: 'ny@example.no' });
    assert.equal(typed.status, 200);
    assert.equal(JSON.parse(readFileSync(suppressionsPath, 'utf8')).asoldi['ny@example.no'].clientId, 'c_3');
    clients.c_4 = { id: 'c_4', contactEmail: 'klikk@example.no' };
    const oneClick = await post(`/email/avmeld?${signedQuery('c_4')}`, { 'List-Unsubscribe': 'One-Click' });
    assert.equal(oneClick.status, 200);
    assert.equal(oneClick.html, 'Unsubscribed');
    assert.equal(JSON.parse(readFileSync(suppressionsPath, 'utf8')).asoldi['klikk@example.no'].source, 'one-click');
  });
});

test('WS7.14: POSTs are rate limited per IP', async () => {
  let calls = 0;
  await withServer(async ({ post }) => {
    assert.equal((await post('/email/avmeld', { email: 'a1@example.no' })).status, 200);
    assert.equal((await post('/email/avmeld', { email: 'a2@example.no' })).status, 200);
    const limited = await post('/email/avmeld', { email: 'a3@example.no' });
    assert.equal(limited.status, 429);
    assert.equal(unsub.isAsoldiMarketingSuppressed('a3@example.no'), false);
  }, { limiter: () => { calls += 1; return calls <= 2; } });
});

test('WS7.14: every Asoldi marketing send is refused for a suppressed address; service mail still goes', () => {
  const blocked = unsub.asoldiMarketingSendBlock({ to: 'ola@example.no', service: false });
  assert.equal(blocked.code, 'asoldi_unsubscribed');
  assert.match(blocked.message, /o\*\*\*@example\.no/);
  assert.equal(unsub.asoldiMarketingSendBlock({ to: 'Kari <kari@example.no>, ola@example.no', service: false })?.code, 'asoldi_unsubscribed');
  assert.equal(unsub.asoldiMarketingSendBlock({ to: 'Ola <OLA@example.no>' })?.code, 'asoldi_unsubscribed', 'display-name form');
  assert.equal(unsub.asoldiMarketingSendBlock({ to: 'ola@example.no', service: true }), null);
  assert.equal(unsub.asoldiMarketingSendBlock({ to: 'ukjent@example.no', service: false }), null);
  // The card opted out through its signed link; a new address on the same card is still blocked.
  assert.equal(unsub.isAsoldiClientSuppressed('c_1'), true);
  assert.equal(unsub.isAsoldiClientSuppressed('c_2'), false, 'an unsigned form unsubscribe does not mark the card');
  assert.equal(unsub.asoldiMarketingSendBlock({ to: 'ny.adresse@example.no', clientId: 'c_1' })?.code, 'asoldi_unsubscribed');
  assert.equal(unsub.asoldiMarketingSendBlock({ to: 'ny.adresse@example.no', clientId: 'c_2' }), null);
  for (const key of ['thank-you', 'reminder-24h-in-person', 'workshop-reminder-3d', 'data-innsamling-2', 'iteration', 'offer', '']) {
    assert.equal(unsub.isAsoldiServiceTemplate(key), true, key);
  }
  assert.equal(unsub.isAsoldiServiceTemplate('host-kampanje'), false);
  assert.equal(unsub.isAsoldiServiceTemplate('custom-1', { preset: false }), false);
  assert.equal(unsub.isAsoldiServiceTemplate('custom-2', { preset: true }), true);
});

test('WS7.14: an unreadable suppression record fails closed and the POST reports it', async () => {
  writeFileSync(suppressionsPath, '{"asoldi": {', 'utf8');
  writeFileSync(join(dataDir, 'backups', 'email-suppressions.json.latest.json'), 'broken', 'utf8');
  assert.equal(unsub.isAsoldiMarketingSuppressed('whoever@example.no'), true, 'unknown state counts as suppressed');
  assert.equal(unsub.asoldiMarketingSendBlock({ to: 'whoever@example.no' })?.code, 'asoldi_unsubscribed');
  await withServer(async ({ post }) => {
    const failed = await post('/email/avmeld', { email: 'whoever@example.no' });
    assert.equal(failed.status, 503);
    assert.match(failed.html, /fikk ikke registrert/);
  });
  await store.updateEmailSuppressions(() => {}).catch(() => {});
});

test.after(() => {
  rmSync(dataDir, { recursive: true, force: true });
});
