// Automation screen view-model. The helper import and the Admin gate check fail on a tree
// that has neither the helper nor the superadmin-only tab.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { automationSettingsView, saveAutomationSettings } from '../data/automation-settings.js';
import {
  BLOCKER_LABELS,
  INACTIVE_PROMOTION_TEXT,
  canSeeAutomation,
  demoteSwitchPatch,
  diffPatch,
  getAt,
  promotionModel,
  roleFromAdminToken,
  roundTripEdits,
  setAt,
  settingFields,
} from '../lib/automation-section-helpers.js';

const admin = readFileSync(new URL('../app/pages/Admin/Admin.tsx', import.meta.url), 'utf8');
const fixture = JSON.parse(readFileSync(new URL('./fixtures/automation-promotion.json', import.meta.url), 'utf8'));

function leaves(obj, prefix = '') {
  const leaf = /^(?:releases|inbox\.autoActions|inbox\.autoReply)$|\.paused$/;
  const out = [];
  for (const [key, value] of Object.entries(obj || {})) {
    const path = prefix ? `${prefix}.${key}` : key;
    const plain = Boolean(value) && typeof value === 'object' && !Array.isArray(value);
    if (plain && !leaf.test(path)) out.push(...leaves(value, path));
    else out.push(path);
  }
  return out;
}

test('only the admin role can see automation', () => {
  assert.equal(canSeeAutomation('admin'), true);
  assert.equal(canSeeAutomation('superadmin'), true);
  for (const role of ['sales', 'developer', 'employee', 'client', 'none', 'maker', '', null, undefined]) {
    assert.equal(canSeeAutomation(role), false, String(role));
  }
});

test('the automation tab is registered only behind the admin gate', () => {
  const renderAt = admin.indexOf('<AutomationSection');
  assert.ok(renderAt > 0, 'AutomationSection is not registered');
  assert.match(admin.slice(renderAt - 300, renderAt), /canSeeAutomation\(/);
  assert.match(admin, /label="Automatisering"/);
  const token = Buffer.from(JSON.stringify({ data: JSON.stringify({ role: 'sales' }), sig: 'x' })).toString('base64url');
  assert.equal(roleFromAdminToken(token), 'sales');
  assert.equal(canSeeAutomation(roleFromAdminToken(token)), false);
});

test('the settings walker lists every leaf and one edit per kind round-trips', () => {
  const dir = mkdtempSync(join(tmpdir(), 'automation-ui-'));
  const view = automationSettingsView({ dataDir: dir });
  const fields = settingFields(view.settings, { defaults: view.defaults, envOverrides: view.envOverrides });
  const expected = [...new Set([...leaves(view.settings), ...leaves(view.defaults)])].sort();
  assert.deepEqual(fields.map((field) => field.path), expected);
  const overridden = settingFields(view.settings, { envOverrides: [{ path: 'emails.workshopReminders', overriddenBy: 'env' }] });
  assert.equal(overridden.find((field) => field.path === 'emails.workshopReminders.enabled').overriddenBy, 'env');

  const edits = roundTripEdits(view.settings);
  const kinds = new Set(fields.map((field) => field.kind).filter((kind) => kind !== 'readonly'));
  assert.deepEqual(new Set(edits.map((edit) => edit.type)), kinds);
  let current = view.settings;
  for (const edit of edits) {
    const next = setAt(current, edit.path, edit.value);
    const patch = diffPatch(current, next);
    const saved = saveAutomationSettings(patch, { dataDir: dir, reason: 'kontroll' });
    assert.equal(saved.ok, true, `${edit.path} ${JSON.stringify(saved.errors)}`);
    current = automationSettingsView({ dataDir: dir }).settings;
    assert.deepEqual(getAt(current, edit.path), edit.value, edit.path);
  }
});

test('promotion rows label blockers, sort, and stay quiet when disabled', () => {
  const quiet = promotionModel({ code: 'disabled' });
  assert.equal(quiet.active, false);
  assert.equal(quiet.message, INACTIVE_PROMOTION_TEXT);
  assert.deepEqual(promotionModel(null).rows, []);

  const model = promotionModel(fixture);
  assert.deepEqual(model.rows.map((row) => row.id), ['emails.previewReady', 'emails.siteLive', 'publish.staging']);
  const preview = model.rows[0];
  assert.equal(preview.blockers.map((item) => item.label).join('|'), `${BLOCKER_LABELS['mode-not-auto']}|${BLOCKER_LABELS['no-pilots']}`);
  assert.equal(preview.streak, 4);
  assert.equal(preview.target, 10);
  const live = model.rows.find((row) => row.id === 'emails.siteLive');
  assert.equal(live.streak, 3);
  assert.equal(live.target, 3);
  assert.equal(live.releasePassedAt, '2026-10-02T08:00:00.000Z');
  const staging = model.rows.find((row) => row.id === 'publish.staging');
  assert.deepEqual(staging.blockers.map((item) => item.id), ['disabled', 'paused', 'no-release']);
  assert.deepEqual(demoteSwitchPatch('emails.previewReady'), { emails: { previewReady: { mode: 'approve' } } });
  assert.deepEqual(demoteSwitchPatch('emails.preWorkshop.gate'), { emails: { preWorkshop: { mode: 'approve' } } });
});
