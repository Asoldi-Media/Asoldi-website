#!/usr/bin/env node
// scripts/golden/seed-hub.mjs
// -----------------------------------------------------------------------------
// Seed a local hub data folder from the Maker's golden fixtures, for the golden harness and the safe-mode
// soak. The fixtures stay in the private Maker repo; this script reads them at run time and writes only to
// a folder below a `.local-data` directory (any other folder is refused).
//
//   node scripts/golden/seed-hub.mjs --data-dir .local-data/golden --clients all
//        [--fixtures-dir ../website-maker/fixtures/golden] [--private-dir ../website-maker/fixtures-private]
//        [--signed id,id]       mark these clients contract-signed (no email is sent while seeding)
//
// Writes, through the hub's own data modules:
//   sales-clients.json      one client per fixture, id golden_<fixture id>, with its sitePlan
//   sales-offers.json       the fixture's offer as a draft offer for that client
//   fireflies-meetings.json the fixture's meetings (inline text; private ones only with --private-dir)
//   users.json              a local admin with a random password, saved to <data-dir>/secrets/local-admin.json
//   sites.json              a site per client that has a website domain
// Fixture values that are private placeholders are read from --private-dir, or the client is skipped.
// Run it in its own process: the data modules fix their folder when they are first loaded.
// -----------------------------------------------------------------------------
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DEFAULT_FIXTURES_DIR = resolve(REPO, '..', 'website-maker', 'fixtures', 'golden');
export const ID_PREFIX = 'golden_';

/** A folder is seedable only below a `.local-data` directory. */
export function assertLocalDataDir(dir) {
  const full = resolve(String(dir || ''));
  const parts = full.split(/[\\/]+/);
  if (!dir || !parts.includes('.local-data')) {
    throw new Error(`refused: ${full} is not below a .local-data folder (seed-hub only writes local test data)`);
  }
  return full;
}

export function parseSeedHubArgs(argv = []) {
  const opts = { dataDir: '', clients: 'all', fixturesDir: process.env.GOLDEN_FIXTURES_DIR || DEFAULT_FIXTURES_DIR, privateDir: process.env.GOLDEN_PRIVATE_DIR || '', signed: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === '--data-dir') opts.dataDir = value;
    else if (key === '--clients') opts.clients = value;
    else if (key === '--fixtures-dir') opts.fixturesDir = value;
    else if (key === '--private-dir') opts.privateDir = value;
    else if (key === '--signed') opts.signed = value;
    else throw new Error(`unknown option ${key}`);
    i += 1;
  }
  if (!opts.dataDir) throw new Error('--data-dir is required');
  return opts;
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function isPlaceholder(value) {
  return Boolean(value) && typeof value === 'object' && typeof value.$private === 'string';
}

function getPath(obj, dotted) {
  let node = obj;
  for (const part of String(dotted || '').split('.').filter(Boolean)) {
    if (node == null) return undefined;
    node = node[part];
  }
  return node;
}

/** A fixture value with private placeholders resolved from <privateDir>/<id>/ (undefined when absent). */
export function resolveFixtureValue(clientId, value, privateDir = '') {
  if (!isPlaceholder(value)) return value;
  if (!privateDir) return undefined;
  const ref = value.$private;
  try {
    if (ref.endsWith('.json')) return readJson(join(privateDir, clientId, ...ref.split('/')));
    const [fileKey, ...rest] = ref.split('.');
    return getPath(readJson(join(privateDir, clientId, `${fileKey}.json`)), rest.join('.'));
  } catch {
    return undefined;
  }
}

function resolveDeep(clientId, value, privateDir) {
  if (isPlaceholder(value)) return resolveFixtureValue(clientId, value, privateDir);
  if (Array.isArray(value)) return value.map((item) => resolveDeep(clientId, item, privateDir));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveDeep(clientId, v, privateDir)]));
  return value;
}

/** Plain-text meeting lines ("Name: text") as Fireflies-style sentences. */
export function sentencesFromText(text = '') {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      const match = line.match(/^([^:]{1,60}):\s*(.+)$/);
      return { index, speaker_name: match ? match[1].trim() : 'Speaker', text: match ? match[2].trim() : line };
    });
}

function meetingsFor(clientId, fixtureDir, transcripts, privateDir) {
  const out = [];
  for (const [purpose, meeting] of Object.entries(transcripts?.meetings || {})) {
    if (!meeting) continue;
    let sentences = [];
    if (meeting.storage === 'inline' && meeting.file) {
      try {
        sentences = sentencesFromText(readFileSync(join(fixtureDir, meeting.file), 'utf8'));
      } catch {
        sentences = [];
      }
    } else if (privateDir && String(meeting.file || '').startsWith('private:')) {
      try {
        sentences = readJson(join(privateDir, clientId, ...meeting.file.slice('private:'.length).split('/'))).sentences || [];
      } catch {
        sentences = [];
      }
    }
    if (!sentences.length) continue;
    out.push({
      purpose,
      meetingId: `${ID_PREFIX}${clientId}_${purpose}`,
      title: String(resolveFixtureValue(clientId, meeting.title, privateDir) || `${purpose} meeting`),
      date: String(meeting.date || ''),
      sentences,
    });
  }
  return out;
}

/** Fixture clients to seed: [{id, kind, dir, client, transcripts}] in index order. */
export function loadFixtureClients(fixturesDir, spec = 'all') {
  const index = readJson(join(fixturesDir, 'index.json'));
  const all = index.clients || [];
  const wanted = spec === 'all' ? all : spec === 'synthetic' || spec === 'real' ? all.filter((c) => c.kind === spec) : String(spec).split(',').map((id) => {
    const found = all.find((c) => c.id === id.trim());
    if (!found) throw new Error(`unknown fixture client ${id}`);
    return found;
  });
  return wanted.map((entry) => {
    const dir = join(fixturesDir, entry.id);
    return { ...entry, dir, client: readJson(join(dir, 'client.json')), transcripts: existsSync(join(dir, 'transcripts.json')) ? readJson(join(dir, 'transcripts.json')) : null };
  });
}

/**
 * Seed the data folder (process.env.APP_DATA_DIR must already point at it, before the hub data modules
 * load). Returns {dataDir, adminFile, clients:[{id, salesClientId, status, meetings, site}], skipped:[...]}.
 */
export async function seedHub(opts) {
  const dataDir = assertLocalDataDir(opts.dataDir);
  if (resolve(String(process.env.APP_DATA_DIR || '')) !== dataDir) {
    throw new Error('seed-hub: APP_DATA_DIR must be the --data-dir before the hub data modules load (run it as its own process)');
  }
  mkdirSync(dataDir, { recursive: true });
  const storage = await import('../../data/storage-path.js');
  if (resolve(storage.getPersistentDataDir()) !== dataDir) throw new Error('seed-hub: the hub data modules were loaded for another folder');
  const sales = await import('../../data/sales.js');
  const offers = await import('../../data/sales-offers.js');
  const store = await import('../../data/store.js');
  const hub = await import('../../data/hub.js');
  const fireflies = await import('../../lib/fireflies-webhook.js');

  // Local admin: a random password, stored only in the data folder (user-only file).
  const secretsDir = join(dataDir, 'secrets');
  mkdirSync(secretsDir, { recursive: true });
  const adminFile = join(secretsDir, 'local-admin.json');
  let admin = existsSync(adminFile) ? readJson(adminFile) : null;
  if (!admin?.username || !admin?.password) {
    admin = { username: 'golden-admin', password: randomBytes(18).toString('base64url') };
    writeFileSync(adminFile, `${JSON.stringify(admin, null, 2)}\n`, { mode: 0o600 });
    try {
      chmodSync(adminFile, 0o600);
    } catch {
      // Windows keeps its own ACLs
    }
  }
  await store.setAdminCredentials(admin.username, admin.password);

  const signed = new Set(String(opts.signed || '').split(',').map((s) => s.trim()).filter(Boolean));
  const result = { dataDir, adminFile, clients: [], skipped: [] };
  for (const fixture of loadFixtureClients(opts.fixturesDir, opts.clients)) {
    const salesClient = resolveDeep(fixture.id, fixture.client?.salesClient || {}, opts.privateDir);
    if (Object.values(salesClient).some((v) => v === undefined)) {
      result.skipped.push({ id: fixture.id, reason: 'private fixture values are not available' });
      continue;
    }
    const id = `${ID_PREFIX}${fixture.id}`;
    const sitePlan = fixture.client?.sitePlan || null;
    const offerSent = ['sent', 'accepted'].includes(String(fixture.client?.offer?.status || ''));
    const record = {
      id,
      product: 'asoldi',
      businessName: salesClient.businessName || fixture.client?.label || fixture.id,
      contactPerson: salesClient.contactPerson || '',
      contactEmail: salesClient.contactEmail || '',
      contactPhone: salesClient.contactPhone || '',
      orgNumber: salesClient.orgNumber || '',
      businessAddress: salesClient.businessAddress || '',
      industry: salesClient.industry || '',
      websiteDomain: salesClient.websiteDomain || '',
      status: 'active',
      ...(sitePlan ? { sitePlan } : {}),
      progression: { meetingHeld: true, offerSent, contractSigned: signed.has(fixture.id) },
      ...(signed.has(fixture.id) ? { contractSignedAt: new Date().toISOString() } : {}),
    };
    const existing = sales.getSalesClientById(id);
    const saved = existing ? sales.updateSalesClient(id, record) : sales.createSalesClient(record);
    if (fixture.client?.offer && !offers.getOfferForClient(id)) {
      offers.createSalesOffer({ salesClientId: id, title: fixture.client.offer.title || 'Offer', summary: fixture.client.offer.summary || '' }, { actor: 'golden-seed' });
    }
    const meetings = meetingsFor(fixture.id, fixture.dir, fixture.transcripts, opts.privateDir);
    for (const meeting of meetings) {
      const stored = fireflies.buildFirefliesMeetingRecord({ meetingId: meeting.meetingId }, { id: meeting.meetingId, title: meeting.title, date: meeting.date, sentences: meeting.sentences });
      fireflies.storeFirefliesMeeting(stored);
      sales.linkMeetingToSalesClient(id, fireflies.meetingRefForClient(stored, { confidence: 'manual' }, { linkedBy: 'golden-seed' }));
    }
    let site = null;
    if (record.websiteDomain) site = hub.createSite({ name: record.businessName, domain: record.websiteDomain, websitePlan: sitePlan?.tierId || undefined });
    result.clients.push({ id: fixture.id, salesClientId: saved?.id || id, signed: signed.has(fixture.id), meetings: meetings.length, site: site ? site.domain : '' });
  }
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  let opts;
  try {
    opts = parseSeedHubArgs(process.argv.slice(2));
    opts.dataDir = assertLocalDataDir(opts.dataDir);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(2);
  }
  process.env.APP_DATA_DIR = opts.dataDir;
  process.env.DATA_DIR = '';
  process.env.PERSIST_PRODUCTION_ENV = '0';
  seedHub(opts).then(
    (summary) => {
      process.stdout.write(`${JSON.stringify({ ...summary, adminFile: summary.adminFile.split(sep).join('/') }, null, 2)}\n`);
    },
    (error) => {
      process.stderr.write(`[seed-hub] ${error?.message || error}\n`);
      process.exit(1);
    },
  );
}
