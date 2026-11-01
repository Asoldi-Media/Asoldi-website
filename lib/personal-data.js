// Personal-data registry: every store on the data disk that holds data about a client, with its
// retention rule and its export and erase handlers.
//
//   registerStore({ id, label, files | dir, clientKey, retention, export, erase, purge?, writers? })
//   exportClient(clientId)                  one JSON bundle with every store's records and files
//   eraseClient(clientId, { dryRun = true }) the plan (dry run) or the erase; legal holds stay
//   retentionText(storeId)                  the retention rule as text, for the legal pages
//   clientRetention(client)                 how long a client's records are kept, from retention.*
//
// Other modules add their stores by calling registerStore with their own id (the built-in row with
// that id is replaced). Nothing here runs on its own: the routes in lib/routes/privacy-routes.js and
// the daily step in lib/delivery-retention.js call it, both behind privacy switches.
//
// Copies: an erase also takes the client out of the snapshot copies (snapshots/<id>/<file>) and the
// automatic backups (backups/<file>.latest.json and backups/<file>.<stamp>.json) of every store it
// deletes from or redacts (COPY_SCRUBBERS). Copies of what an erase holds (signed contracts, the
// client account, the hub site) keep the held records too. A copy that does not parse is reported
// as kept ('unreadable-copy') and never rewritten.
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, normalize, relative, resolve, sep } from 'node:path';
import { getAutomationSettings } from '../data/automation-settings.js';
import { getDataBackupDir, getPersistentDataDir, writeDataJson } from '../data/storage-path.js';
import * as sales from '../data/sales.js';
import * as salesOffers from '../data/sales-offers.js';
import * as portalOffers from '../data/offers.js';
import * as clientPortal from '../data/client-portal.js';
import * as hub from '../data/hub.js';
import { readFirefliesStore, updateFirefliesStore } from './fireflies-store.js';
import { firefliesMediaRoot } from './fireflies-media.js';
import { hashEmail } from './email-log.js';
import { hubSiteForClient, profileForClient } from './delivery-backfill.js';
import { appendDeliveryAudit } from './delivery-audit.js';
import { acquireLease } from '../data/email-store.js';

export const PERSONAL_DATA_EXPORT_KIND = 'asoldi.personal-data-export';
export const PERSONAL_DATA_EXPORT_VERSION = 1;
export const ERASE_ACTIONS = Object.freeze(['delete', 'redact', 'hold', 'retain', 'none']);
const MONTH_MS = 30.4375 * 24 * 60 * 60 * 1000;
const CLIENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
const MAX_INLINE_JSON_BYTES = 2 * 1024 * 1024;
export const ERASE_LEASE_MS = 10 * 60 * 1000;
// An export hashes files up to this size, reading them as a stream; larger files (meeting video) are
// listed with their size and an empty sha256, so an export never reads hundreds of megabytes.
export const EXPORT_HASH_MAX_BYTES = 32 * 1024 * 1024;

// ---------------------------------------------------------------- helpers

function text(value) {
  return String(value ?? '').trim();
}

export function isValidClientId(id) {
  const value = text(id);
  return CLIENT_ID_RE.test(value) && !value.includes('..');
}

function dataDirOf(ctx = {}) {
  return ctx.dataDir || getPersistentDataDir();
}

function rel(ctx, path) {
  return relative(dataDirOf(ctx), path).split(sep).join('/');
}

function inside(root, path) {
  const rootAbs = resolve(root);
  const abs = resolve(path);
  return abs === rootAbs || abs.startsWith(rootAbs + sep);
}

function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

/**
 * Files under `dir` (recursive), or `dir` itself when it is a file, as { path (relative to the data
 * dir), bytes }. Nothing is read: an erase plan only needs the paths, and exportClient adds sha256.
 */
export function listFilesUnder(dir, ctx = {}) {
  if (!dir || !existsSync(dir)) return [];
  const out = [];
  const walk = (current, depth) => {
    if (depth > 6) return;
    let entries = [];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.isFile()) {
        let bytes = 0;
        try {
          bytes = statSync(full).size;
        } catch {
          // Removed meanwhile.
        }
        out.push({ path: rel(ctx, full), bytes });
      }
    }
  };
  try {
    if (statSync(dir).isFile()) return [{ path: rel(ctx, dir), bytes: statSync(dir).size }];
  } catch {
    return [];
  }
  walk(dir, 0);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** sha256 of one file, read as a stream (the event loop keeps running, memory stays at one chunk). */
export async function sha256FileAsync(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

/** Adds sha256 to listed files up to `maxBytes`; larger or unreadable files get ''. */
export async function hashListedFiles(files = [], ctx = {}, { maxBytes = EXPORT_HASH_MAX_BYTES } = {}) {
  const out = [];
  for (const file of Array.isArray(files) ? files : []) {
    if (!file || typeof file !== 'object' || typeof file.sha256 === 'string' || !text(file.path)) {
      out.push(file);
      continue;
    }
    let sha256 = '';
    const full = join(dataDirOf(ctx), file.path);
    if (Number(file.bytes) <= maxBytes && inside(dataDirOf(ctx), full)) {
      try {
        sha256 = await sha256FileAsync(full);
      } catch {
        sha256 = '';
      }
    }
    out.push({ ...file, sha256 });
  }
  return out;
}

function inlineJsonFiles(files, ctx) {
  return files.map((file) => {
    if (!file.path.endsWith('.json') || file.bytes > MAX_INLINE_JSON_BYTES) return file;
    return { ...file, content: readJson(join(dataDirOf(ctx), file.path), null) };
  });
}

function addMonths(iso, months) {
  const ms = Date.parse(text(iso));
  if (!Number.isFinite(ms)) return '';
  return new Date(ms + months * MONTH_MS).toISOString();
}

function latestIso(values = []) {
  const stamps = values.map((value) => Date.parse(text(value))).filter(Number.isFinite);
  return stamps.length ? new Date(Math.max(...stamps)).toISOString() : '';
}

function settingsOf(ctx = {}) {
  if (ctx.settings && typeof ctx.settings === 'object') return ctx.settings;
  try {
    return getAutomationSettings();
  } catch {
    return {};
  }
}

function retentionSettings(settings = {}) {
  const r = settings?.retention || {};
  const num = (value, fallback) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : fallback);
  return {
    leadMonths: num(r.leadMonths, 12),
    afterContractMonths: num(r.afterContractMonths, 12),
    briefOldVersionsDays: num(r.briefOldVersionsDays, 90),
    changeRequestsMonths: num(r.changeRequestsMonths, 24),
    nurtureProofYears: num(r.nurtureProofYears, 3),
    inboxSkipLogDays: num(r.inboxSkipLogDays, 30),
  };
}

// The inbox store is loaded when a handler needs it, so a change to its exports never stops the hub
// from booting; its stores then report an error and erase nothing.
async function inboxStore() {
  try {
    const mod = await import('./inbox-bot/store.js');
    if (typeof mod.listInboxItems === 'function' && typeof mod.updateInboxItem === 'function') return mod;
  } catch {
    // Reported by the caller.
  }
  return null;
}

const INBOX_UNAVAILABLE = 'inbox store unavailable';

// ---------------------------------------------------------------- client state

export function clientIsSigned(client = {}) {
  return client?.progression?.contractSigned === true || Boolean(text(client?.contractSignedAt));
}

/** When the client's contract ended (cancelled, ended or void plan), or '' while it runs. */
export function contractEndedAt(client = {}) {
  const delivery = client?.delivery && typeof client.delivery === 'object' ? client.delivery : {};
  const plan = client?.sitePlan && typeof client.sitePlan === 'object' ? client.sitePlan : {};
  const cancelled = text(delivery.overlay) === 'cancelled' || ['cancelled', 'archived'].includes(text(delivery.stage));
  const endedPlan = ['ended', 'void', 'cancelled'].includes(text(plan.status));
  if (!cancelled && !endedPlan) return '';
  const stamped = latestIso([delivery.cancelledAt, delivery.endedAt, plan.endedAt, plan.voidedAt, plan.statusAt]);
  return stamped || latestIso([cancelled ? delivery.stageAt : '', client.updatedAt]) || text(client.updatedAt);
}

export function clientHasActiveContract(client = {}) {
  return clientIsSigned(client) && !contractEndedAt(client);
}

/**
 * The last thing that happened with a lead, from stamps that only real activity sets: the card's
 * creation, a booked or missed meeting, a recording, a call, a sent contract, a decline and a nurture
 * mail. updatedAt is left out on purpose: automatic passes (links, syncs) bump it, which would push
 * the retention date forward for ever.
 */
export function lastActivityAt(client = {}) {
  const meetings = Array.isArray(client?.meetings) ? client.meetings : [];
  return latestIso([
    client?.createdAt,
    client?.meetingAt,
    client?.missedMeetingAt,
    client?.contractSentAt,
    client?.archive?.archivedAt,
    client?.nurture?.lastSentAt,
    client?.myphoner?.latestCallStartedAt,
    ...meetings.map((row) => row?.startedAt || row?.linkedAt),
  ]);
}

/**
 * How long a client's personal data is kept (retention.*):
 *   signed, contract running        basis 'contract-active', until ''  (kept while the contract runs)
 *   signed, contract ended          contract end + afterContractMonths
 *   deferred (secondary or nurture) last activity + leadMonths, recomputed while nurture runs
 *   not sold                        not-sold date (or last activity) + leadMonths
 *   lead                            last activity + leadMonths
 */
export function clientRetention(client = {}, { settings } = {}) {
  const r = retentionSettings(settings || settingsOf());
  if (clientIsSigned(client)) {
    const ended = contractEndedAt(client);
    if (!ended) return { basis: 'contract-active', until: '' };
    return { basis: 'contract-ended', until: addMonths(ended, r.afterContractMonths) };
  }
  const last = lastActivityAt(client);
  const nurtureActive = client?.nurture && typeof client.nurture === 'object' && client.nurture.active === true;
  if (text(client?.status) === 'secondary' || nurtureActive) {
    return { basis: 'deferred', until: addMonths(latestIso([last, client?.nurture?.nextAt]), r.leadMonths) };
  }
  if (text(client?.status) === 'not-sold') {
    return { basis: 'not-sold', until: addMonths(latestIso([client?.archive?.archivedAt, last]), r.leadMonths) };
  }
  return { basis: 'lead', until: addMonths(last, r.leadMonths) };
}

/** True when the client's retention date has passed (never for a running contract). */
export function clientRetentionExpired(client = {}, { settings, now = new Date() } = {}) {
  const { until } = clientRetention(client, { settings });
  const at = now instanceof Date ? now.getTime() : Date.parse(text(now));
  return Boolean(until) && Number.isFinite(at) && Date.parse(until) <= at;
}

// ---------------------------------------------------------------- retention texts

const RETENTION_TEXTS = {
  'lead-or-contract': {
    nb: (r) => `Leads: ${r.leadMonths} måneder etter siste aktivitet eller avslag. Kunder: så lenge avtalen løper, og ${r.afterContractMonths} måneder etter at den er avsluttet.`,
    en: (r) => `Leads: ${r.leadMonths} months after the last activity or a decline. Clients: while the contract runs, and ${r.afterContractMonths} months after it ends.`,
  },
  transcript: {
    nb: (r) => `Leads som ikke signerer: ${r.leadMonths} måneder etter siste aktivitet eller avslag. Utsatte leads: mens oppfølgingen pågår, deretter ${r.leadMonths} måneder. Kunder: avtaleslutt pluss ${r.afterContractMonths} måneder. Slettes av den daglige oppryddingen.`,
    en: (r) => `Leads who do not sign: ${r.leadMonths} months after the last activity or a decline. Deferred leads: while follow-up runs, then ${r.leadMonths} months. Clients: contract end plus ${r.afterContractMonths} months. Removed by the daily purge.`,
  },
  brief: {
    nb: (r) => `Siste versjon mens kunden er aktiv; eldre versjoner ${r.briefOldVersionsDays} dager; alt slettes ${r.afterContractMonths} måneder etter avtaleslutt.`,
    en: (r) => `The latest version while the client is active; older versions ${r.briefOldVersionsDays} days; everything ${r.afterContractMonths} months after the contract ends.`,
  },
  contract: {
    nb: () => 'Signerte avtaler og fakturagrunnlag oppbevares så lenge bokføringsloven krever (fem år etter regnskapsårets slutt).',
    en: () => 'Signed contracts and invoice records are kept as long as Norwegian bookkeeping law requires (five years after the end of the financial year).',
  },
  'ids-24': {
    nb: () => 'Inneholder bare ID-er. Månedsfiler slettes etter 24 måneder.',
    en: () => 'Ids only. Monthly files are dropped after 24 months.',
  },
  'ids-12': {
    nb: () => 'Inneholder bare ID-er. Månedsfiler slettes etter 12 måneder.',
    en: () => 'Ids only. Monthly files are dropped after 12 months.',
  },
  'ids-10-reports': {
    nb: () => 'Inneholder bare ID-er. De ti nyeste rapportene beholdes.',
    en: () => 'Ids only. The ten newest reports are kept.',
  },
  'email-log': {
    nb: () => 'Ingen e-postadresser i klartekst (bare hash og maskert adresse). Månedsfiler slettes 400 dager etter månedens slutt.',
    en: () => 'No plain addresses (a hash and a masked address only). Monthly files are dropped 400 days after the month ends.',
  },
  snapshots: {
    nb: () => 'Kopier av leveransedata før en oppdatering. De tre nyeste beholdes. En sletting fjerner kunden fra kopiene av det den sletter; det som holdes tilbake (signerte avtaler, kundekontoen, nettstedet), blir også stående i kopiene.',
    en: () => 'Copies of the delivery stores before an update. The three newest are kept. An erase removes the client from the copies of what it erases; what it holds back (signed contracts, the client account, the site) stays in the copies too.',
  },
  backups: {
    nb: () => 'Automatiske sikkerhetskopier ved hver lagring. De nyeste kopiene beholdes. En sletting fjerner kunden fra kopiene av det den sletter; det som holdes tilbake, blir også stående i kopiene, og en kopi som ikke kan leses, rapporteres og beholdes til den roteres ut.',
    en: () => 'Automatic backups on every write. The newest copies are kept. An erase removes the client from the copies of what it erases; what it holds back stays in the copies too, and a copy that cannot be read is reported and kept until it rotates out.',
  },
  account: {
    nb: () => 'Kundekonto og betalingshistorikk beholdes mens kontoen finnes; kunden sletter eller deaktiverer den i portalen. Betalingsgrunnlag følger bokføringsloven.',
    en: () => 'The client account and its payment history are kept while the account exists; the client deletes or deactivates it in the portal. Payment records follow bookkeeping law.',
  },
  site: {
    nb: (r) => `Nettstedet beholdes mens avtalen løper og fjernes ved oppsigelse; data om kunden slettes ${r.afterContractMonths} måneder etter avtaleslutt.`,
    en: (r) => `The site is kept while the contract runs and removed on cancellation; data about the client goes ${r.afterContractMonths} months after the contract ends.`,
  },
  media: {
    nb: (r) => `Mediefiler fra kunden beholdes som kundedataene (leads ${r.leadMonths} måneder etter siste aktivitet, kunder avtaleslutt pluss ${r.afterContractMonths} måneder). Signerte nedlastingslenker gjelder i 24 timer.`,
    en: (r) => `Client media follow the client's data (leads ${r.leadMonths} months after the last activity, clients contract end plus ${r.afterContractMonths} months). Signed download links last 24 hours.`,
  },
  library: {
    nb: () => 'Filer i mediebiblioteket for asoldi.com som er merket med kunden. En sletting holder dem tilbake og lister dem, så de fjernes i biblioteket etter at det er sjekket hvor de brukes.',
    en: () => 'Files in the asoldi.com media library tagged with the client. An erase holds them and lists them, so they are removed in the library once it is checked where they are used.',
  },
};

// ---------------------------------------------------------------- registry

const stores = new Map();

function normalizeDescriptor(input = {}) {
  const id = text(input.id);
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(id)) throw new Error(`registerStore: bad id "${id}"`);
  if (typeof input.export !== 'function') throw new Error(`registerStore ${id}: export must be a function`);
  if (typeof input.erase !== 'function') throw new Error(`registerStore ${id}: erase must be a function`);
  const retention = typeof input.retention === 'string' ? { rule: input.retention } : { ...(input.retention || {}) };
  return {
    id,
    label: text(input.label) || id,
    files: Array.isArray(input.files) ? input.files.map(text).filter(Boolean) : [],
    dir: text(input.dir),
    clientKey: text(input.clientKey) || 'clientId',
    retention,
    personalData: text(input.personalData),
    purpose: text(input.purpose),
    legalBasis: text(input.legalBasis),
    processors: Array.isArray(input.processors) ? input.processors.map(text).filter(Boolean) : [],
    export: input.export,
    erase: input.erase,
    purge: typeof input.purge === 'function' ? input.purge : null,
    writers: Array.isArray(input.writers) ? input.writers.map(text).filter(Boolean) : [],
    order: Number.isFinite(input.order) ? input.order : 50,
  };
}

/** Adds a store, or replaces the store with the same id. Returns the stored descriptor. */
export function registerStore(input) {
  const descriptor = normalizeDescriptor(input);
  stores.set(descriptor.id, descriptor);
  return descriptor;
}

export function registeredStores() {
  return [...stores.values()].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

export function getStore(id) {
  return stores.get(text(id)) || null;
}

/** The retention rule of a store as text ('nb' or 'en'), with the numbers from retention.*. */
export function retentionText(storeId, { settings, lang = 'nb' } = {}) {
  const store = getStore(storeId);
  if (!store) return '';
  if (store.retention.text) return store.retention.text;
  const rule = RETENTION_TEXTS[store.retention.rule];
  if (!rule) return '';
  const render = rule[lang] || rule.nb;
  return render(retentionSettings(settings || settingsOf()));
}

// ---------------------------------------------------------------- generic store kinds

/** A per-client folder or file: <dataDir>/<dir>/<clientId>[suffix]. */
export function perClientPath(dir, clientId, { suffix = '', ctx = {} } = {}) {
  if (!isValidClientId(clientId)) return '';
  return join(dataDirOf(ctx), dir, `${text(clientId)}${suffix}`);
}

function perClientStore({ id, dir, suffix = '', pathOf = null, holdWhen = null, ...rest }) {
  const resolvePath = (clientId, ctx) => (typeof pathOf === 'function' ? pathOf(clientId, ctx) : perClientPath(dir, clientId, { suffix, ctx }));
  return {
    id,
    dir,
    clientKey: 'path',
    ...rest,
    export(clientId, ctx) {
      const path = resolvePath(clientId, ctx);
      const files = path ? listFilesUnder(path, ctx) : [];
      return { files: inlineJsonFiles(files, ctx) };
    },
    erase(clientId, ctx) {
      const path = resolvePath(clientId, ctx);
      const files = path ? listFilesUnder(path, ctx).map((file) => file.path) : [];
      if (!files.length) return { action: 'none', records: 0, files: [] };
      const hold = typeof holdWhen === 'function' ? holdWhen(ctx) : '';
      if (hold) return { action: 'hold', records: 0, files, reason: hold };
      if (!ctx.dryRun) rmSync(path, { recursive: true, force: true });
      return { action: 'delete', records: 0, files };
    },
  };
}

function monthlyLogLines(dir, ctx, predicate) {
  const root = join(dataDirOf(ctx), dir);
  if (!existsSync(root)) return [];
  const out = [];
  for (const name of readdirSync(root).filter((entry) => entry.endsWith('.jsonl')).sort()) {
    let body = '';
    try {
      body = readFileSync(join(root, name), 'utf8');
    } catch {
      continue;
    }
    for (const line of body.split('\n')) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        if (predicate(row)) out.push({ file: `${dir}/${name}`, ...row });
      } catch {
        // A torn line is skipped.
      }
    }
  }
  return out;
}

function idsOnlyLogStore({ id, dir, field = 'clientId', rule, ...rest }) {
  return {
    id,
    dir,
    clientKey: field,
    retention: { rule },
    ...rest,
    export(clientId, ctx) {
      return { records: monthlyLogLines(dir, ctx, (row) => text(row?.[field]) === text(clientId)) };
    },
    erase(clientId, ctx) {
      const lines = monthlyLogLines(dir, ctx, (row) => text(row?.[field]) === text(clientId));
      return lines.length
        ? { action: 'retain', records: lines.length, files: [...new Set(lines.map((row) => row.file))], reason: 'ids-only-log' }
        : { action: 'none', records: 0, files: [] };
    },
  };
}

/** Keyed object file ({ <mapKey>: { <clientId>: entry } }) written through writeDataJson by its module. */
function keyedObjectStore({ id, file, mapKey, ...rest }) {
  const pathOf = (ctx) => join(dataDirOf(ctx), file);
  return {
    id,
    files: [file],
    clientKey: `${mapKey}.<clientId>`,
    ...rest,
    export(clientId, ctx) {
      const doc = readJson(pathOf(ctx), {});
      const entry = doc?.[mapKey]?.[text(clientId)];
      return { records: entry ? [entry] : [] };
    },
    erase(clientId, ctx) {
      const path = pathOf(ctx);
      const doc = readJson(path, null);
      if (!doc?.[mapKey] || !Object.prototype.hasOwnProperty.call(doc[mapKey], text(clientId))) return { action: 'none', records: 0, files: [] };
      if (!ctx.dryRun) {
        const next = { ...doc, [mapKey]: { ...doc[mapKey] } };
        delete next[mapKey][text(clientId)];
        writeDataJson(path, next);
      }
      return { action: 'delete', records: 1, files: [file] };
    },
  };
}

// ---------------------------------------------------------------- shared lookups

/**
 * A sent offer is the contract once the client has signed. It is held when the client card says
 * signed, and also when there is no client card: without the card the offer cannot be shown to be
 * unsigned (a second erase, or an erase of an id whose card is already gone).
 */
function offerIsHeld(offer = {}, ctx = {}) {
  if (text(offer.status) !== 'sent') return false;
  if (!ctx.client) return true;
  return ctx.signed === true;
}

function fireflies(ctx) {
  const map = ctx.firefliesMap || readFirefliesStore('meetings');
  return map && typeof map === 'object' ? map : {};
}

function clientMeetingIds(clientId, ctx) {
  const ids = new Set();
  for (const row of Array.isArray(ctx.client?.meetings) ? ctx.client.meetings : []) {
    const id = text(row?.meetingId);
    if (id && !id.toLowerCase().startsWith('live:')) ids.add(id);
  }
  for (const [id, row] of Object.entries(fireflies(ctx))) {
    if (text(row?.match?.clientId) === clientId || text(row?.pin?.clientId) === clientId) ids.add(id);
  }
  return [...ids];
}

function portalUserIds(ctx) {
  const ids = new Set();
  const profile = ctx.profile || null;
  for (const value of [ctx.client?.portalUserId, profile?.userId, profile?.ownerUserId]) {
    if (text(value) && /^[A-Za-z0-9_-]{1,80}$/.test(text(value))) ids.add(text(value));
  }
  return [...ids];
}

function businessIdOf(ctx) {
  return text(ctx.client?.portalBusinessId || ctx.profile?.businessId);
}

// ---------------------------------------------------------------- call recordings (dialler)

const RECORDING_URL_RE = /\/(myphoner-recordings|myphoner-audio)\/([^/?#"'\s\\]+)/gi;
const RECORDING_MAPS = Object.freeze(['recordingsByLeadId', 'recordingsByCallId', 'recordingsByPhoneDigits']);
const MYPHONER_FILE = 'myphoner-integration.json';

function phoneDigits(value) {
  return String(value ?? '').replace(/\D+/g, '');
}

function samePhone(a, b) {
  const left = phoneDigits(a);
  const right = phoneDigits(b);
  if (left.length < 8 || right.length < 8) return false;
  return left === right || left.slice(-8) === right.slice(-8);
}

/** '<dir>/<file name>' for every dialler recording a value refers to. */
function recordingRefsIn(value) {
  const refs = new Set();
  const body = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  for (const match of body.matchAll(RECORDING_URL_RE)) {
    let name = match[2];
    try {
      name = decodeURIComponent(name);
    } catch {
      continue;
    }
    name = basename(name);
    if (!name || name.startsWith('.') || name.includes('..')) continue;
    refs.add(`${match[1].toLowerCase()}/${name}`);
  }
  return refs;
}

/** The dialler identifiers of a client: lead ids, call ids and phone numbers. */
function diallerKeys(client = {}) {
  const myphoner = client?.myphoner && typeof client.myphoner === 'object' ? client.myphoner : {};
  const leadIds = new Set([myphoner.leadId, ...(Array.isArray(myphoner.leadIds) ? myphoner.leadIds : [])].map(text).filter(Boolean));
  const callIds = new Set([myphoner.latestCallId].map(text).filter(Boolean));
  const phones = [client?.contactPhone, myphoner.latestCallDestinationNumber].map(phoneDigits).filter((digits) => digits.length >= 8);
  return { leadIds, callIds, phones };
}

function recordingEntryMatches(entry = {}, keys) {
  if (text(entry.leadId) && keys.leadIds.has(text(entry.leadId))) return true;
  if (text(entry.callId) && keys.callIds.has(text(entry.callId))) return true;
  const digits = entry.destinationDigits || entry.destinationNumber;
  return keys.phones.some((phone) => samePhone(phone, digits));
}

/** The client's entries in the dialler cache: { entries: [{ map, key, entry }], callIds }. */
function diallerCacheEntries(doc, keys) {
  const entries = [];
  const callIds = new Set(keys.callIds);
  if (!keys.leadIds.size && !keys.callIds.size && !keys.phones.length) return { entries, callIds };
  for (const map of RECORDING_MAPS) {
    const rows = doc?.[map] && typeof doc[map] === 'object' ? doc[map] : {};
    for (const [key, entry] of Object.entries(rows)) {
      const keyHit = (map === 'recordingsByLeadId' && keys.leadIds.has(key))
        || (map === 'recordingsByCallId' && keys.callIds.has(key))
        || (map === 'recordingsByPhoneDigits' && keys.phones.some((phone) => samePhone(phone, key)));
      if (keyHit || recordingEntryMatches(entry, keys)) {
        entries.push({ map, key, entry });
        if (text(entry?.callId)) callIds.add(text(entry.callId));
      }
    }
  }
  return { entries, callIds };
}

function dropDiallerEntries(doc, keys) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { next: doc, removed: 0 };
  const { entries, callIds } = diallerCacheEntries(doc, keys);
  const pending = doc.pendingRecordingsByCallId && typeof doc.pendingRecordingsByCallId === 'object' ? doc.pendingRecordingsByCallId : {};
  const pendingHits = Object.keys(pending).filter((key) => callIds.has(key));
  if (!entries.length && !pendingHits.length) return { next: doc, removed: 0 };
  const next = { ...doc };
  for (const map of RECORDING_MAPS) {
    if (!entries.some((row) => row.map === map)) continue;
    next[map] = { ...doc[map] };
    for (const row of entries.filter((item) => item.map === map)) delete next[map][row.key];
  }
  if (pendingHits.length) {
    next.pendingRecordingsByCallId = { ...pending };
    for (const key of pendingHits) delete next.pendingRecordingsByCallId[key];
  }
  return { next, removed: entries.length + pendingHits.length };
}

/** Recording files on the data disk for a set of refs: [{ ref, path (absolute) }]. */
function recordingFiles(refs, ctx) {
  const base = dataDirOf(ctx);
  const out = [];
  for (const ref of refs) {
    const [dir, name] = ref.split('/');
    const dirs = dir === 'myphoner-audio' ? ['myphoner-audio'] : ['myphoner-recordings', 'myphoner-audio'];
    for (const candidate of dirs) {
      const root = join(base, candidate);
      const full = normalize(join(root, name));
      if (inside(root, full) && existsSync(full)) {
        out.push({ ref, path: full });
        break;
      }
    }
  }
  return out;
}

function clientRecordingPlan(clientId, ctx) {
  const keys = diallerKeys(ctx.client || {});
  const doc = readJson(join(dataDirOf(ctx), MYPHONER_FILE), null);
  const cache = doc ? diallerCacheEntries(doc, keys) : { entries: [] };
  const refs = recordingRefsIn(ctx.client || {});
  for (const row of cache.entries) for (const ref of recordingRefsIn(row.entry)) refs.add(ref);
  const files = recordingFiles(refs, ctx);
  // A file another client card also points at stays.
  const others = (ctx.allClients || []).filter((client) => text(client?.id) !== clientId);
  const shared = new Set();
  for (const other of others) {
    for (const ref of recordingRefsIn(other)) if (refs.has(ref)) shared.add(ref);
  }
  return { keys, doc, cache, files, shared };
}

// ---------------------------------------------------------------- calendar

async function defaultDeleteCalendarEvent(client = {}) {
  const calendar = await import('./google-calendar.js');
  const event = client?.calendar || {};
  const accountKey = text(event.accountKey) || calendar.resolveCalendarSyncAccountKey({
    ownerId: text(client?.ownerId),
    actorAccountKey: '',
    previousAccountKey: text(event.accountKey),
  });
  return calendar.deleteMeetingEvent(text(event.eventId), accountKey, text(event.calendarId) ? { calendarId: text(event.calendarId) } : {});
}

// ---------------------------------------------------------------- hub library

function libraryFilesFor(clientId, ctx) {
  const base = dataDirOf(ctx);
  const root = join(base, 'media');
  const index = readJson(join(base, 'media-library.json'), {});
  const tag = `client:${text(clientId)}`.toLowerCase();
  const out = [];
  for (const [name, meta] of Object.entries(index?.items && typeof index.items === 'object' ? index.items : {})) {
    const tags = Array.isArray(meta?.tags) ? meta.tags.map((entry) => text(entry).toLowerCase()) : [];
    if (!tags.includes(tag)) continue;
    const full = normalize(join(root, name));
    if (!inside(root, full) || !existsSync(full)) continue;
    out.push(...listFilesUnder(full, ctx));
  }
  return out;
}

// ---------------------------------------------------------------- built-in stores

function devHandoffPath(clientId, ctx) {
  const safe = text(clientId).replace(/[^a-zA-Z0-9_-]/g, '');
  return safe && isValidClientId(clientId) ? join(dataDirOf(ctx), 'dev-handoffs', `${safe}.zip`) : '';
}

function builtInStores() {
  return [
    {
      id: 'sales-clients',
      label: 'Salgs- og kundekort',
      files: ['sales-clients.json'],
      clientKey: 'id',
      retention: { rule: 'lead-or-contract' },
      personalData: 'Contact person, e-mail, phone, business details, notes, meeting references',
      purpose: 'Sales follow-up and delivery of the contracted website',
      legalBasis: 'Legitimate interest (leads); contract (clients)',
      processors: ['Hostinger'],
      writers: ['data/sales.js:SALES_PATH'],
      order: 99,
      export(clientId) {
        const client = sales.getSalesClientById(clientId);
        return { records: client ? [client] : [] };
      },
      erase(clientId, ctx) {
        if (!ctx.client) return { action: 'none', records: 0, files: [] };
        if (!ctx.dryRun) sales.deleteSalesClient(clientId);
        return { action: 'delete', records: 1, files: ['sales-clients.json'] };
      },
    },
    {
      id: 'calendar-event',
      label: 'Møte i Google Kalender',
      files: [],
      clientKey: 'calendar.eventId',
      retention: { rule: 'lead-or-contract' },
      personalData: 'The booked meeting in the staff calendar (the client as guest)',
      purpose: 'Booking the sales meeting',
      legalBasis: 'Legitimate interest',
      processors: ['Google'],
      order: 97,
      export(clientId, ctx) {
        const event = ctx.client?.calendar || {};
        return { records: text(event.eventId) ? [{ eventId: text(event.eventId), calendarId: text(event.calendarId) }] : [] };
      },
      // The same clean-up as deleting a client card: the booked event goes from the calendar.
      async erase(clientId, ctx) {
        const eventId = text(ctx.client?.calendar?.eventId);
        if (!eventId) return { action: 'none', records: 0, files: [] };
        if (ctx.dryRun) return { action: 'delete', records: 1, files: [] };
        const remove = typeof ctx.deleteCalendarEvent === 'function' ? ctx.deleteCalendarEvent : defaultDeleteCalendarEvent;
        try {
          const result = await remove(ctx.client);
          if (result?.deleted) return { action: 'delete', records: 1, files: [] };
          return { action: 'retain', records: 1, files: [], reason: result?.safeMode ? 'safe-mode' : 'calendar-not-deleted' };
        } catch (err) {
          return { action: 'retain', records: 1, files: [], reason: 'calendar-delete-failed', error: text(err?.message).slice(0, 200) || 'calendar delete failed' };
        }
      },
    },
    {
      id: 'sales-offers',
      label: 'Tilbud og kontraktsutkast',
      files: ['sales-offers.json'],
      clientKey: 'salesClientId',
      retention: { rule: 'contract' },
      personalData: 'Offer e-mails, contract party (name, org number, address), prices',
      purpose: 'Offers and the signed contract',
      legalBasis: 'Contract; bookkeeping law for signed contracts',
      processors: ['Hostinger'],
      writers: ['data/sales-offers.js:OFFERS_PATH'],
      export(clientId) {
        return { records: salesOffers.listSalesOffers({ salesClientId: clientId }) };
      },
      erase(clientId, ctx) {
        const offers = salesOffers.listSalesOffers({ salesClientId: clientId });
        if (!offers.length) return { action: 'none', records: 0, files: [] };
        const held = offers.filter((offer) => offerIsHeld(offer, ctx));
        const gone = offers.filter((offer) => !offerIsHeld(offer, ctx));
        if (!ctx.dryRun) for (const offer of gone) salesOffers.deleteSalesOffer(offer.id);
        return {
          action: gone.length ? 'delete' : 'hold',
          records: gone.length,
          held: held.map((offer) => offer.id),
          files: ['sales-offers.json'],
          reason: held.length ? (ctx.client ? 'signed-contract' : 'client-card-missing') : '',
        };
      },
    },
    {
      id: 'portal-offers',
      label: 'Tilbud i kundeportalen',
      files: ['client-offers.json'],
      clientKey: 'salesClientId',
      retention: { rule: 'contract' },
      personalData: 'Portal offer, acceptance evidence (e-mail, IP address, browser)',
      purpose: 'Offer acceptance in the client portal',
      legalBasis: 'Contract; proof of acceptance',
      processors: ['Hostinger'],
      writers: ['data/offers.js:OFFERS_PATH'],
      export(clientId) {
        return { records: portalOffers.listOffers().filter((offer) => text(offer.salesClientId) === clientId) };
      },
      erase(clientId, ctx) {
        const offers = portalOffers.listOffers().filter((offer) => text(offer.salesClientId) === clientId);
        if (!offers.length) return { action: 'none', records: 0, files: [] };
        const held = offers.filter((offer) => Boolean(offer?.acceptance?.acceptedAt));
        const gone = offers.filter((offer) => !offer?.acceptance?.acceptedAt);
        if (!ctx.dryRun) for (const offer of gone) portalOffers.deleteOffer(offer.id);
        return {
          action: gone.length ? 'delete' : 'hold',
          records: gone.length,
          held: held.map((offer) => offer.id),
          files: ['client-offers.json'],
          reason: held.length ? 'accepted-offer' : '',
        };
      },
    },
    {
      id: 'signed-contracts',
      label: 'Signerte kontrakter',
      dir: 'inbox-contracts/<clientId>',
      clientKey: 'path',
      retention: { rule: 'contract' },
      personalData: 'Signed contract documents',
      purpose: 'Proof of the agreement',
      legalBasis: 'Legal obligation (bookkeeping law)',
      processors: ['Hostinger'],
      async export(clientId, ctx) {
        const path = perClientPath('inbox-contracts', clientId, { ctx });
        const inbox = await inboxStore();
        return {
          files: path ? listFilesUnder(path, ctx) : [],
          records: inbox ? inbox.listInboxItems({ salesClientId: clientId, kind: 'signed_contract' }) : [],
          ...(inbox ? {} : { error: INBOX_UNAVAILABLE }),
        };
      },
      async erase(clientId, ctx) {
        const path = perClientPath('inbox-contracts', clientId, { ctx });
        const files = path ? listFilesUnder(path, ctx).map((file) => file.path) : [];
        const inbox = await inboxStore();
        const items = inbox ? inbox.listInboxItems({ salesClientId: clientId, kind: 'signed_contract' }) : [];
        if (!files.length && !items.length) return { action: 'none', records: 0, files: [], ...(inbox ? {} : { error: INBOX_UNAVAILABLE }) };
        return { action: 'hold', records: items.length, files, reason: 'bookkeeping-law', ...(inbox ? {} : { error: INBOX_UNAVAILABLE }) };
      },
    },
    {
      id: 'inbox-items',
      label: 'E-post fra kunden (innboks)',
      files: ['inbox-bot.json'],
      clientKey: 'salesClientId',
      retention: { rule: 'lead-or-contract' },
      personalData: 'Sender, subject, summary and text of e-mails from the client',
      purpose: 'Filing client e-mail and material on the client card',
      legalBasis: 'Legitimate interest; contract',
      processors: ['Google', 'Anthropic'],
      writers: ['lib/inbox-bot/store.js:STORE_PATH'],
      async export(clientId) {
        const inbox = await inboxStore();
        if (!inbox) return { records: [], error: INBOX_UNAVAILABLE };
        return { records: inbox.listInboxItems({ salesClientId: clientId }) };
      },
      async erase(clientId, ctx) {
        const inbox = await inboxStore();
        if (!inbox) return { action: 'none', records: 0, files: [], error: INBOX_UNAVAILABLE };
        const items = inbox.listInboxItems({ salesClientId: clientId });
        const contracts = items.filter((item) => item.kind === 'signed_contract');
        const rest = items.filter((item) => item.kind !== 'signed_contract');
        if (!items.length) return { action: 'none', records: 0, files: [] };
        if (!ctx.dryRun) {
          for (const item of rest) inbox.updateInboxItem(item.id, inboxRedaction(ctx));
        }
        return {
          action: rest.length ? 'redact' : 'hold',
          records: rest.length,
          held: contracts.map((item) => item.id),
          files: ['inbox-bot.json'],
          reason: contracts.length ? 'signed-contract' : '',
        };
      },
    },
    perClientStore({
      id: 'inbox-attachments',
      label: 'Vedlegg fra kundens e-post',
      dir: 'inbox-bot-staging',
      retention: { rule: 'media' },
      personalData: 'Images and documents the client sent by e-mail',
      purpose: 'Client material for the website',
      legalBasis: 'Contract; legitimate interest',
      processors: ['Hostinger'],
    }),
    {
      id: 'fireflies-meetings',
      label: 'Møteopptak og transkripsjoner (Fireflies)',
      files: ['fireflies-meetings.json', 'fireflies-media/<meetingId>/'],
      clientKey: 'match.clientId | client.meetings[].meetingId',
      retention: { text: 'Lagres i ett år etter siste endring; arkivkopien følger tabellen for transkripsjonsarkivet.' },
      personalData: 'Meeting transcripts, attendees, summaries, audio and video',
      purpose: 'Meeting notes for the offer, the workshop and the website',
      legalBasis: 'Legitimate interest (leads); contract (clients)',
      processors: ['Fireflies'],
      export(clientId, ctx) {
        const map = fireflies(ctx);
        const ids = clientMeetingIds(clientId, ctx);
        const records = ids.map((id) => map[id]).filter(Boolean);
        const files = ids.flatMap((id) => listFilesUnder(join(firefliesMediaRootIn(ctx), id), ctx));
        return { records, files };
      },
      erase(clientId, ctx) {
        const ids = clientMeetingIds(clientId, ctx);
        const map = fireflies(ctx);
        const stored = ids.filter((id) => map[id]);
        const files = ids.flatMap((id) => listFilesUnder(join(firefliesMediaRootIn(ctx), id), ctx).map((file) => file.path));
        if (!stored.length && !files.length) return { action: 'none', records: 0, files: [] };
        if (!ctx.dryRun) {
          if (stored.length) {
            updateFirefliesStore('meetings', (current) => {
              let changed = false;
              for (const id of stored) {
                if (current[id]) {
                  delete current[id];
                  changed = true;
                }
              }
              return changed;
            });
          }
          for (const id of ids) rmSync(join(firefliesMediaRootIn(ctx), id), { recursive: true, force: true });
        }
        return { action: 'delete', records: stored.length, files: ['fireflies-meetings.json', ...files] };
      },
    },
    perClientStore({
      id: 'transcript-archive',
      label: 'Transkripsjonsarkiv',
      dir: 'transcript-archive',
      retention: { rule: 'transcript' },
      personalData: 'Full meeting transcripts and attendees',
      purpose: 'The meeting record behind the delivery brief',
      legalBasis: 'Legitimate interest (leads); contract (clients)',
      processors: ['Hostinger'],
    }),
    perClientStore({
      id: 'delivery-briefs',
      label: 'Leveransebrief',
      dir: 'delivery-briefs',
      retention: { rule: 'brief' },
      personalData: 'Facts about the client and short quotes from meetings',
      purpose: 'The brief the website is built from',
      legalBasis: 'Contract',
      processors: ['Anthropic'],
    }),
    perClientStore({
      id: 'media-manifest',
      label: 'Medieliste',
      dir: 'media-manifest',
      suffix: '.json',
      retention: { rule: 'media' },
      personalData: 'File names, checksums and rights confirmations of client media',
      purpose: 'Handing client media to the website build',
      legalBasis: 'Contract',
      processors: ['Hostinger'],
    }),
    perClientStore({
      id: 'sales-site-imports',
      label: 'Importert kopi av kundens nettsted',
      dir: 'sales-site-imports',
      retention: { rule: 'lead-or-contract' },
      personalData: 'A copy of the client\'s existing website (texts, images, contact details)',
      purpose: 'Building the preview from the client\'s current site',
      legalBasis: 'Legitimate interest (leads); contract (clients)',
      processors: ['Hostinger'],
    }),
    perClientStore({
      id: 'dev-handoffs',
      label: 'Overleveringspakke til utvikler',
      dir: 'dev-handoffs/<clientId>.zip',
      pathOf: devHandoffPath,
      retention: { rule: 'lead-or-contract' },
      personalData: 'The client\'s material packed for a developer',
      purpose: 'Building and changing the website',
      legalBasis: 'Contract',
      processors: ['Hostinger'],
    }),
    {
      id: 'call-recordings',
      label: 'Samtaleopptak fra ringeverktøyet',
      files: ['myphoner-recordings/<file>', 'myphoner-audio/<file>', MYPHONER_FILE],
      clientKey: 'client recording URLs | myphoner.leadId | latestCallId | phone',
      retention: { rule: 'lead-or-contract' },
      personalData: 'Recorded sales calls, the called number, call times',
      purpose: 'Sales follow-up and the meeting preview',
      legalBasis: 'Legitimate interest',
      processors: ['Hostinger', 'Myphoner'],
      writers: ['data/myphoner-integration.js:MYPHONER_INTEGRATION_PATH'],
      export(clientId, ctx) {
        if (!ctx.client) return { records: [], files: [] };
        const plan = clientRecordingPlan(clientId, ctx);
        return {
          records: plan.cache.entries.map((row) => ({ list: row.map, key: row.key, ...row.entry })),
          files: plan.files.flatMap((file) => listFilesUnder(file.path, ctx)),
        };
      },
      erase(clientId, ctx) {
        if (!ctx.client) return { action: 'none', records: 0, files: [] };
        const plan = clientRecordingPlan(clientId, ctx);
        const gone = plan.files.filter((file) => !plan.shared.has(file.ref));
        const kept = plan.files.filter((file) => plan.shared.has(file.ref));
        if (!plan.files.length && !plan.cache.entries.length) return { action: 'none', records: 0, files: [] };
        if (!ctx.dryRun) {
          for (const file of gone) rmSync(file.path, { force: true });
          if (plan.cache.entries.length && plan.doc) {
            const path = join(dataDirOf(ctx), MYPHONER_FILE);
            const { next, removed } = dropDiallerEntries(plan.doc, plan.keys);
            if (removed) writeDataJson(path, next);
          }
        }
        const files = [...gone.map((file) => rel(ctx, file.path)), ...(plan.cache.entries.length ? [MYPHONER_FILE] : [])];
        if (!gone.length && !plan.cache.entries.length) {
          return { action: 'hold', records: 0, files: kept.map((file) => rel(ctx, file.path)), reason: 'shared-recording' };
        }
        return {
          action: 'delete',
          records: plan.cache.entries.length + gone.length,
          files,
          ...(kept.length ? { held: kept.map((file) => rel(ctx, file.path)), reason: 'shared-recording' } : {}),
        };
      },
    },
    {
      id: 'client-uploads',
      label: 'Opplastede filer i kundeportalen',
      dir: 'client-uploads/<portalUserId>',
      clientKey: 'portalUserId',
      retention: { rule: 'media' },
      personalData: 'Images, logos and documents the client uploaded',
      purpose: 'Client material for the website',
      legalBasis: 'Contract',
      processors: ['Hostinger', 'Google'],
      export(clientId, ctx) {
        return { files: portalUserIds(ctx).flatMap((userId) => listFilesUnder(join(dataDirOf(ctx), 'client-uploads', userId), ctx)) };
      },
      erase(clientId, ctx) {
        const users = portalUserIds(ctx);
        const files = users.flatMap((userId) => listFilesUnder(join(dataDirOf(ctx), 'client-uploads', userId), ctx).map((file) => file.path));
        if (!files.length) return { action: 'none', records: 0, files: [] };
        if (!ctx.dryRun) for (const userId of users) rmSync(join(dataDirOf(ctx), 'client-uploads', userId), { recursive: true, force: true });
        return { action: 'delete', records: 0, files };
      },
    },
    {
      id: 'hub-library-media',
      label: 'Kundefiler i mediebiblioteket',
      files: ['media/<file tagged client:<clientId>>', 'media-library.json'],
      clientKey: 'tag client:<clientId>',
      retention: { rule: 'library' },
      personalData: 'Client images placed in the asoldi.com media library',
      purpose: 'Showing the client\'s work on asoldi.com',
      legalBasis: 'Legitimate interest; contract',
      processors: ['Hostinger'],
      writers: ['lib/hub-media-library.js:indexPath()'],
      export(clientId, ctx) {
        return { files: libraryFilesFor(clientId, ctx) };
      },
      erase(clientId, ctx) {
        const files = libraryFilesFor(clientId, ctx).map((file) => file.path);
        return files.length
          ? { action: 'hold', records: files.length, files, reason: 'library-review' }
          : { action: 'none', records: 0, files: [] };
      },
    },
    {
      id: 'client-portal',
      label: 'Kundekonto i portalen',
      files: ['client-portal-profiles.json', 'client-portal-state.json', 'client-businesses.json', 'users.json'],
      clientKey: 'portalBusinessId | portalUserId',
      retention: { rule: 'account' },
      personalData: 'Account e-mail, business details, Kundedata answers, payment status',
      purpose: 'The client portal and payments',
      legalBasis: 'Contract; bookkeeping law for payments',
      processors: ['Hostinger', 'Stripe'],
      writers: ['data/client-portal.js:filePath', 'data/client-businesses.js:STORE_PATH', 'data/store.js:USERS_PATH'],
      export(clientId, ctx) {
        const profile = ctx.profile || null;
        return { records: profile ? [profile] : [] };
      },
      erase(clientId, ctx) {
        return ctx.profile
          ? { action: 'hold', records: 1, files: ['client-portal-profiles.json'], reason: 'client-account' }
          : { action: 'none', records: 0, files: [] };
      },
    },
    {
      id: 'hub-sites',
      label: 'Kundens nettsted i huben',
      files: ['sites.json'],
      clientKey: 'client.hubSite',
      retention: { rule: 'site' },
      personalData: 'Site contact e-mail and domain',
      purpose: 'Running the client site and its CMS',
      legalBasis: 'Contract',
      processors: ['Hostinger'],
      writers: ['data/hub.js:SITES_PATH'],
      export(clientId, ctx) {
        const site = ctx.site || null;
        return { records: site ? [{ id: site.id, name: site.name, domain: site.domain, contactEmail: site.contactEmail || '', websitePlan: site.websitePlan, createdAt: site.createdAt }] : [] };
      },
      erase(clientId, ctx) {
        return ctx.site
          ? { action: 'hold', records: 1, files: ['sites.json'], reason: 'site-removed-on-cancellation' }
          : { action: 'none', records: 0, files: [] };
      },
    },
    keyedObjectStore({
      id: 'workshop-needs',
      label: 'Behov fra workshop',
      file: 'workshop-needs.json',
      mapKey: 'clients',
      retention: { rule: 'lead-or-contract' },
      personalData: 'What the client asked for, with short quotes',
      purpose: 'Planning the website',
      legalBasis: 'Contract',
      processors: ['Hostinger'],
      writers: ['lib/workshop-needs.js:STORE_PATH'],
    }),
    {
      ...keyedObjectStore({
        id: 'dev-requests',
        label: 'Utviklerforespørsler',
        file: 'admin-dev-requests.json',
        mapKey: 'threads',
        retention: { rule: 'lead-or-contract' },
        personalData: 'Messages about the client between admin and developer, attached files',
        purpose: 'Building and changing the website',
        legalBasis: 'Contract',
        processors: ['Hostinger'],
        writers: ['lib/admin-dev-requests.js:requestsIndexPath()'],
      }),
      dir: 'admin-dev-request-files/<clientId>',
    },
    perClientStore({
      id: 'dev-request-files',
      label: 'Filer i utviklerforespørsler',
      dir: 'admin-dev-request-files',
      retention: { rule: 'lead-or-contract' },
      personalData: 'Files attached to developer requests',
      purpose: 'Building and changing the website',
      legalBasis: 'Contract',
      processors: ['Hostinger'],
    }),
    {
      id: 'seo-client',
      label: 'SEO-kundedata',
      files: ['seo-ops/clients/<clientId>.json'],
      clientKey: 'path',
      retention: { rule: 'lead-or-contract' },
      personalData: 'Agreed keywords and the SEO plan summary',
      purpose: 'SEO work on the client site',
      legalBasis: 'Contract',
      processors: ['Hostinger', 'DataForSEO'],
      writers: ['lib/seo-ops/store.js:path'],
      export(clientId, ctx) {
        const path = perClientPath('seo-ops/clients', clientId, { suffix: '.json', ctx });
        return { files: path ? inlineJsonFiles(listFilesUnder(path, ctx), ctx) : [] };
      },
      async erase(clientId, ctx) {
        const path = perClientPath('seo-ops/clients', clientId, { suffix: '.json', ctx });
        const files = path ? listFilesUnder(path, ctx).map((file) => file.path) : [];
        const remover = await optionalExport('./seo-ops/index.js', 'deleteClientSeoData')
          || await optionalExport('./seo-ops/store.js', 'deleteClientSeoData');
        if (!files.length && !remover) return { action: 'none', records: 0, files: [] };
        if (!ctx.dryRun) {
          if (remover) await remover(clientId, { dataDir: ctx.dataDir });
          else if (path) rmSync(path, { force: true });
        }
        return { action: files.length || remover ? 'delete' : 'none', records: 0, files };
      },
    },
    {
      id: 'media-rights',
      label: 'Bekreftet bruksrett til bilder',
      files: ['media-rights.json', 'sales-clients.json (ext.mediaRights)'],
      clientKey: 'portalBusinessId',
      retention: { rule: 'media' },
      personalData: 'Which uploads the client confirmed the right to use, and when',
      purpose: 'Using client images on the website',
      legalBasis: 'Contract',
      processors: ['Hostinger'],
      // lib/personal-data.js:path is this module's own erase rewrite of the keyed stores, this file and
      // the dialler cache (writeDataJson(path, ...)).
      writers: ['lib/media-manifest.js:path', 'lib/personal-data.js:path'],
      export(clientId, ctx) {
        const rights = ctx.client?.ext?.mediaRights || null;
        const fallback = readJson(join(dataDirOf(ctx), 'media-rights.json'), {});
        const business = businessIdOf(ctx);
        const records = [];
        if (rights) records.push({ source: 'client', rights });
        if (business && fallback?.businesses?.[business]) records.push({ source: 'portal', rights: fallback.businesses[business] });
        return { records };
      },
      erase(clientId, ctx) {
        const path = join(dataDirOf(ctx), 'media-rights.json');
        const doc = readJson(path, null);
        const business = businessIdOf(ctx);
        const inFallback = Boolean(business && doc?.businesses?.[business]);
        const onClient = Boolean(ctx.client?.ext?.mediaRights);
        if (!inFallback && !onClient) return { action: 'none', records: 0, files: [] };
        if (!ctx.dryRun && inFallback) {
          const next = { ...doc, businesses: { ...doc.businesses } };
          delete next.businesses[business];
          writeDataJson(path, next);
        }
        // The copy on the client record goes with the client record (sales-clients).
        return { action: 'delete', records: Number(inFallback) + Number(onClient), files: inFallback ? ['media-rights.json'] : [] };
      },
    },
    idsOnlyLogStore({
      id: 'delivery-audit',
      label: 'Leveranselogg',
      dir: 'delivery-audit',
      rule: 'ids-24',
      personalData: 'Client ids and stage names only',
      purpose: 'Tracing delivery changes',
      legalBasis: 'Legitimate interest',
      processors: ['Hostinger'],
    }),
    idsOnlyLogStore({
      id: 'maker-access-log',
      label: 'Tilgangslogg for Maker',
      dir: 'maker-access-log',
      rule: 'ids-12',
      personalData: 'Host, client and run ids only',
      purpose: 'Tracing which build host read client data',
      legalBasis: 'Legitimate interest (security)',
      processors: ['Hostinger'],
    }),
    idsOnlyLogStore({
      id: 'fireflies-link-audit',
      label: 'Logg over koblinger av møteopptak',
      dir: 'fireflies-link-audit',
      rule: 'ids-24',
      personalData: 'Meeting and client ids only',
      purpose: 'Tracing how recordings were linked to clients',
      legalBasis: 'Legitimate interest',
      processors: ['Hostinger'],
    }),
    {
      id: 'migrations',
      label: 'Migreringsrapporter',
      dir: 'migrations',
      clientKey: 'clientId (inside reports)',
      retention: { rule: 'ids-10-reports' },
      personalData: 'Client ids and planned changes only',
      purpose: 'Checking data migrations',
      legalBasis: 'Legitimate interest',
      processors: ['Hostinger'],
      export(clientId, ctx) {
        const dir = join(dataDirOf(ctx), 'migrations');
        if (!existsSync(dir)) return { files: [] };
        const files = listFilesUnder(dir, ctx).filter((file) => {
          if (file.bytes > MAX_INLINE_JSON_BYTES * 4) return false;
          try {
            return readFileSync(join(dataDirOf(ctx), file.path), 'utf8').includes(`"${clientId}"`);
          } catch {
            return false;
          }
        });
        return { files };
      },
      erase(clientId, ctx) {
        const { files } = this.export(clientId, ctx);
        return files.length
          ? { action: 'retain', records: 0, files: files.map((file) => file.path), reason: 'ids-only-log' }
          : { action: 'none', records: 0, files: [] };
      },
    },
    {
      id: 'email-log',
      label: 'Logg over sendt e-post',
      dir: 'email-log',
      clientKey: 'toHash',
      retention: { rule: 'email-log' },
      personalData: 'Hashed and masked recipient address, message kind and status',
      purpose: 'Proof of what was sent, and bounce handling',
      legalBasis: 'Legitimate interest; legal obligation (consent proof)',
      processors: ['Brevo', 'Resend'],
      export(clientId, ctx) {
        const hashes = new Set([ctx.client?.contactEmail, ctx.client?.clientEmail, ctx.client?.websiteEmail?.email].map((email) => hashEmail(text(email))).filter(Boolean));
        const dir = join(dataDirOf(ctx), 'email-log');
        if (!hashes.size || !existsSync(dir)) return { records: [] };
        const records = [];
        for (const name of readdirSync(dir).filter((entry) => /^messages-\d{6}\.jsonl$/.test(entry)).sort()) {
          for (const line of readFileSync(join(dir, name), 'utf8').split('\n')) {
            if (!line.trim()) continue;
            try {
              const row = JSON.parse(line);
              if (hashes.has(text(row?.toHash))) records.push({ file: `email-log/${name}`, ...row });
            } catch {
              // A torn line is skipped.
            }
          }
        }
        return { records };
      },
      erase(clientId, ctx) {
        const { records } = this.export(clientId, ctx);
        return records.length
          ? { action: 'retain', records: records.length, files: [...new Set(records.map((row) => row.file))], reason: 'pseudonymised-send-evidence' }
          : { action: 'none', records: 0, files: [] };
      },
    },
    {
      id: 'snapshots',
      label: 'Kopier før oppdateringer',
      dir: 'snapshots',
      clientKey: 'id | salesClientId (inside copies)',
      retention: { rule: 'snapshots' },
      personalData: 'Copies of the sales, offer and site stores',
      purpose: 'Restoring data after a failed update',
      legalBasis: 'Legitimate interest (data safety)',
      processors: ['Hostinger'],
      writers: ['lib/delivery-snapshots.js:join(base, file.name)'],
      // After the stores above have written: their own writes then make copies without the client.
      order: 98,
      export() {
        return { records: [], note: 'Copies of records exported from the stores above.' };
      },
      erase(clientId, ctx) {
        return scrubCopies(join(dataDirOf(ctx), 'snapshots'), ctx, { snapshots: true });
      },
    },
    {
      id: 'data-backups',
      label: 'Automatiske sikkerhetskopier',
      dir: 'backups',
      clientKey: 'id | salesClientId | meeting ids | inbox item ids (inside copies)',
      retention: { rule: 'backups' },
      personalData: 'Copies of the stores, made on every write',
      purpose: 'Recovering from a failed write',
      legalBasis: 'Legitimate interest (data safety)',
      processors: ['Hostinger'],
      order: 98,
      export() {
        return { records: [], note: 'Copies of records exported from the stores above.' };
      },
      erase(clientId, ctx) {
        const root = ctx.backupDir || (ctx.dataDir ? join(ctx.dataDir, 'backups') : getDataBackupDir());
        return scrubCopies(root, ctx, { snapshots: false });
      },
    },
  ];
}

function firefliesMediaRootIn(ctx = {}) {
  return ctx.dataDir ? join(ctx.dataDir, 'fireflies-media') : firefliesMediaRoot();
}

// ---------------------------------------------------------------- copies (snapshots and backups)

function inboxRedaction(ctx = {}) {
  return {
    salesClientId: '',
    summary: '',
    text: '',
    subject: '',
    from: '',
    fileName: '',
    filePath: '',
    elements: [],
    stagedFiles: [],
    found: [],
    erasedAt: (ctx.now || new Date()).toISOString(),
  };
}

function dropRows(doc, drop) {
  if (!Array.isArray(doc)) return { next: doc, removed: 0 };
  const next = doc.filter((row) => !drop(row));
  return { next, removed: doc.length - next.length };
}

function dropMapKeys(doc, mapKey, keys) {
  const map = mapKey ? doc?.[mapKey] : doc;
  if (!map || typeof map !== 'object' || Array.isArray(map)) return { next: doc, removed: 0 };
  const wanted = keys.map(text).filter((key) => key && Object.prototype.hasOwnProperty.call(map, key));
  if (!wanted.length) return { next: doc, removed: 0 };
  const copy = { ...map };
  for (const key of wanted) delete copy[key];
  return { next: mapKey ? { ...doc, [mapKey]: copy } : copy, removed: wanted.length };
}

function redactInboxCopy(doc, ctx) {
  const items = Array.isArray(doc?.items) ? doc.items : null;
  if (!items) return { next: doc, removed: 0 };
  const ids = new Set(ctx.inboxItemIds || []);
  let removed = 0;
  const next = items.map((item) => {
    if (!item || item.kind === 'signed_contract') return item;
    const mine = text(item.salesClientId) === ctx.clientId || ids.has(text(item.id));
    const blank = !text(item.from) && !text(item.text) && !text(item.subject) && !text(item.summary) && !text(item.salesClientId);
    if (!mine || blank) return item;
    removed += 1;
    return { ...item, ...inboxRedaction(ctx) };
  });
  return { next: removed ? { ...doc, items: next } : doc, removed };
}

/**
 * The data files whose copies an erase scrubs, by file name, each with a function that returns the
 * copy without the client: { next, removed }. Held records (signed contract offers and inbox items,
 * accepted portal offers) stay, as they do in the store itself.
 */
const COPY_SCRUBBERS = Object.freeze({
  'sales-clients.json': (doc, ctx) => dropRows(doc, (row) => text(row?.id) === ctx.clientId),
  'sales-offers.json': (doc, ctx) => dropRows(doc, (row) => text(row?.salesClientId) === ctx.clientId && !offerIsHeld(row, ctx)),
  'client-offers.json': (doc, ctx) => dropRows(doc, (row) => text(row?.salesClientId) === ctx.clientId && !row?.acceptance?.acceptedAt),
  'fireflies-meetings.json': (doc, ctx) => dropMapKeys(doc, '', ctx.meetingIds || []),
  'inbox-bot.json': (doc, ctx) => redactInboxCopy(doc, ctx),
  'workshop-needs.json': (doc, ctx) => dropMapKeys(doc, 'clients', [ctx.clientId]),
  'admin-dev-requests.json': (doc, ctx) => dropMapKeys(doc, 'threads', [ctx.clientId]),
  'media-rights.json': (doc, ctx) => dropMapKeys(doc, 'businesses', [businessIdOf(ctx)]),
  [MYPHONER_FILE]: (doc, ctx) => dropDiallerEntries(doc, diallerKeys(ctx.client || {})),
});

export const SCRUBBED_COPY_FILES = Object.freeze(Object.keys(COPY_SCRUBBERS));

const UNREADABLE_COPY_RE = /^(.*)\.unreadable-/;
const STAMPED_COPY_RE = /^(.*)\.(\d{4}-\d{2}-\d{2}T.+)\.json$/;

/** The data file a backup copy belongs to: { source, unreadable } or null. */
export function backupSourceOf(name = '') {
  const unreadable = UNREADABLE_COPY_RE.exec(name);
  if (unreadable) return { source: unreadable[1], unreadable: true };
  if (name.endsWith('.latest.json')) return { source: name.slice(0, -'.latest.json'.length), unreadable: false };
  const stamped = STAMPED_COPY_RE.exec(name);
  if (stamped) return { source: stamped[1], unreadable: false };
  return null;
}

function mentionsClient(raw, ctx) {
  const needles = [ctx.clientId, ...(ctx.meetingIds || []), ...(ctx.inboxItemIds || [])].map(text).filter((value) => value.length >= 3);
  return needles.some((needle) => raw.includes(needle));
}

/**
 * Takes the client out of every copy under `root`: snapshots/<id>/<file> (snapshots) or
 * backups/<file>.(latest|<stamp>).json. Copies that belong to the client alone (ctx.ownCopies, by
 * source name) are deleted. Returns { action, records, files, kept? }.
 */
function scrubCopies(root, ctx, { snapshots }) {
  if (!existsSync(root)) return { action: 'none', records: 0, files: [] };
  const touched = [];
  const kept = [];
  let records = 0;
  const own = new Set(ctx.ownCopies || []);
  const handle = (dir, name, source, unreadable) => {
    const full = join(dir, name);
    const relPath = rel(ctx, full);
    if (own.has(source)) {
      if (!ctx.dryRun) rmSync(full, { force: true });
      touched.push(relPath);
      records += 1;
      return;
    }
    const scrub = COPY_SCRUBBERS[source];
    if (!scrub) return;
    let raw = '';
    try {
      raw = readFileSync(full, 'utf8');
    } catch {
      return;
    }
    let doc;
    try {
      doc = unreadable ? undefined : JSON.parse(raw);
    } catch {
      doc = undefined;
    }
    if (doc === undefined) {
      if (mentionsClient(raw, ctx)) kept.push(relPath);
      return;
    }
    const { next, removed } = scrub(doc, ctx);
    if (!removed) return;
    records += removed;
    touched.push(relPath);
    if (!ctx.dryRun) {
      writeFileSync(full, JSON.stringify(next, null, 2), 'utf8');
      if (snapshots) refreshSnapshotManifest(dir, name);
    }
  };
  if (snapshots) {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const dir = join(root, entry.name);
      for (const file of readdirSync(dir, { withFileTypes: true })) {
        if (file.isFile() && file.name !== 'manifest.json') handle(dir, file.name, file.name, false);
      }
    }
  } else {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const source = backupSourceOf(entry.name);
      if (source) handle(root, entry.name, source.source, source.unreadable);
    }
  }
  if (!touched.length && !kept.length) return { action: 'none', records: 0, files: [] };
  return {
    action: touched.length ? 'delete' : 'retain',
    records,
    files: touched,
    ...(kept.length ? { kept, reason: 'unreadable-copy' } : {}),
  };
}

/** A snapshot's manifest names each file's sha256 and size; an erased copy gets its new values. */
function refreshSnapshotManifest(dir, fileName) {
  const manifestPath = join(dir, 'manifest.json');
  const manifest = readJson(manifestPath, null);
  if (!manifest || !Array.isArray(manifest.files)) return;
  const full = join(dir, fileName);
  const buffer = readFileSync(full);
  const parsed = readJson(full, null);
  manifest.files = manifest.files.map((file) => (file.name === fileName
    ? { ...file, bytes: buffer.length, sha256: createHash('sha256').update(buffer).digest('hex'), records: Array.isArray(parsed) ? parsed.length : file.records }
    : file));
  manifest.erasedAt = new Date().toISOString();
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

async function optionalExport(specifier, name) {
  try {
    const url = new URL(specifier, import.meta.url);
    if (!existsSync(url)) return null;
    const mod = await import(url.href);
    return typeof mod?.[name] === 'function' ? mod[name] : null;
  } catch {
    return null;
  }
}

/** Backup names that hold only this client's data: the SEO client file's own backups. */
async function ownCopyNames(clientId) {
  const sanitize = await optionalExport('./seo-ops/store.js', 'sanitizeSeoOpsKey');
  let key = clientId;
  try {
    if (sanitize) key = sanitize(clientId);
  } catch {
    key = clientId;
  }
  return [`seo-ops__clients__${key}.json`];
}

let builtInsLoaded = false;
function ensureBuiltIns() {
  if (builtInsLoaded) return;
  builtInsLoaded = true;
  for (const store of builtInStores()) {
    if (!stores.has(store.id)) registerStore(store);
  }
}

// Modules that register richer handlers for a built-in row (purge, readers). Loaded before an
// export, erase or purge so their handlers are the ones that run.
const STORE_MODULES = Object.freeze(['./transcript-archive.js', './media-manifest.js', './fireflies-candidate-rank.js']);

export async function loadStoreModules() {
  ensureBuiltIns();
  for (const specifier of STORE_MODULES) {
    const url = new URL(specifier, import.meta.url);
    if (existsSync(url)) await import(url.href);
  }
  return registeredStores();
}

// ---------------------------------------------------------------- export and erase

async function clientContext(clientId, { dataDir, now = new Date(), settings, dryRun = true } = {}) {
  const client = sales.getSalesClientById(clientId);
  let profile = null;
  let site = null;
  try {
    profile = client ? profileForClient(client, clientPortal.listClientProfiles()) : null;
  } catch {
    profile = null;
  }
  try {
    site = client ? hubSiteForClient(client, hub.getAllSites()) : null;
  } catch {
    site = null;
  }
  let allClients = [];
  try {
    allClients = sales.getSalesClients();
  } catch {
    allClients = [];
  }
  return {
    clientId,
    client,
    profile,
    site,
    allClients,
    dataDir,
    now: now instanceof Date ? now : new Date(now),
    settings: settings || settingsOf(),
    dryRun,
    signed: client ? clientIsSigned(client) : false,
  };
}

/**
 * One JSON bundle with every registered store's records and files for the client. Files carry their
 * size and a sha256 (empty for files over EXPORT_HASH_MAX_BYTES, which are not read).
 */
export async function exportClient(clientId, { dataDir, now = new Date(), settings } = {}) {
  const id = text(clientId);
  if (!isValidClientId(id)) throw Object.assign(new Error('Invalid client id.'), { status: 400 });
  await loadStoreModules();
  const ctx = await clientContext(id, { dataDir, now, settings });
  const out = [];
  for (const store of registeredStores()) {
    let result = {};
    let error = '';
    try {
      result = (await store.export(id, ctx)) || {};
    } catch (err) {
      error = text(err?.message) || 'export failed';
    }
    if (!error && result.error) error = text(result.error);
    out.push({
      id: store.id,
      label: store.label,
      retention: retentionText(store.id, { settings: ctx.settings }),
      records: Array.isArray(result.records) ? result.records : [],
      files: Array.isArray(result.files) ? await hashListedFiles(result.files, ctx) : [],
      ...(result.note ? { note: result.note } : {}),
      ...(error ? { error } : {}),
    });
  }
  return {
    kind: PERSONAL_DATA_EXPORT_KIND,
    version: PERSONAL_DATA_EXPORT_VERSION,
    clientId: id,
    exportedAt: ctx.now.toISOString(),
    found: Boolean(ctx.client),
    hashLimitBytes: EXPORT_HASH_MAX_BYTES,
    stores: out,
  };
}

/**
 * Erase plan (dryRun, the default) or erase. Each store answers { action, records, files, held?, reason? }:
 * delete | redact | hold (kept by law or contract) | retain (ids-only logs, dropped by month) | none.
 * A client with a running contract is erased only with { allowActiveContract: true }. An id with no
 * client card is erased only with { allowMissingClient: true } (a plan always runs): without the card
 * the stores cannot see what the client had, and sent offers are then always held.
 */
export async function eraseClient(clientId, {
  dryRun = true,
  dataDir,
  now = new Date(),
  settings,
  by = '',
  allowActiveContract = false,
  allowMissingClient = false,
  deleteCalendarEvent = null,
} = {}) {
  const id = text(clientId);
  if (!isValidClientId(id)) throw Object.assign(new Error('Invalid client id.'), { status: 400 });
  await loadStoreModules();
  const dry = dryRun !== false;
  const ctx = await clientContext(id, { dataDir, now, settings, dryRun: true });
  ctx.firefliesMap = readFirefliesStore('meetings');
  ctx.meetingIds = clientMeetingIds(id, ctx);
  const inbox = await inboxStore();
  ctx.inboxItemIds = inbox ? inbox.listInboxItems({ salesClientId: id }).filter((item) => item.kind !== 'signed_contract').map((item) => text(item.id)) : [];
  ctx.ownCopies = await ownCopyNames(id);
  if (typeof deleteCalendarEvent === 'function') ctx.deleteCalendarEvent = deleteCalendarEvent;
  const activeContract = ctx.client ? clientHasActiveContract(ctx.client) : false;
  let blocked = '';
  if (!dry && activeContract && allowActiveContract !== true) blocked = 'active-contract';
  else if (!dry && !ctx.client && allowMissingClient !== true) blocked = 'client-not-found';
  const runCtx = { ...ctx, dryRun: dry || Boolean(blocked) };
  // One erase at a time across hub processes; a plan (dry run) needs no lease.
  const lease = runCtx.dryRun ? null : await acquireLease('privacy-erase', ERASE_LEASE_MS);
  if (!runCtx.dryRun && !lease) {
    return { clientId: id, dryRun: true, erased: false, found: Boolean(ctx.client), activeContract, blocked: 'busy', at: ctx.now.toISOString(), stores: [], held: [] };
  }
  const results = [];
  try {
    // The client record goes last: the other stores look the client up through it.
    for (const store of registeredStores()) {
      let result;
      try {
        result = (await store.erase(id, runCtx)) || { action: 'none' };
      } catch (err) {
        result = { action: 'none', error: text(err?.message) || 'erase failed' };
      }
      results.push({
        id: store.id,
        label: store.label,
        action: ERASE_ACTIONS.includes(result.action) ? result.action : 'none',
        records: Number(result.records) || 0,
        files: Array.isArray(result.files) ? result.files : [],
        ...(Array.isArray(result.held) && result.held.length ? { held: result.held } : {}),
        ...(Array.isArray(result.kept) && result.kept.length ? { kept: result.kept } : {}),
        ...(result.reason ? { reason: result.reason } : {}),
        ...(result.error ? { error: result.error } : {}),
      });
    }
  } finally {
    if (lease) await lease.release();
  }
  const summary = {
    clientId: id,
    dryRun: runCtx.dryRun,
    erased: !runCtx.dryRun,
    found: Boolean(ctx.client),
    activeContract,
    ...(blocked ? { blocked } : {}),
    at: ctx.now.toISOString(),
    stores: results,
    held: results.filter((row) => row.action === 'hold' || row.held).map((row) => row.id),
  };
  if (summary.erased) {
    appendDeliveryAudit({
      at: ctx.now.toISOString(),
      kind: 'privacy-erase',
      clientId: id,
      by: text(by).slice(0, 80),
      stores: results.filter((row) => row.action === 'delete' || row.action === 'redact').map((row) => row.id),
      held: summary.held,
    }, { dataDir });
  }
  return summary;
}

// ---------------------------------------------------------------- purge (used by the retention step)

/** Runs every store's purge handler. { dryRun } reports only. Returns [{ id, wouldPurge|purged }]. */
export async function purgeStores({ dryRun = true, dataDir, now = new Date(), settings } = {}) {
  await loadStoreModules();
  const out = [];
  for (const store of registeredStores()) {
    if (!store.purge) continue;
    try {
      const result = (await store.purge({ dryRun, dataDir, now: now instanceof Date ? now : new Date(now), settings: settings || settingsOf() })) || {};
      out.push({ id: store.id, items: Array.isArray(result.items) ? result.items : [], ...(result.error ? { error: result.error } : {}) });
    } catch (err) {
      out.push({ id: store.id, items: [], error: text(err?.message) || 'purge failed' });
    }
  }
  return out;
}

// ---------------------------------------------------------------- writers (static scan contract)

// Data files written through writeDataJson / writeHotJson that hold no client personal data, or
// whose data subjects are not clients (staff, configuration, caches). Keyed '<file>:<target>'.
export const NON_PERSONAL_WRITERS = Object.freeze({
  'data/automation-settings.js:settingsPath(dataDir)': 'Automation settings; staff names in the settings audit only.',
  'data/client-analytics.js:file': 'Site traffic and maps ranking aggregates for client businesses.',
  'data/email-store.js:path': 'Email product stores (site settings, suppressions, campaigns); site subscribers are handled by the email hub.',
  'data/employees.js:EMPLOYEES_PATH': 'Staff records, not clients.',
  'data/reset-tokens.js:TOKENS_PATH': 'Password reset tokens that expire within hours.',
  'data/sales.js:DEVELOPER_OWNER_SEED_PATH': 'One-time migration marker.',
  'data/store.js:ADMIN_PATH': 'Superadmin account.',
  'lib/dataforseo-maps.js:spendPath()': 'Provider spend ledger.',
  'lib/dataforseo-serp.js:getDataFilePath(SPEND_FILE)': 'Provider spend ledger.',
  'lib/dataforseo-serp.js:getDataFilePath(CACHE_FILE)': 'Keyword search result cache.',
  'lib/email-templates-store.js:TEMPLATES_PATH': 'Staff e-mail templates.',
  'lib/email-templates-store.js:DRAFTS_PATH': 'Staff e-mail drafts, dropped after 24 hours.',
  'lib/fathom-webhook.js:NOTIFIED_PATH': 'Meeting ids already notified.',
  'lib/google-calendar.js:TOKENS_PATH': 'Staff calendar tokens.',
  'lib/sales-signed-contract.js:stamp': 'One-time backfill marker.',
  'lib/shop-payments.js:getDataFilePath(PLATFORM_FILE)': 'Payment platform settings.',
  'lib/shop-payments.js:getDataFilePath(SITES_FILE)': 'Per-site payment account settings (business data).',
});

ensureBuiltIns();
