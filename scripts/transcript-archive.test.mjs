// Transcript archive: archived on link and deleted on unlink only with privacy.archive on; nothing is
// written while it is off; the copy outlives the Fireflies record (pruned a year after its last
// change) while the client's retention date is ahead, and the purge removes it once that date passes.
// Synthetic clients and recordings on a temp data dir; the real linker (lib/fireflies-linking.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'asoldi-transcript-archive-'));
process.env.APP_DATA_DIR = DATA_DIR;
delete process.env.DATA_DIR;

const DAY = 86_400_000;
const NOW = Date.now();
const iso = (ms) => new Date(ms).toISOString();

writeFileSync(join(DATA_DIR, 'sales-clients.json'), JSON.stringify([
  {
    id: 'ta-signed',
    product: 'asoldi',
    businessName: 'Testverkstedet AS',
    contactEmail: 'verksted@example.com',
    status: 'active',
    progression: { meetingHeld: true, offerSent: true, contractSigned: true },
    contractSignedAt: iso(NOW - 2 * DAY),
  },
  { id: 'ta-lead', product: 'asoldi', businessName: 'Testkafeen AS', contactEmail: 'kafe@example.com', status: 'active' },
], null, 2));

const webhook = await import('../lib/fireflies-webhook.js');
const sales = await import('../data/sales.js');
const settingsStore = await import('../data/automation-settings.js');
const { createFirefliesLinker } = await import('../lib/fireflies-linking.js');
const { privacyOnLinked, privacyOnUnlinked } = await import('../lib/privacy-link-hooks.js');
const archive = await import('../lib/transcript-archive.js');
const retention = await import('../lib/delivery-retention.js');

const linker = createFirefliesLinker({
  sales,
  log: { warn() {} },
  onLinked: (clientId, meetingId, info) => privacyOnLinked(clientId, meetingId, info),
  onUnlinked: (clientId, meetingId) => privacyOnUnlinked(clientId, meetingId),
});

const TRANSCRIPT = 'Kunde: Vi vil ha en nettside med booking.\nSelger: Det ordner vi.';
function record(meetingId, transcript = TRANSCRIPT) {
  return {
    meetingId,
    title: 'Oppstartsmøte',
    startedAt: iso(NOW - DAY),
    durationMinutes: 30,
    attendees: ['Test Kunde <verksted@example.com>'],
    attendeeEmails: ['verksted@example.com'],
    hostEmail: 'host@example.com',
    transcript,
    summary: 'Nettside med booking.',
    actionItems: ['Send tilbud'],
    keywords: ['booking'],
    final: true,
  };
}

function personRef(stored, clientId) {
  return webhook.meetingRefForClient(stored, { clientId, confidence: 'manual', score: 100, reasons: ['test'] }, { linkedBy: 'admin:test' });
}

function archiveFiles(clientId) {
  const dir = join(DATA_DIR, 'transcript-archive', clientId);
  return existsSync(dir) ? readdirSync(dir) : [];
}

function setSettings(patch) {
  const result = settingsStore.saveAutomationSettings(patch);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
}

test('with privacy.archive off (the default) link and unlink write nothing to the archive or the link audit', () => {
  const stored = webhook.storeFirefliesMeeting(record('ff-off'));
  linker.link('ta-signed', personRef(stored, 'ta-signed'));
  assert.ok(sales.getSalesClientById('ta-signed').meetings.some((row) => row.meetingId === 'ff-off'), 'the link itself happened');
  assert.equal(existsSync(join(DATA_DIR, 'transcript-archive')), false);
  assert.equal(existsSync(join(DATA_DIR, 'fireflies-link-audit')), false);
  linker.unlinkFromHolder('ff-off');
  assert.equal(existsSync(join(DATA_DIR, 'transcript-archive')), false);
  assert.equal(existsSync(join(DATA_DIR, 'secrets')), false);
});

test('with privacy.archive on, a link archives the transcript (content-addressed, written once)', () => {
  setSettings({ privacy: { archive: { enabled: true } } });
  const stored = webhook.storeFirefliesMeeting(record('ff-1'));
  linker.link('ta-signed', personRef(stored, 'ta-signed'));
  const sha = archive.transcriptSha(TRANSCRIPT);
  assert.deepEqual(archiveFiles('ta-signed'), [`${sha}.json`]);
  const entry = JSON.parse(readFileSync(join(DATA_DIR, 'transcript-archive', 'ta-signed', `${sha}.json`), 'utf8'));
  assert.equal(entry.meetingId, 'ff-1');
  assert.equal(entry.transcript, TRANSCRIPT);
  assert.equal(entry.sha256, sha);
  assert.equal(entry.linkedBy, 'admin:test');
  assert.equal(entry.retainBasis, 'contract-active');
  assert.equal(entry.retainUntil, '');
  for (const key of ['meetingId', 'purpose', 'title', 'startedAt', 'durationMinutes', 'attendees', 'hostEmail', 'transcript', 'summary', 'actionItems', 'keywords', 'sha256', 'archivedAt', 'linkedBy', 'retainUntil']) {
    assert.ok(Object.prototype.hasOwnProperty.call(entry, key), key);
  }
  const archivedAt = entry.archivedAt;
  linker.link('ta-signed', personRef(stored, 'ta-signed'));
  const again = JSON.parse(readFileSync(join(DATA_DIR, 'transcript-archive', 'ta-signed', `${sha}.json`), 'utf8'));
  assert.equal(again.archivedAt, archivedAt, 'written once');
  assert.deepEqual(archive.readArchivedTranscripts('ta-signed').map((row) => row.meetingId), ['ff-1']);
});

test('a newer transcript of the same meeting replaces the older copy', () => {
  const longer = `${TRANSCRIPT}\nKunde: Og nettbutikk.`;
  const stored = webhook.storeFirefliesMeeting(record('ff-1', longer));
  linker.link('ta-signed', personRef(stored, 'ta-signed'));
  assert.deepEqual(archiveFiles('ta-signed'), [`${archive.transcriptSha(longer)}.json`]);
});

test('the archive survives the pruning of a 400-day-old Fireflies record while retainUntil is ahead', async () => {
  const sha = archive.transcriptSha(`${TRANSCRIPT}\nKunde: Og nettbutikk.`);
  // A write 400 days later prunes records whose last change is more than a year old.
  webhook.storeFirefliesMeeting({ meetingId: 'ff-later', title: 'Senere', transcript: 'A: b' }, { nowMs: NOW + 400 * DAY });
  assert.equal(webhook.readStoredFirefliesMeeting('ff-1'), null, 'the Fireflies record is gone');
  const fromArchive = archive.readTranscriptBySha('ta-signed', sha);
  assert.equal(fromArchive.source, 'archive');
  assert.match(fromArchive.transcript, /nettbutikk/);

  setSettings({ privacy: { purge: { enabled: true, mode: 'auto' } } });
  const kept = await retention.runRetentionPurge({ settings: settingsStore.getAutomationSettings({ fresh: true }), now: new Date(NOW + 400 * DAY), force: true });
  assert.equal(kept.counts['transcript-archive'], 0);
  assert.deepEqual(archiveFiles('ta-signed'), [`${sha}.json`], 'kept while the contract runs');

  // The contract ends 100 days in: kept until a year after that, purged once that has passed.
  const clients = JSON.parse(readFileSync(join(DATA_DIR, 'sales-clients.json'), 'utf8'));
  for (const client of clients) if (client.id === 'ta-signed') client.delivery = { stage: 'live', overlay: 'cancelled', cancelledAt: iso(NOW + 100 * DAY) };
  writeFileSync(join(DATA_DIR, 'sales-clients.json'), JSON.stringify(clients, null, 2));
  const stillKept = await retention.runRetentionPurge({ settings: settingsStore.getAutomationSettings({ fresh: true }), now: new Date(NOW + 400 * DAY), force: true });
  assert.equal(stillKept.counts['transcript-archive'], 0, 'contract end + 12 months is ahead at day 400');
  assert.equal(archiveFiles('ta-signed').length, 1);
  const purged = await retention.runRetentionPurge({ settings: settingsStore.getAutomationSettings({ fresh: true }), now: new Date(NOW + 480 * DAY), force: true });
  assert.equal(purged.counts['transcript-archive'], 1);
  assert.deepEqual(archiveFiles('ta-signed'), [], 'purged after retainUntil');
  assert.equal(archive.readTranscriptBySha('ta-signed', sha), null);
  setSettings({ privacy: { purge: { enabled: false, mode: 'shadow' } } });
});

test('readTranscriptBySha falls back to the stored Fireflies meeting', () => {
  const stored = webhook.storeFirefliesMeeting(record('ff-lead', 'Kafe: Vi trenger meny.'));
  linker.link('ta-lead', personRef(stored, 'ta-lead'));
  const sha = archive.transcriptSha('Kafe: Vi trenger meny.');
  archive.deleteArchivedTranscripts('ta-lead', 'ff-lead');
  const fallback = archive.readTranscriptBySha('ta-lead', sha);
  assert.equal(fallback.source, 'fireflies');
  assert.equal(fallback.meetingId, 'ff-lead');
  assert.equal(archive.readTranscriptBySha('ta-lead', 'f'.repeat(64)), null);
  assert.equal(archive.readTranscriptBySha('../x', sha), null);
});

test('an unlink deletes the archived copy; a move archives it under the new client only', () => {
  const stored = webhook.storeFirefliesMeeting(record('ff-move', 'Flytt: tekst.'));
  linker.link('ta-lead', personRef(stored, 'ta-lead'));
  const sha = archive.transcriptSha('Flytt: tekst.');
  assert.ok(archiveFiles('ta-lead').includes(`${sha}.json`));
  linker.link('ta-signed', personRef(stored, 'ta-signed'));
  assert.equal(archiveFiles('ta-lead').includes(`${sha}.json`), false, 'gone from the card it left');
  assert.ok(archiveFiles('ta-signed').includes(`${sha}.json`));
  linker.unlinkFromHolder('ff-move');
  assert.equal(archiveFiles('ta-signed').includes(`${sha}.json`), false, 'unlink deletes it');
});

test('the backfill is a dry run by default and archives what is missing with --apply', async () => {
  const stored = webhook.storeFirefliesMeeting(record('ff-backfill', 'Backfill: tekst.'));
  setSettings({ privacy: { archive: { enabled: false } } });
  linker.link('ta-lead', personRef(stored, 'ta-lead'));
  const sha = archive.transcriptSha('Backfill: tekst.');
  assert.equal(archiveFiles('ta-lead').includes(`${sha}.json`), false);
  const dry = archive.syncTranscriptArchive();
  assert.ok(dry.planned.some((row) => row.meetingId === 'ff-backfill'));
  assert.equal(dry.written, 0);
  assert.equal(archiveFiles('ta-lead').includes(`${sha}.json`), false, 'dry run writes nothing');
  const { execFileSync } = await import('node:child_process');
  const script = fileURLToPath(new URL('./backfill-transcript-archive.mjs', import.meta.url));
  const env = { ...process.env, APP_DATA_DIR: DATA_DIR };
  const out = execFileSync(process.execPath, [script], { env, encoding: 'utf8' });
  assert.match(out, /dry run/i);
  assert.match(out, /ta-lead ff-backfill/);
  assert.equal(archiveFiles('ta-lead').includes(`${sha}.json`), false);
  const applied = execFileSync(process.execPath, [script, '--apply'], { env, encoding: 'utf8' });
  assert.match(applied, /apply: \d+ recording\(s\) without an archived copy, \d+ written/);
  assert.match(applied, /ta-lead ff-backfill/);
  assert.ok(archiveFiles('ta-lead').includes(`${sha}.json`));
  const step = archive.tickSteps[0];
  assert.deepEqual(await step.run({ settings: settingsStore.getAutomationSettings({ fresh: true }) }), { wrote: false }, 'the sync step does nothing while the switch is off');
});
