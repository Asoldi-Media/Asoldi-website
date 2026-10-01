import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.APP_DATA_DIR = mkdtempSync(join(tmpdir(), 'asoldi-dev-requests-'));

const sales = await import('../data/sales.js');
const clientPortal = await import('../data/client-portal.js');
const lib = await import('../lib/admin-dev-requests.js');

const DATA_DIR = process.env.APP_DATA_DIR;
const PORTAL_USER = 'portal-user-t02';
const MAKER_DIR = join(DATA_DIR, 'fake-maker-run');

function listNames(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true }).map(String).filter((name) => name && !name.endsWith('.json'));
}

function clientUploadDir() {
  return join(DATA_DIR, 'client-uploads', PORTAL_USER);
}

function hubMediaDir() {
  return join(DATA_DIR, 'media');
}

function productTitles() {
  const profile = clientPortal.getClientProfileByUserId(PORTAL_USER);
  const products = profile?.clientDataBank?.products || [];
  return products.flatMap((category) => (category.items || []).map((item) => item.title));
}

function seedClient({ id, runId = 'run-t02', product = 'asoldi' } = {}) {
  clientPortal.upsertClientProfile(PORTAL_USER, { businessName: 'Cafe Test' });
  const bank = clientPortal.getClientProfileByUserId(PORTAL_USER)?.clientDataBank || {};
  clientPortal.setClientDataBank(PORTAL_USER, {
    ...bank,
    products: [{ categoryName: 'Meny', items: [{ title: 'Soup' }] }],
  });
  return sales.createSalesClient({
    id,
    businessName: 'Cafe Test',
    product,
    portalUserId: PORTAL_USER,
    makerRun: runId ? { runId } : {},
  });
}

async function mockMakerFetch(url, init) {
  assert.match(String(url), /\/api\/runs\/run-t02\/uploads$/);
  const form = init.body;
  assert.ok(form instanceof FormData);
  mkdirSync(join(MAKER_DIR, 'uploads'), { recursive: true });
  const saved = {};
  for (const [field, value] of form.entries()) {
    const name = value?.name || 'file';
    const bytes = Buffer.from(await value.arrayBuffer());
    const dest = join(MAKER_DIR, 'uploads', `${field}-${name}`);
    writeFileSync(dest, bytes);
    saved[field] = [dest];
  }
  return {
    ok: true,
    status: 200,
    json: async () => ({ ok: true, uploads: saved }),
  };
}

test('recommended commit destination follows makerRun.runId', () => {
  assert.equal(lib.recommendedCommitDestination({ makerRun: { runId: 'abc' } }), 'maker');
  assert.equal(lib.recommendedCommitDestination({ makerRun: { runId: '' } }), 'client-uploads');
  assert.equal(lib.recommendedCommitDestination({}), 'client-uploads');
});

test('Maker field mapping sends images, video, audio, and text to the existing upload fields', () => {
  assert.equal(lib.makerUploadFieldForName('photo.jpg', 'image/jpeg'), 'generalImages');
  assert.equal(lib.makerUploadFieldForName('clip.mp4', 'video/mp4'), 'generalVideos');
  assert.equal(lib.makerUploadFieldForName('voice.mp3', 'audio/mpeg'), 'generalAudio');
  assert.equal(lib.makerUploadFieldForName('notes.txt', 'text/plain'), 'mainMedia');
});

test('SSU clients cannot open a request thread', () => {
  const client = sales.createSalesClient({ businessName: 'SSU Lead', product: 'ssu' });
  assert.throws(() => lib.addMessage({
    salesClientId: client.id,
    authorRole: 'developer',
    text: 'Need access',
  }), /SSU/);
});

test('txt + jpg stay staged until commit, then land in only the chosen folder', async () => {
  mkdirSync(MAKER_DIR, { recursive: true });
  const client = seedClient({ id: 't02-thread-client' });

  const thread = lib.addMessage({
    salesClientId: client.id,
    authorRole: 'developer',
    authorLabel: 'Utvikler',
    text: 'Mangler logo og åpningstekst',
    files: [
      { originalName: 'notes.txt', mime: 'text/plain', buffer: Buffer.from('opening hours 10-16') },
      { originalName: 'photo.jpg', mime: 'image/jpeg', buffer: Buffer.from('fake-jpeg-bytes') },
    ],
  });

  assert.equal(thread.messages.length, 1);
  assert.equal(thread.messages[0].files.length, 2);
  const txt = thread.messages[0].files.find((file) => file.originalName === 'notes.txt');
  const jpg = thread.messages[0].files.find((file) => file.originalName === 'photo.jpg');
  assert.ok(txt && jpg);
  assert.equal(txt.committed, null);
  assert.equal(jpg.committed, null);

  const stagingDir = join(DATA_DIR, lib.REQUESTS_FILES_DIR, client.id);
  const staged = listNames(stagingDir);
  assert.equal(staged.length, 2);
  assert.equal(listNames(clientUploadDir()).length, 0);
  assert.equal(listNames(join(MAKER_DIR, 'uploads')).length, 0);
  assert.equal(existsSync(hubMediaDir()), false);
  assert.deepEqual(productTitles(), ['Soup']);

  const afterKunde = await lib.commitFile({
    salesClientId: client.id,
    fileId: jpg.id,
    destination: 'client-uploads',
  });
  const committedJpg = afterKunde.messages[0].files.find((file) => file.id === jpg.id);
  assert.equal(committedJpg.committed.destination, 'client-uploads');
  assert.match(String(committedJpg.committed.url), /^\/client-media\//);

  const kundeFiles = listNames(clientUploadDir());
  assert.equal(kundeFiles.length, 1);
  assert.match(kundeFiles[0], /photo\.jpg$/i);
  assert.equal(
    readFileSync(join(clientUploadDir(), kundeFiles[0]), 'utf8'),
    'fake-jpeg-bytes'
  );
  assert.equal(listNames(join(MAKER_DIR, 'uploads')).length, 0);
  const bank = clientPortal.getClientProfileByUserId(PORTAL_USER)?.clientDataBank;
  assert.ok(bank.media.uncategorized.includes(committedJpg.committed.url));
  assert.deepEqual(productTitles(), ['Soup']);
  assert.equal(existsSync(hubMediaDir()), false);

  await assert.rejects(
    () => lib.commitFile({
      salesClientId: client.id,
      fileId: jpg.id,
      destination: 'maker',
      websiteMakerBaseUrl: 'http://127.0.0.1:3000',
      fetchImpl: mockMakerFetch,
    }),
    /allerede lagt inn/
  );
  assert.equal(listNames(join(MAKER_DIR, 'uploads')).length, 0);

  const afterMaker = await lib.commitFile({
    salesClientId: client.id,
    fileId: txt.id,
    destination: 'maker',
    websiteMakerBaseUrl: 'http://127.0.0.1:3000',
    fetchImpl: mockMakerFetch,
  });
  const committedTxt = afterMaker.messages[0].files.find((file) => file.id === txt.id);
  assert.equal(committedTxt.committed.destination, 'maker');
  assert.equal(committedTxt.committed.field, 'mainMedia');

  const makerFiles = listNames(join(MAKER_DIR, 'uploads'));
  assert.equal(makerFiles.length, 1);
  assert.match(makerFiles[0], /mainMedia-notes\.txt$/);
  assert.equal(
    readFileSync(join(MAKER_DIR, 'uploads', makerFiles[0]), 'utf8'),
    'opening hours 10-16'
  );
  assert.equal(listNames(clientUploadDir()).length, 1, 'txt must not be copied into Kundedata');
  assert.deepEqual(productTitles(), ['Soup']);
  assert.equal(existsSync(hubMediaDir()), false);
  assert.equal(lib.readStagingFile(client.id, txt.id).buffer.toString(), 'opening hours 10-16');
});

test('Maker LAN handoff does not mark committed or write libraries', async () => {
  const client = seedClient({ id: 't02-handoff-client' });
  const thread = lib.addMessage({
    salesClientId: client.id,
    authorRole: 'admin',
    text: '',
    files: [{ originalName: 'brief.txt', mime: 'text/plain', buffer: Buffer.from('need domain') }],
  });
  const fileId = thread.messages[0].files[0].id;
  let fetchCalls = 0;
  const result = await lib.commitFile({
    salesClientId: client.id,
    fileId,
    destination: 'maker',
    websiteMakerBaseUrl: 'http://192.168.68.92:3000',
    publicHost: true,
    fetchImpl: async () => {
      fetchCalls += 1;
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    },
  });
  assert.equal(result.browserHandoff, true);
  assert.equal(result.field, 'mainMedia');
  assert.equal(fetchCalls, 0);
  const still = lib.getThread(client.id);
  assert.equal(still.messages[0].files[0].committed, null);
  assert.equal(listNames(clientUploadDir()).filter((name) => name.includes('brief')).length, 0);

  const completed = lib.completeCommit({
    salesClientId: client.id,
    fileId,
    destination: 'maker',
    field: 'mainMedia',
  });
  assert.equal(completed.messages[0].files[0].committed.destination, 'maker');
});

test('client domain-help owned vs buy land as distinct requests on the sales client', () => {
  const ownedClient = seedClient({ id: 'domain-help-owned' });
  const owned = lib.addClientDomainHelp({
    portalUserId: PORTAL_USER,
    salesClientId: ownedClient.id,
    kind: 'domain-nameservers-owned',
    domain: 'https://www.cafe-test.no/path',
    businessName: 'Cafe Test',
  });
  const ownedMessage = owned.messages[owned.messages.length - 1];
  assert.equal(owned.salesClientId, ownedClient.id);
  assert.equal(ownedMessage.authorRole, 'client');
  assert.equal(ownedMessage.kind, 'domain-nameservers-owned');
  assert.match(ownedMessage.text, /eid domene/);
  assert.equal(owned.lastKindLabel, 'Hjelp kunde sette opp navnservere på eid domene');

  const buyClient = sales.createSalesClient({
    id: 'domain-help-buy',
    businessName: 'Kjøp AS',
    product: 'asoldi',
    portalUserId: 'portal-buy-user',
  });
  const buy = lib.addClientDomainHelp({
    portalUserId: 'portal-buy-user',
    kind: 'domain-nameservers-buy',
    domain: 'nybutikk.no',
    businessName: 'Kjøp AS',
  });
  const buyMessage = buy.messages[buy.messages.length - 1];
  assert.equal(buy.salesClientId, buyClient.id);
  assert.equal(buyMessage.kind, 'domain-nameservers-buy');
  assert.equal(buy.lastKindLabel, 'Hjelp kunde sette opp navnservere på ikke-eid domene');

  const listed = lib.listThreads();
  const ownedRow = listed.find((row) => row.salesClientId === ownedClient.id);
  const buyRow = listed.find((row) => row.salesClientId === buyClient.id);
  assert.equal(ownedRow.lastKind, 'domain-nameservers-owned');
  assert.equal(buyRow.lastKind, 'domain-nameservers-buy');
  assert.equal(ownedRow.lastAuthorRole, 'client');
});

test('domain help without a linked sales client is refused', () => {
  assert.throws(() => lib.addClientDomainHelp({
    portalUserId: 'nobody',
    kind: 'domain-nameservers-owned',
    domain: 'missing.no',
  }), /koblet/);
});
