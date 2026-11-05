// The automation promotion ladder (owner decision: automatic from day one, no approval queue).
//
// A release-gated switch (RELEASE_GATED_SWITCHES) reaches auto in three steps:
//   1. the pre-release suite (scripts/release-suite.mjs: golden clients, safe-mode outbox snapshots,
//      the canary) passes for it and the signed report is recorded (recordReleasePass, through
//      POST /api/admin/automation/release-pass);
//   2. with promotion.auto on, recording the pass also sets the switch to auto when the result is
//      valid settings (a pilot-only switch waits for a pilot list);
//   3. spine switches and gate mails act in auto only for pilot clients (lib/spine-mode.js).
// At runtime the mail guards (lib/delivery-guards.js) pause a kind that goes wrong and raise an alert.
//
// promotionView() is the data of the promotion dashboard; nothing here writes.
import {
  PILOT_ONLY_SWITCHES,
  SPINE_SWITCHES,
  effectiveSwitchMode,
  getAutomationSettings,
} from '../data/automation-settings.js';
import { getPersistentDataDir } from '../data/storage-path.js';
import { EMAIL_KINDS, RELEASE_GATED_SWITCHES } from '../packages/suite/core/delivery/vocab.js';
import { guardStats } from './delivery-guards.js';
import { keyId, readReleaseKeyFile, releaseKeyPath } from './release-suite.js';

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function getPath(obj, path) {
  return path.split('.').reduce((node, key) => (isPlainObject(node) ? node[key] : undefined), obj);
}

/**
 * True when the promotion routes may answer: some client is a pilot or some release pass is
 * recorded. Before that the routes answer 404 {code:'disabled'} (the hub looks as it did).
 */
export function promotionRoutesOpen(settings) {
  const pilots = Array.isArray(settings?.pilotClientIds) ? settings.pilotClientIds : [];
  const releases = isPlainObject(settings?.releases) ? settings.releases : {};
  return pilots.length > 0 || Object.keys(releases).length > 0;
}

function storedState(settings, id) {
  if (id === 'emails.preWorkshop.gate') {
    const node = settings?.emails?.preWorkshop || {};
    return { enabled: node.enabled !== false, mode: node.lines === 'gate' ? String(node.mode || 'shadow') : 'legacy-lines', paused: node.paused || null };
  }
  if (id === 'development.autoQueue') {
    const on = settings?.development?.autoQueue === true;
    return { enabled: on, mode: on ? 'auto' : 'shadow', paused: null };
  }
  const node = getPath(settings, id);
  if (!isPlainObject(node)) return { enabled: false, mode: 'shadow', paused: null };
  return { enabled: node.enabled !== false, mode: String(node.mode || 'shadow'), paused: node.paused || null };
}

function effectiveState(settings, id) {
  if (id === 'development.autoQueue') return settings?.development?.autoQueue === true ? 'auto' : 'off';
  const path = id === 'emails.preWorkshop.gate' ? 'emails.preWorkshop' : id;
  try {
    return effectiveSwitchMode(path, { settings });
  } catch {
    return 'off';
  }
}

function needsPilots(id) {
  return PILOT_ONLY_SWITCHES.includes(id) || id === 'gate' || id.startsWith('emails.');
}

/** What keeps one release-gated switch from running in auto now. */
export function promotionBlockers(settings, id) {
  const stored = storedState(settings, id);
  const blockers = [];
  if (!stored.enabled) blockers.push('disabled');
  if (stored.paused) blockers.push('paused');
  if (stored.mode !== 'auto') blockers.push('mode-not-auto');
  if (!settings?.releases?.[id]?.passedAt) blockers.push('no-release');
  const pilots = Array.isArray(settings?.pilotClientIds) ? settings.pilotClientIds : [];
  if (needsPilots(id) && !pilots.length) blockers.push('no-pilots');
  return blockers;
}

/** The promotion dashboard: every release-gated switch, the guards and the release key state. */
export function promotionView({ dataDir, settings = null, now = Date.now() } = {}) {
  const resolved = settings || getAutomationSettings({ dataDir, fresh: true });
  const guards = guardStats({ dataDir, settings: resolved, now });
  const legacyKinds = new Set(EMAIL_KINDS.filter((kind) => kind.legacy).map((kind) => kind.id));
  const switches = RELEASE_GATED_SWITCHES.map((id) => {
    const blockers = promotionBlockers(resolved, id);
    const kind = id.startsWith('emails.') && !id.endsWith('.gate') ? id.slice('emails.'.length) : '';
    return {
      id,
      spine: SPINE_SWITCHES.includes(id),
      release: isPlainObject(resolved?.releases?.[id]) ? resolved.releases[id] : null,
      stored: storedState(resolved, id),
      effective: effectiveState(resolved, id),
      autoReachable: blockers.length === 0,
      blockers,
      guard: kind && !legacyKinds.has(kind) ? guards.kinds[kind] || null : null,
    };
  });
  const key = readReleaseKeyFile(releaseKeyPath({ dataDir: dataDir || getPersistentDataDir() }));
  return {
    pilots: Array.isArray(resolved?.pilotClientIds) ? resolved.pilotClientIds.length : 0,
    promotionAuto: resolved?.promotion?.auto === true,
    switches,
    guards: { settings: guards.guards, trips: guards.trips },
    releaseKey: key ? { installed: true, keyId: keyId(key) } : { installed: false, keyId: '' },
  };
}
