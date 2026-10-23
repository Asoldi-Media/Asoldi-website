// WS8.10: automation settings store and routes (shadow -> auto, no approval queue).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'asoldi-automation-settings-'));
process.env.APP_DATA_DIR = DATA_DIR;
delete process.env.WORKSHOP_DESK_EMAIL_AUTOSEND;

const store = await import('../data/automation-settings.js');
const vocab = await import('../packages/suite/core/delivery/vocab.js');
const {
  preWorkshopAutosendForClient,
  workshopDeskEmailAutosendEnabled,
  workshopDeskEmailAutosendForClient,
  workshopReminderClients,
} = await import('../lib/workshop-desk-emails.js');
const { INBOX_BOT_MAILBOXES } = await import('../lib/gmail-readonly.js');

const FILE = join(DATA_DIR, store.AUTOMATION_SETTINGS_FILE);

function reset() {
  rmSync(FILE, { force: true });
  store.invalidateAutomationSettingsCache();
}

function getPath(obj, path) {
  return path.split('.').reduce((node, key) => (node && typeof node === 'object' ? node[key] : undefined), obj);
}

function errorPaths(result) {
  return result.errors.map((error) => error.path);
}

test('defaults reproduce today: legacy pre-workshop autosend only, no new autosend, no auto-queue', () => {
  reset();
  const view = store.automationSettingsView();
  assert.equal(view.stored, false);
  const autos = Object.entries(view.effective.emails).filter(([, entry]) => entry.mode === 'auto').map(([kind]) => kind);
  assert.deepEqual(autos, ['preWorkshop']);
  assert.equal(view.settings.emails.preWorkshop.lines, 'legacy');
  assert.equal(view.effective.emails.workshopReminders.mode, 'off');
  for (const kind of vocab.EMAIL_KINDS.filter((entry) => !entry.legacy)) {
    assert.ok(['off', 'shadow'].includes(view.effective.emails[kind.id].mode), kind.id);
  }
  assert.equal(view.effective.development.autoQueue, false);
  assert.equal(view.effective.publish.staging.mode, 'shadow');
  assert.equal(view.effective.publish.production.mode, 'shadow');
  assert.deepEqual(view.settings.pilotClientIds, []);
  // The inbox bot reads the same mailboxes as today.
  assert.deepEqual(view.settings.inbox.mailboxes, INBOX_BOT_MAILBOXES);
  assert.equal(workshopDeskEmailAutosendEnabled(), false);
  assert.equal(store.validateAutomationSettings({}).ok, true, 'the defaults validate');
  assert.equal(view.settings.lifecycle.cancellationGraceDays, 30);
});

test('validation: mailboxes on the allowlist, replyTo among them, enums, thresholds and unknown keys', () => {
  reset();
  const bad = store.validateAutomationSettings({ inbox: { mailboxes: ['someone@gmail.com'] } });
  assert.equal(bad.ok, false);
  assert.ok(errorPaths(bad).includes('inbox.mailboxes'));

  const reply = store.validateAutomationSettings({ sender: { service: { replyTo: 'damian@asoldi.com' } } });
  assert.ok(errorPaths(reply).includes('sender.service.replyTo'), 'replyTo must be a read mailbox');
  const both = store.validateAutomationSettings({
    inbox: { mailboxes: ['alexander@asoldi.com', 'damian@asoldi.com'], autoActions: { 'damian@asoldi.com': true } },
    sender: { service: { replyTo: 'damian@asoldi.com' } },
  });
  assert.equal(both.ok, true, JSON.stringify(both.errors));
  // A partial map keeps the other mailbox's value; a newly listed mailbox starts off.
  assert.deepEqual(both.value.inbox.autoActions, { 'alexander@asoldi.com': true, 'damian@asoldi.com': true });
  assert.deepEqual(both.value.inbox.autoReply, { 'alexander@asoldi.com': true, 'damian@asoldi.com': false });

  const stray = store.validateAutomationSettings({ inbox: { autoReply: { 'damian@asoldi.com': true } } });
  assert.ok(errorPaths(stray).includes('inbox.autoReply'));

  const many = store.validateAutomationSettings({
    emails: { postWorkshop: { delayMinutes: -5, mode: 'sometimes' }, nurture: { cadenceDays: [180, 90] } },
    fireflies: { candidateRanker: { candidateMinScore: 101 } },
    alerts: { digestAt: '25:00', to: 'not-an-email' },
    changeRequests: { countAt: 'done' },
    publish: { staging: { tiers: ['tier-9'] } },
    pilotClientIds: ['ok-id', 'bad id!'],
    development: { autoQueue: 'yes' },
    emailz: { typo: true },
  });
  assert.equal(many.ok, false);
  for (const path of [
    'emails.postWorkshop.delayMinutes', 'emails.postWorkshop.mode', 'emails.nurture.cadenceDays',
    'fireflies.candidateRanker.candidateMinScore', 'alerts.digestAt', 'alerts.to', 'changeRequests.countAt',
    'publish.staging.tiers', 'pilotClientIds', 'development.autoQueue', 'emailz.typo',
  ]) {
    assert.ok(errorPaths(many).includes(path), `expected an error for ${path}: ${JSON.stringify(many.errors)}`);
  }
});

test('approve and manual are old names for shadow; there is no approval mode', () => {
  reset();
  const result = store.saveAutomationSettings({ emails: { postWorkshop: { mode: 'approve' }, siteLive: { mode: 'manual' } } }, { by: 'test' });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.settings.emails.postWorkshop.mode, 'shadow');
  assert.equal(result.settings.emails.siteLive.mode, 'shadow');
});

test('a release-gated switch reaches auto only after the pre-release suite passed', () => {
  reset();
  const early = store.saveAutomationSettings({ emails: { preWorkshop: { lines: 'gate', mode: 'auto' } } });
  assert.equal(early.ok, false);
  assert.ok(errorPaths(early).includes('emails.preWorkshop.gate'));
  const siteLive = store.saveAutomationSettings({ emails: { siteLive: { mode: 'auto' } } });
  assert.ok(errorPaths(siteLive).includes('emails.siteLive'));
  const queue = store.saveAutomationSettings({ development: { autoQueue: true } });
  assert.ok(errorPaths(queue).includes('development.autoQueue'));
  const publish = store.saveAutomationSettings({ publish: { production: { mode: 'auto' } } });
  assert.ok(errorPaths(publish).includes('publish.production'));
  // Gate lines in shadow are fine before the pass.
  assert.equal(store.saveAutomationSettings({ emails: { preWorkshop: { lines: 'gate', mode: 'shadow' } } }).ok, true);

  // A PUT cannot forge a release pass.
  const forged = store.saveAutomationSettings({ releases: { 'emails.siteLive': { passedAt: '2026-10-23T00:00:00Z' } } });
  assert.ok(errorPaths(forged).includes('releases'));

  // The suite records a pass; with promotion.auto the switch is promoted in the same write.
  assert.equal(store.recordReleasePass('emails.preWorkshop.gate', { suite: '' }).ok, false);
  assert.equal(store.recordReleasePass('emails.preWorkshop', { suite: 'x' }).ok, false, 'legacy kinds are not gated');
  const passed = store.recordReleasePass('emails.preWorkshop.gate', { suite: 'golden+outbox+canary', evidence: 'run 42' });
  assert.equal(passed.ok, true);
  assert.equal(passed.settings.emails.preWorkshop.lines, 'gate');
  assert.equal(passed.settings.emails.preWorkshop.mode, 'auto');
  assert.ok(passed.settings.releases['emails.preWorkshop.gate'].passedAt);
  assert.equal(store.saveAutomationSettings({ emails: { preWorkshop: { lines: 'gate', mode: 'auto' } } }).ok, true);

  // With promotion.auto off, a pass only records; a person then switches to auto.
  assert.equal(store.saveAutomationSettings({ promotion: { auto: false } }).ok, true);
  const recorded = store.recordReleasePass('emails.siteLive', { suite: 'golden' });
  assert.equal(recorded.settings.emails.siteLive.mode, 'shadow');
  assert.equal(store.saveAutomationSettings({ emails: { siteLive: { mode: 'auto' } } }).ok, true);
  assert.equal(store.effectiveEmailMode('siteLive'), 'auto');
});

test('WORKSHOP_DESK_EMAIL_AUTOSEND=1 still overrides and is reported as overriddenBy env', () => {
  reset();
  process.env.WORKSHOP_DESK_EMAIL_AUTOSEND = '1';
  try {
    assert.equal(workshopDeskEmailAutosendEnabled(), true);
    const view = store.automationSettingsView();
    assert.deepEqual(view.effective.emails.workshopReminders, { mode: 'auto', overriddenBy: 'env', env: 'WORKSHOP_DESK_EMAIL_AUTOSEND' });
    assert.deepEqual(view.envOverrides, [{ path: 'emails.workshopReminders', env: 'WORKSHOP_DESK_EMAIL_AUTOSEND', overriddenBy: 'env' }]);
  } finally {
    delete process.env.WORKSHOP_DESK_EMAIL_AUTOSEND;
  }
  assert.equal(workshopDeskEmailAutosendEnabled(), false);
  assert.deepEqual(store.automationSettingsView().envOverrides, []);
});

test('workshop reminders follow the setting; a runtime guard pause stops them until resumed', () => {
  reset();
  assert.equal(store.saveAutomationSettings({ emails: { workshopReminders: { enabled: true } } }, { by: 'superadmin' }).ok, true);
  assert.equal(workshopDeskEmailAutosendEnabled(), true);

  assert.equal(store.pauseAutomationSwitch('emails.workshopReminders', { reason: '' }).ok, false);
  assert.equal(store.pauseAutomationSwitch('development.autoQueue', { reason: 'x' }).ok, false);
  const paused = store.pauseAutomationSwitch('emails.workshopReminders', { reason: 'bounce rate 9 % over 24 h', now: new Date('2026-11-01T08:00:00Z') });
  assert.equal(paused.ok, true);
  assert.equal(store.effectiveEmailMode('workshopReminders'), 'paused');
  assert.equal(workshopDeskEmailAutosendEnabled(), false);
  const { audit } = store.readAutomationSettingsFile();
  assert.equal(audit.at(-1).source, 'guard');
  assert.equal(audit.at(-1).changes[0].path, 'emails.workshopReminders.paused');

  assert.equal(store.resumeAutomationSwitch('emails.workshopReminders', { by: 'dev' }).ok, true);
  assert.equal(workshopDeskEmailAutosendEnabled(), true);
  // A PUT can also resume (paused: null) or pause with a reason.
  assert.equal(store.saveAutomationSettings({ emails: { workshopReminders: { paused: { reason: 'checking a complaint' } } } }).ok, true);
  assert.equal(store.effectiveEmailMode('workshopReminders'), 'paused');
  assert.equal(store.saveAutomationSettings({ emails: { workshopReminders: { paused: null } } }).ok, true);
  assert.equal(store.effectiveEmailMode('workshopReminders'), 'auto');
  assert.equal(store.saveAutomationSettings({ emails: { workshopReminders: { paused: { at: 'x' } } } }).ok, false, 'a pause needs a reason');
});

test('WORKSHOP_DESK_EMAIL_AUTOSEND=1 overrides enabled and mode only: a runtime guard pause still stops reminders', () => {
  reset();
  process.env.WORKSHOP_DESK_EMAIL_AUTOSEND = '1';
  try {
    assert.equal(workshopDeskEmailAutosendEnabled(), true, 'env=1 without a pause sends');
    assert.equal(store.pauseAutomationSwitch('emails.workshopReminders', { reason: 'bounces' }).ok, true);
    assert.equal(store.automationSettingsView().effective.emails.workshopReminders.mode, 'paused');
    assert.equal(workshopDeskEmailAutosendEnabled(), false, 'env=1 plus a pause does not send');
    assert.equal(workshopDeskEmailAutosendForClient({ id: 'real-1', status: 'active' }), false);
    assert.equal(store.resumeAutomationSwitch('emails.workshopReminders', { by: 'dev' }).ok, true);
    assert.equal(workshopDeskEmailAutosendEnabled(), true);
  } finally {
    delete process.env.WORKSHOP_DESK_EMAIL_AUTOSEND;
  }
});

test('workshop reminders and the pre-workshop autosend skip test clients unless they are pilots', () => {
  reset();
  const real = { id: 'real-1', status: 'active' };
  const testClient = { id: 'test-1', status: 'active', isTest: true };
  const inactive = { id: 'old-1', status: 'archived' };
  const clients = [real, testClient, inactive];

  // Reminders off (default): nobody is mailed.
  assert.deepEqual(workshopReminderClients(clients), []);
  assert.equal(store.saveAutomationSettings({ emails: { workshopReminders: { enabled: true } } }).ok, true);
  assert.deepEqual(workshopReminderClients(clients).map((client) => client.id), ['real-1']);
  assert.equal(workshopDeskEmailAutosendForClient(testClient), false);
  assert.equal(preWorkshopAutosendForClient(real), true);
  assert.equal(preWorkshopAutosendForClient(testClient), false);

  // Listed as a pilot, the test client takes part; legacy kinds ignore the pilot list for others.
  assert.equal(store.saveAutomationSettings({ pilotClientIds: ['test-1'] }).ok, true);
  assert.deepEqual(workshopReminderClients(clients).map((client) => client.id), ['real-1', 'test-1']);
  assert.equal(preWorkshopAutosendForClient(testClient), true);
  assert.equal(preWorkshopAutosendForClient(real), true);

  // A pause stops both kinds for everyone.
  assert.equal(store.pauseAutomationSwitch('emails.workshopReminders', { reason: 'complaint' }).ok, true);
  assert.equal(store.pauseAutomationSwitch('emails.preWorkshop', { reason: 'complaint' }).ok, true);
  assert.deepEqual(workshopReminderClients(clients), []);
  assert.equal(preWorkshopAutosendForClient(real), false);
});

test('a mailbox added to the inbox maps can be removed again (save and rollback)', () => {
  reset();
  const added = store.saveAutomationSettings({
    inbox: {
      mailboxes: ['alexander@asoldi.com', 'damian@asoldi.com'],
      autoActions: { 'alexander@asoldi.com': true, 'damian@asoldi.com': true },
      autoReply: { 'alexander@asoldi.com': true, 'damian@asoldi.com': false },
    },
  });
  assert.equal(added.ok, true, JSON.stringify(added.errors));
  assert.deepEqual(Object.keys(added.settings.inbox.autoActions), ['alexander@asoldi.com', 'damian@asoldi.com']);

  // Mailboxes only: the inherited per-mailbox entries for damian@ go with it.
  const removed = store.saveAutomationSettings({ inbox: { mailboxes: ['alexander@asoldi.com'] } });
  assert.equal(removed.ok, true, JSON.stringify(removed.errors));
  assert.deepEqual(removed.settings.inbox.autoActions, { 'alexander@asoldi.com': true });
  assert.deepEqual(removed.settings.inbox.autoReply, { 'alexander@asoldi.com': true });
  const stored = JSON.parse(readFileSync(FILE, 'utf8'));
  assert.deepEqual(stored.inbox.mailboxes, ['alexander@asoldi.com']);
  assert.deepEqual(stored.inbox.autoActions, { 'alexander@asoldi.com': true });

  // Rollback with the full old values (the runbook) works too.
  assert.equal(store.saveAutomationSettings({ inbox: added.settings.inbox }).ok, true);
  const rollback = store.saveAutomationSettings({
    inbox: { mailboxes: ['alexander@asoldi.com'], autoActions: { 'alexander@asoldi.com': true }, autoReply: { 'alexander@asoldi.com': false } },
  });
  assert.equal(rollback.ok, true, JSON.stringify(rollback.errors));
  assert.deepEqual(rollback.settings.inbox.autoReply, { 'alexander@asoldi.com': false });

  // A map entry sent explicitly for a mailbox that is not listed is still an error, not dropped.
  const typo = store.saveAutomationSettings({ inbox: { mailboxes: ['alexander@asoldi.com'], autoActions: { 'damain@asoldi.com': true } } });
  assert.equal(typo.ok, false);
  assert.ok(errorPaths(typo).includes('inbox.autoActions'));
  // replyTo must follow: removing the mailbox replyTo points at is refused with a clear path.
  assert.equal(store.saveAutomationSettings({ inbox: added.settings.inbox, sender: { service: { replyTo: 'damian@asoldi.com' } } }).ok, true);
  const orphan = store.saveAutomationSettings({ inbox: { mailboxes: ['alexander@asoldi.com'] } });
  assert.equal(orphan.ok, false);
  assert.deepEqual(errorPaths(orphan), ['sender.service.replyTo']);
  assert.equal(store.saveAutomationSettings({ inbox: { mailboxes: ['alexander@asoldi.com'] }, sender: { service: { replyTo: 'alexander@asoldi.com' } } }).ok, true);
});

test('a partial per-mailbox map changes only the mailboxes it names', () => {
  reset();
  const both = ['alexander@asoldi.com', 'damian@asoldi.com'];
  // Adding a mailbox without map entries: it starts off in both maps, alexander@ keeps its values.
  const added = store.saveAutomationSettings({ inbox: { mailboxes: both } });
  assert.equal(added.ok, true, JSON.stringify(added.errors));
  assert.deepEqual(added.settings.inbox.autoActions, { 'alexander@asoldi.com': true, 'damian@asoldi.com': false });
  assert.deepEqual(added.settings.inbox.autoReply, { 'alexander@asoldi.com': true, 'damian@asoldi.com': false });

  // The reviewer's case: one entry for damian@ must not remove alexander@'s flag.
  const partial = store.saveAutomationSettings({ inbox: { autoReply: { 'damian@asoldi.com': true } } });
  assert.equal(partial.ok, true, JSON.stringify(partial.errors));
  assert.deepEqual(partial.settings.inbox.autoReply, { 'alexander@asoldi.com': true, 'damian@asoldi.com': true });
  assert.deepEqual(partial.changes, [{ path: 'inbox.autoReply', from: { 'alexander@asoldi.com': true, 'damian@asoldi.com': false }, to: { 'alexander@asoldi.com': true, 'damian@asoldi.com': true } }]);
  const stored = JSON.parse(readFileSync(FILE, 'utf8'));
  assert.deepEqual(stored.inbox.autoReply, { 'alexander@asoldi.com': true, 'damian@asoldi.com': true });
  assert.deepEqual(stored.inbox.autoActions, { 'alexander@asoldi.com': true, 'damian@asoldi.com': false });

  // Turning one mailbox off leaves the other one on.
  const off = store.saveAutomationSettings({ inbox: { autoActions: { 'alexander@asoldi.com': false } } });
  assert.equal(off.ok, true, JSON.stringify(off.errors));
  assert.deepEqual(off.settings.inbox.autoActions, { 'alexander@asoldi.com': false, 'damian@asoldi.com': false });
  assert.deepEqual(off.settings.inbox.autoReply, { 'alexander@asoldi.com': true, 'damian@asoldi.com': true });

  // Every read gives one entry per listed mailbox, even for a hand-edited file that lacks one.
  writeFileSync(FILE, JSON.stringify({ inbox: { mailboxes: both, autoActions: { 'damian@asoldi.com': true }, autoReply: {} } }));
  store.invalidateAutomationSettingsCache();
  const read = store.getAutomationSettings({ fresh: true });
  assert.deepEqual(read.inbox.autoActions, { 'alexander@asoldi.com': true, 'damian@asoldi.com': true });
  assert.deepEqual(read.inbox.autoReply, { 'alexander@asoldi.com': true, 'damian@asoldi.com': false });
});

test('audit keeps the last 50 changes, with who and what; unchanged saves add nothing', () => {
  reset();
  for (let i = 0; i < 55; i += 1) {
    assert.equal(store.saveAutomationSettings({ guards: { minSample: (i % 50) + 2 } }, { by: `user${i}` }).ok, true);
  }
  const { audit } = store.readAutomationSettingsFile();
  assert.equal(audit.length, 50);
  assert.equal(audit.at(-1).by, 'user54');
  // i = 54 sets (54 % 50) + 2 = 6 after i = 53 set 5.
  assert.deepEqual(audit.at(-1).changes, [{ path: 'guards.minSample', from: 5, to: 6 }]);
  const before = readFileSync(FILE, 'utf8');
  assert.deepEqual(store.saveAutomationSettings({ guards: { minSample: 6 } }).changes, []);
  assert.equal(readFileSync(FILE, 'utf8'), before);
});

test('reads are cached for 10 s and a save invalidates the cache', () => {
  reset();
  const t0 = 1_000_000;
  assert.equal(store.getAutomationSettings({ nowMs: t0 }).pricing.oneTimeMultiplier, 9);
  writeFileSync(FILE, JSON.stringify({ pricing: { oneTimeMultiplier: 12 } }));
  assert.equal(store.getAutomationSettings({ nowMs: t0 + 9_000 }).pricing.oneTimeMultiplier, 9, 'cached');
  assert.equal(store.getAutomationSettings({ nowMs: t0 + 10_001 }).pricing.oneTimeMultiplier, 12, 'expired');
  store.saveAutomationSettings({ pricing: { oneTimeMultiplier: 10 } });
  assert.equal(store.getAutomationSettings({ nowMs: t0 + 10_002 }).pricing.oneTimeMultiplier, 10, 'invalidated on save');
});

test('keys a later batch stored are kept on save, not rejected', () => {
  reset();
  writeFileSync(FILE, JSON.stringify({ emails: { futureKind: { enabled: true, mode: 'shadow' } }, futureGroup: { a: 1 } }));
  store.invalidateAutomationSettingsCache();
  const saved = store.saveAutomationSettings({ guards: { minSample: 7 } });
  assert.equal(saved.ok, true, JSON.stringify(saved.errors));
  const stored = JSON.parse(readFileSync(FILE, 'utf8'));
  assert.deepEqual(stored.emails.futureKind, { enabled: true, mode: 'shadow' });
  assert.deepEqual(stored.futureGroup, { a: 1 });
});

test('pilots and test clients: test clients only as pilots; non-pilots run in shadow', () => {
  reset();
  store.recordReleasePass('emails.postWorkshop', { suite: 'golden' });
  const settings = store.getAutomationSettings({ fresh: true });
  assert.equal(settings.emails.postWorkshop.mode, 'auto');
  const real = { id: 'real-1' };
  const testClient = { id: 'test-1', isTest: true };

  assert.deepEqual(store.automationScopeForClient(real, { settings }), { included: true, live: true, pilot: false, reason: '' });
  assert.equal(store.automationScopeForClient(testClient, { settings }).included, false);
  assert.equal(store.effectiveModeForClient('emails.postWorkshop', real, { settings }), 'auto');
  assert.equal(store.effectiveModeForClient('emails.postWorkshop', testClient, { settings }), 'off');

  assert.equal(store.saveAutomationSettings({ pilotClientIds: ['test-1'] }).ok, true);
  const piloted = store.getAutomationSettings({ fresh: true });
  assert.equal(store.effectiveModeForClient('emails.postWorkshop', testClient, { settings: piloted }), 'auto');
  assert.equal(store.effectiveModeForClient('emails.postWorkshop', real, { settings: piloted }), 'shadow', 'non-pilots run in shadow');
  assert.equal(store.effectiveModeForClient('emails.preWorkshop', real, { settings: piloted }), 'auto', 'legacy kinds keep running');
});

test('every settings key in the vocabulary exists in the defaults, and every default leaf is named', () => {
  const defaults = store.defaultAutomationSettings();
  for (const path of Object.values(vocab.SETTINGS_KEYS)) {
    assert.notEqual(getPath(defaults, path), undefined, `${path} missing from the defaults`);
  }
  const named = new Set(Object.values(vocab.SETTINGS_KEYS));
  for (const kind of vocab.EMAIL_KIND_IDS) {
    for (const field of vocab.EMAIL_SETTINGS_FIELDS) named.add(vocab.emailSettingsPath(kind, field));
    assert.ok(defaults.emails[kind], kind);
  }
  const walk = (obj, prefix = '') => Object.entries(obj).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    if (['version', 'releases'].includes(path) || /\.paused$/.test(path) || /^inbox\.auto(Actions|Reply)$/.test(path)) return [];
    return value && typeof value === 'object' && !Array.isArray(value) ? walk(value, path) : [path];
  });
  const unnamed = walk(defaults).filter((path) => !named.has(path) && !/^publish\.(staging|production)\.paused$/.test(path));
  assert.deepEqual(unnamed, []);
});

