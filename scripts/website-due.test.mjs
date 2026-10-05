import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  contractDeliverySentence,
  deliveryWeeksForOffer,
  dueDateDay,
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

test('an admin date starts the clock even without a signed contract', () => {
  const referral = resolveWebsiteDue({
    contractSigned: false,
    dueOverride: '2026-10-20',
    weeks: 0,
  });
  assert.equal(referral.started, true);
  assert.equal(referral.override, true);
  assert.equal(referral.dueAt.slice(0, 10), '2026-10-20');
  assert.match(referral.label, /20\. okt\. 2026/);
  assert.doesNotMatch(referral.label, /Planlagt/);
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

test('the date picker uses the effective developer deadline, not only a stored override', () => {
  const signedTier1 = resolveWebsiteDue({
    contractSigned: true,
    contractSignedAt: '2026-10-01T08:00:00.000Z',
    weeks: weeksForDeveloperBoard({ tierId: 'tier-1-standard' }),
  });
  assert.equal(dueDateDay(signedTier1.dueAt), '2026-10-15');
  assert.equal(signedTier1.override, false);

  const overridden = resolveWebsiteDue({
    contractSigned: true,
    contractSignedAt: '2026-10-01T08:00:00.000Z',
    dueOverride: '2026-11-02',
    weeks: weeksForDeveloperBoard({ tierId: 'tier-1-standard', dueOverride: '2026-11-02' }),
  });
  assert.equal(dueDateDay(overridden.dueAt), '2026-11-02');
  assert.equal(overridden.override, true);

  const custom = resolveWebsiteDue({
    contractSigned: true,
    contractSignedAt: '2026-10-01T08:00:00.000Z',
    weeks: weeksForDeveloperBoard({ tierId: 'custom' }),
  });
  assert.equal(dueDateDay(custom.dueAt), '');
  assert.equal(custom.started, false);
});

test('admin client cards can edit the website due date for any client', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const adminBoard = readFileSync(join(root, 'app/pages/Admin/sections/AdminBoardSection.tsx'), 'utf8');
  const clients = readFileSync(join(root, 'app/pages/Admin/sections/ClientSitesSection.tsx'), 'utf8');
  const developer = readFileSync(join(root, 'app/pages/developer/DeveloperClientCard.tsx'), 'utf8');
  const field = readFileSync(join(root, 'app/pages/Admin/sections/WebsiteDueField.tsx'), 'utf8');
  const inbox = readFileSync(join(root, 'app/pages/Admin/sections/AdminRequestInbox.tsx'), 'utf8');
  assert.match(adminBoard, /WebsiteDueField/);
  assert.match(clients, /WebsiteDueField/);
  assert.match(developer, /WebsiteDueField/);
  assert.match(developer, /isAdmin && \(salesClientId \|\| item\.siteId\)/);
  assert.doesNotMatch(developer, /item\.offerCustom \?/);
  assert.match(field, /siteId/);
  assert.match(field, /variant/);
  assert.match(field, /effectiveDate/);
  assert.match(field, /setDate\(next\.effectiveDate\)/);
  assert.match(field, /date === effectiveDate/);
  assert.match(field, /view\?\.override \?/);
  assert.doesNotMatch(field, /date === String\(view\?\.dueDate/);
  assert.doesNotMatch(inbox, /WebsiteDueField/);
  const server = readFileSync(join(root, 'server.js'), 'utf8');
  assert.match(server, /\/api\/hub\/sites\/:id\/website-due/);
  assert.match(server, /persistWebsiteDue/);
  assert.match(server, /function websiteDueView[\s\S]*weeksForDeveloperBoard/);
  assert.match(server, /effectiveDate: dueDateDay\(due\.dueAt\)/);
  assert.match(server, /override: Boolean\(due\.override\)/);
  assert.match(server, /phrase: offerDeliveryPhraseNb/);
  assert.doesNotMatch(adminBoard, /onSaved=\{\(\) => onClient\(client\)\}/);
});
