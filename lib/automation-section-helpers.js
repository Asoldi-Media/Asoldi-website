// Pure view-model for the superadmin automation screen.
// Field kinds follow the settings object: booleans, numbers, string lists, number lists,
// per-mailbox maps, and the enum lists mirrored from data/automation-settings.js.
// A path ending in `.mode` is shadow|auto unless that file lists a tighter set.
// `approve` is the manual demotion; the store reads it as shadow.
import { AUTOMATION_MODES, BACKFILL_MODES, MAKER_EVENT_MODES } from '../packages/suite/core/delivery/vocab.js';

const SUPERADMIN_ROLES = new Set(['admin', 'superadmin']);

/** True only for the admin role that owns the automation settings routes. */
export function canSeeAutomation(role) {
  return SUPERADMIN_ROLES.has(String(role || '').trim().toLowerCase());
}

/** Role claim inside an admin session token. Empty when the token is missing or not that shape. */
export function roleFromAdminToken(token) {
  try {
    const pad = String(token || '').replace(/-/g, '+').replace(/_/g, '/');
    const padded = pad + '='.repeat((4 - (pad.length % 4)) % 4);
    const wrapped = JSON.parse(atob(padded));
    const payload = JSON.parse(wrapped.data);
    return String(payload?.role || '');
  } catch {
    return '';
  }
}

/** Enum lists from data/automation-settings.js. Mode paths not listed here use shadow|auto. */
export const SETTING_ENUMS = Object.freeze({
  'emails.preWorkshop.lines': Object.freeze(['legacy', 'gate']),
  'sender.scheduling': Object.freeze(['owner-rep', 'service']),
  'inbox.prefilter': Object.freeze(['known-contacts']),
  'development.directivesForAutoDev': Object.freeze(['accepted+must', 'accepted', 'none']),
  'changeRequests.enforce': Object.freeze(['track', 'enforce']),
  'changeRequests.countAt': Object.freeze(['accepted']),
  'development.makerEvents': Object.freeze([...MAKER_EVENT_MODES]),
  'migrations.deliveryBackfill': Object.freeze([...BACKFILL_MODES]),
  'seo.jobGating.mode': Object.freeze([...AUTOMATION_MODES]),
  'delivery.loop.mode': Object.freeze([...AUTOMATION_MODES]),
  'gate.mode': Object.freeze(['shadow']),
  'brief.mode': Object.freeze([...AUTOMATION_MODES]),
  'privacy.purge.mode': Object.freeze([...AUTOMATION_MODES]),
  'signing.mode': Object.freeze([...AUTOMATION_MODES]),
  'intake.tierSteps.mode': Object.freeze([...AUTOMATION_MODES]),
  'intake.transcriptKeywords.mode': Object.freeze([...AUTOMATION_MODES]),
  'cmsFleet.monitor.mode': Object.freeze([...AUTOMATION_MODES]),
});

const LEAF_OBJECT = /^(?:releases|inbox\.autoActions|inbox\.autoReply)$|\.paused$/;

const GROUP_LABELS = Object.freeze({
  emails: 'E-post',
  sender: 'Avsender',
  inbox: 'Innboks',
  fireflies: 'Møteopptak',
  development: 'Utvikling',
  publish: 'Publisering',
  changeRequests: 'Endringsønsker',
  pricing: 'Pris',
  lifecycle: 'Livsløp',
  promotion: 'Opprykk',
  storage: 'Lagring',
  alerts: 'Varsler',
  pilotClientIds: 'Pilotkunder',
  privacy: 'Personvern',
  media: 'Medier',
  seo: 'Synlighet',
  delivery: 'Leveranse',
  gate: 'Krav',
  brief: 'Underlag',
  signing: 'Signering',
  intake: 'Inntak',
  cmsFleet: 'Nettstedflåte',
  guards: 'Vern',
  retention: 'Oppbevaring',
  migrations: 'Flytting',
  legal: 'Juridisk tekst',
  version: 'Versjon',
  releases: 'Utgivelser',
});

const FIELD_LABELS = Object.freeze({
  enabled: 'På',
  mode: 'Modus',
  paused: 'Pause',
  lines: 'Linjer',
  scheduling: 'Planlegging',
  accountKey: 'Konto',
  replyTo: 'Svar til',
  mailboxes: 'Postkasser',
  autoActions: 'Automatiske handlinger',
  autoReply: 'Automatisk svar',
  prefilter: 'Forfilter',
  internalDomains: 'Interne domener',
  internalSenders: 'Interne avsendere',
  candidateMinScore: 'Laveste poeng',
  requireExactAttendeeEmail: 'Krever nøyaktig e-post',
  slotWindowMinutes: 'Tidsvindu (minutter)',
  autoQueue: 'Automatisk kø',
  directivesForAutoDev: 'Direktiver',
  defaultHostId: 'Standard vert',
  requireConfirmForCustom: 'Bekreft tilpasning',
  previewJobs: 'Forhåndsvisningsjobber',
  seoJobs: 'Synlighetsjobber',
  makerEvents: 'Hendelser',
  deliveryBackfill: 'Etterfylling',
  tiers: 'Planer',
  enforce: 'Håndheving',
  slaWorkDays: 'Frist (virkedager)',
  countAt: 'Telles ved',
  oneTimeMultiplier: 'Engangsfaktor',
  oneTimeMinExMva: 'Minstebeløp eks. mva',
  oneTimeMonths: 'Engangsmåneder',
  paymentGraceDays: 'Betalingsfrist (dager)',
  cancellationGraceDays: 'Oppsigelsesfrist (dager)',
  auto: 'Automatisk',
  budgetFiles: 'Filbudsjett',
  budgetMb: 'Megabyte-budsjett',
  to: 'Til',
  hostOfflineHours: 'Vert nede (timer)',
  jobBlockedHours: 'Jobb stoppet (timer)',
  digestAt: 'Sammendrag klokkeslett',
  cadenceDays: 'Intervall (dager)',
  delayMinutes: 'Forsinkelse (minutter)',
  afterDays: 'Etter (dager)',
  max: 'Maks',
  pilotClientIds: 'Pilotkunder',
  errorRatePct: 'Feilrate (prosent)',
  bounceRatePct: 'Returrate (prosent)',
  complaintsMax: 'Maks klager',
  volumeSpikeFactor: 'Volumtopp',
  windowHours: 'Vindu (timer)',
  minSample: 'Minste utvalg',
  leadMonths: 'Lead (måneder)',
  afterContractMonths: 'Etter kontrakt (måneder)',
  briefOldVersionsDays: 'Gamle underlag (dager)',
  changeRequestsMonths: 'Endringsønsker (måneder)',
  nurtureProofYears: 'Oppfølgingsbevis (år)',
  inboxSkipLogDays: 'Hoppet over (dager)',
  autoApplyFlip: 'Bruk forslag automatisk',
  catalogTexts: 'Katalogtekster',
});

export function groupLabel(group) {
  return GROUP_LABELS[group] || group;
}

export function labelFor(path) {
  const last = String(path || '').split('.').pop();
  return FIELD_LABELS[last] || FIELD_LABELS[path] || last || path;
}

function isPlain(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function same(a, b) {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

export function getAt(root, path) {
  return String(path || '').split('.').reduce((node, key) => (node == null ? undefined : node[key]), root);
}

export function setAt(root, path, value) {
  const clone = structuredClone(root);
  const keys = String(path || '').split('.').filter(Boolean);
  let node = clone;
  for (const key of keys.slice(0, -1)) {
    if (!isPlain(node[key])) node[key] = {};
    node = node[key];
  }
  node[keys[keys.length - 1]] = value;
  return clone;
}

function leafPaths(obj, prefix = '') {
  const out = [];
  for (const [key, value] of Object.entries(obj || {})) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (isPlain(value) && !LEAF_OBJECT.test(path)) out.push(...leafPaths(value, path));
    else out.push(path);
  }
  return out;
}

export function kindOf(path, value, enums = SETTING_ENUMS) {
  if (path === 'version' || path === 'releases') return 'readonly';
  if (/\.paused$/.test(path)) return 'paused';
  if (path === 'inbox.autoActions' || path === 'inbox.autoReply') return 'mailbox-map';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return 'number';
  if (Array.isArray(value) && value.every((item) => typeof item === 'number')) return 'number-list';
  if (Array.isArray(value)) return 'string-list';
  if (enums[path] || (String(path).endsWith('.mode') && typeof value === 'string')) return 'enum';
  if (typeof value === 'string') return 'string';
  return 'readonly';
}

export function enumOptions(path, enums = SETTING_ENUMS) {
  if (enums[path]) return [...enums[path]];
  if (String(path).endsWith('.mode')) return [...AUTOMATION_MODES];
  return [];
}

/** One row per leaf of `settings` and `defaults`, including keys that exist on only one of them. */
export function settingFields(settings, { defaults = {}, envOverrides = [], enums = SETTING_ENUMS } = {}) {
  const paths = [...new Set([...leafPaths(defaults), ...leafPaths(settings)])].sort();
  return paths.map((path) => {
    const own = getAt(settings, path);
    const value = own === undefined ? getAt(defaults, path) : own;
    const kind = kindOf(path, value, enums);
    const hit = envOverrides.find((entry) => entry?.path === path || (entry?.path && (path === entry.path || path.startsWith(`${entry.path}.`))));
    return {
      path,
      group: path.split('.')[0],
      label: labelFor(path),
      kind,
      value,
      options: kind === 'enum' ? enumOptions(path, enums) : [],
      overriddenBy: hit ? 'env' : '',
      editable: kind !== 'readonly',
    };
  });
}

/** Partial object of paths whose JSON changed. Mailbox maps and pauses replace as a whole. */
export function diffPatch(before, after, prefix = '') {
  if (same(before, after)) return undefined;
  if (!isPlain(before) || !isPlain(after) || (prefix && LEAF_OBJECT.test(prefix))) {
    return after === undefined ? null : structuredClone(after);
  }
  const out = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const path = prefix ? `${prefix}.${key}` : key;
    const child = diffPatch(before[key], after[key], path);
    if (child !== undefined) out[key] = child;
  }
  return out;
}

export function parseList(text, { numbers = false } = {}) {
  const parts = String(text ?? '').split(',').map((part) => part.trim()).filter(Boolean);
  if (!numbers) return parts;
  return parts.map((part) => Number(part));
}

export const INACTIVE_PROMOTION_TEXT = 'Ikke aktiv ennå.';

export const BLOCKER_LABELS = Object.freeze({
  disabled: 'Slått av',
  paused: 'Pauset',
  'mode-not-auto': 'Modus er ikke auto',
  'no-release': 'Mangler utgivelse',
  'no-pilots': 'Ingen pilotkunder',
});

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function guardProgress(guard) {
  if (!guard || typeof guard !== 'object') return { streak: null, target: null };
  return {
    streak: finite(guard.streak ?? guard.cleanStreak ?? guard.clean),
    target: finite(guard.target ?? guard.cleanTarget ?? guard.required),
  };
}

/**
 * Rows for the promotion dashboard. A 404 `{code:'disabled'}` (or no body) is inactive,
 * not an error. Blockers use the Norwegian labels above. Rows sort by spine, then id.
 */
export function promotionModel(payload) {
  if (!payload || payload.code === 'disabled' || payload.disabled === true) {
    return { active: false, message: INACTIVE_PROMOTION_TEXT, rows: [] };
  }
  const rows = (Array.isArray(payload.switches) ? payload.switches : []).map((row) => {
    const progress = guardProgress(row?.guard);
    const blockers = (Array.isArray(row?.blockers) ? row.blockers : []).map((id) => ({
      id: String(id),
      label: BLOCKER_LABELS[id] || String(id),
    }));
    return {
      id: String(row?.id || ''),
      spine: String(row?.spine || ''),
      mode: row?.stored?.mode ?? row?.effective ?? '',
      enabled: row?.stored?.enabled,
      paused: Boolean(row?.stored?.paused),
      effective: row?.effective ?? '',
      autoReachable: row?.autoReachable === true,
      blockers,
      releasePassedAt: row?.release?.passedAt || '',
      streak: progress.streak,
      target: progress.target,
      guard: row?.guard || null,
    };
  }).sort((a, b) => a.spine.localeCompare(b.spine) || a.id.localeCompare(b.id));
  return {
    active: true,
    message: '',
    rows,
    pilots: Array.isArray(payload.pilots) ? payload.pilots : [],
    promotionAuto: payload.promotionAuto === true,
    guards: payload.guards || null,
    releaseKey: payload.releaseKey || null,
  };
}

/** Settings patch that demotes one switch by setting its mode to `approve`. */
export function demoteSwitchPatch(switchId) {
  const id = String(switchId || '').replace(/\.gate$/, '');
  const parts = id.split('.').filter(Boolean);
  if (!parts.length) return {};
  const patch = {};
  let node = patch;
  for (let i = 0; i < parts.length - 1; i += 1) {
    node[parts[i]] = {};
    node = node[parts[i]];
  }
  node[parts[parts.length - 1]] = { mode: 'approve' };
  return patch;
}

/**
 * One safe edit per field kind, taken from the loaded settings so mailbox maps keep listed mailboxes.
 * Values stay inside the store's validation.
 */
export function roundTripEdits(settings) {
  const reply = { ...(getAt(settings, 'inbox.autoReply') || {}) };
  const first = Object.keys(reply)[0];
  if (first) reply[first] = !reply[first];
  return [
    { type: 'boolean', path: 'promotion.auto', value: false },
    { type: 'number', path: 'lifecycle.paymentGraceDays', value: 15 },
    { type: 'enum', path: 'sender.scheduling', value: 'service' },
    { type: 'string', path: 'alerts.digestAt', value: '09:15' },
    { type: 'string-list', path: 'inbox.internalDomains', value: ['example.com'] },
    { type: 'number-list', path: 'emails.nurture.cadenceDays', value: [30, 90, 180] },
    { type: 'mailbox-map', path: 'inbox.autoReply', value: reply },
    { type: 'paused', path: 'publish.production.paused', value: { at: '2026-11-01T00:00:00.000Z', reason: 'kontroll', by: 'test' } },
  ];
}
