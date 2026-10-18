import {
  ADMIN_BOARD_RANKED_BUCKET,
  ADMIN_BOARD_UNBOOKED_BUCKET,
  classifyAdminWorkshopBucket,
  filterAdminBoardClients,
  getAdminRankMs,
} from './workshop-booking.js';
import { getAdminCurrentGoalKey } from './workshop-goal-timeline.js';

export const ADMIN_FOCUS_CATEGORIES = [
  { id: 'unbooked', label: 'Ingen workshop avtalt', hint: 'Kontrakt signert, men workshop-tid er ikke satt. Eldste signering først.' },
  { id: 'workshop', label: 'Workshop booket', hint: 'Workshop-tid er satt. Hold workshopen og bekreft sammendraget.' },
  { id: 'informasjon', label: 'Informasjon', hint: 'Workshop holdt. Samle inn informasjon fra kunden.' },
  { id: 'iteration', label: 'Iterasjon', hint: 'Informasjon er samlet. Hold iterasjonsmøtet og loggfør endringer.' },
  { id: 'done', label: 'Ferdig', hint: 'Workshop, informasjon og iterasjon er ferdig. Sist ferdig først.' },
  { id: 'unlisted', label: 'Ikke listet ennå', hint: 'Ingen workshop og kontrakt er ikke signert.' },
];

const IDS = ADMIN_FOCUS_CATEGORIES.map((row) => row.id);

function text(value) {
  return String(value ?? '').trim();
}

function parseMs(value) {
  const ms = Date.parse(text(value));
  return Number.isFinite(ms) ? ms : null;
}

function compareNames(a, b) {
  return text(a.client.businessName).localeCompare(text(b.client.businessName), 'nb-NO', { sensitivity: 'base' });
}

export function normalizeAdminFocusCategory(value) {
  const id = text(value);
  return IDS.includes(id) ? id : '';
}

export function adminFocusCategoryFor(client = {}) {
  const goal = getAdminCurrentGoalKey(client);
  if (goal === 'informasjon') return 'informasjon';
  if (goal === 'iterated') return 'iteration';
  if (!goal) return 'done';
  const bucket = classifyAdminWorkshopBucket(client);
  if (bucket === ADMIN_BOARD_RANKED_BUCKET) return 'workshop';
  if (bucket === ADMIN_BOARD_UNBOOKED_BUCKET) return 'unbooked';
  return 'unlisted';
}

export function adminFocusEntry(client = {}, nowMs = Date.now()) {
  const category = adminFocusCategoryFor(client);
  const rankMs = category === 'done' || category === 'unbooked' || category === 'unlisted'
    ? null
    : getAdminRankMs(client);
  const timed = rankMs != null && rankMs !== Number.MAX_SAFE_INTEGER;
  return {
    id: text(client.id),
    name: text(client.businessName),
    client,
    category,
    dueAt: timed ? new Date(rankMs).toISOString() : '',
    overdue: timed && rankMs < nowMs,
  };
}

function compareTimed(a, b) {
  const aMs = parseMs(a.dueAt);
  const bMs = parseMs(b.dueAt);
  if (aMs != null && bMs == null) return -1;
  if (aMs == null && bMs != null) return 1;
  if (aMs != null && bMs != null && aMs !== bMs) return aMs - bMs;
  return compareNames(a, b);
}

const SORTERS = {
  unbooked: (a, b) => {
    const aMs = parseMs(a.client.contractSignedAt) ?? 0;
    const bMs = parseMs(b.client.contractSignedAt) ?? 0;
    return aMs !== bMs ? aMs - bMs : compareNames(a, b);
  },
  workshop: compareTimed,
  informasjon: compareTimed,
  iteration: compareTimed,
  done: (a, b) => {
    const aMs = parseMs(a.client.workshop?.iteratedAt) ?? 0;
    const bMs = parseMs(b.client.workshop?.iteratedAt) ?? 0;
    return aMs !== bMs ? bMs - aMs : compareNames(a, b);
  },
  unlisted: compareNames,
};

/** Admin board queues, one per goal step. Most urgent first in each. */
export function groupAdminFocusQueues(clients = [], nowMs = Date.now()) {
  const queues = Object.fromEntries(IDS.map((id) => [id, []]));
  for (const client of filterAdminBoardClients(clients)) {
    const entry = adminFocusEntry(client, nowMs);
    queues[entry.category].push(entry);
  }
  for (const id of IDS) queues[id].sort(SORTERS[id]);
  return queues;
}

/** First tab with something late, else the first one with clients. */
export function defaultAdminFocusCategory(queues = {}) {
  return IDS.find((id) => (queues[id] || []).some((entry) => entry.overdue))
    || IDS.find((id) => id !== 'done' && (queues[id] || []).length)
    || IDS[0];
}
