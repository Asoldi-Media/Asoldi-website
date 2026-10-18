import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';

const dataDir = mkdtempSync(join(tmpdir(), 'asoldi-shop-docs-'));
process.env.APP_DATA_DIR = dataDir;
process.env.RESEND_FROM = 'Asoldi <contact@asoldi.com>';

const hub = await import('../data/hub.js');
const docs = await import('../lib/shop-documents.js');
const { registerShopPaymentsRoutes } = await import('../lib/shop-payments-routes.js');

const mails = [];
let failNext = false;
docs.setShopDocumentDeps({
  sendEmail: async (m) => {
    if (failNext) {
      failNext = false;
      throw new Error('SMTP down');
    }
    mails.push(m);
  },
});

const site = hub.createSite({ name: 'Kazal Test', domain: 'kazal.no', websitePlan: 'tier-3-ecommerce' });
const app = express();
app.use(express.json({ limit: '2mb' }));
registerShopPaymentsRoutes(app, { adminAuth: (_req, _res, next) => next() });
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;

async function send(body, siteKey = site.site_key) {
  const res = await fetch(`${base}/api/hub/shop/document`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-site-key': siteKey }, body: JSON.stringify(body) });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

test.after(() => {
  server.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const seller = { name: 'Kazal Frisør AS', orgNumber: '934327497', vatRegistered: true, foretaksregisteret: true, address: 'Storgata 1, 7010 Trondheim', email: 'post@kazal.no', phone: '+4790000000' };
const order = {
  kind: 'order',
  number: '1001',
  orderNumber: '1001',
  date: '2026-10-18T10:00:00.000Z',
  currency: 'nok',
  siteName: 'Kazal',
  siteUrl: 'https://kazal.no',
  seller,
  buyer: { name: 'Kari <b>Nordmann</b>', email: 'Kari@Example.com', phone: '+4799999999', address: 'Gata 2, 0155 Oslo, NO' },
  lines: [
    { name: 'Hårvoks – 100 ml 💈', sku: 'HV1', quantity: 2, unitMinor: 24900, discountMinor: 4980, totalMinor: 44820, rate: 25 },
    { name: 'Gavekort', quantity: 1, unitMinor: 50000, discountMinor: 0, totalMinor: 50000, rate: 0 },
  ],
  shipping: { name: 'Posten', amountMinor: 9900 },
  discounts: [{ code: 'HOST10', title: 'HOST10', amountMinor: 4980 }],
  taxLines: [{ rate: 25, netMinor: 43776, taxMinor: 10944 }],
  subtotalMinor: 94820,
  totalMinor: 104720,
  giftcardPayments: [{ last4: 'AB12', amountMinor: 20000 }],
  amountPaidMinor: 84720,
  paymentMethod: 'Kort (Stripe)',
  withdrawal: { text: 'Du har 14 dagers angrerett.', formUrl: 'https://kazal.no/api/cms/angreskjema?order=1001' },
  accountUrl: 'https://kazal.no/api/cms/account',
  downloads: [{ name: 'E-bok', url: 'https://kazal.no/api/cms/downloads/tok' }, { name: 'Bad', url: 'javascript:alert(1)' }],
};

test('HD-1 money and PDFs: Norwegian format, valid PDF for every PDF kind, odd characters do not break rendering', async () => {
  assert.match(docs.formatMoney(104720, 'nok'), /^1\s047,20\skr$/);
  assert.match(docs.formatMoney(-4980, 'nok'), /49,80/);
  for (const doc of [order, { ...order, kind: 'credit-note', number: '1001K1', creditFor: '1001', reason: 'Retur' }, { ...order, kind: 'renewal', number: '1002' }, { ...order, kind: 'giftcard', giftcard: { code: 'GC-ABCD-1234', amountMinor: 50000, expiresAt: '2029-10-18T00:00:00.000Z', recipientName: 'Ola', message: 'Gratulerer 🎉' } }]) {
    const pdf = await docs.renderShopDocumentPdf(doc);
    assert.equal(pdf.subarray(0, 5).toString(), '%PDF-', doc.kind);
    assert.ok(pdf.length > 1200, `${doc.kind} has content`);
  }
  const many = { ...order, lines: Array.from({ length: 80 }, (_, i) => ({ name: `Vare ${i}`, quantity: 1, unitMinor: 100, totalMinor: 100, rate: 25 })) };
  const long = await docs.renderShopDocumentPdf(many);
  assert.ok((long.toString('latin1').match(/\/Type \/Page\b/g) || []).length >= 2, 'long orders flow onto a second page');
});

test('HD-2 email bodies escape every field and drop non-http links', () => {
  const mail = docs.documentEmail(order);
  assert.match(mail.subject, /ordre 1001/);
  assert.equal(mail.html.includes('<b>Nordmann</b>'), false);
  assert.equal(mail.html.includes('javascript:'), false);
  assert.match(mail.html, /api\/cms\/downloads\/tok/);
  assert.match(mail.html, /angreskjema\?order=1001/);
  assert.match(mail.text, /Takk for bestillingen/);
  assert.match(mail.text, /ml 💈\t+\S/, 'plain text keeps table cells apart');
  const shipped = docs.documentEmail({ ...order, kind: 'shipped', shipment: { carrier: 'Posten', trackingNumber: 'AB123', trackingUrl: 'javascript:evil()' } });
  assert.equal(shipped.html.includes('javascript:'), false);
  assert.match(shipped.html, /AB123/);
  const tracked = docs.documentEmail({ ...order, kind: 'shipped', shipment: { carrier: 'Posten', trackingNumber: 'AB123', trackingUrl: 'https://sporing.posten.no/sporing/AB123' } });
  assert.match(tracked.html, /href="https:\/\/sporing\.posten\.no\/sporing\/AB123"/);
});

test('HD-3 booking calendar: UTC times, stable UID, cancel variant', () => {
  const doc = { ...order, kind: 'booking', bookings: [{ id: 'bk_1', productName: 'Herreklipp', staffName: 'Ali', start: '2026-10-20T08:00:00.000Z', end: '2026-10-20T08:30:00.000Z' }, { id: 'bk_bad', productName: 'X' }] };
  const ics = docs.bookingIcs(doc);
  assert.match(ics, /DTSTART:20261020T080000Z/);
  assert.match(ics, /DTEND:20261020T083000Z/);
  assert.match(ics, /UID:bk_1@kazal\.no/);
  assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, 1, 'bookings without times are skipped');
  assert.match(ics, /METHOD:PUBLISH/);
  const cancel = docs.bookingIcs(doc, { cancel: true });
  assert.match(cancel, /METHOD:CANCEL/);
  assert.match(cancel, /STATUS:CANCELLED/);
  assert.equal(docs.bookingIcs({ ...order, bookings: [] }), '');
});

test('HD-4 send: buyer gets PDF from the shop name, once; resend works; explicit `to` only for gift cards', async () => {
  assert.equal((await send({ document: order }, 'wrong')).status, 401);
  const first = await send({ document: order, to: 'attacker@example.com' });
  assert.equal(first.status, 200, JSON.stringify(first.data));
  assert.deepEqual(first.data, { ok: true, skipped: false });
  const mail = mails.at(-1);
  assert.equal(mail.to, 'kari@example.com', 'order documents always go to the buyer');
  assert.equal(mail.from, 'Kazal Frisør AS <contact@asoldi.com>');
  assert.equal(mail.replyTo, 'post@kazal.no');
  assert.equal(mail.bcc, false, 'no BCC copy of customer receipts');
  assert.equal(mail.attachments[0].filename, 'kvittering-1001.pdf');
  assert.equal(mail.attachments[0].content.subarray(0, 5).toString(), '%PDF-');

  const count = mails.length;
  assert.deepEqual((await send({ document: order })).data, { ok: true, skipped: true });
  assert.equal(mails.length, count, 'same document is not sent twice');
  assert.equal((await send({ document: order, resend: true })).data.skipped, false);
  assert.equal(mails.length, count + 1);

  const gift = { ...order, kind: 'giftcard', giftcard: { code: 'GC-1', amountMinor: 50000, recipientName: 'Ola' } };
  await send({ document: gift, to: 'ola@example.com' });
  assert.equal(mails.at(-1).to, 'ola@example.com');
  assert.equal(mails.at(-1).attachments[0].filename, 'gavekort-1001.pdf');
  await send({ document: { ...gift, giftcard: { ...gift.giftcard, code: 'GC-2' } } });
  assert.equal(mails.at(-1).to, 'kari@example.com', 'a second card on the same order is its own document; no recipient → buyer');

  await send({ document: { ...order, kind: 'credit-note', number: '1001K1', creditFor: '1001' } });
  assert.equal(mails.at(-1).attachments[0].filename, 'kreditnota-1001K1.pdf');
  await send({ document: { ...order, kind: 'shipped', shipment: { id: 'shp_1', carrier: 'Posten' } } });
  assert.equal(mails.at(-1).attachments.length, 0, 'shipping notice has no PDF');
  assert.equal((await send({ document: { ...order, kind: 'shipped', shipment: { id: 'shp_1' } } })).data.skipped, true);
  assert.equal((await send({ document: { ...order, kind: 'shipped', shipment: { id: 'shp_2' } } })).data.skipped, false, 'second parcel is a new notice');
});

test('HD-5 bookings attach a calendar file; cancellations a CANCEL file', async () => {
  const bookings = [{ id: 'bk_9', productName: 'Herreklipp', start: '2026-10-21T08:00:00.000Z', end: '2026-10-21T08:30:00.000Z' }];
  await send({ document: { ...order, kind: 'booking', number: '1003', bookings } });
  const names = mails.at(-1).attachments.map((a) => a.filename);
  assert.deepEqual(names, ['kvittering-1003.pdf', 'booking.ics']);
  await send({ document: { ...order, kind: 'booking-cancelled', number: '1003', bookings } });
  const cancel = mails.at(-1).attachments.find((a) => a.filename === 'avbestilt.ics');
  assert.match(cancel.content.toString(), /METHOD:CANCEL/);
});

test('HD-6 magic link must point at the site; validation and mail errors are reported', async () => {
  const foreign = await send({ to: 'kari@example.com', document: { kind: 'magic-link', siteName: 'Kazal', siteUrl: 'https://kazal.no', link: 'https://evil.example/login' } });
  assert.equal(foreign.status, 400);
  const ok = await send({ to: 'kari@example.com', document: { kind: 'magic-link', siteName: 'Kazal', siteUrl: 'https://kazal.no', link: 'https://kazal.no/api/cms/account/verify?token=abc' } });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.match(mails.at(-1).html, /account\/verify\?token=abc/);
  assert.equal((await send({ document: { kind: 'nope' } })).status, 400);
  assert.equal((await send({ document: { ...order, number: '' } })).status, 400);
  assert.equal((await send({ document: { ...order, number: '2001', buyer: { name: 'X' } } })).data.code, 'no_recipient');
  assert.equal((await send({ document: { ...order, kind: 'giftcard', giftcard: {} } })).status, 400, 'gift card needs a code');
  failNext = true;
  const down = await send({ document: { ...order, number: '2002' } });
  assert.equal(down.status, 500);
  assert.match(down.data.message, /SMTP down/);
  assert.equal((await send({ document: { ...order, number: '2002' } })).data.skipped, false, 'a failed send is not marked as sent');
});

test('HD-7 per-recipient rate limit', async () => {
  docs.setShopDocumentDeps({ sendEmail: async (m) => mails.push(m) });
  const link = { kind: 'magic-link', siteName: 'Kazal', siteUrl: 'https://kazal.no', link: 'https://kazal.no/api/cms/account/verify?token=x' };
  for (let i = 0; i < 20; i += 1) assert.equal((await send({ to: 'spam@example.com', document: link })).status, 200);
  const blocked = await send({ to: 'spam@example.com', document: link });
  assert.equal(blocked.status, 429);
  assert.equal((await send({ to: 'other@example.com', document: link })).status, 200, 'other recipients still work');
});
