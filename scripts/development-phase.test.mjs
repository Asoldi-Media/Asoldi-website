import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDevelopmentItems,
  buildDeveloperBoardItems,
  buildPreviewItems,
  buildSsuBoardItems,
  isSsuBoardClient,
  isLiveHubClient,
  isDevelopmentSalesClient,
  isDeveloperBoardClient,
  isPreviewSalesClient,
  previewTimelineAt,
  resolveSiteDeliveryPhase,
} from '../lib/development-phase.js';

const mong = {
  id: '1',
  site_key: 'mong-key',
  name: 'Mong Sushi',
  domain: 'mongsushi.no',
};

const neo = {
  id: '2',
  site_key: 'neo-key',
  name: 'NEOmål',
  domain: '',
};

const byneset = {
  id: '3',
  site_key: 'byneset-key',
  name: 'Byneset Bydelskafe',
  domain: 'bynesetbydelskafe.no',
};

const bynesetSales = {
  id: 'sales-byneset',
  product: 'asoldi',
  status: 'active',
  businessName: 'Byneset Bydelskafe',
  websiteDomain: 'bynesetbydelskafe.no',
  progression: { contractSigned: true },
  development: { nettsideFerdig: false },
  hubSite: { siteKey: 'byneset-key', id: '3', domain: 'bynesetbydelskafe.no' },
};

test('Byneset leaves Clients and appears in Development when contract is signed', () => {
  const sales = [bynesetSales];
  const sites = [mong, neo, byneset];
  assert.equal(resolveSiteDeliveryPhase(byneset, sales), 'development');
  assert.equal(isLiveHubClient(byneset, sales), false);
  assert.equal(isLiveHubClient(mong, sales), true);
  assert.equal(isLiveHubClient(neo, sales), true);

  const items = buildDevelopmentItems(sales, sites);
  assert.equal(items.length, 1);
  assert.equal(items[0].businessName, 'Byneset Bydelskafe');
  assert.equal(items[0].id, 'sales:sales-byneset');
});

test('Byneset hub site still appears in Development without a sales row', () => {
  const items = buildDevelopmentItems([], [mong, byneset]);
  assert.equal(items.length, 1);
  assert.equal(items[0].id, 'site:3');
  assert.equal(isLiveHubClient(byneset, []), false);
});

test('finished website leaves Development and returns to Clients', () => {
  const finished = {
    ...bynesetSales,
    development: { nettsideFerdig: true },
  };
  const site = {
    ...byneset,
    development: { nettsideFerdig: true },
  };
  assert.equal(isDevelopmentSalesClient(finished), false);
  assert.equal(resolveSiteDeliveryPhase(site, [finished]), 'client');
  assert.equal(buildDevelopmentItems([finished], [site]).length, 0);
});

test('unsigned contract stays in sales and does not create a development card', () => {
  const unsigned = {
    ...bynesetSales,
    businessName: 'New Cafe',
    progression: { contractSigned: false },
    hubSite: {},
  };
  assert.equal(isDevelopmentSalesClient(unsigned), false);
  assert.equal(buildDevelopmentItems([unsigned], [mong]).length, 0);
});

test('unsigned active asoldi client appears on the preview board', () => {
  const unsigned = {
    ...bynesetSales,
    id: 'sales-preview',
    businessName: 'New Cafe',
    status: 'active',
    progression: { contractSigned: false },
    development: { nettsideFerdig: false },
    hubSite: {},
  };
  assert.equal(isPreviewSalesClient(unsigned), true);
  const preview = buildPreviewItems([unsigned], [mong]);
  assert.equal(preview.length, 1);
  assert.equal(preview[0].businessName, 'New Cafe');
  assert.equal(buildDevelopmentItems([unsigned], [mong]).length, 0);
});

test('signed client leaves preview and stays on deployment', () => {
  assert.equal(isPreviewSalesClient(bynesetSales), false);
  assert.equal(buildPreviewItems([bynesetSales], [byneset]).length, 0);
  assert.equal(buildDevelopmentItems([bynesetSales], [byneset]).length, 1);
});

test('preview board ranks by next meeting, not website due date', () => {
  const later = {
    ...bynesetSales,
    id: 'sales-later',
    businessName: 'Zeta Cafe',
    status: 'active',
    agreedTime: true,
    meetingAt: '2026-10-20T10:00:00.000Z',
    progression: { contractSigned: false },
    development: { nettsideFerdig: false },
    hubSite: {},
    nextActions: [{ name: 'Møte', dueAt: '2026-10-20T10:00:00.000Z', presetKey: 'meeting', doneAt: '' }],
  };
  const sooner = {
    ...later,
    id: 'sales-sooner',
    businessName: 'Alpha Cafe',
    meetingAt: '2026-10-05T10:00:00.000Z',
    nextActions: [{ name: 'Møte', dueAt: '2026-10-05T10:00:00.000Z', presetKey: 'meeting', doneAt: '' }],
  };
  const preview = buildPreviewItems([later, sooner], []);
  assert.equal(preview.map((item) => item.businessName).join(','), 'Alpha Cafe,Zeta Cafe');
  assert.ok(Date.parse(preview[0].rankAt) < Date.parse(preview[1].rankAt));
  assert.equal(preview[0].websiteDue?.dueAt || '', '');
  assert.equal(buildDevelopmentItems([later, sooner], []).length, 0);
});

test('SSU and archived clients stay off the preview board', () => {
  const ssu = { ...bynesetSales, product: 'ssu', progression: { contractSigned: false } };
  const archived = { ...bynesetSales, status: 'not-sold', progression: { contractSigned: false } };
  assert.equal(isPreviewSalesClient(ssu), false);
  assert.equal(isPreviewSalesClient(archived), false);
  assert.equal(buildPreviewItems([ssu, archived], []).length, 0);
});

test('developer board merges unsigned preview clients and signed contracts', () => {
  const unsigned = {
    ...bynesetSales,
    id: 'sales-preview',
    businessName: 'New Cafe',
    status: 'active',
    progression: { contractSigned: false },
    hubSite: {},
  };
  assert.equal(isDeveloperBoardClient(unsigned), true);
  assert.equal(isDeveloperBoardClient(bynesetSales), true);
  const board = buildDeveloperBoardItems([unsigned, bynesetSales], [byneset]);
  assert.equal(board.length, 2);
  assert.equal(board.some((item) => item.businessName === 'New Cafe'), true);
  assert.equal(board.some((item) => item.businessName === 'Byneset Bydelskafe'), true);
  assert.equal(board.every((item) => item.developerGoals && item.developerGoals.readyForPreview === false), true);
  assert.equal(buildPreviewItems([unsigned, bynesetSales], [byneset]).some((item) => item.businessName === 'Byneset Bydelskafe'), false);
  assert.equal(buildDevelopmentItems([unsigned, bynesetSales], [byneset]).some((item) => item.businessName === 'New Cafe'), false);
});

test('preview rank is the sales meeting clock, and Klar for preview clears it', () => {
  const reminderFirst = {
    ...bynesetSales,
    id: 'sales-reminder',
    businessName: 'Reminder Cafe',
    status: 'active',
    agreedTime: true,
    meetingAt: '2026-10-20T10:00:00.000Z',
    progression: { contractSigned: false },
    development: { nettsideFerdig: false },
    hubSite: {},
    nextActions: [{ name: 'SMS', dueAt: '2026-10-05T08:00:00.000Z', presetKey: 'sms', doneAt: '' }],
  };
  assert.equal(previewTimelineAt(reminderFirst), '2026-10-20T10:00:00.000Z');
  const ranked = buildPreviewItems([reminderFirst], []);
  assert.equal(ranked[0].rankAt, '2026-10-20T10:00:00.000Z');
  const ready = {
    ...reminderFirst,
    developerGoals: { readyForPreview: true },
  };
  assert.equal(previewTimelineAt(ready), '');
  assert.equal(buildPreviewItems([ready], [])[0].rankAt, '');
  assert.equal(buildDevelopmentItems([ready], []).length, 0);
});

test('a signed client ranks by tier weeks, and a custom offer without a date has no countdown', () => {
  const tier2 = {
    ...bynesetSales,
    id: 'sales-tier2',
    businessName: 'Tier Cafe',
    contractSignedAt: '2026-10-01T08:00:00.000Z',
    websiteDeliveryWeeks: 2,
    meetingAt: '2026-09-01T10:00:00.000Z',
    agreedTime: true,
  };
  const tierItem = buildDevelopmentItems([tier2], [])[0];
  assert.equal(tierItem.rankAt.slice(0, 10), '2026-10-21');
  assert.equal(tierItem.meetingAt, '2026-09-01T10:00:00.000Z');
  const custom = {
    ...bynesetSales,
    id: 'sales-custom',
    businessName: 'Custom Cafe',
    contractSignedAt: '2026-10-01T08:00:00.000Z',
    websiteDeliveryWeeks: 0,
    offerCustom: true,
    offerTierId: 'custom',
  };
  const customItem = buildDevelopmentItems([custom], [])[0];
  assert.equal(customItem.rankAt, '');
  assert.match(customItem.websiteDue.label, /sett leveringsfrist/);
  assert.equal(customItem.offerCustom, true);
  assert.equal(buildPreviewItems([tier2, custom], []).length, 0);
});

test('an admin due date ranks a signed client even when the offer has no weeks', () => {
  const referral = {
    ...bynesetSales,
    id: 'sales-referral',
    businessName: 'Referral Cafe',
    contractSignedAt: '2026-10-01T08:00:00.000Z',
    websiteDeliveryWeeks: 0,
    websiteDueOverride: '2026-10-20',
  };
  const item = buildDevelopmentItems([referral], [])[0];
  assert.equal(item.rankAt.slice(0, 10), '2026-10-20');
  assert.equal(item.websiteDue.override, true);
  assert.equal(item.websiteDue.started, true);
});

test('a hub site without a sales row uses the site due date', () => {
  const site = {
    ...byneset,
    deliveryPhase: 'development',
    websiteDueOverride: '2026-11-02',
  };
  const items = buildDevelopmentItems([], [site]);
  assert.equal(items.length, 1);
  assert.equal(items[0].websiteDue.dueAt.slice(0, 10), '2026-11-02');
  assert.equal(items[0].websiteDue.started, true);
});

test('SSU clients stay off the website board and keep their own count list', () => {
  const ssu = {
    id: 'sales-ssu',
    product: 'ssu',
    status: 'active',
    businessName: 'SSU Arkitekt',
    industry: 'Arkitekt',
    createdAt: '2026-09-02T10:00:00.000Z',
    progression: { contractSigned: false },
  };
  const dropped = { ...ssu, id: 'sales-ssu-lost', status: 'not-sold' };
  assert.equal(isSsuBoardClient(ssu), true);
  assert.equal(isSsuBoardClient(dropped), false);
  assert.equal(isSsuBoardClient(bynesetSales), false);
  assert.equal(buildDevelopmentItems([ssu, bynesetSales], []).some((item) => item.businessName === 'SSU Arkitekt'), false);
  assert.equal(buildPreviewItems([ssu], []).length, 0);
  const ssuItems = buildSsuBoardItems([ssu, dropped, bynesetSales], []);
  assert.equal(ssuItems.length, 1);
  assert.equal(ssuItems[0].product, 'ssu');
  assert.equal(ssuItems[0].industry, 'Arkitekt');
  assert.equal(ssuItems[0].createdAt, '2026-09-02T10:00:00.000Z');
  const website = buildDevelopmentItems([bynesetSales], []);
  assert.equal(website[0].product, 'asoldi');
});
