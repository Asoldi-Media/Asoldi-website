// Spine safety: a delivery spine switch runs in auto for a client only when the client is a pilot and
// the pre-release suite has recorded a pass for the switch; settings refuse auto on a pilot-only switch
// while the pilot list is empty, and before the switch has a pass.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'asoldi-spine-mode-'));
process.env.APP_DATA_DIR = DATA_DIR;
test.after(() => rmSync(DATA_DIR, { recursive: true, force: true }));

const settingsStore = await import('../data/automation-settings.js');
const { spineModeForClient } = await import('../lib/spine-mode.js');
const { globalLoopMode } = await import('../lib/delivery-loop.js');
const { purgeSettings } = await import('../lib/privacy-settings.js');
const { signingSwitchMode } = await import('../lib/contract-signing.js');
const vocab = await import('../packages/suite/core/delivery/vocab.js');

const PASSED = { passedAt: '2026-11-01T00:00:00.000Z', suite: 'delivery-e2e', evidence: '', by: 'release-suite' };
const PILOT = { id: 'pilot-1' };
const OTHER = { id: 'other-1' };

function settingsWith({ pilots = ['pilot-1'], releases = {}, patch = {} } = {}) {
  const base = settingsStore.defaultAutomationSettings();
  return {
    ...base,
    ...patch,
    pilotClientIds: pilots,
    releases,
    signing: { ...base.signing, enabled: true, mode: 'auto' },
    delivery: { loop: { ...base.delivery.loop, enabled: true, mode: 'auto' } },
    brief: { ...base.brief, enabled: true, mode: 'auto' },
    gate: { ...base.gate, enabled: true, mode: 'auto' },
    privacy: { ...base.privacy, purge: { enabled: true, mode: 'auto' } },
  };
}

const SPINE = ['signing', 'delivery.loop', 'brief', 'gate'];

test('every spine switch and every new email kind is release-gated and pausable', () => {
  for (const id of [...SPINE, 'privacy.purge']) {
    assert.ok(vocab.RELEASE_GATED_SWITCHES.includes(id), `${id} is release-gated`);
    assert.ok(settingsStore.PAUSABLE_SWITCHES.includes(id), `${id} is pausable`);
  }
  for (const kind of vocab.EMAIL_KINDS.filter((entry) => !entry.legacy)) {
    assert.ok(vocab.RELEASE_GATED_SWITCHES.includes(`emails.${kind.id}`), kind.id);
    assert.ok(settingsStore.PAUSABLE_SWITCHES.includes(`emails.${kind.id}`), kind.id);
  }
  assert.deepEqual([...settingsStore.SPINE_SWITCHES].sort(), [...SPINE, 'privacy.purge'].sort());
});

test('a non-pilot runs in shadow, also with a recorded pass', () => {
  const releases = Object.fromEntries(SPINE.map((id) => [id, PASSED]));
  const settings = settingsWith({ releases });
  for (const id of SPINE) {
    assert.equal(spineModeForClient(id, OTHER, { settings }), 'shadow', id);
    assert.equal(spineModeForClient(id, PILOT, { settings }), 'auto', `${id}: a pilot with a pass runs in auto (positive control)`);
  }
  // No pilots at all: shadow for everyone.
  const empty = settingsWith({ pilots: [], releases });
  for (const id of SPINE) assert.equal(spineModeForClient(id, PILOT, { settings: empty }), 'shadow', id);
});

test('auto without a recorded release pass runs in shadow, for pilots too', () => {
  const settings = settingsWith({ releases: {} });
  for (const id of SPINE) assert.equal(spineModeForClient(id, PILOT, { settings }), 'shadow', id);
  // A pass for another switch does not count.
  const other = settingsWith({ releases: { signing: PASSED } });
  assert.equal(spineModeForClient('signing', PILOT, { settings: other }), 'auto');
  assert.equal(spineModeForClient('brief', PILOT, { settings: other }), 'shadow');
  // Gate mails: the kind needs its own pass; the pre-workshop mail with the gate's lines needs the gate line release.
  const mails = settingsWith({ releases: {}, patch: { emails: { ...settingsStore.defaultAutomationSettings().emails } } });
  mails.emails.postWorkshop = { ...mails.emails.postWorkshop, enabled: true, mode: 'auto' };
  mails.emails.preWorkshop = { ...mails.emails.preWorkshop, lines: 'gate', mode: 'auto' };
  assert.equal(spineModeForClient('emails.postWorkshop', PILOT, { settings: mails }), 'shadow');
  assert.equal(spineModeForClient('emails.preWorkshop', PILOT, { settings: mails }), 'shadow');
  mails.releases = { 'emails.postWorkshop': PASSED, 'emails.preWorkshop.gate': PASSED };
  assert.equal(spineModeForClient('emails.postWorkshop', PILOT, { settings: mails }), 'auto');
  assert.equal(spineModeForClient('emails.preWorkshop', PILOT, { settings: mails }), 'auto');
  // The legacy pre-workshop lines need no release (today's autosend).
  mails.emails.preWorkshop.lines = 'legacy';
  mails.releases = {};
  assert.equal(spineModeForClient('emails.preWorkshop', PILOT, { settings: mails }), 'auto');
});

test('the hub-wide views follow the same rule: the loop, signing and the retention purge', () => {
  const none = settingsWith({ releases: {} });
  assert.equal(globalLoopMode(none), 'shadow');
  assert.equal(signingSwitchMode({ settings: none }), 'shadow');
  assert.deepEqual(purgeSettings(none), { enabled: true, mode: 'shadow' });
  const all = settingsWith({ releases: { 'delivery.loop': PASSED, signing: PASSED, 'privacy.purge': PASSED } });
  assert.equal(globalLoopMode(all), 'auto');
  assert.equal(signingSwitchMode({ settings: all }), 'auto');
  assert.deepEqual(purgeSettings(all), { enabled: true, mode: 'auto' });
  // The purge also waits for a pilot list and stops deleting while paused.
  assert.deepEqual(purgeSettings(settingsWith({ pilots: [], releases: { 'privacy.purge': PASSED } })), { enabled: true, mode: 'shadow' });
  const paused = settingsWith({ releases: { 'privacy.purge': PASSED } });
  paused.privacy.purge.paused = { at: '2026-11-01T00:00:00.000Z', reason: 'guard', by: 'guard' };
  assert.deepEqual(purgeSettings(paused), { enabled: true, mode: 'shadow' });
});

test('validation refuses auto on signing, delivery.loop, brief and privacy.purge while there are no pilots', () => {
  const patches = {
    signing: { signing: { enabled: true, mode: 'auto' } },
    'delivery.loop': { delivery: { loop: { enabled: true, mode: 'auto' } } },
    brief: { brief: { enabled: true, mode: 'auto' } },
    'privacy.purge': { privacy: { purge: { enabled: true, mode: 'auto' } } },
  };
  for (const [id, patch] of Object.entries(patches)) {
    const releases = { [id]: PASSED };
    const noPilots = settingsStore.validateAutomationSettings(patch, { current: { pilotClientIds: [], releases } });
    assert.equal(noPilots.ok, false, `${id} without pilots`);
    assert.ok(noPilots.errors.some((error) => error.path === `${id}.mode` && /pilot/i.test(error.message)), `${id}: ${JSON.stringify(noPilots.errors)}`);
    const noPass = settingsStore.validateAutomationSettings(patch, { current: { pilotClientIds: ['pilot-1'], releases: {} } });
    assert.equal(noPass.ok, false, `${id} without a release pass`);
    assert.ok(noPass.errors.some((error) => error.path === id && /pre-release suite/.test(error.message)), `${id}: ${JSON.stringify(noPass.errors)}`);
    const ok = settingsStore.validateAutomationSettings(patch, { current: { pilotClientIds: ['pilot-1'], releases } });
    assert.equal(ok.ok, true, `${id} with a pilot and a pass: ${JSON.stringify(ok.errors)}`);
    // Shadow stays allowed without pilots or passes.
    const shadowPatch = JSON.parse(JSON.stringify(patch).replace('"auto"', '"shadow"'));
    assert.equal(settingsStore.validateAutomationSettings(shadowPatch, { current: { pilotClientIds: [], releases: {} } }).ok, true, `${id} in shadow`);
  }
});

test('a pause on brief or privacy.purge needs a reason and takes effect', () => {
  for (const id of ['brief', 'privacy.purge']) {
    const result = settingsStore.pauseAutomationSwitch(id, { reason: 'release suite failed', dataDir: DATA_DIR, now: new Date('2026-11-05T10:00:00.000Z') });
    assert.equal(result.ok, true, id);
  }
  const { settings } = settingsStore.readAutomationSettingsFile({ dataDir: DATA_DIR });
  assert.equal(settings.brief.paused.reason, 'release suite failed');
  assert.equal(settingsStore.effectiveSwitchMode('brief', { settings: { ...settings, brief: { ...settings.brief, enabled: true } } }), 'paused');
  // The stored pause validates; an empty reason does not; null resumes.
  assert.equal(settingsStore.validateAutomationSettings({}, { current: settings }).ok, true);
  assert.equal(settingsStore.validateAutomationSettings({ brief: { paused: { reason: '' } } }, { current: settings }).ok, false);
  assert.equal(settingsStore.validateAutomationSettings({ brief: { paused: null }, privacy: { purge: { paused: null } } }, { current: settings }).ok, true);
  assert.equal(settingsStore.pauseAutomationSwitch('pilotClientIds', { reason: 'x', dataDir: DATA_DIR }).ok, false);
});
