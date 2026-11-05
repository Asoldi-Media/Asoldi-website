// The intake switches in the automation settings: both default off, auto is refused without pilot
// clients, a pause needs a reason, and per client the mode follows the pilot rule.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'asoldi-intake-settings-'));
process.env.APP_DATA_DIR = dataDir;
test.after(() => rmSync(dataDir, { recursive: true, force: true }));

const settings = await import('../data/automation-settings.js');
const { SETTINGS_KEYS } = await import('../packages/suite/core/delivery/vocab.js');
const { spineModeForClient } = await import('../lib/spine-mode.js');

const SWITCHES = ['intake.tierSteps', 'intake.transcriptKeywords'];

test('both intake switches default to off in shadow with no pause, and are settings keys', () => {
  const defaults = settings.defaultAutomationSettings();
  assert.deepEqual(defaults.intake, {
    tierSteps: { enabled: false, mode: 'shadow', paused: null },
    transcriptKeywords: { enabled: false, mode: 'shadow', paused: null },
  });
  const keys = Object.values(SETTINGS_KEYS);
  for (const path of SWITCHES) {
    for (const field of ['enabled', 'mode', 'paused']) assert.ok(keys.includes(`${path}.${field}`), `${path}.${field}`);
    assert.equal(settings.effectiveSwitchMode(path, { settings: defaults }), 'off');
  }
});

test('auto needs pilot clients, a mode outside shadow and auto is refused, and a pause needs a reason', () => {
  const base = settings.defaultAutomationSettings();
  for (const path of SWITCHES) {
    const [, name] = path.split('.');
    const auto = structuredClone(base);
    auto.intake[name] = { enabled: true, mode: 'auto', paused: null };
    const refused = settings.validateAutomationSettings(auto);
    assert.equal(refused.ok, false);
    assert.ok(refused.errors.some((error) => error.path === `${path}.mode`), JSON.stringify(refused.errors));
    auto.pilotClientIds = ['pilot-1'];
    assert.equal(settings.validateAutomationSettings(auto).ok, true);

    const odd = structuredClone(base);
    odd.intake[name].mode = 'always';
    assert.ok(settings.validateAutomationSettings(odd).errors.some((error) => error.path === `${path}.mode`));

    const paused = structuredClone(base);
    paused.intake[name].paused = { reason: '' };
    assert.ok(settings.validateAutomationSettings(paused).errors.some((error) => error.path === `${path}.paused`));
    paused.intake[name].paused = { reason: 'checking the answers' };
    assert.equal(settings.validateAutomationSettings(paused).ok, true);
  }
});

test('per client: auto reaches pilot clients only, everyone else runs in shadow, off stays off', () => {
  const on = settings.defaultAutomationSettings();
  on.pilotClientIds = ['pilot-1'];
  on.intake.tierSteps = { enabled: true, mode: 'auto', paused: null };
  assert.equal(spineModeForClient('intake.tierSteps', { id: 'pilot-1' }, { settings: on }), 'auto');
  assert.equal(spineModeForClient('intake.tierSteps', { id: 'other-1' }, { settings: on }), 'shadow');
  assert.equal(spineModeForClient('intake.transcriptKeywords', { id: 'pilot-1' }, { settings: on }), 'off');
  on.intake.tierSteps.paused = { reason: 'checking', at: '2026-11-05T10:00:00.000Z', by: 'admin' };
  assert.equal(spineModeForClient('intake.tierSteps', { id: 'pilot-1' }, { settings: on }), 'paused');
});
