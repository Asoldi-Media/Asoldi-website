// Fireflies candidate ranker: with default settings no recording is linked and no candidate route
// answers; the ranker scores the signal table and never links; auto-link (only when switched on)
// needs an exact attendee e-mail and a slot the hub booked within 30 minutes, and a title and name
// match without that e-mail never links; a person's one-click link survives the backfill while an
// old automatic link does not become trusted; 'demo' survives a save through updateSalesClient.
// Synthetic clients and recordings (example.com addresses) on a temp data dir.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'asoldi-ff-rank-'));
process.env.APP_DATA_DIR = DATA_DIR;
delete process.env.DATA_DIR;

const HOUR = 3_600_000;
const T = Date.parse('2026-10-20T10:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();

const ACME = {
  id: 'rk-acme',
  product: 'asoldi',
  businessName: 'Acme Bygg AS',
  contactPerson: 'Ola Normann',
  contactEmail: 'ola@acme-bygg.example',
  websiteDomain: 'https://www.acme-bygg.example',
  status: 'active',
  agreedTime: true,
  meetingAt: iso(T),
  progression: {},
};
const TITLE_ONLY = {
  id: 'rk-title',
  product: 'asoldi',
  businessName: 'Fjordkafeen AS',
  contactPerson: 'Kari Fjord',
  contactEmail: 'kari@fjordkafe.example',
  status: 'active',
  agreedTime: true,
  meetingAt: iso(T + 10 * HOUR),
  progression: {},
};
const NOT_SOLD = { id: 'rk-notsold', product: 'asoldi', businessName: 'Acme Bygg Vest AS', contactEmail: 'post@vest.example', status: 'not-sold', progression: {} };
const FREEMAIL = { id: 'rk-freemail', product: 'asoldi', businessName: 'Gmail Snekker', contactEmail: 'snekker@gmail.com', websiteDomain: 'gmail.com', status: 'active', progression: {} };
writeFileSync(join(DATA_DIR, 'sales-clients.json'), JSON.stringify([ACME, TITLE_ONLY, NOT_SOLD, FREEMAIL], null, 2));

const webhook = await import('../lib/fireflies-webhook.js');
const sales = await import('../data/sales.js');
const settingsStore = await import('../data/automation-settings.js');
const rank = await import('../lib/fireflies-candidate-rank.js');
const { createFirefliesLinker, setFirefliesLinkerProvider } = await import('../lib/fireflies-linking.js');
const { privacyOnLinked, privacyOnUnlinked } = await import('../lib/privacy-link-hooks.js');
const { MEETING_PURPOSES, sanitizeMeetingPurpose } = await import('../lib/workshop-record.js');

const linker = createFirefliesLinker({
  sales,
  log: { warn() {} },
  onLinked: (clientId, meetingId, info) => privacyOnLinked(clientId, meetingId, info),
  onUnlinked: (clientId, meetingId) => privacyOnUnlinked(clientId, meetingId),
});
setFirefliesLinkerProvider(() => linker);

function setSettings(patch) {
  const result = settingsStore.saveAutomationSettings(patch);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
}

const ACME_RECORDING = {
  meetingId: 'rk-rec-acme',
  title: 'Møte med Acme Bygg',
  startedAt: iso(T + HOUR),
  attendees: ['Ola Normann <ola@acme-bygg.example>', 'Selger <selger@asoldi.com>'],
  attendeeEmails: ['ola@acme-bygg.example', 'selger@asoldi.com'],
  transcript: 'Ola Normann: Vi vil ha ny nettside.\nSelger: Flott.',
  final: true,
};
// The title and the contact's name match Fjordkafeen, but no attendee e-mail is the client's.
const TITLE_RECORDING = {
  meetingId: 'rk-rec-title',
  title: 'Fjordkafeen nettside',
  startedAt: iso(T + 10 * HOUR + 10 * 60_000),
  attendees: ['Kari Fjord <kari.privat@example.com>'],
  attendeeEmails: ['kari.privat@example.com'],
  transcript: 'Kari Fjord: Hei.\nSelger: Hei.',
  final: true,
};
for (const record of [ACME_RECORDING, TITLE_RECORDING]) webhook.storeFirefliesMeeting(record);

test('the switches default to off: the ranker, auto-link, archive, purge and media switches', () => {
  const defaults = settingsStore.defaultAutomationSettings();
  assert.equal(defaults.fireflies.candidateRanker.enabled, false);
  assert.equal(defaults.fireflies.autoLink.enabled, false);
  assert.deepEqual(defaults.privacy, { archive: { enabled: false }, purge: { enabled: false, mode: 'shadow' } });
  assert.deepEqual(defaults.media, { signedUrls: { enabled: false }, rightsConfirm: { enabled: false } });
  assert.equal(settingsStore.validateAutomationSettings({ privacy: { purge: { mode: 'delete' } } }).ok, false);
});

test('with default settings no recording is linked by the ranker and nothing is written', async () => {
  sales.getSalesClients(); // the first read normalizes the fixture file once
  const before = readFileSync(join(DATA_DIR, 'sales-clients.json'), 'utf8');
  let calls = 0;
  const result = rank.runAutoLinkPass({ settings: settingsStore.getAutomationSettings({ fresh: true }), clients: sales.getSalesClients(), link: () => { calls += 1; return {}; } });
  assert.deepEqual(result, { linked: [], skipped: 'disabled' });
  assert.equal(calls, 0);
  const step = rank.tickSteps.find((entry) => entry.name === 'fireflies-autolink');
  assert.deepEqual(await step.run({ settings: settingsStore.getAutomationSettings({ fresh: true }) }), { wrote: false });
  assert.equal(readFileSync(join(DATA_DIR, 'sales-clients.json'), 'utf8'), before, '0 recordings linked');
  assert.equal(existsSync(join(DATA_DIR, 'fireflies-link-audit')), false);
  // Even with the ranker on, ranking itself never links.
  setSettings({ fireflies: { candidateRanker: { enabled: true } } });
  const rows = rank.candidatesForUnownedRecordings({ clients: sales.getSalesClients() });
  assert.ok(rows.length >= 2);
  assert.equal(readFileSync(join(DATA_DIR, 'sales-clients.json'), 'utf8'), before, 'candidates are computed, nothing linked');
});

test('the signal table: e-mail, domain, booked slot, title, speaker, and not-sold', () => {
  const clients = sales.getSalesClients();
  const [best] = rank.rankRecordingCandidates(ACME_RECORDING, clients, { minScore: 40 });
  assert.equal(best.clientId, 'rk-acme');
  assert.deepEqual(best.signals, { attendeeEmail: 50, attendeeDomain: 30, bookedSlot: 30, titleBusinessName: 20, contactSpeaker: 15 });
  assert.equal(best.score, 145);
  assert.equal(best.confidence, 'high');
  const all = rank.rankRecordingCandidates(ACME_RECORDING, clients, { minScore: -100 });
  const notSold = all.find((row) => row.clientId === 'rk-notsold');
  assert.equal(notSold, undefined, 'a not-sold client with only a partial title match scores below zero');
  const notSoldScore = rank.scoreClientForRecording({ ...ACME_RECORDING, title: 'Acme Bygg Vest' }, NOT_SOLD);
  assert.deepEqual(notSoldScore.signals, { titleBusinessName: 20, notSold: -20 });
  const free = rank.scoreClientForRecording({ ...ACME_RECORDING, attendeeEmails: ['someone@gmail.com'], attendees: [] }, FREEMAIL);
  assert.equal(free.signals.attendeeDomain, undefined, 'a free-mail domain is never a website match');
  const excluded = rank.rankRecordingCandidates({ ...ACME_RECORDING, excludedClientIds: ['rk-acme'] }, clients, { minScore: 0 });
  assert.equal(excluded.some((row) => row.clientId === 'rk-acme'), false, 'an excluded client is never a candidate');
  const titleOnly = rank.rankRecordingCandidates(TITLE_RECORDING, clients, { minScore: 40 });
  assert.equal(titleOnly[0].clientId, 'rk-title');
  assert.equal(titleOnly[0].signals.attendeeEmail, undefined);
});

test('auto-link needs an exact attendee e-mail and a booked slot within 30 minutes; title and name never link', () => {
  setSettings({ fireflies: { autoLink: { enabled: true } } });
  const settings = settingsStore.getAutomationSettings({ fresh: true });
  const clients = sales.getSalesClients();
  assert.deepEqual(rank.autoLinkDecision(TITLE_RECORDING, clients, { settings }), { clientId: '', reason: 'no-match' });
  const farSlot = rank.autoLinkDecision({ ...ACME_RECORDING, startedAt: iso(T + 2 * HOUR) }, clients, { settings });
  assert.equal(farSlot.clientId, '', 'e-mail alone is not enough');
  const ok = rank.autoLinkDecision({ ...ACME_RECORDING, startedAt: iso(T + 20 * 60_000) }, clients, { settings });
  assert.deepEqual(ok, { clientId: 'rk-acme', reason: 'email-and-slot' });
  const twin = { ...ACME, id: 'rk-twin', businessName: 'Twin AS' };
  assert.equal(rank.autoLinkDecision({ ...ACME_RECORDING, startedAt: iso(T + 20 * 60_000) }, [...clients, twin], { settings }).reason, 'ambiguous');

  // The pass links only the recording that passes, through the hub linker, and audits ids only.
  webhook.storeFirefliesMeeting({ ...ACME_RECORDING, meetingId: 'rk-rec-auto', startedAt: iso(T + 20 * 60_000) });
  const result = rank.runAutoLinkPass({ settings, clients, link: (clientId, ref) => linker.link(clientId, ref) });
  assert.deepEqual(result.linked, [{ meetingId: 'rk-rec-auto', clientId: 'rk-acme' }]);
  const acme = sales.getSalesClientById('rk-acme');
  assert.equal(acme.meetings.find((row) => row.meetingId === 'rk-rec-auto').linkedBy, 'email-slot');
  assert.equal(sales.getSalesClientById('rk-title').meetings?.length || 0, 0, 'the title-and-name recording stays unlinked');
  const month = new Date().toISOString().slice(0, 7);
  const lines = readFileSync(join(DATA_DIR, 'fireflies-link-audit', `${month}.jsonl`), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.ok(lines.some((row) => row.action === 'auto-link' && row.meetingId === 'rk-rec-auto' && row.by === 'email-slot'));
  assert.doesNotMatch(JSON.stringify(lines), /@|Acme|Ola/, 'the link audit holds ids only');
  setSettings({ fireflies: { autoLink: { enabled: false } } });
});

test('a person\'s one-click candidate link survives the backfill; an old automatic link does not become trusted', async () => {
  const express = (await import('express')).default;
  const { register } = await import('../lib/routes/privacy-routes.js');
  const app = express();
  app.use(express.json());
  const salesAuth = (req, res, next) => {
    const auth = req.get('authorization');
    if (auth === 'Bearer admin-staff') req.salesUser = { isAdmin: true, accountKey: 'admin:staff@example.com', name: 'Admin' };
    else if (auth === 'Bearer rep') req.salesUser = { isAdmin: false, accountKey: 'sales:rep' };
    else return res.status(401).json({});
    return next();
  };
  await register(app, { salesAuth, adminAuth: (_req, res) => res.status(401).json({}), clientAuth: (_req, res) => res.status(401).json({}), sales, getDataDir: () => DATA_DIR });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (method, path, auth, body) => fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', authorization: auth }, body: body ? JSON.stringify(body) : undefined });
  try {
    const listed = await call('GET', '/api/admin/fireflies/candidates', 'Bearer admin-staff');
    assert.equal(listed.status, 200);
    const body = await listed.json();
    const row = body.recordings.find((entry) => entry.meetingId === 'rk-rec-title');
    assert.equal(row.candidates[0].clientId, 'rk-title');
    assert.ok(body.purposes.includes('demo'));
    assert.equal(body.recordings.some((entry) => entry.meetingId === 'rk-rec-auto'), false, 'a recording on a card is not a candidate row');
    assert.equal((await call('GET', '/api/admin/fireflies/candidates', 'Bearer rep')).status, 403);

    const linked = await call('POST', '/api/admin/fireflies/meetings/rk-rec-title/candidate-link', 'Bearer admin-staff', { clientId: 'rk-title', purpose: 'demo' });
    assert.equal(linked.status, 200);
    const result = await linked.json();
    assert.equal(result.rank, 1);
    assert.equal(result.purpose, 'demo');
    assert.equal(result.linkedBy, 'admin:staff@example.com');
    assert.equal((await call('POST', '/api/admin/fireflies/meetings/rk-rec-title/candidate-link', 'Bearer admin-staff', { clientId: 'rk-acme' })).status, 409, 'owned now');

    // An old automatic link of a recording with no Meet room: the backfill takes it off (unchanged rule).
    webhook.storeFirefliesMeeting({ meetingId: 'rk-rec-old', title: 'Gammel', startedAt: iso(T - 30 * 24 * HOUR), transcript: 'A: b', final: true });
    sales.linkMeetingToSalesClient('rk-acme', webhook.meetingRefForClient(webhook.readStoredFirefliesMeeting('rk-rec-old'), {}, { linkedBy: 'auto' }));
    const plan = linker.backfill();
    assert.ok(plan.unlinks.some((entry) => entry.meetingId === 'rk-rec-old'), 'an old automatic link is not trusted');
    const title = sales.getSalesClientById('rk-title');
    const kept = title.meetings.find((entry) => entry.meetingId === 'rk-rec-title');
    assert.ok(kept, 'the person\'s link survives the backfill');
    assert.equal(kept.purpose, 'demo');
    assert.equal(webhook.readStoredFirefliesMeeting('rk-rec-title').pin.clientId, 'rk-title', 'pinned as a person\'s link');

    setSettings({ fireflies: { candidateRanker: { enabled: false } } });
    const off = await call('GET', '/api/admin/fireflies/candidates', 'Bearer admin-staff');
    assert.equal(off.status, 404);
    assert.equal((await off.json()).code, 'disabled');
    assert.equal((await call('POST', '/api/admin/fireflies/meetings/rk-rec-title/candidate-link', 'Bearer admin-staff', { clientId: 'rk-title' })).status, 404);
  } finally {
    server.close();
  }
});

test('demo is a purpose in every whitelist and survives a save through updateSalesClient', () => {
  assert.ok(MEETING_PURPOSES.includes('demo'));
  assert.equal(sanitizeMeetingPurpose('Demo'), 'demo');
  assert.equal(webhook.meetingRefForClient({ meetingId: 'x', purpose: 'demo' }).purpose, 'demo');
  const client = sales.getSalesClientById('rk-title');
  const meetings = client.meetings.map((row) => ({ ...row, purpose: 'demo' }));
  sales.updateSalesClient('rk-title', { meetings, notes: 'oppdatert' });
  const after = sales.getSalesClientById('rk-title');
  assert.equal(after.meetings.find((row) => row.meetingId === 'rk-rec-title').purpose, 'demo');
  const stored = JSON.parse(readFileSync(join(DATA_DIR, 'sales-clients.json'), 'utf8')).find((row) => row.id === 'rk-title');
  assert.equal(stored.meetings.find((row) => row.meetingId === 'rk-rec-title').purpose, 'demo');
});

test('the labelled-set eval script reports top-1 accuracy with ids only', () => {
  const labels = join(DATA_DIR, 'labels.json');
  writeFileSync(labels, JSON.stringify({
    clients: [ACME, TITLE_ONLY, NOT_SOLD],
    recordings: [
      { record: ACME_RECORDING, clientId: 'rk-acme' },
      { record: TITLE_RECORDING, clientId: 'rk-title' },
    ],
  }));
  const out = join(DATA_DIR, 'rank-report.json');
  const script = fileURLToPath(new URL('./eval/fireflies-rank.mjs', import.meta.url));
  const stdout = execFileSync(process.execPath, [script, labels, '--out', out], { encoding: 'utf8', env: { ...process.env, APP_DATA_DIR: '' } });
  assert.match(stdout, /top-1 2 \(100\.0%\)/);
  const report = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(report.top1Rate, 1);
  assert.doesNotMatch(JSON.stringify(report), /example|Acme|Ola/);
  assert.ok(readdirSync(DATA_DIR).includes('sales-clients.json'));
});
