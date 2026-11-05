// Personal-data stores written with plain file writes: workshop note files, the mail outbox (held-back
// and shadow mails), the last mail sent and the sales map's place cache. Each is exported for the client
// it holds and erased for that client only; a mail that also went to another card stays. Synthetic
// clients only (example.com addresses), on a temp data dir.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'asoldi-pd-file-stores-'));
process.env.APP_DATA_DIR = DATA_DIR;
delete process.env.DATA_DIR;
test.after(() => rmSync(DATA_DIR, { recursive: true, force: true }));

function put(rel, value) {
  const path = join(DATA_DIR, rel);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value, null, 2));
  return path;
}

const LEAD = {
  id: 'fs-lead',
  product: 'asoldi',
  businessName: 'Testverkstedet AS',
  contactEmail: 'verksted@example.com',
  meetingPlace: 'Eksempelveien 1, Testvik',
  status: 'active',
  createdAt: '2026-10-01T10:00:00.000Z',
};
const OTHER = { id: 'fs-other', product: 'asoldi', businessName: 'Annen Butikk AS', contactEmail: 'annen@example.com', status: 'active', createdAt: '2026-10-02T10:00:00.000Z' };
put('sales-clients.json', [LEAD, OTHER]);

// Workshop note files of both clients.
put('workshop-notes/fs-lead/note-1/tavle.jpg', 'jpeg-bytes');
put('workshop-notes/fs-other/note-2/skisse.png', 'png-bytes');

// The outbox: one mail to the lead, one to the lead and the other card together, one to the other card.
const ids = ['20261101T100000Z-11111111-1111-4111-8111-111111111111', '20261101T100100Z-22222222-2222-4222-8222-222222222222', '20261101T100200Z-33333333-3333-4333-8333-333333333333'];
const entry = (id, to) => ({ id, at: '2026-11-01T10:00:00.000Z', day: '2026-11-01', channel: 'delivery-shadow', to, bcc: [], replyTo: '', subject: 'Forhåndsvisning' });
for (const id of ids) {
  put(`outbox/2026-11-01/${id}.eml`, 'Subject: Forhåndsvisning\n\nHei');
  put(`outbox/2026-11-01/${id}.body.json`, { html: '', text: 'Hei' });
}
put('outbox/index.jsonl', [
  entry(ids[0], ['Verkstedet <verksted@example.com>']),
  entry(ids[1], ['verksted@example.com', 'annen@example.com']),
  entry(ids[2], ['annen@example.com']),
].map((row) => JSON.stringify(row)).join('\n') + '\n');

put('last-email-send.json', { ok: true, transport: 'resend', from: 'Asoldi <hei@example.com>', to: ['verksted@example.com'], subject: 'Velkommen', at: '2026-11-01T10:05:00.000Z' });
put('sales-meeting-geocode-cache.json', { places: {
  'eksempelveien 1, testvik': { lat: 60.1, lng: 10.1, label: 'Eksempelveien 1' },
  'annen butikk as, norge': { lat: 60.2, lng: 10.2, label: 'Annen Butikk' },
} });

const personalData = await import('../lib/personal-data.js');

const byId = (stores) => Object.fromEntries(stores.map((store) => [store.id, store]));

test('the new stores are registered with their retention texts', async () => {
  const stores = await personalData.loadStoreModules();
  const ids = stores.map((store) => store.id);
  for (const id of ['workshop-note-files', 'mail-outbox', 'last-mail-send', 'sales-map-places']) {
    assert.ok(ids.includes(id), id);
    assert.ok(personalData.retentionText(id).length > 20, `${id} retention text`);
  }
});

test('the export finds the client\'s note files, mails, last mail and map place, and nothing of the other card', async () => {
  const bundle = await personalData.exportClient('fs-lead', { dataDir: DATA_DIR });
  const stores = byId(bundle.stores);
  assert.deepEqual(stores['workshop-note-files'].files.map((file) => file.path), ['workshop-notes/fs-lead/note-1/tavle.jpg']);
  assert.deepEqual(stores['mail-outbox'].records.map((row) => row.id).sort(), [ids[0], ids[1]]);
  assert.equal(stores['mail-outbox'].files.length, 4, 'the .eml and .body.json of both mails');
  assert.equal(stores['last-mail-send'].records[0].subject, 'Velkommen');
  assert.deepEqual(stores['sales-map-places'].records.map((row) => row.place), ['eksempelveien 1, testvik']);
});

test('an erase plan lists what would go and changes nothing', async () => {
  const plan = await personalData.eraseClient('fs-lead', { dataDir: DATA_DIR, dryRun: true });
  const stores = byId(plan.stores);
  assert.equal(stores['workshop-note-files'].action, 'delete');
  assert.equal(stores['mail-outbox'].action, 'delete');
  assert.deepEqual(stores['mail-outbox'].held, [ids[1]], 'the mail that also went to another card is held');
  assert.equal(stores['mail-outbox'].reason, 'shared-address');
  assert.equal(stores['last-mail-send'].action, 'delete');
  assert.equal(stores['sales-map-places'].action, 'delete');
  assert.equal(existsSync(join(DATA_DIR, 'workshop-notes', 'fs-lead')), true);
  assert.equal(readFileSync(join(DATA_DIR, 'outbox', 'index.jsonl'), 'utf8').trim().split('\n').length, 3);
  assert.equal(existsSync(join(DATA_DIR, 'last-email-send.json')), true);
});

test('an erase removes only the client\'s own files, mails and place; the other card keeps everything', async () => {
  const result = await personalData.eraseClient('fs-lead', { dataDir: DATA_DIR, dryRun: false });
  assert.equal(result.erased, true);
  assert.equal(existsSync(join(DATA_DIR, 'workshop-notes', 'fs-lead')), false);
  assert.equal(existsSync(join(DATA_DIR, 'workshop-notes', 'fs-other', 'note-2', 'skisse.png')), true);
  const lines = readFileSync(join(DATA_DIR, 'outbox', 'index.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line).id);
  assert.deepEqual(lines, [ids[1], ids[2]], 'the shared mail and the other card\'s mail stay');
  assert.equal(existsSync(join(DATA_DIR, 'outbox', '2026-11-01', `${ids[0]}.eml`)), false);
  assert.equal(existsSync(join(DATA_DIR, 'outbox', '2026-11-01', `${ids[1]}.eml`)), true);
  assert.equal(existsSync(join(DATA_DIR, 'last-email-send.json')), false);
  const places = JSON.parse(readFileSync(join(DATA_DIR, 'sales-meeting-geocode-cache.json'), 'utf8')).places;
  assert.deepEqual(Object.keys(places), ['annen butikk as, norge']);
  const outbox = result.stores.find((store) => store.id === 'mail-outbox');
  assert.equal(outbox.records, 1);
});

test('a last mail to someone else is not the client\'s, and an empty data dir gives none everywhere', async () => {
  put('last-email-send.json', { ok: true, to: ['annen@example.com'], subject: 'Faktura' });
  const plan = await personalData.eraseClient('fs-other', { dataDir: DATA_DIR, dryRun: true });
  assert.equal(byId(plan.stores)['last-mail-send'].action, 'delete');
  const empty = mkdtempSync(join(tmpdir(), 'asoldi-pd-file-stores-empty-'));
  try {
    const none = await personalData.eraseClient('fs-other', { dataDir: empty, dryRun: true });
    for (const id of ['workshop-note-files', 'mail-outbox', 'last-mail-send', 'sales-map-places']) assert.equal(byId(none.stores)[id].action, 'none', id);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});
