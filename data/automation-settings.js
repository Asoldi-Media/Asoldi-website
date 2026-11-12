// Automation settings store: <dataDir>/automation-settings.json, version 2.
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
  BACKFILL_MODES,
  CANCELLATION_GRACE_DAYS,
  EMAIL_KINDS,
  EMAIL_KIND_IDS,
  MAKER_EVENT_MODES,
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

// release suite
// The delivery spine switches. Each reaches 'auto' for a client only when the client is a pilot
// and the pre-release suite has recorded a pass for the switch (lib/spine-mode.js).
export const SPINE_SWITCHES = Object.freeze(['signing', 'delivery.loop', 'brief', 'gate', 'privacy.purge']);
// Spine switches whose 'auto' needs at least one client in pilotClientIds.
export const PILOT_ONLY_SWITCHES = Object.freeze(['signing', 'delivery.loop', 'brief', 'privacy.purge']);
// end release suite

// Switch paths a runtime guard (or a person) can pause.
export const PAUSABLE_SWITCHES = Object.freeze([
  ...EMAIL_KIND_IDS.map((kind) => `emails.${kind}`),
  'publish.staging',
  'publish.production',
  // release suite
  ...SPINE_SWITCHES,
  // end release suite
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
  // A terms-update notice is only ever sent by a person; the kind stays off until it is turned on.
  termsUpdate: { enabled: false, mode: 'shadow' },
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
    // Today the inbox bot reads alexander@ only. Inbox bot adds damian@ behind the known-contact prefilter.
    inbox: {
      mailboxes: ['alexander@asoldi.com'],
      autoActions: { 'alexander@asoldi.com': true },
      autoReply: { 'alexander@asoldi.com': true },
      prefilter: 'known-contacts',
      internalDomains: ['asoldi.com'],
      internalSenders: ['ansatte@asoldi.com'],
    },
    fireflies: {
      // Ranked client candidates for recordings no booked Meet room owns. It never links.
      candidateRanker: { enabled: false, candidateMinScore: 40 },
      autoLink: { enabled: false, requireExactAttendeeEmail: true, slotWindowMinutes: 30 },
    },
    development: {
      autoQueue: false,
      directivesForAutoDev: 'accepted+must',
      defaultHostId: '',
      requireConfirmForCustom: true,
      previewJobs: false,
      seoJobs: false,
      // Maker delivery events are recorded on makerRun only when set to 'record'.
      makerEvents: 'off',
    },
    // 'dry-run' writes the backfill report at boot, 'apply' also applies it (idempotent).
    migrations: { deliveryBackfill: 'off' },
    publish: {
      staging: { mode: 'shadow', tiers: ['tier-3-ecommerce'], paused: null },
      production: { mode: 'shadow', paused: null },
    },
    changeRequests: { enforce: 'track', slaWorkDays: 10, countAt: 'accepted' },
    pricing: { oneTimeMultiplier: 9, oneTimeMinExMva: 0, oneTimeMonths: 6 },
    lifecycle: {
      paymentGraceDays: 14,
      cancellationGraceDays: CANCELLATION_GRACE_DAYS,
      // --- lifecycle
      // planChange: a plan change after signing (an accepted upgrade offer, a superadmin edit, an accepted
      // Stripe conflict) goes through markPlanChanged. cancellation: a Stripe cancellation, a failed payment
      // and un-signing (markContractUnsigned) change the delivery state. Off: today's paths, unchanged.
      // shadow: today's paths plus a record of what would change. auto: pilot clients only.
      planChange: { enabled: false, mode: 'shadow', paused: null },
      cancellation: { enabled: false, mode: 'shadow', paused: null },
      // --- end lifecycle
    },
    promotion: { auto: true },
    guards: { errorRatePct: 20, bounceRatePct: 5, complaintsMax: 1, volumeSpikeFactor: 3, windowHours: 24, minSample: 5 },
    retention: {
      leadMonths: 12,
      afterContractMonths: 12,
      briefOldVersionsDays: 90,
      changeRequestsMonths: 24,
      nurtureProofYears: 3,
      inboxSkipLogDays: 30,
      // --- visit statistics retention
      // Off: nothing runs and nothing is written. shadow: count day files older than 26 months
      // and store a report, delete nothing. auto: delete those files (report only while safe mode is on).
      // A paused switch ({reason}) counts as off.
      analyticsTraffic: { enabled: false, mode: 'shadow', paused: null },
      // --- end visit statistics retention
    },
    // privacy
    // privacy.archive: a copy of each linked transcript under transcript-archive/ (off: nothing written).
    // privacy.purge: the daily retention step and the erase route; shadow only reports what would go.
    // media.signedUrls: the media manifest and its signed download route.
    // media.rightsConfirm: the per-upload rights checkbox in the client portal.
    privacy: {
      archive: { enabled: false },
      purge: { enabled: false, mode: 'shadow' },
    },
    media: {
      signedUrls: { enabled: false },
      rightsConfirm: { enabled: false },
    },
    // end privacy
    storage: { budgetFiles: 20000, budgetMb: 2048 },
    alerts: { to: 'ansatte@asoldi.com', hostOfflineHours: 2, jobBlockedHours: 24, digestAt: '08:00' },
    // ---- legal texts
    // The clause catalog (lib/legal) renders the legal pages, contract lines, offer letters and
    // sales copy, stamps DPA versions and offers DPA signing only while catalogTexts is enabled.
    // Off: today's static texts, no stamps, and the legal routes answer 404.
    legal: { catalogTexts: { enabled: false } },
    // ---- end legal texts
    // seo
    // jobGating: off = the old gates decide automatic posts and Maps ranking; shadow = the old gates
    // still decide and every site where the feature-key gate would decide differently is logged; auto =
    // the feature-key gate decides, and only after a release pass whose evidence names the reviewed
    // output of scripts/seo-gating-diff.mjs. dfsLedger: DataForSEO spend is also booked into the monthly seo-ops
    // ledger, which alerts at a cap and never stops a call. recordPull: the Maker may read a client's
    // SEO record. A paused switch ({reason}) counts as off.
    seo: {
      jobGating: { enabled: false, mode: 'shadow', paused: null },
      dfsLedger: { enabled: false, paused: null },
      recordPull: { enabled: false, paused: null },
    },
    // delivery loop: the 60 s delivery tick and the Maker job queue. Off by default; 'shadow'
    // records what the tick would do, 'auto' acts for pilot clients only (lib/spine-mode.js).
    delivery: { loop: { enabled: false, mode: 'shadow', paused: null } },
    // gate: the delivery gate (lib/delivery-gate.js). Off by default; 'shadow' computes the requirement
    // lines and shows them to developers, and the mails that would use them are recorded, never sent.
    gate: { enabled: false, mode: 'shadow', paused: null },
    // brief: the delivery brief (lib/delivery-brief). Off: nothing is built. Shadow: briefs are built and
    // stored for admins. Auto: pilot clients' briefs are also served to the Maker.
    brief: { enabled: false, mode: 'shadow' },
    // Written only by recordReleasePass (the pre-release suite), never by PUT.
    releases: {},
    // --- signing
    // One signer for every signing path (lib/contract-signing.js). Off: today's paths, unchanged.
    // shadow: today's paths plus a record of what the signer would write. auto: the signer runs for
    // pilot clients only (lib/spine-mode.js); every other client stays in shadow.
    signing: { enabled: false, mode: 'shadow', paused: null },
    // --- end signing
    // --- booking
    // selfLink: signed links that let a client book its own workshop or iteration slot
    // (lib/client-booking.js). Off: no link in any mail and the public booking routes answer 404.
    // shadow: a record where a mail would have carried a link. auto: pilot clients only get the link.
    booking: { selfLink: { enabled: false, mode: 'shadow', paused: null } },
    // --- end booking
    // --- intake
    // intake.tierSteps: the client assistant also asks what the signed plan needs (shop terms for a shop,
    // keywords and the service area for SEO, bookable services for booking). Off: today's six steps.
    // Shadow: the extra steps are worked out and noted in the delivery audit; the client sees nothing new.
    // Auto: pilot clients get the steps (lib/spine-mode.js); every other client stays in shadow.
    // intake.transcriptKeywords: keyword talk in meeting transcripts becomes SEO keyword proposals, never
    // approved automatically. Off: nothing runs. Shadow: the delivery loop notes what it would propose,
    // with no model call and no SEO record write. Auto: pilot clients get the proposals.
    intake: {
      tierSteps: { enabled: false, mode: 'shadow', paused: null },
      transcriptKeywords: { enabled: false, mode: 'shadow', paused: null },
    },
    // --- end intake
    // --- cms fleet monitor
    // cmsFleet.monitor: the daily review of the client CMS sites (lib/cms-fleet-monitor.js). Off: nothing
    // runs and nothing is written. shadow: proposals and the digest are worked out and stored, no mail.
    // auto: the digest is also mailed to alerts.to (the safe-mode outbox while safe mode is on).
    // cmsFleet.autoApplyFlip: with the monitor in auto and safe mode off, a proposal nobody dismissed for
    // 3 days is applied (featureEnforcement 'on').
    // cmsFleet.wakePing: the hourly GET /api/cms/health on every CMS site (5 s timeout).
    // A paused switch ({reason}) counts as off.
    cmsFleet: {
      monitor: { enabled: false, mode: 'shadow', paused: null },
      autoApplyFlip: false,
      wakePing: { enabled: false, paused: null },
    },
    // --- end cms fleet monitor
    // --- site rekey
    // siteRekey: the staff route POST /api/admin/sites/rekey (lib/routes/site-rekey-routes.js) that gives a
    // site the key its published site carries, keeping the old key as an alias for 90 days. Off: the route
    // answers 404 disabled and nothing is written. A paused switch ({reason}) counts as off.
    siteRekey: { enabled: false, paused: null },
    // --- end site rekey
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

function isReplaceObjectPath(path) {
  return REPLACE_OBJECT_PATHS.some((re) => re.test(path));
}

/**
 * Deep merge: plain objects merge, everything else (arrays included) replaces. `releases` and every
 * `paused` object replace as a whole. The per-mailbox maps (`inbox.autoActions`, `inbox.autoReply`)
 * merge per mailbox; alignMailboxMaps then keeps exactly the listed mailboxes.
 */
function deepMerge(base, patch, prefix = '') {
  if (!isPlainObject(base) || !isPlainObject(patch)) return clone(patch);
  const out = clone(base);
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const path = prefix ? `${prefix}.${key}` : key;
    out[key] = isPlainObject(value) && isPlainObject(out[key]) && !isReplaceObjectPath(path)
      ? deepMerge(out[key], value, path)
      : clone(value);
  }
  return out;
}

export const INBOX_MAILBOX_MAP_KEYS = Object.freeze(['autoActions', 'autoReply']);

/**
 * Gives each per-mailbox map exactly one entry per listed mailbox (in place). A mailbox the map
 * does not mention keeps its previous value, or `false` (off) when it is new; entries of mailboxes
 * that are no longer listed are dropped. Entries in `sent` (what a patch sent explicitly) are kept
 * even when the mailbox is not listed, so validation reports them as typos instead of dropping them.
 */
function alignMailboxMaps(settings, sent = {}) {
  const inbox = settings?.inbox;
  if (!isPlainObject(inbox) || !Array.isArray(inbox.mailboxes)) return settings;
  const listed = inbox.mailboxes.map((entry) => String(entry || '').trim().toLowerCase()).filter(Boolean);
  for (const mapKey of INBOX_MAILBOX_MAP_KEYS) {
    const map = inbox[mapKey];
    if (!isPlainObject(map)) continue;
    const explicit = isPlainObject(sent?.[mapKey]) ? sent[mapKey] : {};
    const next = {};
    for (const mailbox of listed) next[mailbox] = Object.prototype.hasOwnProperty.call(map, mailbox) ? map[mailbox] : false;
    for (const [mailbox, flag] of Object.entries(map)) {
      if (!Object.prototype.hasOwnProperty.call(next, mailbox) && Object.prototype.hasOwnProperty.call(explicit, mailbox)) next[mailbox] = flag;
    }
    inbox[mapKey] = next;
  }
  return settings;
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
const REPLACE_OBJECT_PATHS = [/^releases$/, /\.paused$/];

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
  'development.makerEvents': [...MAKER_EVENT_MODES],
  'migrations.deliveryBackfill': [...BACKFILL_MODES],
  // seo
  'seo.jobGating.mode': ['shadow', 'auto'],
  // delivery loop
  'delivery.loop.mode': ['shadow', 'auto'],
  // gate: 'auto' is not offered yet; the gate runs in shadow only.
  'gate.mode': ['shadow'],
  // brief
  'brief.mode': ['shadow', 'auto'],
  // privacy
  'privacy.purge.mode': ['shadow', 'auto'],
  // end privacy
  // --- signing
  'signing.mode': ['shadow', 'auto'],
  // --- end signing
  // --- lifecycle
  'lifecycle.planChange.mode': ['shadow', 'auto'],
  'lifecycle.cancellation.mode': ['shadow', 'auto'],
  // --- end lifecycle
  // --- booking
  'booking.selfLink.mode': ['shadow', 'auto'],
  // --- end booking
  // --- intake
  'intake.tierSteps.mode': ['shadow', 'auto'],
  'intake.transcriptKeywords.mode': ['shadow', 'auto'],
  // --- end intake
  // --- cms fleet monitor
  'cmsFleet.monitor.mode': ['shadow', 'auto'],
  // --- end cms fleet monitor
  // --- visit statistics retention
  'retention.analyticsTraffic.mode': ['shadow', 'auto'],
  // --- end visit statistics retention
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
  // ---- legal texts
  'legal.catalogTexts.enabled',
  // ---- end legal texts
  // seo
  'seo.jobGating.enabled',
  'seo.dfsLedger.enabled',
  'seo.recordPull.enabled',
  // delivery loop
  'delivery.loop.enabled',
  // gate
  'gate.enabled',
  // brief
  'brief.enabled',
  // privacy
  'privacy.archive.enabled',
  'privacy.purge.enabled',
  'media.signedUrls.enabled',
  'media.rightsConfirm.enabled',
  // end privacy
  // --- signing
  'signing.enabled',
  // --- end signing
  // --- lifecycle
  'lifecycle.planChange.enabled',
  'lifecycle.cancellation.enabled',
  // --- end lifecycle
  // --- booking
  'booking.selfLink.enabled',
  // --- end booking
  // --- intake
  'intake.tierSteps.enabled',
  'intake.transcriptKeywords.enabled',
  // --- end intake
  // --- cms fleet monitor
  'cmsFleet.monitor.enabled',
  'cmsFleet.autoApplyFlip',
  'cmsFleet.wakePing.enabled',
  // --- end cms fleet monitor
  // --- site rekey
  'siteRekey.enabled',
  // --- end site rekey
  // --- visit statistics retention
  'retention.analyticsTraffic.enabled',
  // --- end visit statistics retention
]);

function knownPaths() {
  return new Set(leafPaths(defaultAutomationSettings()));
}

function releasePassed(settings, switchId) {
  return Boolean(settings?.releases?.[switchId]?.passedAt);
}

// release suite
/**
 * The release id a switch path needs before it runs in auto, or '' when the path is not
 * release-gated (the legacy email kinds). The pre-workshop mail with the gate's lines has a
 * release of its own.
 */
export function releaseIdForSwitch(switchPath, settings) {
  const path = String(switchPath || '');
  if (path === 'emails.preWorkshop' && settings?.emails?.preWorkshop?.lines === 'gate') return 'emails.preWorkshop.gate';
  return RELEASE_GATED_SWITCHES.includes(path) ? path : '';
}

/** True when the switch path needs no release, or the pre-release suite has recorded one. */
export function releasePassedFor(switchPath, settings) {
  const id = releaseIdForSwitch(switchPath, settings);
  return !id || releasePassed(settings, id);
}
// end release suite

/** seo.jobGating counts a pass only when its evidence names the reviewed gating diff. */
function jobGatingReleasePassed(settings) {
  const pass = settings?.releases?.['seo.jobGating'];
  return Boolean(pass?.passedAt) && String(pass?.evidence || '').trim().length > 0;
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
    if (switchId === 'seo.jobGating') {
      const gating = getPath(settings, switchId);
      if (isPlainObject(gating) && gating.mode === 'auto' && gating.enabled !== false && !jobGatingReleasePassed(settings)) out.push(switchId);
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

// --- lifecycle
/**
 * A pilot switch node ({ enabled, mode, paused }) at `path`: shadow or auto (old names normalized), a pause
 * needs a reason, and auto needs listed pilot clients. Used by the lifecycle and booking switches.
 */
function validatePilotSwitch(value, path, { fail, by, now }) {
  const node = getPath(value, path);
  if (!isPlainObject(node)) {
    fail(path, `Missing ${path} settings.`);
    return;
  }
  const mode = normalizeAutomationMode(node.mode);
  if (mode) node.mode = mode;
  const paused = normalizePaused(node.paused, { by, now });
  if (paused === undefined) fail(`${path}.paused`, 'Must be null or {reason}.');
  else node.paused = paused;
  const pilotList = Array.isArray(value.pilotClientIds) ? value.pilotClientIds : [];
  if (node.enabled === true && node.mode === 'auto' && !pilotList.length) {
    fail(`${path}.mode`, `${path} runs in auto only for listed pilot clients. Add pilotClientIds first, or keep it in shadow.`);
  }
}
// --- end lifecycle

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
    // release suite: a guard or a person may pause any spine switch
    if (SPINE_SWITCHES.some((id) => path === `${id}.paused`)) continue;
    fail(path, 'Unknown setting.');
  }

  const value = deepMerge(base, input);
  value.version = AUTOMATION_SETTINGS_VERSION;

  // One entry per listed mailbox: a partial map keeps the other mailboxes' values, a removed
  // mailbox's entries go with it, a new mailbox starts off. Entries the patch sends itself are
  // validated as sent.
  alignMailboxMaps(value, isPlainObject(input.inbox) ? input.inbox : {});

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
  // seo
  for (const name of ['jobGating', 'dfsLedger', 'recordPull']) {
    const node = value.seo?.[name];
    if (!isPlainObject(node)) continue;
    const paused = normalizePaused(node.paused, { by, now });
    if (paused === undefined) fail(`seo.${name}.paused`, 'Must be null or {reason}.');
    else node.paused = paused;
  }
  // gate: shadow (old names approve and manual) or a refused auto; a pause needs a reason.
  if (isPlainObject(value.gate)) {
    const gateMode = normalizeAutomationMode(value.gate.mode);
    if (gateMode) value.gate.mode = gateMode;
    const gatePaused = normalizePaused(value.gate.paused, { by, now });
    if (gatePaused === undefined) fail('gate.paused', 'Must be null or {reason}.');
    else value.gate.paused = gatePaused;
  }
  // --- signing
  if (isPlainObject(value.signing)) {
    const mode = normalizeAutomationMode(value.signing.mode);
    if (mode) value.signing.mode = mode;
    const paused = normalizePaused(value.signing.paused, { by, now });
    if (paused === undefined) fail('signing.paused', 'Must be null or {reason}.');
    else value.signing.paused = paused;
    const pilotList = Array.isArray(value.pilotClientIds) ? value.pilotClientIds : [];
    if (value.signing.enabled === true && value.signing.mode === 'auto' && !pilotList.length) {
      fail('signing.mode', 'signing runs in auto only for listed pilot clients. Add pilotClientIds first, or keep it in shadow.');
    }
  } else {
    fail('signing', 'Missing signing settings.');
  }
  // --- end signing
  // --- lifecycle
  validatePilotSwitch(value, 'lifecycle.planChange', { fail, by, now });
  validatePilotSwitch(value, 'lifecycle.cancellation', { fail, by, now });
  // --- end lifecycle
  // --- booking
  validatePilotSwitch(value, 'booking.selfLink', { fail, by, now });
  // --- end booking
  // --- intake: 'auto' reaches pilot clients only, so it needs a pilot list; a pause needs a reason.
  for (const name of ['tierSteps', 'transcriptKeywords']) {
    const node = value.intake?.[name];
    if (!isPlainObject(node)) continue;
    const mode = normalizeAutomationMode(node.mode);
    if (mode) node.mode = mode;
    const paused = normalizePaused(node.paused, { by, now });
    if (paused === undefined) fail(`intake.${name}.paused`, 'Must be null or {reason}.');
    else node.paused = paused;
    if (node.enabled === true && node.mode === 'auto' && !(Array.isArray(value.pilotClientIds) && value.pilotClientIds.length)) {
      fail(`intake.${name}.mode`, `intake.${name} runs in auto only for listed pilot clients. Add pilotClientIds first, or keep it in shadow.`);
    }
  }
  // --- end intake
  // --- cms fleet monitor
  for (const name of ['monitor', 'wakePing']) {
    const node = value.cmsFleet?.[name];
    if (!isPlainObject(node)) continue;
    const paused = normalizePaused(node.paused, { by, now });
    if (paused === undefined) fail(`cmsFleet.${name}.paused`, 'Must be null or {reason}.');
    else node.paused = paused;
  }
  // --- end cms fleet monitor
  // --- site rekey
  if (isPlainObject(value.siteRekey)) {
    const paused = normalizePaused(value.siteRekey.paused, { by, now });
    if (paused === undefined) fail('siteRekey.paused', 'Must be null or {reason}.');
    else value.siteRekey.paused = paused;
  }
  // --- end site rekey
  // --- visit statistics retention
  if (isPlainObject(value.retention?.analyticsTraffic)) {
    const paused = normalizePaused(value.retention.analyticsTraffic.paused, { by, now });
    if (paused === undefined) fail('retention.analyticsTraffic.paused', 'Must be null or {reason}.');
    else value.retention.analyticsTraffic.paused = paused;
  }
  // --- end visit statistics retention
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
  // delivery loop: 'auto' acts only for pilot clients, so it needs a pilot list.
  const loop = value.delivery?.loop;
  if (isPlainObject(loop)) {
    const paused = normalizePaused(loop.paused, { by, now });
    if (paused === undefined) fail('delivery.loop.paused', 'Must be null or {reason}.');
    else loop.paused = paused;
    if (loop.enabled === true && loop.mode === 'auto' && !(Array.isArray(value.pilotClientIds) && value.pilotClientIds.length)) {
      fail('delivery.loop.mode', 'delivery.loop can run in auto only with at least one client in pilotClientIds. Keep it in shadow.');
    }
  }
  if (!EMAIL_RE.test(String(value.alerts?.to || ''))) fail('alerts.to', 'Must be an email address.');
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(value.alerts?.digestAt || ''))) fail('alerts.digestAt', 'Must be HH:MM.');

  // brief: auto serves briefs to the Maker, which only pilot clients may get; refuse it without pilots.
  if (value.brief?.enabled === true && value.brief?.mode === 'auto' && Array.isArray(pilots) && !pilots.length) {
    fail('brief.mode', 'brief can run in auto only for pilot clients: list them in pilotClientIds first, or keep it in shadow.');
  }
  // release suite: the retention purge deletes data, so its auto also waits for a pilot list; a
  // pause on brief or privacy.purge needs a reason like every other pause.
  if (value.privacy?.purge?.enabled === true && value.privacy?.purge?.mode === 'auto' && Array.isArray(pilots) && !pilots.length) {
    fail('privacy.purge.mode', 'privacy.purge can run in auto only with at least one client in pilotClientIds. Keep it in shadow.');
  }
  for (const id of ['brief', 'privacy.purge']) {
    const node = getPath(value, id);
    if (!isPlainObject(node) || !Object.prototype.hasOwnProperty.call(node, 'paused')) continue;
    const paused = normalizePaused(node.paused, { by, now });
    if (paused === undefined) fail(`${id}.paused`, 'Must be null or {reason}.');
    else node.paused = paused;
  }
  // end release suite

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
  const settings = alignMailboxMaps(deepMerge(defaultAutomationSettings(), body));
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
  if (switchId === 'seo.jobGating' && !String(evidence || '').trim()) {
    return { ok: false, error: 'seo.jobGating needs evidence naming the reviewed output of scripts/seo-gating-diff.mjs.' };
  }
  let promotion = 'off';
  const result = writeSystemChange({
    dataDir, now, by, source: 'release', reason: `pre-release suite passed: ${suiteName}`,
    mutate: (next) => {
      next.releases = { ...(next.releases || {}) };
      next.releases[switchId] = { passedAt: now.toISOString(), suite: suiteName, evidence: String(evidence || '').slice(0, 500), by };
      if (next.promotion?.auto !== true) return;
      // release suite: promote only to settings that validate (a pilot-only switch without pilots,
      // or a mode the switch does not offer yet, keeps its mode and only records the pass).
      const candidate = clone(next);
      promoteReleased(candidate, switchId);
      const pilots = Array.isArray(next.pilotClientIds) ? next.pilotClientIds : [];
      if ((PILOT_ONLY_SWITCHES.includes(switchId) && !pilots.length) || !validateAutomationSettings({}, { current: candidate, by, now }).ok) {
        promotion = 'refused';
        return;
      }
      promoteReleased(next, switchId);
      promotion = 'promoted';
    },
  });
  return { ...result, promotion };
}

function promoteReleased(next, switchId) {
  if (switchId === 'emails.preWorkshop.gate') {
    next.emails.preWorkshop.lines = 'gate';
    next.emails.preWorkshop.mode = 'auto';
  } else if (switchId === 'development.autoQueue') {
    next.development.autoQueue = true;
  } else {
    const node = getPath(next, switchId);
    if (isPlainObject(node)) node.mode = 'auto';
  }
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
