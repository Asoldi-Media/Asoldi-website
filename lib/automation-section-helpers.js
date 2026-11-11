// Pure view-model for the superadmin automation screen.
// Field kinds follow the settings object: booleans, numbers, string lists, number lists,
// per-mailbox maps, and the enum lists mirrored from data/automation-settings.js.
// A path ending in `.mode` is shadow|auto unless that file lists a tighter set.
// A manual demotion stores mode `shadow`. The queue switch is a boolean.
// The workshop gate is put back to its previous lines only while those lines are `gate`.
import { AUTOMATION_MODES, BACKFILL_MODES, MAKER_EVENT_MODES } from '../packages/suite/core/delivery/vocab.js';

const SUPERADMIN_ROLES = new Set(['admin', 'superadmin']);

/** True only for the admin role that owns the automation settings routes. */
export function canSeeAutomation(role) {
  return SUPERADMIN_ROLES.has(String(role || '').trim().toLowerCase());
}

/**
 * Picker rows for pilotClientIds. Those ids are sales client ids, so the options come from
 * the sales list (`{ clients: [{ id, businessName }] }`), never from hub site ids.
 */
export function pilotPickerOptions(payload) {
  const clients = Array.isArray(payload) ? payload : (payload?.clients || []);
  return clients.map((client) => ({
    id: String(client?.id || ''),
    name: String(client?.businessName || client?.companyName || client?.name || client?.id || ''),
  })).filter((row) => row.id);
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

/**
 * Kind of a field from the defaults or the loaded value. A draft (cleared number, half-typed
 * list) must not change the kind.
 */
export function fieldKind(path, { defaults = {}, loaded = null, enums = SETTING_ENUMS } = {}) {
  const fromDefaults = getAt(defaults, path);
  if (fromDefaults !== undefined) return kindOf(path, fromDefaults, enums);
  const fromLoaded = loaded ? getAt(loaded, path) : undefined;
  return kindOf(path, fromLoaded, enums);
}

/** One row per leaf of `settings` and `defaults`, including keys that exist on only one of them. */
export function settingFields(settings, { defaults = {}, envOverrides = [], enums = SETTING_ENUMS, loaded = null } = {}) {
  const paths = [...new Set([...leafPaths(defaults), ...leafPaths(settings)])].sort();
  return paths.map((path) => {
    const own = getAt(settings, path);
    const value = own === undefined ? getAt(defaults, path) : own;
    const kind = fieldKind(path, { defaults, loaded: loaded || settings, enums });
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

/** The characters in a list field, including a trailing comma the user has not finished. */
export function listInputValue(text) {
  return String(text ?? '');
}

/**
 * Turns the raw field text into the value the store expects. Numbers stay numbers.
 * An empty number is left unchanged (undefined). Lists drop empty pieces.
 */
export function commitTypedText(path, text, context = {}) {
  const kind = fieldKind(path, context);
  if (kind === 'number') {
    const trimmed = String(text ?? '').trim();
    if (!trimmed) return undefined;
    const number = Number(trimmed);
    return Number.isFinite(number) ? number : undefined;
  }
  if (kind === 'string-list' || kind === 'number-list') {
    return parseList(text, { numbers: kind === 'number-list' });
  }
  return text;
}

export const INACTIVE_PROMOTION_TEXT = 'Ikke aktiv ennå.';

export const BLOCKER_LABELS = Object.freeze({
  disabled: 'Slått av',
  paused: 'Pauset',
  'mode-not-auto': 'Modus er ikke auto',
  'no-release': 'Mangler utgivelse',
  'no-pilots': 'Ingen pilotkunder',
  'no-feedback-feed': 'Mangler tilbakemeldinger',
});

function blockerLabel(id) {
  const key = String(id);
  return BLOCKER_LABELS[key] || key;
}

function guardCounters(guard) {
  if (!guard || typeof guard !== 'object') return null;
  return {
    sent: Number(guard.sent) || 0,
    error: Number(guard.error) || 0,
    bounce: Number(guard.bounce) || 0,
    complaint: Number(guard.complaint) || 0,
    previous: Array.isArray(guard.previous) ? guard.previous : [],
    verdict: guard.verdict && typeof guard.verdict === 'object' ? guard.verdict : null,
  };
}

/**
 * Reads a promotion response. A 404, a non-JSON body (the app shell), a parse failure,
 * or a body without a switches array is the quiet inactive state.
 */
export function parsePromotionResponse({ status, contentType, text } = {}) {
  if (status === 404) return { code: 'disabled' };
  const type = String(contentType || '').toLowerCase();
  if (!type.includes('json')) return { code: 'disabled' };
  let body;
  try {
    body = JSON.parse(String(text ?? ''));
  } catch {
    return { code: 'disabled' };
  }
  if (!body || typeof body !== 'object' || Array.isArray(body) || !Array.isArray(body.switches)) {
    return { code: 'disabled' };
  }
  return body;
}

/** True when the row's stored mode is auto. The gate row only while its lines are `gate`. */
export function canDemoteRow(row, settings) {
  const stored = row?.stored && typeof row.stored === 'object' ? row.stored : {};
  const mode = stored.mode ?? row?.mode ?? '';
  if (mode !== 'auto') return false;
  if (String(row?.id || '') !== 'emails.preWorkshop.gate') return true;
  const lines = settings?.emails?.preWorkshop?.lines ?? stored.lines ?? row?.lines;
  if (lines == null) return true;
  return lines === 'gate';
}

/**
 * Rows for the promotion dashboard. Inactive when the body is missing or has no switches
 * array. Blockers use the Norwegian labels above; an unknown id is shown as itself.
 */
export function promotionModel(payload) {
  const inactive = {
    active: false,
    message: INACTIVE_PROMOTION_TEXT,
    rows: [],
    pilots: 0,
    promotionAuto: false,
    guards: { settings: null, trips: [] },
    releaseKey: { installed: false, keyId: '' },
  };
  if (!payload || payload.code === 'disabled' || payload.disabled === true || !Array.isArray(payload.switches)) {
    return inactive;
  }
  const rows = payload.switches.map((row) => {
    const stored = row?.stored && typeof row.stored === 'object' ? row.stored : {};
    const blockers = (Array.isArray(row?.blockers) ? row.blockers : []).map((id) => ({
      id: String(id),
      label: blockerLabel(id),
    }));
    const view = {
      id: String(row?.id || ''),
      spine: row?.spine === true,
      stored,
      mode: stored.mode ?? '',
      enabled: stored.enabled,
      paused: Boolean(stored.paused),
      effective: row?.effective ?? '',
      autoReachable: row?.autoReachable === true,
      blockers,
      releasePassedAt: row?.release?.passedAt || '',
      guard: guardCounters(row?.guard),
    };
    return { ...view, canDemote: canDemoteRow(view) };
  });
  const guards = payload.guards && typeof payload.guards === 'object' ? payload.guards : {};
  const releaseKey = payload.releaseKey && typeof payload.releaseKey === 'object' ? payload.releaseKey : {};
  return {
    active: true,
    message: '',
    rows,
    pilots: Number(payload.pilots) || 0,
    promotionAuto: payload.promotionAuto === true,
    guards: { settings: guards.settings ?? null, trips: Array.isArray(guards.trips) ? guards.trips : [] },
    releaseKey: { installed: releaseKey.installed === true, keyId: String(releaseKey.keyId || '') },
  };
}

function nestMode(switchId, leaf) {
  const parts = String(switchId || '').split('.').filter(Boolean);
  if (!parts.length) return null;
  const patch = {};
  let node = patch;
  for (let i = 0; i < parts.length - 1; i += 1) {
    node[parts[i]] = {};
    node = node[parts[i]];
  }
  node[parts[parts.length - 1]] = leaf;
  return patch;
}

/**
 * Settings patch that demotes one switch. Mode switches go to shadow. The queue switch
 * turns off. The workshop gate returns to the previous lines, and only while it is on `gate`.
 */
export function demoteSwitchPatch(switchId, settings) {
  const id = String(switchId || '');
  if (id === 'development.autoQueue') return { development: { autoQueue: false } };
  if (id === 'emails.preWorkshop.gate') {
    const lines = settings?.emails?.preWorkshop?.lines;
    if (lines && lines !== 'gate') return null;
    return { emails: { preWorkshop: { lines: 'legacy' } } };
  }
  return nestMode(id, { mode: 'shadow' });
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
