// Automation settings store (WS8.10): <dataDir>/automation-settings.json, version 2.
//
// Owner decision 2026-10-23: no approval queues. Every switch is either `shadow` (internal
// pre-release stage: the system computes and records what it would do and sends nothing) or
// `auto` (runs, with runtime guards that pause it on errors, bounces, complaints or anomalies).
// A release-gated switch may only be set to `auto` after the pre-release suite has recorded a pass
// for it (recordReleasePass). Legacy kinds that already ran automatically are not gated.
//
// Defaults reproduce today's behaviour: the legacy pre-workshop autosend stays, workshop reminders
// stay off unless WORKSHOP_DESK_EMAIL_AUTOSEND=1, nothing new sends and nothing is auto-queued.
// Settings are edited from Superadmin and never live in Hostinger env.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getPersistentDataDir, writeDataJson } from './storage-path.js';
import {
  CANCELLATION_GRACE_DAYS,
  EMAIL_KINDS,
  EMAIL_KIND_IDS,
  RELEASE_GATED_SWITCHES,
  TIER_IDS,
  normalizeAutomationMode,
} from '../packages/suite/core/delivery/vocab.js';

export const AUTOMATION_SETTINGS_VERSION = 2;
export const AUTOMATION_SETTINGS_FILE = 'automation-settings.json';
export const AUTOMATION_AUDIT_MAX = 50;
export const AUTOMATION_CACHE_MS = 10_000;

// Mailboxes the hub may read. Only these may appear in inbox.mailboxes.
export const INBOX_MAILBOX_ALLOWLIST = Object.freeze(['alexander@asoldi.com', 'damian@asoldi.com']);

// Switch paths a runtime guard (or a person) can pause.
export const PAUSABLE_SWITCHES = Object.freeze([
  ...EMAIL_KIND_IDS.map((kind) => `emails.${kind}`),
  'publish.staging',
  'publish.production',
]);

// Env values that still override a setting. GET reports them as overriddenBy:'env'.
export const ENV_OVERRIDES = Object.freeze([
  {
    path: 'emails.workshopReminders',
    env: 'WORKSHOP_DESK_EMAIL_AUTOSEND',
    applies: (value) => String(value ?? '') === '1',
    effect: { enabled: true, mode: 'auto' },
  },
]);

const KIND_EXTRA_DEFAULTS = {
  preWorkshop: { lines: 'legacy' },
  postWorkshop: { delayMinutes: 120 },
  dataReminder: { afterDays: 4, max: 2 },
  nurture: { cadenceDays: [90, 180, 365] },
};

const KIND_BASE_DEFAULTS = {
  // Legacy autosend on contract signing, as today.
  preWorkshop: { enabled: true, mode: 'auto' },
  // Off unless the env override or Superadmin turns it on, as today.
  workshopReminders: { enabled: false, mode: 'auto' },
  dataReminder: { enabled: false, mode: 'shadow' },
  nurture: { enabled: false, mode: 'shadow' },
};

export function defaultAutomationSettings() {
  const emails = {};
  for (const kind of EMAIL_KINDS) {
    emails[kind.id] = {
      ...(KIND_BASE_DEFAULTS[kind.id] || { enabled: true, mode: 'shadow' }),
      ...structuredClone(KIND_EXTRA_DEFAULTS[kind.id] || {}),
      paused: null,
    };
  }
  return {
    version: AUTOMATION_SETTINGS_VERSION,
    pilotClientIds: [],
    emails,
    sender: { scheduling: 'owner-rep', service: { accountKey: 'damian', replyTo: 'alexander@asoldi.com' } },
    // Today the inbox bot reads alexander@ only. WS8.32 adds damian@ behind the known-contact prefilter.
    inbox: {
      mailboxes: ['alexander@asoldi.com'],
      autoActions: { 'alexander@asoldi.com': true },
      autoReply: { 'alexander@asoldi.com': true },
      prefilter: 'known-contacts',
      internalDomains: ['asoldi.com'],
      internalSenders: ['ansatte@asoldi.com'],
    },
    fireflies: {
      candidateRanker: { enabled: true, candidateMinScore: 40 },
      autoLink: { enabled: false, requireExactAttendeeEmail: true, slotWindowMinutes: 30 },
    },
    development: {
      autoQueue: false,
      directivesForAutoDev: 'accepted+must',
      defaultHostId: '',
      requireConfirmForCustom: true,
      previewJobs: false,
      seoJobs: false,
    },
    publish: {
      staging: { mode: 'shadow', tiers: ['tier-3-ecommerce'], paused: null },
      production: { mode: 'shadow', paused: null },
    },
    changeRequests: { enforce: 'track', slaWorkDays: 10, countAt: 'accepted' },
    pricing: { oneTimeMultiplier: 9, oneTimeMinExMva: 0, oneTimeMonths: 6 },
    lifecycle: { paymentGraceDays: 14, cancellationGraceDays: CANCELLATION_GRACE_DAYS },
    promotion: { auto: true },
    guards: { errorRatePct: 20, bounceRatePct: 5, complaintsMax: 1, volumeSpikeFactor: 3, windowHours: 24, minSample: 5 },
    retention: {
      leadMonths: 12,
      afterContractMonths: 12,
      briefOldVersionsDays: 90,
      changeRequestsMonths: 24,
      nurtureProofYears: 3,
      inboxSkipLogDays: 30,
    },
    storage: { budgetFiles: 20000, budgetMb: 2048 },
    alerts: { to: 'ansatte@asoldi.com', hostOfflineHours: 2, jobBlockedHours: 24, digestAt: '08:00' },
    // Written only by recordReleasePass (the pre-release suite), never by PUT.
    releases: {},
  };
}

// ---------------------------------------------------------------- helpers

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function getPath(obj, path) {
  return path.split('.').reduce((node, key) => (isPlainObject(node) ? node[key] : undefined), obj);
}

function setPath(obj, path, value) {
  const keys = path.split('.');
  let node = obj;
  for (const key of keys.slice(0, -1)) {
    if (!isPlainObject(node[key])) node[key] = {};
    node = node[key];
  }
  node[keys[keys.length - 1]] = value;
}

function isLeafObjectPath(path) {
  return LEAF_OBJECT_PATHS.some((re) => re.test(path));
}

/**
 * Deep merge: plain objects merge, everything else (arrays included) replaces. The leaf maps
 * (`releases`, every `paused`, the per-mailbox `inbox.autoActions` / `inbox.autoReply`) replace as a
 * whole, so a save can remove a mailbox entry again.
 */
function deepMerge(base, patch, prefix = '') {
  if (!isPlainObject(base) || !isPlainObject(patch)) return clone(patch);
  const out = clone(base);
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const path = prefix ? `${prefix}.${key}` : key;
    out[key] = isPlainObject(value) && isPlainObject(out[key]) && !isLeafObjectPath(path)
      ? deepMerge(out[key], value, path)
      : clone(value);
  }
  return out;
}

function leafPaths(obj, prefix = '') {
  const out = [];
  for (const [key, value] of Object.entries(obj || {})) {
    const path = prefix ? `${prefix}.${key}` : key;
    // `releases`, `paused` and the per-mailbox maps are leaves: their keys are data, not schema.
    if (isPlainObject(value) && !isLeafObjectPath(path)) out.push(...leafPaths(value, path));
    else out.push(path);
  }
  return out;
}

const LEAF_OBJECT_PATHS = [/^releases$/, /\.paused$/, /^inbox\.autoActions$/, /^inbox\.autoReply$/];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;
const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9-]+\.)+[a-z]{2,}$/i;

function stableJson(value) {
  return JSON.stringify(value);
}

// ---------------------------------------------------------------- validation

const ENUMS = {
  'emails.preWorkshop.lines': ['legacy', 'gate'],
  'sender.scheduling': ['owner-rep', 'service'],
  'inbox.prefilter': ['known-contacts'],
  'development.directivesForAutoDev': ['accepted+must', 'accepted', 'none'],
  'changeRequests.enforce': ['track', 'enforce'],
  'changeRequests.countAt': ['accepted'],
};

const RANGES = {
  'emails.postWorkshop.delayMinutes': [0, 10080],
  'emails.dataReminder.afterDays': [1, 60],
  'emails.dataReminder.max': [0, 10],
  'fireflies.candidateRanker.candidateMinScore': [0, 100],
  'fireflies.autoLink.slotWindowMinutes': [0, 240],
  'changeRequests.slaWorkDays': [1, 60],
  'pricing.oneTimeMultiplier': [1, 36],
  'pricing.oneTimeMinExMva': [0, 1_000_000],
  'pricing.oneTimeMonths': [1, 24],
  'lifecycle.paymentGraceDays': [0, 90],
  'lifecycle.cancellationGraceDays': [0, 365],
  'guards.errorRatePct': [1, 100],
  'guards.bounceRatePct': [1, 100],
  'guards.complaintsMax': [0, 100],
  'guards.volumeSpikeFactor': [1.5, 100],
  'guards.windowHours': [1, 720],
  'guards.minSample': [1, 1000],
  'retention.leadMonths': [1, 120],
  'retention.afterContractMonths': [1, 120],
  'retention.briefOldVersionsDays': [7, 3650],
  'retention.changeRequestsMonths': [1, 120],
  'retention.nurtureProofYears': [1, 10],
  'retention.inboxSkipLogDays': [1, 365],
  'storage.budgetFiles': [1000, 1_000_000],
  'storage.budgetMb': [64, 1_000_000],
  'alerts.hostOfflineHours': [1, 168],
  'alerts.jobBlockedHours': [1, 720],
};

const BOOLEANS = new Set([
  'fireflies.candidateRanker.enabled',
  'fireflies.autoLink.enabled',
  'fireflies.autoLink.requireExactAttendeeEmail',
  'development.autoQueue',
  'development.requireConfirmForCustom',
  'development.previewJobs',
  'development.seoJobs',
  'promotion.auto',
]);

function knownPaths() {
  return new Set(leafPaths(defaultAutomationSettings()));
}

function releasePassed(settings, switchId) {
  return Boolean(settings?.releases?.[switchId]?.passedAt);
}

/** Every release-gated switch that `settings` sets to auto without a recorded pass. */
export function unreleasedAutoSwitches(settings) {
  const out = [];
  for (const switchId of RELEASE_GATED_SWITCHES) {
    if (switchId === 'emails.preWorkshop.gate') {
      const pre = settings?.emails?.preWorkshop || {};
      if (pre.lines === 'gate' && pre.mode === 'auto' && pre.enabled !== false && !releasePassed(settings, switchId)) out.push(switchId);
      continue;
    }
    if (switchId === 'development.autoQueue') {
      if (settings?.development?.autoQueue === true && !releasePassed(settings, switchId)) out.push(switchId);
      continue;
    }
    const node = getPath(settings, switchId);
    if (!isPlainObject(node)) continue;
    if (node.mode === 'auto' && node.enabled !== false && !releasePassed(settings, switchId)) out.push(switchId);
  }
  return out;
}

function normalizePaused(value, { by = '', now = new Date() } = {}) {
  if (value === null || value === undefined || value === false) return null;
  if (!isPlainObject(value)) return undefined;
  const reason = String(value.reason ?? '').trim().slice(0, 300);
  if (!reason) return undefined;
  return {
    at: String(value.at || now.toISOString()),
    reason,
    by: String(value.by || by || '').slice(0, 120),
  };
}

/**
 * Merges `patch` into `current` (or the defaults) and validates the whole result.
 * Returns { ok, errors: [{path, message}], value }.
 */
export function validateAutomationSettings(patch, { current = null, by = '', now = new Date() } = {}) {
  const errors = [];
  const fail = (path, message) => errors.push({ path, message });
  const base = current ? deepMerge(defaultAutomationSettings(), current) : defaultAutomationSettings();
  if (!isPlainObject(patch)) {
    return { ok: false, errors: [{ path: '', message: 'Settings must be a JSON object.' }], value: base };
  }
  const input = clone(patch);
  delete input.audit;
  delete input.version;

  if (Object.prototype.hasOwnProperty.call(input, 'releases')) {
    if (stableJson(input.releases) !== stableJson(base.releases)) {
      fail('releases', 'Release passes are recorded by the pre-release suite, not by a settings edit.');
    }
    delete input.releases;
  }

  // Unknown keys in the patch are typos; keys a later batch already stored are kept.
  const known = knownPaths();
  const existing = new Set(leafPaths(base));
  for (const path of leafPaths(input)) {
    if (known.has(path) || existing.has(path)) continue;
    if (/^emails\.[^.]+\.paused$/.test(path) || /^publish\.(staging|production)\.paused$/.test(path)) continue;
    fail(path, 'Unknown setting.');
  }

  const value = deepMerge(base, input);
  value.version = AUTOMATION_SETTINGS_VERSION;

  // A patch that changes inbox.mailboxes drops the per-mailbox entries it inherited for mailboxes
  // that are no longer listed. Entries the patch sends itself are validated as sent.
  if (Array.isArray(input.inbox?.mailboxes) && isPlainObject(value.inbox)) {
    const listed = new Set(input.inbox.mailboxes.map((entry) => String(entry || '').trim().toLowerCase()));
    for (const mapKey of ['autoActions', 'autoReply']) {
      if (Object.prototype.hasOwnProperty.call(input.inbox, mapKey) || !isPlainObject(value.inbox[mapKey])) continue;
      value.inbox[mapKey] = Object.fromEntries(Object.entries(value.inbox[mapKey]).filter(([mailbox]) => listed.has(mailbox)));
    }
  }

  // Modes: shadow or auto (approve and manual are old names for shadow).
  for (const kind of EMAIL_KIND_IDS) {
    const node = value.emails?.[kind];
    if (!isPlainObject(node)) {
      fail(`emails.${kind}`, 'Missing email kind settings.');
      continue;
    }
    if (typeof node.enabled !== 'boolean') fail(`emails.${kind}.enabled`, 'Must be true or false.');
    const mode = normalizeAutomationMode(node.mode);
    if (!mode) fail(`emails.${kind}.mode`, 'Must be shadow or auto.');
    else node.mode = mode;
    const paused = normalizePaused(node.paused, { by, now });
    if (paused === undefined) fail(`emails.${kind}.paused`, 'Must be null or {reason}.');
    else node.paused = paused;
  }
  for (const target of ['staging', 'production']) {
    const node = value.publish?.[target];
    if (!isPlainObject(node)) {
      fail(`publish.${target}`, 'Missing publish settings.');
      continue;
    }
    const mode = normalizeAutomationMode(node.mode);
    if (!mode) fail(`publish.${target}.mode`, 'Must be shadow or auto.');
    else node.mode = mode;
    const paused = normalizePaused(node.paused, { by, now });
    if (paused === undefined) fail(`publish.${target}.paused`, 'Must be null or {reason}.');
    else node.paused = paused;
  }
  const tiers = value.publish?.staging?.tiers;
  if (!Array.isArray(tiers) || tiers.some((tier) => !TIER_IDS.includes(tier))) {
    fail('publish.staging.tiers', `Must list tier ids (${TIER_IDS.join(', ')}).`);
  }

  for (const [path, allowed] of Object.entries(ENUMS)) {
    if (!allowed.includes(getPath(value, path))) fail(path, `Must be one of: ${allowed.join(', ')}.`);
  }
  for (const [path, [min, max]] of Object.entries(RANGES)) {
    const number = getPath(value, path);
    if (typeof number !== 'number' || !Number.isFinite(number) || number < min || number > max) {
      fail(path, `Must be a number from ${min} to ${max}.`);
    }
  }
  for (const path of BOOLEANS) {
    if (typeof getPath(value, path) !== 'boolean') fail(path, 'Must be true or false.');
  }

  const cadence = value.emails?.nurture?.cadenceDays;
  if (
    !Array.isArray(cadence)
    || cadence.length < 1
    || cadence.length > 6
    || cadence.some((day, index) => !Number.isInteger(day) || day < 1 || day > 1095 || (index > 0 && day <= cadence[index - 1]))
  ) {
    fail('emails.nurture.cadenceDays', 'Must be 1-6 rising whole days from 1 to 1095.');
  }

  // Pilots.
  const pilots = value.pilotClientIds;
  if (
    !Array.isArray(pilots)
    || pilots.length > 100
    || pilots.some((id) => typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(id))
    || new Set(pilots).size !== pilots.length
  ) {
    fail('pilotClientIds', 'Must be up to 100 distinct client ids.');
  }

  // Inbox and senders.
  const inbox = value.inbox || {};
  const mailboxes = Array.isArray(inbox.mailboxes) ? inbox.mailboxes.map((entry) => String(entry || '').trim().toLowerCase()) : null;
  if (!mailboxes || !mailboxes.length || new Set(mailboxes).size !== mailboxes.length) {
    fail('inbox.mailboxes', 'Must list at least one mailbox, without duplicates.');
  } else {
    for (const mailbox of mailboxes) {
      if (!INBOX_MAILBOX_ALLOWLIST.includes(mailbox)) {
        fail('inbox.mailboxes', `${mailbox} is not an allowed mailbox (${INBOX_MAILBOX_ALLOWLIST.join(', ')}).`);
      }
    }
    inbox.mailboxes = mailboxes;
  }
  for (const mapKey of ['autoActions', 'autoReply']) {
    const map = inbox[mapKey];
    if (!isPlainObject(map)) {
      fail(`inbox.${mapKey}`, 'Must map mailboxes to true or false.');
      continue;
    }
    for (const [mailbox, flag] of Object.entries(map)) {
      if (!(mailboxes || []).includes(mailbox)) fail(`inbox.${mapKey}`, `${mailbox} is not in inbox.mailboxes.`);
      if (typeof flag !== 'boolean') fail(`inbox.${mapKey}`, `${mailbox} must be true or false.`);
    }
  }
  if (!Array.isArray(inbox.internalDomains) || inbox.internalDomains.some((domain) => !DOMAIN_RE.test(String(domain)))) {
    fail('inbox.internalDomains', 'Must list domain names.');
  }
  if (!Array.isArray(inbox.internalSenders) || inbox.internalSenders.some((email) => !EMAIL_RE.test(String(email)))) {
    fail('inbox.internalSenders', 'Must list email addresses.');
  }
  const service = value.sender?.service || {};
  if (typeof service.accountKey !== 'string' || !/^[a-z0-9._:-]{1,64}$/i.test(service.accountKey)) {
    fail('sender.service.accountKey', 'Must be an account key.');
  }
  const replyTo = String(service.replyTo || '').trim().toLowerCase();
  if (!(mailboxes || []).includes(replyTo)) fail('sender.service.replyTo', 'Must be one of inbox.mailboxes.');
  else service.replyTo = replyTo;

  const hostId = value.development?.defaultHostId;
  if (typeof hostId !== 'string' || !/^[A-Za-z0-9_-]{0,64}$/.test(hostId)) {
    fail('development.defaultHostId', 'Must be empty or a Maker host id.');
  }
  if (!EMAIL_RE.test(String(value.alerts?.to || ''))) fail('alerts.to', 'Must be an email address.');
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(value.alerts?.digestAt || ''))) fail('alerts.digestAt', 'Must be HH:MM.');

  // No owner approval queue: a gated switch reaches auto only after the pre-release suite passed.
  for (const switchId of unreleasedAutoSwitches(value)) {
    fail(switchId, `${switchId} cannot run in auto before the pre-release suite has passed for it. Keep it in shadow.`);
  }

  return { ok: errors.length === 0, errors, value };
}

// ---------------------------------------------------------------- store

let cache = { at: 0, path: '', value: null };

function settingsPath(dataDir) {
  return join(dataDir || getPersistentDataDir(), AUTOMATION_SETTINGS_FILE);
}

export function invalidateAutomationSettingsCache() {
  cache = { at: 0, path: '', value: null };
}

function readStoredFile(file) {
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** The stored file merged over the defaults, plus its audit list. Unknown stored keys are kept. */
export function readAutomationSettingsFile({ dataDir } = {}) {
  const stored = readStoredFile(settingsPath(dataDir));
  const audit = Array.isArray(stored?.audit) ? stored.audit.slice(-AUTOMATION_AUDIT_MAX) : [];
  const body = stored ? { ...stored } : {};
  delete body.audit;
  const settings = deepMerge(defaultAutomationSettings(), body);
  settings.version = AUTOMATION_SETTINGS_VERSION;
  return { settings, audit, stored: Boolean(stored) };
}

/** Settings with a 10 s cache. */
export function getAutomationSettings({ dataDir, nowMs = Date.now(), fresh = false } = {}) {
  const file = settingsPath(dataDir);
  if (!fresh && cache.value && cache.path === file && nowMs - cache.at < AUTOMATION_CACHE_MS) return cache.value;
  const { settings } = readAutomationSettingsFile({ dataDir });
  cache = { at: nowMs, path: file, value: settings };
  return settings;
}

function diffSettings(before, after) {
  const changes = [];
  const paths = new Set([...leafPaths(before), ...leafPaths(after)]);
  for (const path of [...paths].sort()) {
    const from = getPath(before, path);
    const to = getPath(after, path);
    if (stableJson(from) !== stableJson(to)) changes.push({ path, from: clone(from) ?? null, to: clone(to) ?? null });
  }
  return changes;
}

function writeSettings({ dataDir, settings, audit }) {
  writeDataJson(settingsPath(dataDir), { ...settings, audit: audit.slice(-AUTOMATION_AUDIT_MAX) });
  invalidateAutomationSettingsCache();
}

/**
 * Validates and stores a (partial) settings patch. Writes only when something changed and adds one
 * audit entry {at, by, source, reason, changes}. Returns { ok, errors?, settings, changes }.
 */
export function saveAutomationSettings(patch, { dataDir, by = '', reason = '', source = 'superadmin', now = new Date() } = {}) {
  const { settings: current, audit } = readAutomationSettingsFile({ dataDir });
  const result = validateAutomationSettings(patch, { current, by, now });
  if (!result.ok) return { ok: false, errors: result.errors, settings: current, changes: [] };
  const changes = diffSettings(current, result.value);
  if (!changes.length) return { ok: true, settings: current, changes };
  audit.push({ at: now.toISOString(), by: String(by || '').slice(0, 120), source, reason: String(reason || '').slice(0, 300), changes });
  writeSettings({ dataDir, settings: result.value, audit });
  return { ok: true, settings: result.value, changes };
}

function writeSystemChange({ dataDir, now, by, source, reason, mutate }) {
  const { settings: current, audit } = readAutomationSettingsFile({ dataDir });
  const next = clone(current);
  mutate(next);
  const changes = diffSettings(current, next);
  if (!changes.length) return { ok: true, settings: current, changes };
  audit.push({ at: now.toISOString(), by, source, reason, changes });
  writeSettings({ dataDir, settings: next, audit });
  return { ok: true, settings: next, changes };
}

/** Runtime guard: pause a switch (email kind or publish target) and record why. */
export function pauseAutomationSwitch(switchPath, { reason, by = 'guard', dataDir, now = new Date() } = {}) {
  if (!PAUSABLE_SWITCHES.includes(switchPath)) return { ok: false, error: `Not a pausable switch: ${switchPath}` };
  const text = String(reason || '').trim().slice(0, 300);
  if (!text) return { ok: false, error: 'A pause needs a reason.' };
  return writeSystemChange({
    dataDir, now, by, source: 'guard', reason: text,
    mutate: (next) => setPath(next, `${switchPath}.paused`, { at: now.toISOString(), reason: text, by }),
  });
}

export function resumeAutomationSwitch(switchPath, { by = '', reason = '', dataDir, now = new Date() } = {}) {
  if (!PAUSABLE_SWITCHES.includes(switchPath)) return { ok: false, error: `Not a pausable switch: ${switchPath}` };
  return writeSystemChange({
    dataDir, now, by, source: 'resume', reason,
    mutate: (next) => setPath(next, `${switchPath}.paused`, null),
  });
}

/**
 * The pre-release suite (golden, safe-mode outbox snapshots, canary) records a pass for a gated
 * switch. With promotion.auto on, the switch is promoted to auto in the same write.
 */
export function recordReleasePass(switchId, { suite = '', evidence = '', by = 'release-suite', dataDir, now = new Date() } = {}) {
  if (!RELEASE_GATED_SWITCHES.includes(switchId)) return { ok: false, error: `Not a release-gated switch: ${switchId}` };
  const suiteName = String(suite || '').trim().slice(0, 120);
  if (!suiteName) return { ok: false, error: 'A release pass names the suite that passed.' };
  return writeSystemChange({
    dataDir, now, by, source: 'release', reason: `pre-release suite passed: ${suiteName}`,
    mutate: (next) => {
      next.releases = { ...(next.releases || {}) };
      next.releases[switchId] = { passedAt: now.toISOString(), suite: suiteName, evidence: String(evidence || '').slice(0, 500), by };
      if (next.promotion?.auto !== true) return;
      if (switchId === 'emails.preWorkshop.gate') {
        next.emails.preWorkshop.lines = 'gate';
        next.emails.preWorkshop.mode = 'auto';
      } else if (switchId === 'development.autoQueue') {
        next.development.autoQueue = true;
      } else {
        const node = getPath(next, switchId);
        if (isPlainObject(node)) node.mode = 'auto';
      }
    },
  });
}

// ---------------------------------------------------------------- effective state

function envOverrideFor(path, env) {
  return ENV_OVERRIDES.find((entry) => entry.path === path && entry.applies(env?.[entry.env])) || null;
}

/** off | shadow | paused | auto for one switch node, after env overrides. */
export function effectiveSwitchMode(switchPath, { settings, env = process.env } = {}) {
  const resolved = settings || getAutomationSettings();
  const override = envOverrideFor(switchPath, env);
  const node = { ...(getPath(resolved, switchPath) || {}), ...(override?.effect || {}) };
  if (node.enabled === false) return 'off';
  if (node.paused) return 'paused';
  return normalizeAutomationMode(node.mode) || 'shadow';
}

export function effectiveEmailMode(kind, options = {}) {
  return effectiveSwitchMode(`emails.${kind}`, options);
}

/**
 * How automation treats one client. Test clients take part only when listed as pilots. With a
 * non-empty pilot list, everyone else runs in shadow (computed, nothing sent or queued).
 */
export function automationScopeForClient(client, { settings } = {}) {
  const resolved = settings || getAutomationSettings();
  const id = String(client?.id || '');
  const pilots = Array.isArray(resolved.pilotClientIds) ? resolved.pilotClientIds : [];
  const pilot = Boolean(id) && pilots.includes(id);
  if (client?.isTest === true && !pilot) return { included: false, live: false, pilot, reason: 'test-client-not-pilot' };
  if (pilots.length && !pilot) return { included: true, live: false, pilot, reason: 'not-a-pilot' };
  return { included: true, live: true, pilot, reason: '' };
}

/** Effective mode of an automation switch for one client (legacy kinds ignore the pilot list). */
export function effectiveModeForClient(switchPath, client, options = {}) {
  const settings = options.settings || getAutomationSettings();
  const mode = effectiveSwitchMode(switchPath, { ...options, settings });
  if (mode !== 'auto') return mode;
  const scope = automationScopeForClient(client, { settings });
  if (!scope.included) return 'off';
  const kind = switchPath.startsWith('emails.') ? EMAIL_KINDS.find((entry) => `emails.${entry.id}` === switchPath) : null;
  if (kind?.legacy) return mode;
  return scope.live ? 'auto' : 'shadow';
}

/** Superadmin view: settings, defaults, effective modes, env overrides and the audit list. */
export function automationSettingsView({ dataDir, env = process.env } = {}) {
  const { settings, audit, stored } = readAutomationSettingsFile({ dataDir });
  const effective = { emails: {}, publish: {}, development: { autoQueue: settings.development.autoQueue === true } };
  for (const kind of EMAIL_KIND_IDS) {
    const override = envOverrideFor(`emails.${kind}`, env);
    effective.emails[kind] = {
      mode: effectiveSwitchMode(`emails.${kind}`, { settings, env }),
      ...(override ? { overriddenBy: 'env', env: override.env } : {}),
    };
  }
  for (const target of ['staging', 'production']) {
    effective.publish[target] = { mode: effectiveSwitchMode(`publish.${target}`, { settings, env }) };
  }
  return {
    settings,
    stored,
    defaults: defaultAutomationSettings(),
    effective,
    envOverrides: ENV_OVERRIDES.filter((entry) => entry.applies(env?.[entry.env])).map((entry) => ({ path: entry.path, env: entry.env, overriddenBy: 'env' })),
    releaseGated: [...RELEASE_GATED_SWITCHES],
    pausable: [...PAUSABLE_SWITCHES],
    mailboxAllowlist: [...INBOX_MAILBOX_ALLOWLIST],
    audit,
  };
}
