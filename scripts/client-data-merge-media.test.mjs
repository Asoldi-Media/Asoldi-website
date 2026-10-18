import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import AdmZip from 'adm-zip';

process.env.APP_DATA_DIR = mkdtempSync(join(tmpdir(), 'asoldi-merge-media-'));
delete process.env.DEEPSEEK_API_KEY;
delete process.env.GEMINI_API_KEY;

const clientPortal = await import('../data/client-portal.js');
const { applyNoteToBank, filledFieldKeys, normalizeNote } = await import('../lib/ai-assistant/gather.js');
const { parseOpeningHoursAnswer } = await import('../lib/ai-assistant/intake.js');
const { expandContainerFiles } = await import('../lib/ai-assistant/unpack-files.js');
const { extractIngestText } = await import('../lib/ai-assistant/products-ingest.js');
const { partitionAssistantFiles } = await import('../lib/ai-assistant/source-kind.js');
const { normalizePortalTranscript, placementFromTranscript, transcribeClientMedia } = await import('../lib/ai-assistant/media-transcript.js');
const { categorizeClientUpload, persistMediaFiles } = await import('../lib/ai-assistant/service.js');

const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 1, 2, 3]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function seedBank() {
  return {
    websiteCreatorQuestions: { businessWhat: 'Vi baker brød.', businessStory: 'Familiebedrift.', reviews: '"Best i byen" – Kari' },
    generalInfo: { companyPhone: '55 12 34 56', companyAddress: 'Gamleveien 1' },
    staff: [{ name: 'Ola Nordmann', title: 'Baker', phone: '', email: '' }],
    affiliations: [{ categoryName: 'Leverandører', items: [{ title: 'Mølla' }, { title: 'Tine' }] }],
    openingHours: { status: 'set', days: parseOpeningHoursAnswer('mandag til lørdag 9-17, søndag stengt').days },
    productCatalogs: [{ layout: 'normal', categories: [{ name: 'Brød', products: [{ title: 'Grovbrød' }, { title: 'Kanelsnurr' }] }] }],
  };
}

test('add appends, replace overwrites, and lists merge instead of being wiped', () => {
  const note = normalizeNote({
    fields: {
      businessWhat: 'Vi lager også kaker på bestilling.',
      companyPhone: '99 88 77 66',
      companyAddress: 'Nyveien 2',
      reviews: '"Best i byen" – Kari',
    },
    fieldActions: { businessWhat: 'add', companyPhone: 'add', companyAddress: 'replace' },
    people: [{ name: 'ola nordmann', phone: '40000000', action: 'update' }, { name: 'Kari Hansen', title: 'Daglig leder' }],
    partners: [{ categoryName: 'Leverandører', titles: ['Tine'], action: 'remove' }],
    hoursText: 'lørdag stengt',
    hoursAction: 'update',
    removeProducts: ['Kanelsnurr'],
  });
  const next = applyNoteToBank(seedBank(), note);
  assert.equal(next.websiteCreatorQuestions.businessWhat, 'Vi baker brød.\nVi lager også kaker på bestilling.');
  assert.equal(next.websiteCreatorQuestions.reviews, '"Best i byen" – Kari');
  assert.equal(next.websiteCreatorQuestions.businessStory, 'Familiebedrift.');
  assert.equal(next.generalInfo.companyPhone, '55 12 34 56 / 99 88 77 66');
  assert.equal(next.generalInfo.companyAddress, 'Nyveien 2');
  assert.equal(next.staff.length, 2);
  assert.deepEqual([next.staff[0].title, next.staff[0].phone], ['Baker', '40000000']);
  assert.deepEqual(next.affiliations[0].items, [{ title: 'Mølla' }]);
  assert.equal(next.openingHours.days[5].closed, true);
  assert.equal(next.openingHours.days[0].opensAt, '09:00');
  assert.deepEqual(next.productCatalogs[0].categories[0].products.map((p) => p.title), ['Grovbrød']);
});

test('delete removes only what the client named; no action defaults to add', () => {
  const bank = applyNoteToBank(seedBank(), normalizeNote({ fields: { businessWhat: 'Vi lager kaker.' } }));
  assert.equal(bank.websiteCreatorQuestions.businessWhat, 'Vi baker brød.\nVi lager kaker.');
  const note = normalizeNote({
    fields: { businessWhat: 'kaker', businessStory: 'Startet i 1990.' },
    fieldActions: { businessWhat: 'delete', companyPhone: 'delete' },
  });
  assert.deepEqual(filledFieldKeys(note), ['businessStory']);
  const next = applyNoteToBank(bank, note);
  assert.equal(next.websiteCreatorQuestions.businessWhat, 'Vi baker brød.');
  assert.equal(next.generalInfo.companyPhone, '');
  assert.equal(next.websiteCreatorQuestions.businessStory, 'Familiebedrift.\nStartet i 1990.');
  const labelled = applyNoteToBank(seedBank(), normalizeNote({ removeProducts: ['Brød: Kanelsnurr'] }));
  assert.deepEqual(labelled.productCatalogs[0].categories[0].products.map((p) => p.title), ['Grovbrød']);
  const repeated = applyNoteToBank(seedBank(), normalizeNote({ partners: [{ categoryName: 'leverandører', titles: ['Tine', 'Bama'] }] }));
  assert.deepEqual(repeated.affiliations[0].items.map((item) => item.title), ['Mølla', 'Tine', 'Bama']);
});

test('a full new week replaces hours; a one-day change keeps the rest', () => {
  const full = applyNoteToBank(seedBank(), normalizeNote({ hoursText: 'mandag til fredag 10-16', hoursAction: 'replace' }));
  assert.equal(full.openingHours.days[5].closed, true);
  assert.equal(full.openingHours.days[0].opensAt, '10:00');
  const guess = applyNoteToBank(seedBank(), normalizeNote({ hoursText: 'søndag 12-16' }));
  assert.equal(guess.openingHours.days[6].opensAt, '12:00');
  assert.equal(guess.openingHours.days[2].opensAt, '09:00');
});

function snappy(literal, copy) {
  const lit = Buffer.from(literal, 'utf8');
  const parts = [Buffer.from([lit.length + copy.length]), Buffer.from([60 << 2, lit.length - 1]), lit];
  parts.push(Buffer.from([1 | ((copy.length - 4) << 2) | ((copy.offset >> 8) << 5), copy.offset & 0xff]));
  return Buffer.concat(parts);
}

test('zip, winmail.dat and Apple Pages files are unpacked and read', async () => {
  const pagesText = 'Vi baker brød hver dag i Bergen sentrum. ';
  const block = snappy(pagesText, { length: 9, offset: Buffer.byteLength(pagesText) });
  const iwa = Buffer.concat([Buffer.from([0, block.length & 0xff, (block.length >> 8) & 0xff, 0]), block]);
  const pagesZip = new AdmZip();
  pagesZip.addFile('Index/Document.iwa', iwa);
  pagesZip.addFile('preview.jpg', JPG);
  const pages = await extractIngestText({ originalName: 'om-oss.pages', buffer: pagesZip.toBuffer() });
  assert.match(pages.text, /Vi baker brød hver dag i Bergen sentrum\. Vi baker/);

  const attr = (level, id, data) => {
    const head = Buffer.alloc(9);
    head[0] = level;
    head.writeUInt32LE(id, 1);
    head.writeUInt32LE(data.length, 5);
    return Buffer.concat([head, data, Buffer.alloc(2)]);
  };
  const signature = Buffer.alloc(6);
  signature.writeUInt32LE(0x223e9f78, 0);
  const tnef = Buffer.concat([
    signature,
    attr(1, 0x0002800c, Buffer.from('Hei, her er menyen.\0')),
    attr(2, 0x00069002, Buffer.alloc(14)),
    attr(2, 0x00018010, Buffer.from('MENY.TXT\0')),
    attr(2, 0x0006800f, Buffer.from('Grovbrød 59 kr')),
    attr(2, 0x00069002, Buffer.alloc(14)),
    attr(2, 0x00018010, Buffer.from('BUTIKK.JPG\0')),
    attr(2, 0x0006800f, JPG),
  ]);

  const zip = new AdmZip();
  zip.addFile('bilder/fasade.jpg', JPG);
  zip.addFile('__MACOSX/bilder/._fasade.jpg', Buffer.from('junk'));
  zip.addFile('priser.csv', Buffer.from('Grovbrød;59'));
  zip.addFile('winmail.dat', tnef);

  const files = expandContainerFiles([{ originalName: 'materiale.zip', buffer: zip.toBuffer() }]);
  assert.deepEqual(files.map((file) => file.originalName).sort(), ['BUTIKK.JPG', 'MENY.TXT', 'e-posttekst.txt', 'fasade.jpg', 'priser.csv']);
  const split = partitionAssistantFiles(files);
  assert.equal(split.media.length, 2);
  assert.equal(split.documents.length, 3);
  const menu = await extractIngestText(files.find((file) => file.originalName === 'MENY.TXT'));
  assert.equal(menu.text, 'Grovbrød 59 kr');
});

test('Gemini brief picks the bucket; partner logos never take the client logo slot', async () => {
  assert.deepEqual(placementFromTranscript(normalizePortalTranscript({ depicts: 'Logo', primarySection: 'logo', logoKind: 'client' })), { bucket: 'logos', isLogo: true, favicon: false });
  // Shared rule with website-maker: a partner's logo is portfolio work (offerings), never the site logo.
  assert.equal(placementFromTranscript(normalizePortalTranscript({ depicts: 'Tine logo', primarySection: 'logo', logoKind: 'partner' })).bucket, 'offeringImages');
  assert.equal(placementFromTranscript(normalizePortalTranscript({ depicts: 'Blurry', primarySection: 'hero', usable: 'skip' })).bucket, 'uncategorized');
  assert.equal(await transcribeClientMedia({ buffer: JPG, fileName: 'a.jpg' }), null);
  assert.equal(await transcribeClientMedia({ buffer: JPG, fileName: 'a.svg', generate: async () => ({ data: {} }) }), null);
});

const BRIEFS = {
  'meny.jpg': { depicts: 'Tavle med brød og priser', visibleText: ['Grovbrød 59,-'], primarySection: 'offerings', productInfo: true },
  'logo.png': { depicts: 'Rund logo med kornaks', primarySection: 'logo', logoKind: 'client', medium: 'logo' },
  'ansatte.jpg': { depicts: 'To bakere ved disken', primarySection: 'team', facesVisible: true, peopleCount: 2 },
  'IMG_0042.jpg': { depicts: 'Fasaden med skilt', primarySection: 'location' },
};
const stub = async ({ fileName }) => ({ ...normalizePortalTranscript(BRIEFS[fileName], { fileName }), hash: fileName });

test('every saved media file gets a brief; product-info images go to product extraction', async () => {
  const userId = 'portal-media-brief';
  clientPortal.upsertClientProfile(userId, { businessName: 'Bakkes' });
  const saved = await persistMediaFiles(userId, [
    { originalName: 'meny.jpg', buffer: JPG },
    { originalName: 'logo.png', buffer: PNG },
    { originalName: 'ansatte.jpg', buffer: JPG },
    { originalName: 'IMG_0042.jpg', buffer: JPG },
  ], {
    buckets: {
      'ansatte.jpg': { bucket: 'aboutImages' },
      'IMG_0042.jpg': { bucket: 'mainHeroImages', weak: true },
    },
    transcribe: stub,
  });
  const bank = clientPortal.getClientProfileByUserId(userId).clientDataBank;
  const at = Object.fromEntries(saved.placed.map((row) => [row.fileName, row]));
  assert.equal(at['meny.jpg'].bucket, 'offeringImages');
  assert.equal(at['logo.png'].bucket, 'logos');
  assert.equal(at['ansatte.jpg'].bucket, 'aboutImages', 'a bucket the client named wins over the brief');
  assert.equal(at['IMG_0042.jpg'].bucket, 'locationImages', 'a file-name guess loses to the brief');
  assert.equal(bank.brandIdentity.logos.normal, at['logo.png'].url);
  assert.equal(bank.media.briefs.length, 4);
  assert.equal(bank.media.briefs.find((row) => row.url === at['meny.jpg'].url).productInfo, true);
  assert.deepEqual(saved.productFiles.map((file) => file.originalName), ['meny.jpg']);
});

test('Kundedata upload returns the brief and suggested bucket for the page to apply', async () => {
  const userId = 'portal-media-upload';
  clientPortal.upsertClientProfile(userId, { businessName: 'Bakkes' });
  const out = await categorizeClientUpload(userId, { url: '/client-media/x/ansatte.jpg', buffer: JPG, originalName: 'ansatte.jpg', transcribe: stub });
  assert.equal(out.placement.bucket, 'teamImages');
  assert.equal(out.productCatalogs, null);
  const briefs = clientPortal.getClientProfileByUserId(userId).clientDataBank.media.briefs;
  assert.equal(briefs.filter((row) => row.url === '/client-media/x/ansatte.jpg').length, 1);
  assert.equal(await categorizeClientUpload(userId, { url: '/x', buffer: JPG, originalName: 'a.jpg', transcribe: async () => null }), null);
});
