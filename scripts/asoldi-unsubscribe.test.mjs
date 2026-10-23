import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
  assert.equal(unsub.isAsoldiServiceTemplate('custom-1', { key: '', preset: false }), false);
  // A stored row is service only when it is an Asoldi preset with a service key.
  assert.equal(unsub.isAsoldiServiceTemplate('preset-offer', { key: 'offer', preset: true }), true);
  assert.equal(unsub.isAsoldiServiceTemplate('custom-2', { key: 'host-kampanje', preset: true }), false, 'a preset flag alone is not enough');
  assert.equal(unsub.isAsoldiServiceTemplate('offer', { key: 'offer', preset: false }), false, 'a custom row with a service key is marketing');
});

async function postWith(path, { headers = {}, body = '' } = {}, port) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers, body });
  return { status: response.status, html: await response.text() };
}

async function withRawServer(fn) {
  const app = express();
  unsub.registerAsoldiUnsubscribeRoutes(app, { getSalesClientById: (id) => clients[id] || null });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  try {
    await fn(server.address().port);
  } finally {
    server.close();
  }
}

test('WS7.14: a spoofed X-Forwarded-For cannot dodge the per-client limit on typed addresses', async () => {
  await withRawServer(async (port) => {
    const statuses = [];
    for (let i = 0; i < 30; i += 1) {
      // The client controls the left-most entries; the hosting proxy appends the real address on the right.
      const result = await postWith('/email/avmeld', {
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': `198.51.100.${i}, 203.0.113.7` },
        body: new URLSearchParams({ email: `spoof${i}@example.no` }).toString(),
      }, port);
      statuses.push(result.status);
    }
    assert.equal(statuses.filter((s) => s === 200).length, 20);
    assert.equal(statuses.filter((s) => s === 429).length, 10);
    assert.equal(unsub.isAsoldiMarketingSuppressed('spoof25@example.no'), false);
    // A signed link is not limited: it can only opt out its own card.
    clients.c_5 = { id: 'c_5', contactEmail: 'signert@example.no' };
    const signed = await postWith(`/email/avmeld?${signedQuery('c_5')}`, { headers: { 'x-forwarded-for': '203.0.113.7' } }, port);
    assert.equal(signed.status, 200);
    assert.equal(unsub.isAsoldiMarketingSuppressed('signert@example.no'), true);
  });
  const key = (peer, xff) => unsub.unsubscribeRateKey({ socket: { remoteAddress: peer }, headers: xff ? { 'x-forwarded-for': xff } : {} });
  assert.equal(key('127.0.0.1', '1.1.1.1, 2.2.2.2'), '2.2.2.2', 'behind the local proxy: the hop it appended');
  assert.equal(key('::ffff:10.0.0.4', '1.1.1.1, 2.2.2.2'), '2.2.2.2');
  assert.equal(key('203.0.113.9', '1.1.1.1'), '203.0.113.9', 'a public peer is never replaced by a header');
  assert.equal(key('203.0.113.9', ''), '203.0.113.9');
});

test('WS7.14: typed opt-outs are capped hub-wide whatever the IP; signed links still work', async () => {
  const now = Date.now();
  const seeded = [];
  await store.updateEmailSuppressions((rows) => {
    const scope = rows.asoldi;
    const recent = Object.values(scope).filter((row) => row.source === 'unsubscribe-form' && Date.parse(row.at) >= now - 60 * 60 * 1000).length;
    for (let i = recent; i < unsub.FORM_ROWS_PER_HOUR; i += 1) {
      const email = `seed${i}@example.no`;
      seeded.push(email);
      scope[email] = { scope: 'marketing', source: 'unsubscribe-form', at: new Date(now - 1000).toISOString() };
    }
  });
  await assert.rejects(
    unsub.recordAsoldiSuppression({ emails: ['over@example.no'], source: 'unsubscribe-form', now }),
    (error) => error.code === 'AVMELD_FORM_CAP',
  );
  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  try {
    await withRawServer(async (port) => {
      const capped = await postWith('/email/avmeld', {
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': '192.0.2.200' },
        body: 'email=over%40example.no',
      }, port);
      assert.equal(capped.status, 429);
      assert.equal(unsub.isAsoldiMarketingSuppressed('over@example.no'), false);
      clients.c_6 = { id: 'c_6', contactEmail: 'cap-signert@example.no' };
      assert.equal((await postWith(`/email/avmeld?${signedQuery('c_6')}`, {}, port)).status, 200, 'signed links are not capped');
      assert.equal(unsub.isAsoldiMarketingSuppressed('cap-signert@example.no'), true);
      const repeat = await postWith('/email/avmeld', {
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': '192.0.2.201' },
        body: `email=${encodeURIComponent(seeded[0])}`,
      }, port);
      assert.equal(repeat.status, 200, 'an address that already opted out is not a new row');
    });
  } finally {
    console.error = original;
  }
  assert.ok(errors.some((line) => line.includes('ALERT') && line.includes('cap')));
  // An hour later the hourly cap is free again, but the total cap still holds.
  const later = now + 61 * 60 * 1000;
  await unsub.recordAsoldiSuppression({ emails: ['later@example.no'], source: 'unsubscribe-form', now: later });
  assert.equal(unsub.isAsoldiMarketingSuppressed('later@example.no'), true);
  await store.updateEmailSuppressions((rows) => {
    const total = Object.values(rows.asoldi).filter((row) => row.source === 'unsubscribe-form').length;
    for (let i = total; i < unsub.FORM_ROWS_MAX; i += 1) {
      rows.asoldi[`old${i}@example.no`] = { scope: 'marketing', source: 'unsubscribe-form', at: '2026-01-01T00:00:00.000Z' };
    }
  });
  await assert.rejects(
    unsub.recordAsoldiSuppression({ emails: ['total@example.no'], source: 'unsubscribe-form', now: later + 2 * 60 * 60 * 1000 }),
    (error) => error.code === 'AVMELD_FORM_CAP',
  );
  await store.updateEmailSuppressions((rows) => {
    for (const [email, row] of Object.entries(rows.asoldi)) {
      if (/^(seed|old)\d+@example\.no$/.test(email) && row.source === 'unsubscribe-form') delete rows.asoldi[email];
    }
  });
});

test('WS7.14: repeating an opt-out writes nothing (no file rewrite, no backup snapshot, no lock)', async () => {
  await withServer(async ({ post }) => {
    assert.equal(unsub.isAsoldiMarketingSuppressed('ola@example.no'), true);
    const before = statSync(suppressionsPath).mtimeMs;
    const backups = readdirSync(join(dataDir, 'backups')).length;
    await new Promise((resolve) => setTimeout(resolve, 20));
    for (let i = 0; i < 5; i += 1) assert.equal((await post(`/email/avmeld?${signedQuery('c_1')}`, {})).status, 200);
    assert.equal((await post('/email/avmeld', { email: 'ola@example.no' })).status, 200);
    assert.equal(statSync(suppressionsPath).mtimeMs, before);
    assert.equal(readdirSync(join(dataDir, 'backups')).length, backups);
    assert.deepEqual(readdirSync(join(dataDir, 'email-locks')).filter((name) => name.endsWith('.lock')), []);
  }, { limiter: () => true });
  // A signed link ties an earlier typed opt-out to its card (so a new address on the card is blocked too).
  clients.c_7 = { id: 'c_7', contactEmail: 'per@example.no' };
  assert.equal(unsub.isAsoldiClientSuppressed('c_7'), false);
  await unsub.recordAsoldiSuppression({ emails: ['per@example.no'], clientId: 'c_7' });
  assert.equal(unsub.isAsoldiClientSuppressed('c_7'), true);
  assert.equal(JSON.parse(readFileSync(suppressionsPath, 'utf8')).asoldi['per@example.no'].source, 'unsubscribe-form', 'the original row is kept');
});

test('WS7.14: RFC 8058 one-click also works as multipart/form-data', async () => {
  clients.c_8 = { id: 'c_8', contactEmail: 'multipart@example.no' };
  await withRawServer(async (port) => {
    const form = new FormData();
    form.append('List-Unsubscribe', 'One-Click');
    const response = await fetch(`http://127.0.0.1:${port}/email/avmeld?${signedQuery('c_8')}`, { method: 'POST', body: form });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'Unsubscribed');
  });
  assert.equal(JSON.parse(readFileSync(suppressionsPath, 'utf8')).asoldi['multipart@example.no'].source, 'one-click');
});

test('WS7.14: Asoldi marketing mail carries the signed footer link and https-only List-Unsubscribe headers', () => {
  const message = { subject: 'Kampanje', html: '<html><body><p>Hei</p></body></html>', text: 'Hei', from: 'a@asoldi.com' };
  assert.equal(unsub.withAsoldiMarketingUnsubscribe(message, { clientId: 'c_2', service: true }), message, 'service mail is untouched');
  const marketing = unsub.withAsoldiMarketingUnsubscribe(message, { clientId: 'c_2' });
  const url = unsub.asoldiUnsubscribeUrl('c_2');
  assert.match(url, /^https:\/\/asoldi\.com\/email\/avmeld\?c=c_2&s=[A-Za-z0-9_-]{32}$/);
  assert.ok(marketing.html.includes(url.replace('&', '&amp;')), 'signed link in the html footer');
  assert.ok(marketing.html.indexOf('/email/avmeld') < marketing.html.indexOf('</body>'), 'inside the body');
  assert.ok(marketing.text.endsWith(`Avmeld e-postmarkedsføring fra Asoldi: ${url}\n`));
  assert.deepEqual(marketing.headers, { 'List-Unsubscribe': `<${url}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' });
  assert.equal(marketing.headers['List-Unsubscribe'].includes('mailto:'), false, 'no mailto entry (no task reads such a mailbox)');
  assert.equal(marketing.subject, 'Kampanje');
  const unsigned = unsub.withAsoldiMarketingUnsubscribe(message, { clientId: '' });
  assert.ok(unsigned.html.includes('https://asoldi.com/email/avmeld'), 'without a card the form link is still there');
  assert.deepEqual(unsigned.headers, {}, 'no one-click header without a signed link');
  const local = unsub.withAsoldiMarketingUnsubscribe(message, { clientId: 'c_2', siteUrl: 'http://127.0.0.1:3001' });
  assert.deepEqual(local.headers, {}, 'List-Unsubscribe is https only');
});

test('WS7.14: a composed custom template gets exactly one signed link after the merge strip; presets keep their flags', async () => {
  const templates = await import('../lib/email-templates-store.js');
  const forged = templates.saveEmailTemplate({ name: 'Kampanje', key: 'offer', preset: true, html: '<p>Hei {{firstName}}</p><a href="https://asoldi.com/email/avmeld?c=x">Avmeld</a>' });
  assert.equal(forged.ok, true);
  assert.equal(forged.template.preset, false, 'staff cannot mark a template as an Asoldi preset');
  assert.equal(forged.template.key, '', 'a custom template cannot take a service key');
  assert.equal(unsub.isAsoldiServiceTemplate(forged.template.id, templates.getEmailTemplateById(forged.template.id)), false);
  const renamed = templates.saveEmailTemplate({ ...forged.template, key: 'thank-you' });
  assert.equal(renamed.template.key, '');
  const preset = templates.getEmailTemplateById('offer');
  assert.equal(preset.preset, true);
  const edited = templates.saveEmailTemplate({ ...preset, key: 'host-kampanje', preset: false, name: 'Tilbud (redigert)' });
  assert.equal(edited.template.preset, true, 'a preset stays a preset');
  assert.equal(edited.template.key, 'offer', 'and keeps its key');
  assert.equal(unsub.isAsoldiServiceTemplate('offer', templates.getEmailTemplateById('offer')), true);

  const client = { id: 'c_2', businessName: 'Annen Kunde', contactPerson: 'Per Hansen', contactEmail: 'per@example.no' };
  const composed = templates.composeEmailForClient(client, forged.template.id, null, { sender: {} }).message;
  assert.equal(composed.html.includes('/email/avmeld'), false, 'the template\'s own link was stripped');
  const sent = unsub.withAsoldiMarketingUnsubscribe(composed, { clientId: client.id, service: false });
  assert.equal(sent.html.split('/email/avmeld').length - 1, 1, 'exactly one signed link');
  assert.ok(sent.html.includes(unsub.asoldiUnsubscribeUrl('c_2').replace('&', '&amp;')));
  assert.ok(sent.headers['List-Unsubscribe']);
});

test('WS7.14: the composer route checks the service flag once and sends the footer and headers', () => {
  const source = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const start = source.indexOf("app.post('/api/admin/sales/:id/send-composed-email'");
  const route = source.slice(start, source.indexOf('\n});', start));
  assert.match(route, /const service = isAsoldiServiceTemplate\(templateKey, getEmailTemplateById\(templateKey\)\);/);
  assert.match(route, /asoldiMarketingSendBlock\(\{[\s\S]*?service,\s*\}\)/);
  assert.match(route, /withAsoldiMarketingUnsubscribe\(composeEmailForClient\([\s\S]*?\)\.message, \{ clientId: client\.id, service \}\)/);
  assert.match(route, /headers: composed\.headers,/);
});

test('WS7.14: rendering sales mail (no unsubscribe footer) does not touch the email secret store', async () => {
  const fresh = mkdtempSync(join(tmpdir(), 'asoldi-unsub-lazy-'));
  try {
    const salesUrl = new URL('../lib/sales-email.js', import.meta.url).href;
    const code = `
      const m = await import(${JSON.stringify(salesUrl)});
      const mail = m.buildSalesThankYouEmail({ id: 'c_lazy', businessName: 'Lazy AS', contactPerson: 'Ola', contactEmail: 'lazy@example.no', meetingAt: '2026-11-01T10:00:00.000Z' }, {}, {});
      console.log('HTML=' + (typeof mail.html === 'string' && mail.html.length > 100));
    `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, APP_DATA_DIR: fresh }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    const code_ = await new Promise((resolve) => child.on('exit', resolve));
    assert.equal(code_, 0, err);
    assert.match(out, /HTML=true/);
    assert.equal(existsSync(join(fresh, 'secrets', 'email-unsub-key')), false, 'no unsub key created by a render');
    assert.equal(existsSync(join(fresh, 'secrets', 'email-webhook-token')), false, 'no webhook token created by a render');
  } finally {
    rmSync(fresh, { recursive: true, force: true });
  }
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
