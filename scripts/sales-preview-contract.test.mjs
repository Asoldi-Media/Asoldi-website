import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const dataDir = mkdtempSync(join(tmpdir(), 'asoldi-preview-contract-'));
process.env.APP_DATA_DIR = dataDir;

const offers = await import('../data/offers.js');
const { allowPreviewAcceptAttempt, ensurePreviewSigner, presentPreviewContract, previewSignAgreementsOk } = await import('../lib/sales-preview-contract.js');

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

test('sent preview contract button shows Signer kontrakt without a hover', () => {
  const src = readFileSync(new URL('../public/sales-preview-contract.js', import.meta.url), 'utf8');
  assert.match(src, /\.btn\[data-status="ready"\] \{[^}]*min-width:\s*188px/);
  assert.match(src, /\.btn\[data-status="ready"\] \.btn-label \{[^}]*opacity:\s*1/);
  assert.doesNotMatch(src, /\.btn\[data-status="ready"\]:hover \.btn-label/);
});

test('contract overlay scrolls inside the popup instead of the site behind', () => {
  const src = readFileSync(new URL('../public/sales-preview-contract.js', import.meta.url), 'utf8');
  assert.match(src, /<dialog class="overlay"/);
  assert.match(src, /dialog\.overlay:modal/);
  assert.match(src, /\.panel \{[\s\S]*?min-height:\s*0/);
  assert.match(src, /\.panel \{[\s\S]*?max-height:\s*min\(92dvh/);
  assert.match(src, /\.scroller \{[\s\S]*?overflow-y:\s*auto/);
  assert.match(src, /\.scroller \{[\s\S]*?overscroll-behavior:\s*contain/);
  assert.match(src, /\.overlay \{[\s\S]*?overscroll-behavior:\s*none/);
  assert.match(src, /showModal/);
  assert.match(src, /data-lenis-prevent/);
  assert.match(src, /lockPageScroll/);
  assert.match(src, /overflow = 'hidden'/);
  assert.match(src, /trapWheel/);
  assert.match(src, /applyDelta\(scroller,/);
  assert.doesNotMatch(src, /scrollableForEvent/);
  assert.match(src, /preventDefault\(\)/);
  assert.match(src, /lenis\?\.stop/);
});

test('contract popup can download the PDF and requires terms plus 6-month binding', () => {
  const src = readFileSync(new URL('../public/sales-preview-contract.js', import.meta.url), 'utf8');
  assert.match(src, /Last ned PDF/);
  assert.match(src, /\.pdf\?download=1/);
  assert.match(src, /name="terms"/);
  assert.match(src, /name="binding"/);
  assert.match(src, /asoldi\.com\/vilkar/);
  assert.match(src, /bindingstid/);
  assert.match(src, /termsAccepted/);
  assert.match(src, /bindingAccepted/);
  assert.equal(previewSignAgreementsOk({ termsAccepted: true, bindingAccepted: true }), true);
  assert.equal(previewSignAgreementsOk({ termsAccepted: true }), false);
  assert.equal(previewSignAgreementsOk({ accepted: true }), false);
});

test('kontrakt link opens the contract, docks into the sign button, and explains the Asoldi password', () => {
  const src = readFileSync(new URL('../public/sales-preview-contract.js', import.meta.url), 'utf8');
  assert.match(src, /wantsContractOpen/);
  assert.match(src, /params\.get\('kontrakt'\)/);
  assert.match(src, /fromContractLink && state\.status === 'ready'/);
  assert.match(src, /dockIntoButton/);
  assert.match(src, /data-call/);
  assert.match(src, /asoldi-orbit/);
  assert.match(src, /@property --asoldi-orbit/);
  assert.doesNotMatch(src, /asoldi-orbit[^}]*rotate\(360deg\)/);
  assert.match(src, /account-note/);
  assert.match(src, /Nytt Asoldi-passord/);
  assert.match(src, /read-note/);
  assert.match(src, />Signer</);
});

test('preview accept is rate-limited per key', () => {
  const key = `test-ip|${Date.now()}`;
  for (let i = 0; i < 8; i += 1) {
    assert.equal(allowPreviewAcceptAttempt(key), true);
  }
  assert.equal(allowPreviewAcceptAttempt(key), false);
  assert.equal(allowPreviewAcceptAttempt(`${key}-other`), true);
});
