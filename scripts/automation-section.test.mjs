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
  canDemoteRow,
  canSeeAutomation,
  commitTypedText,
  demoteSwitchPatch,
  diffPatch,
  fieldKind,
  getAt,
  listInputValue,
  parsePromotionResponse,
  pilotPickerOptions,
  promotionModel,
  roleFromAdminToken,
  roundTripEdits,
  setAt,
  settingFields,
} from '../lib/automation-section-helpers.js';

const admin = readFileSync(new URL('../app/pages/Admin/Admin.tsx', import.meta.url), 'utf8');
const section = readFileSync(new URL('../app/pages/Admin/sections/AutomationSection.tsx', import.meta.url), 'utf8');
const fixture = JSON.parse(readFileSync(new URL('./fixtures/automation-promotion.json', import.meta.url), 'utf8'));

// Ids the promotion route lists. Copied from the delivery vocabulary's release-gated switches.
const RELEASE_GATED_SWITCHES = [
  'emails.postWorkshop',
  'emails.dataReminder',
  'emails.previewReady',
  'emails.stagingReady',
  'emails.siteLive',
  'emails.changeRequestAck',
  'emails.changeRequestDone',
  'emails.nurture',
  'emails.dpaSigning',
  'emails.preWorkshop.gate',
  'development.autoQueue',
  'publish.staging',
  'publish.production',
  'brief',
  'signing',
  'delivery.loop',
  'gate',
  'privacy.purge',
];

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

test('promotion rows label blockers and stay quiet without a switches array', () => {
  const quiet = promotionModel({ code: 'disabled' });
  assert.equal(quiet.active, false);
  assert.equal(quiet.message, INACTIVE_PROMOTION_TEXT);
  assert.equal(promotionModel(null).active, false);
  assert.equal(promotionModel({}).active, false);
  assert.equal(promotionModel({ pilots: 1 }).active, false);

  const html = parsePromotionResponse({ status: 200, contentType: 'text/html; charset=utf-8', text: '<!doctype html><html></html>' });
  assert.equal(promotionModel(html).active, false);
  assert.equal(promotionModel(html).message, INACTIVE_PROMOTION_TEXT);
  assert.equal(parsePromotionResponse({ status: 200, contentType: 'application/json', text: '{' }).code, 'disabled');
  assert.equal(parsePromotionResponse({ status: 404, contentType: 'application/json', text: '{"code":"disabled"}' }).code, 'disabled');

  const model = promotionModel(fixture);
  assert.equal(model.active, true);
  assert.equal(model.pilots, 2);
  assert.equal(model.promotionAuto, true);
  assert.equal(model.releaseKey.installed, true);
  assert.equal(model.releaseKey.keyId, 'eksempel-nokkel');
  assert.equal(model.guards.trips.length, 1);
  assert.equal(model.guards.trips[0].code, 'error-rate');
  assert.deepEqual(model.rows.map((row) => row.id), fixture.switches.map((row) => row.id));
  const preview = model.rows[0];
  assert.equal(preview.spine, true);
  assert.equal(preview.guard.sent, 4);
  assert.equal(preview.guard.error, 1);
  assert.equal(preview.guard.bounce, 0);
  assert.equal(preview.guard.complaint, 0);
  assert.equal(preview.guard.verdict.code, 'error-rate');
  assert.equal(preview.canDemote, false);
  assert.equal('streak' in preview, false);
  assert.deepEqual(preview.blockers.map((item) => item.label), [
    BLOCKER_LABELS['mode-not-auto'],
    BLOCKER_LABELS['no-release'],
    BLOCKER_LABELS['no-pilots'],
    BLOCKER_LABELS['no-feedback-feed'],
  ]);
  const live = model.rows.find((row) => row.id === 'emails.siteLive');
  assert.equal(live.canDemote, true);
  assert.equal(live.releasePassedAt, '2026-10-02T08:00:00.000Z');
  assert.equal(live.guard.verdict, null);
  const staging = model.rows.find((row) => row.id === 'publish.staging');
  assert.equal(staging.spine, false);
  assert.equal(staging.guard, null);
  assert.deepEqual(staging.blockers.map((item) => item.id), ['disabled', 'paused', 'mode-not-auto', 'no-release']);
  const gate = model.rows.find((row) => row.id === 'emails.preWorkshop.gate');
  assert.equal(gate.canDemote, false);
  const queue = model.rows.find((row) => row.id === 'development.autoQueue');
  assert.equal(queue.canDemote, true);

  const labeled = promotionModel({
    pilots: 0,
    promotionAuto: false,
    switches: [{ id: 'brief', spine: false, stored: { mode: 'shadow' }, blockers: [...Object.keys(BLOCKER_LABELS), 'ukjent-kode'], guard: null }],
    guards: { settings: {}, trips: [] },
    releaseKey: { installed: false, keyId: '' },
  });
  const labels = labeled.rows[0].blockers;
  for (const id of Object.keys(BLOCKER_LABELS)) {
    assert.equal(labels.find((item) => item.id === id).label, BLOCKER_LABELS[id]);
    assert.notEqual(BLOCKER_LABELS[id], id);
  }
  assert.equal(labels.find((item) => item.id === 'ukjent-kode').label, 'ukjent-kode');
});

test('pilot options are sales client ids', () => {
  const options = pilotPickerOptions({
    clients: [{ id: 'client-havn', businessName: 'Eksempel Havn' }],
    sites: [{ id: 'site-havn', name: 'Eksempel Havn' }],
  });
  assert.deepEqual(options, [{ id: 'client-havn', name: 'Eksempel Havn' }]);
  assert.equal(options.some((row) => row.id.startsWith('site-')), false);
  assert.match(section, /\/admin\/sales/);
  assert.doesNotMatch(admin, /clients=\{sites\.map/);
});

test('list text keeps a trailing comma and numbers commit as numbers', () => {
  const dir = mkdtempSync(join(tmpdir(), 'automation-ui-text-'));
  const view = automationSettingsView({ dataDir: dir });
  const typed = 'a.example,';
  assert.equal(listInputValue(typed), 'a.example,');
  const domains = commitTypedText('inbox.internalDomains', typed, { defaults: view.defaults, loaded: view.settings });
  assert.deepEqual(domains, ['a.example']);
  assert.equal(listInputValue(domains.join(', ')), 'a.example');

  const dirty = setAt(view.settings, 'lifecycle.paymentGraceDays', '');
  assert.equal(fieldKind('lifecycle.paymentGraceDays', { defaults: view.defaults, loaded: view.settings }), 'number');
  assert.equal(settingFields(dirty, { defaults: view.defaults, loaded: view.settings }).find((field) => field.path === 'lifecycle.paymentGraceDays').kind, 'number');
  const grace = commitTypedText('lifecycle.paymentGraceDays', '15', { defaults: view.defaults, loaded: view.settings });
  assert.equal(grace, 15);
  assert.equal(typeof grace, 'number');
  const gracePatch = diffPatch(view.settings, setAt(view.settings, 'lifecycle.paymentGraceDays', grace));
  assert.deepEqual(gracePatch, { lifecycle: { paymentGraceDays: 15 } });
  const savedGrace = saveAutomationSettings(gracePatch, { dataDir: dir, reason: 'kontroll' });
  assert.equal(savedGrace.ok, true, JSON.stringify(savedGrace.errors));
  assert.equal(getAt(automationSettingsView({ dataDir: dir }).settings, 'lifecycle.paymentGraceDays'), 15);

  const max = commitTypedText('emails.dataReminder.max', '4', { defaults: view.defaults, loaded: view.settings });
  assert.equal(max, 4);
  assert.equal(typeof max, 'number');
  const maxPatch = diffPatch(view.settings, setAt(view.settings, 'emails.dataReminder.max', max));
  const savedMax = saveAutomationSettings(maxPatch, { dataDir: dir, reason: 'kontroll' });
  assert.equal(savedMax.ok, true, JSON.stringify(savedMax.errors));
  assert.equal(getAt(automationSettingsView({ dataDir: dir }).settings, 'emails.dataReminder.max'), 4);
  assert.doesNotMatch(section, /onChange=\{\(event\) => onChange\(parseList/);
});

test('demotion patches are values the store accepts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'automation-ui-demote-'));
  const gateOn = { emails: { preWorkshop: { lines: 'gate', mode: 'auto' } } };
  for (const id of RELEASE_GATED_SWITCHES) {
    const patch = demoteSwitchPatch(id, gateOn);
    assert.ok(patch, id);
    assert.equal(JSON.stringify(patch).includes('approve'), false, id);
    if (id === 'development.autoQueue') assert.deepEqual(patch, { development: { autoQueue: false } });
    else if (id === 'emails.preWorkshop.gate') assert.deepEqual(patch, { emails: { preWorkshop: { lines: 'legacy' } } });
    else assert.equal(JSON.stringify(patch).includes('"shadow"'), true, id);
    const saved = saveAutomationSettings(patch, { dataDir: dir, reason: 'kontroll' });
    assert.equal(saved.ok, true, `${id} ${JSON.stringify(saved.errors)}`);
  }
  const legacyLines = { emails: { preWorkshop: { lines: 'legacy', mode: 'auto' } } };
  assert.equal(canDemoteRow({ id: 'emails.preWorkshop.gate', stored: { mode: 'auto' } }, legacyLines), false);
  assert.equal(demoteSwitchPatch('emails.preWorkshop.gate', legacyLines), null);
  assert.equal(canDemoteRow({ id: 'emails.preWorkshop.gate', stored: { mode: 'auto' } }, gateOn), true);
  assert.equal(canDemoteRow({ id: 'emails.previewReady', stored: { mode: 'shadow' } }), false);
  assert.equal(canDemoteRow({ id: 'emails.siteLive', stored: { mode: 'auto' } }), true);
  assert.match(section, /canDemote/);
  assert.doesNotMatch(section, /Sett modus til godkjenning/);
});

test('a settings warning is shown in amber under the field with the same path', () => {
  assert.match(section, /body\.warnings/);
  assert.match(section, /setWarnings\(Array\.isArray\(body\.warnings\) \? body\.warnings : \[\]\)/);
  assert.match(section, /errorText\(warnings, field\.path\)/);
  assert.match(section, /text-amber-300 text-xs mt-1/);
  assert.match(section, /warnings\.filter\(\(warning\) => !warning\.path\)/);
});
