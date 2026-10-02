import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.APP_DATA_DIR = mkdtempSync(join(tmpdir(), 'asoldi-workshop-needs-'));

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const {
  evaluateWorkshopNeeds,
  appendHeardFact,
  readWorkshopNeedsClient,
  patchWorkshopNeedLine,
} = await import('../lib/workshop-needs.js');
const {
  gmailQueryForClient,
  extractAttachmentNames,
  extractMessageText,
  presentGmailMessage,
  DAMIAN_GMAIL,
} = await import('../lib/gmail-readonly.js');
const { googleCalendarOauthScopes } = await import('../lib/google-calendar.js');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function emptyBank(overrides = {}) {
  return {
    brandIdentity: { logos: { normal: '', favicon: '' } },
    media: {
      mainHeroImages: [],
      galleryImages: [],
      logos: [],
      icons: [],
      teamImages: [],
      aboutImages: [],
      locationImages: [],
      illustrationImages: [],
      offeringImages: [],
      uncategorized: [],
    },
    products: [],
    productCatalogs: [],
    websiteCreatorQuestions: { websiteDomain: '' },
    openingHours: {
      googleBusinessSyncUrl: '',
      days: [
        { day: 'Mandag', opensAt: '08:00', closesAt: '16:00', closed: false },
        { day: 'Tirsdag', opensAt: '08:00', closesAt: '16:00', closed: false },
        { day: 'Onsdag', opensAt: '08:00', closesAt: '16:00', closed: false },
        { day: 'Torsdag', opensAt: '08:00', closesAt: '16:00', closed: false },
        { day: 'Fredag', opensAt: '08:00', closesAt: '16:00', closed: false },
        { day: 'Lørdag', opensAt: '10:00', closesAt: '14:00', closed: true },
        { day: 'Søndag', opensAt: '10:00', closesAt: '14:00', closed: true },
      ],
    },
    ...overrides,
  };
}

function catalogWithProducts(count) {
  return [{
    layout: 'normal',
    label: 'Produkter',
    categories: [{
      name: 'Katalog',
      products: Array.from({ length: count }, (_, index) => ({
        title: `Vare ${index + 1}`,
        price: '100',
      })),
    }],
  }];
}

function baseClient(overrides = {}) {
  return {
    id: 'client-1',
    businessName: 'Test Bakeri',
    contactEmail: 'seller@asoldi.com',
    clientEmail: 'kunde@example.no',
    websiteDomain: '',
    notes: '',
    meetingAt: '',
    meetingMode: '',
    portalUserId: '',
    makerRun: {},
    meetings: [],
    myphoner: {},
    progression: {},
    reminders: {},
    details: {
      meetingQuote: {
        tierId: 'starter',
        pages: 5,
        selected: ['hosting'],
        oneTimeAddOns: [],
        customSections: '',
        startDate: '',
        productNotes: '',
        productGoal: '',
      },
    },
    ...overrides,
  };
}

function byId(result, id) {
  return (result.lines || []).find((line) => line.id === id);
}

function openNeeds(result) {
  return (result.lines || []).filter((line) => line.bucket === 'need' && line.status === 'open');
}

test('gmail.readonly is added beside the existing calendar scopes', () => {
  const scopes = googleCalendarOauthScopes();
  assert.equal(scopes.includes('https://www.googleapis.com/auth/calendar.events'), true);
  assert.equal(scopes.includes('https://www.googleapis.com/auth/calendar.readonly'), true);
  assert.equal(scopes.includes('https://www.googleapis.com/auth/calendar.acls'), true);
  assert.equal(scopes.includes('https://www.googleapis.com/auth/gmail.readonly'), true);
});

test('Gmail query uses only the portal clientEmail and lists attachment names without downloading', () => {
  assert.equal(DAMIAN_GMAIL, 'damian@asoldi.com');
  assert.equal(gmailQueryForClient(''), '');
  assert.equal(gmailQueryForClient('Kunde@Example.NO'), 'from:kunde@example.no');
  const names = extractAttachmentNames({
    filename: '',
    parts: [
      { filename: 'logo.png', body: { attachmentId: 'att-1' } },
      { filename: '', parts: [{ filename: 'meny.pdf', body: { attachmentId: 'att-2' } }] },
    ],
  });
  assert.deepEqual(names, ['logo.png', 'meny.pdf']);
  const src = readFileSync(join(root, 'lib/gmail-readonly.js'), 'utf8');
  assert.equal(src.includes('attachments.get'), false);
  assert.equal(src.includes('attachments.list'), false);
});

test('Gmail message text prefers plain body over snippet', () => {
  const text = extractMessageText({
    mimeType: 'text/plain',
    body: { data: Buffer.from('Her er logoet vårt', 'utf8').toString('base64url') },
  }, 'snippet only');
  assert.equal(text, 'Her er logoet vårt');
  const presented = presentGmailMessage({
    id: 'm1',
    internalDate: '1710000000000',
    snippet: 'ignore',
    payload: {
      headers: [
        { name: 'Subject', value: 'Logo' },
        { name: 'From', value: 'kunde@example.no' },
      ],
      filename: 'logo.png',
      mimeType: 'text/plain',
      body: { data: Buffer.from('Her er logoet vårt', 'utf8').toString('base64url') },
    },
  });
  assert.equal(presented.attachmentNames.includes('logo.png'), true);
  assert.match(presented.text, /logoet/);
});

test('empty clientEmail skips Gmail instead of searching contactEmail', () => {
  const result = evaluateWorkshopNeeds({
    client: baseClient({ clientEmail: '', contactEmail: 'seller@asoldi.com' }),
    bank: emptyBank(),
    gmail: { skipped: true, reason: 'no-client-email', messages: [] },
  });
  assert.ok(byId(result, 'unknown.client-email'));
  assert.equal(byId(result, 'unknown.gmail'), undefined);
});

test('logo empty is a need; favicon alone does not count', () => {
  const bank = emptyBank({
    brandIdentity: { logos: { normal: '', favicon: '/client-media/favicon.ico' } },
    media: { ...emptyBank().media, logos: ['', ''] },
  });
  const snapshot = clone(bank);
  const result = evaluateWorkshopNeeds({ client: baseClient(), bank });
  const logoNeed = byId(result, 'need.logo');
  assert.equal(logoNeed?.bucket, 'need');
  assert.equal(logoNeed?.status, 'open');
  assert.equal(result.materials.logo, false);
  assert.deepEqual(bank, snapshot);
});

test('logo set is not a need and the bank is unchanged', () => {
  const bank = emptyBank({
    brandIdentity: { logos: { normal: '/client-media/logo.png', favicon: '' } },
  });
  const snapshot = clone(bank);
  const result = evaluateWorkshopNeeds({ client: baseClient(), bank });
  assert.equal(byId(result, 'need.logo'), undefined);
  assert.equal(byId(result, 'have.logo')?.bucket, 'have');
  assert.equal(result.materials.logo, true);
  assert.equal(openNeeds(result).some((line) => line.id === 'need.logo'), false);
  assert.deepEqual(bank, snapshot);
});

test('meeting time is activity and already have, never a need', () => {
  const result = evaluateWorkshopNeeds({
    client: baseClient({
      meetingAt: '2026-10-01T08:00:00.000Z',
      meetingMode: 'online',
      progression: { meetingHeld: true },
    }),
    bank: emptyBank(),
  });
  assert.equal(byId(result, 'activity.sales-meeting')?.bucket, 'activity');
  assert.equal(byId(result, 'have.meeting-time')?.bucket, 'have');
  assert.equal(byId(result, 'have.meeting-mode')?.detail, 'Online');
  assert.equal((result.lines || []).some((line) => (
    line.bucket === 'need' && /møtetid|meeting-time|meetingAt/i.test(`${line.id} ${line.title}`)
  )), false);
});

test('0 products on a catalog offer is a need; brochure with 0 products is not', () => {
  const bank = emptyBank();
  const catalog = evaluateWorkshopNeeds({
    client: baseClient({
      details: { meetingQuote: { selected: ['ecom'], productNotes: 'katalog', productGoal: '', customSections: '' } },
    }),
    bank,
  });
  assert.equal(catalog.counts.products, 0);
  assert.equal(byId(catalog, 'need.products')?.status, 'open');

  const brochure = evaluateWorkshopNeeds({
    client: baseClient({
      details: { meetingQuote: { selected: ['hosting'], productNotes: '', productGoal: '', customSections: '' } },
    }),
    bank,
  });
  assert.equal(brochure.counts.products, 0);
  assert.equal(byId(brochure, 'need.products'), undefined);
});

test('12 products is a count only, even on a catalog offer', () => {
  const bank = emptyBank({ productCatalogs: catalogWithProducts(12) });
  const result = evaluateWorkshopNeeds({
    client: baseClient({
      details: { meetingQuote: { selected: ['ecom'], productNotes: 'meny', productGoal: '', customSections: '' } },
    }),
    bank,
  });
  assert.equal(result.counts.products, 12);
  assert.equal(byId(result, 'have.product-count')?.detail, '12');
  assert.equal(byId(result, 'need.products'), undefined);
});

test('domain set only on Maker is not a need; sales websiteDomain does not fill it', () => {
  const bank = emptyBank();
  const makerOnly = evaluateWorkshopNeeds({
    client: baseClient({ websiteDomain: 'ignore-sales.no' }),
    bank,
    maker: { run: { metadata: { productionDomain: 'bakeri.no' }, answers: { websiteDomain: '' } } },
  });
  assert.equal(makerOnly.materials.domain, true);
  assert.equal(byId(makerOnly, 'need.domain'), undefined);
  assert.match(byId(makerOnly, 'have.domain')?.detail || '', /bakeri\.no/);

  const salesOnly = evaluateWorkshopNeeds({
    client: baseClient({ websiteDomain: 'sales-only.no' }),
    bank: emptyBank(),
    maker: {},
  });
  assert.equal(salesOnly.materials.domain, false);
  assert.equal(byId(salesOnly, 'need.domain')?.status, 'open');
});

test('transcript hours become heard, not saved, and the bank fixture is unchanged', () => {
  const bank = emptyBank();
  const snapshot = clone(bank);
  const result = evaluateWorkshopNeeds({
    client: baseClient(),
    bank,
    transcripts: [{ source: 'transcript', text: 'Vi har åpent mandag til fredag kl. 10-20.' }],
  });
  const heard = byId(result, 'heard.hours');
  assert.equal(heard?.bucket, 'heard');
  assert.match(heard?.quote || '', /åpent/i);
  assert.equal(byId(result, 'need.hours'), undefined);
  assert.deepEqual(bank, snapshot);
  assert.equal(bank.openingHours.days[0].opensAt, '08:00');
});

test('Gmail evidence marks a gap received without media or bank writes', () => {
  const bank = emptyBank();
  const snapshot = clone(bank);
  const result = evaluateWorkshopNeeds({
    client: baseClient(),
    bank,
    gmail: {
      skipped: false,
      messages: [{
        id: 'msg-1',
        mailAt: '2026-10-01T09:00:00.000Z',
        subject: 'Logo',
        text: 'Her er logoet vårt som avtalt.',
        attachmentNames: ['logo.png'],
      }],
    },
  });
  const logo = byId(result, 'need.logo');
  assert.equal(logo?.status, 'received');
  assert.deepEqual(logo?.attachmentNames, ['logo.png']);
  assert.match(logo?.quote || '', /logoet/i);
  assert.equal(logo?.mailAt, '2026-10-01T09:00:00.000Z');
  assert.deepEqual(bank, snapshot);
  assert.equal(result.counts.media, 0);
  assert.equal(result.materials.logo, false);
});

test('appendHeardFact writes the sidecar only', () => {
  const bank = emptyBank({ brandIdentity: { logos: { normal: '/x.png', favicon: '' } } });
  const snapshot = clone(bank);
  const stored = appendHeardFact('heard-client', {
    id: 'hours-extra',
    title: 'Allergi-meny nevnt',
    detail: 'I workshop-notat',
    quote: 'De sa de har allergimeny',
  });
  assert.equal(stored.id, 'heard.hours-extra');
  const record = readWorkshopNeedsClient('heard-client');
  assert.equal(record.heardFacts.some((row) => row.id === 'heard.hours-extra'), true);
  assert.deepEqual(bank, snapshot);
  const sidecarPath = join(process.env.APP_DATA_DIR, 'workshop-needs.json');
  assert.equal(existsSync(sidecarPath), true);
  const raw = JSON.parse(readFileSync(sidecarPath, 'utf8'));
  assert.equal(raw.clients['heard-client'].heardFacts[0].title, 'Allergi-meny nevnt');
});

test('admin wording and check survive a later refresh', () => {
  patchWorkshopNeedLine('check-client', { lineId: 'need.logo', checked: true, wording: 'Send logo i PNG' });
  const result = evaluateWorkshopNeeds({
    client: baseClient({ id: 'check-client' }),
    bank: emptyBank(),
    sidecar: readWorkshopNeedsClient('check-client'),
  });
  const logo = byId(result, 'need.logo');
  assert.equal(logo?.title, 'Send logo i PNG');
  assert.equal(logo?.status, 'checked');
});

test('booking is only client.workshopAction', () => {
  const booked = evaluateWorkshopNeeds({
    client: baseClient({
      workshopAction: { name: 'Workshop', format: 'mote', dueAt: '2026-10-08T08:00:00.000Z' },
    }),
    bank: emptyBank(),
  });
  assert.ok(byId(booked, 'activity.workshop-booked'));
  assert.ok(byId(booked, 'have.workshop-time'));

  const decoys = evaluateWorkshopNeeds({
    client: baseClient({
      details: { workshopAction: { name: 'Workshop', format: 'mote', dueAt: '2026-10-08T08:00:00.000Z' } },
      workshop: { action: { name: 'Workshop', format: 'mote', dueAt: '2026-10-08T08:00:00.000Z' } },
    }),
    bank: emptyBank(),
  });
  assert.equal(byId(decoys, 'activity.workshop-booked'), undefined);
});

test('Maker uploads are a count and do not stop a Kundedata media ask', () => {
  const result = evaluateWorkshopNeeds({
    client: baseClient({
      details: { meetingQuote: { selected: ['ecom'], productNotes: 'galleri og meny', productGoal: '', customSections: '' } },
    }),
    bank: emptyBank(),
    maker: { run: { uploads: { heroImages: ['a.jpg', 'b.jpg'], logo: ['logo.png'] } } },
  });
  assert.equal(result.counts.media, 0);
  assert.equal(result.counts.makerUploads, 3);
  assert.equal(byId(result, 'need.media')?.status, 'open');
  assert.equal(byId(result, 'have.maker-uploads')?.detail, '3');
});

test('need-list files never write Kundedata, Maker, hub media, or other booking paths', () => {
  const needsSrc = readFileSync(join(root, 'lib/workshop-needs.js'), 'utf8');
  const gmailSrc = readFileSync(join(root, 'lib/gmail-readonly.js'), 'utf8');
  const panelSrc = readFileSync(join(root, 'app/pages/Admin/sections/WorkshopNeedsPanel.tsx'), 'utf8');
  for (const src of [needsSrc, gmailSrc, panelSrc]) {
    assert.equal(src.includes('setClientDataBank'), false);
    assert.equal(src.includes('hub-media-library'), false);
    assert.equal(src.includes('saveClientUploadBuffer'), false);
    assert.equal(src.includes('updateRunUploads'), false);
    assert.equal(src.includes('details.workshopAction'), false);
    assert.equal(src.includes('workshop.action'), false);
  }
  const salesSrc = readFileSync(join(root, 'app/pages/Admin/sections/SalesClientsSection.tsx'), 'utf8');
  const devSrc = readFileSync(join(root, 'app/pages/Admin/sections/DevelopmentClientsSection.tsx'), 'utf8');
  const manageSrc = readFileSync(join(root, 'app/pages/Admin/sections/ManageClientsSection.tsx'), 'utf8');
  const adminSrc = readFileSync(join(root, 'app/pages/Admin/sections/AdminBoardSection.tsx'), 'utf8');
  assert.equal(salesSrc.includes('WorkshopNeedsPanel'), false);
  assert.equal(devSrc.includes('WorkshopNeedsPanel'), false);
  assert.equal(manageSrc.includes('WorkshopNeedsPanel'), false);
  assert.equal(adminSrc.includes('WorkshopNeedsPanel'), false);
});
