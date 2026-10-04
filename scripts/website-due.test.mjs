import assert from 'node:assert/strict';
import test from 'node:test';
import {
  contractDeliverySentence,
  deliveryWeeksForOffer,
  offerDeliveryPhraseNb,
  resolveWebsiteDue,
  weeksForDeveloperBoard,
} from '../lib/website-due.js';

test('tier weeks stay 2, 2 and 3, and custom with no count is 4 weeks', () => {
  assert.equal(deliveryWeeksForOffer({ tierId: 'tier-1-standard' }), 2);
  assert.equal(deliveryWeeksForOffer({ tierId: 'tier-2-seo' }), 2);
  assert.equal(deliveryWeeksForOffer({ tierId: 'tier-3-ecommerce' }), 3);
  assert.equal(deliveryWeeksForOffer({ tierId: 'custom' }), 4);
  assert.equal(deliveryWeeksForOffer({
    tierId: 'custom',
    products: [{ kind: 'custom', deliveryWeeks: 6 }],
  }), 6);
});

test('the developer board does not start a 4-week clock for a custom offer', () => {
  assert.equal(weeksForDeveloperBoard({ tierId: 'tier-1-standard' }), 2);
  assert.equal(weeksForDeveloperBoard({ tierId: 'tier-2-seo' }), 2);
  assert.equal(weeksForDeveloperBoard({ tierId: 'tier-3-ecommerce' }), 3);
  assert.equal(weeksForDeveloperBoard({ tierId: 'custom' }), 0);
  assert.equal(weeksForDeveloperBoard({ tierId: 'custom', dueOverride: '2026-11-02' }), 4);
  assert.equal(deliveryWeeksForOffer({ tierId: 'custom' }), 4);
});

test('the clock starts at the signed contract, and an admin date replaces the tier weeks', () => {
  const waiting = resolveWebsiteDue({
    contractSigned: false,
    weeks: 2,
  });
  assert.equal(waiting.started, false);
  assert.equal(waiting.dueAt, '');
  assert.equal(waiting.label, 'Frist: 2 uker fra signert kontrakt');

  const started = resolveWebsiteDue({
    contractSigned: true,
    contractSignedAt: '2026-10-01T08:00:00.000Z',
    weeks: 2,
  });
  assert.equal(started.started, true);
  assert.equal(started.dueAt.slice(0, 10), '2026-10-15');
  assert.match(started.label, /15\. okt\. 2026/);

  const custom = resolveWebsiteDue({
    contractSigned: true,
    contractSignedAt: '2026-10-01T08:00:00.000Z',
    dueOverride: '2026-11-02',
    weeks: 2,
  });
  assert.equal(custom.dueAt.slice(0, 10), '2026-11-02');
  assert.equal(custom.override, true);
});

test('offer and contract mention the date or the weeks from the signed contract', () => {
  assert.equal(
    offerDeliveryPhraseNb({ tierId: 'tier-3-ecommerce' }),
    '3 uker fra signert kontrakt',
  );
  assert.match(offerDeliveryPhraseNb({ dueDate: '2026-11-02', tierId: 'tier-1-standard' }), /2\. nov\. 2026/);
  assert.equal(
    contractDeliverySentence({ weeks: 2 }),
    'Delivery time: 2 weeks from the signed contract.',
  );
  assert.equal(
    contractDeliverySentence({ dueDate: '2026-11-02' }),
    'Delivery date: 2 November 2026.',
  );
});
