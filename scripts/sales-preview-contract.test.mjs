import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const dataDir = mkdtempSync(join(tmpdir(), 'asoldi-preview-contract-'));
process.env.APP_DATA_DIR = dataDir;

const offers = await import('../data/offers.js');
const { allowPreviewAcceptAttempt, ensurePreviewSigner, presentPreviewContract } = await import('../lib/sales-preview-contract.js');

test('idle / ready / signed payloads never include the offer letter', () => {
  const idle = presentPreviewContract({ name: 'Kari', email: 'kari@cafe.no' });
  assert.equal(idle.status, 'idle');
  assert.equal(idle.contractHtml, '');
  assert.equal('letterHtml' in idle, false);

  const ready = presentPreviewContract({
    offer: { id: 'o1', letterHtml: '<p>Hele tilbudet</p>', acceptance: null },
    name: 'Kari',
    email: 'kari@cafe.no',
    contractHtml: '<article>Avtale</article>',
    alternatives: [{ index: 0, label: 'Tilbud 1' }],
  });
  assert.equal(ready.status, 'ready');
  assert.equal(ready.contractHtml, '<article>Avtale</article>');
  assert.equal(ready.alternatives.length, 1);
  assert.equal('letterHtml' in ready, false);

  const signed = presentPreviewContract({
    offer: { id: 'o1', letterHtml: '<p>Hele tilbudet</p>', acceptance: { acceptedAt: '2026-10-10T10:00:00.000Z' } },
    name: 'Kari',
    email: 'kari@cafe.no',
    contractHtml: '<article>Avtale</article>',
  });
  assert.equal(signed.status, 'signed');
  assert.equal(signed.contractHtml, '');
  assert.equal(signed.acceptedAt, '2026-10-10T10:00:00.000Z');
  assert.equal('letterHtml' in signed, false);
});

test('portal offer for a sales client is the active one', () => {
  assert.equal(offers.getActiveOfferForSalesClient('sales-1'), null);
  const row = offers.upsertPortalOffer({
    salesClientId: 'sales-1',
    salesOfferId: 'offer-a',
    targetEmail: 'kari@cafe.no',
    letterHtml: '<p>brev</p>',
    contractHtml: '<article>en</article>',
  });
  const active = offers.getActiveOfferForSalesClient('sales-1');
  assert.equal(active.id, row.id);
  assert.equal(active.targetEmail, 'kari@cafe.no');
  assert.equal(offers.getActiveOfferForSalesClient('sales-other'), null);
});

test('preview signer creates a client, then accepts; second accept stays signed', async () => {
  const offer = offers.upsertPortalOffer({
    salesClientId: 'sales-sign',
    salesOfferId: 'offer-sign',
    targetEmail: 'kari@cafe.no',
    contractHtml: '<article>Avtale</article>',
  });
  const short = await ensurePreviewSigner({ email: 'kari@cafe.no', password: 'short' });
  assert.equal(short.ok, false);
  assert.equal(short.status, 400);

  const created = await ensurePreviewSigner({
    email: 'kari@cafe.no',
    password: 'hemmelig1',
    name: 'Kari Nord',
  });
  assert.equal(created.ok, true);
  assert.equal(created.user.role, 'client');

  const wrong = await ensurePreviewSigner({ email: 'kari@cafe.no', password: 'feilpassord' });
  assert.equal(wrong.ok, false);
  assert.equal(wrong.status, 401);

  const again = await ensurePreviewSigner({ email: 'kari@cafe.no', password: 'hemmelig1' });
  assert.equal(again.ok, true);
  assert.equal(again.user.id, created.user.id);

  const saved = offers.recordOfferAcceptance(offer.id, {
    userId: created.user.id,
    email: 'kari@cafe.no',
  });
  assert.ok(saved.acceptance.acceptedAt);
  const second = offers.recordOfferAcceptance(offer.id, {
    userId: created.user.id,
    email: 'kari@cafe.no',
  });
  assert.equal(second.acceptance.acceptedAt, saved.acceptance.acceptedAt);
  const presented = presentPreviewContract({
    offer: offers.getActiveOfferForSalesClient('sales-sign'),
    name: 'Kari Nord',
    email: 'kari@cafe.no',
    contractHtml: '<article>Avtale</article>',
  });
  assert.equal(presented.status, 'signed');
  assert.equal(presented.contractHtml, '');
});

test('preview accept is rate-limited per key', () => {
  const key = `test-ip|${Date.now()}`;
  for (let i = 0; i < 8; i += 1) {
    assert.equal(allowPreviewAcceptAttempt(key), true);
  }
  assert.equal(allowPreviewAcceptAttempt(key), false);
  assert.equal(allowPreviewAcceptAttempt(`${key}-other`), true);
});
