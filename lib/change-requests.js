// Change requests: one JSON file, locked read-modify-write (the same hot store the job queue uses).
// A request counts when it is accepted, in the Europe/Oslo month of that moment, against the
// client's plan. The routes stay closed until changeRequests.enabled is on and the switch is not paused.
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { getAutomationSettings } from '../data/automation-settings.js';
import { getPersistentDataDir } from '../data/storage-path.js';
import { CHANGES_PER_MONTH } from '../packages/suite/core/delivery/vocab.js';
import { readHotJson, updateHotJson } from './hot-store.js';
import { normalizeSitePlan } from './site-plan-model.js';
import { registerStore } from './personal-data.js';
import { addWorkDays } from './website-due.js';

export const CHANGE_REQUEST_FILE = 'change-requests.json';
export const MAX_INTAKE_BYTES = 16384;
export const UNVERIFIED_PER_SITE_DAY = 20;
const HISTORY_MAX = 50;
const TYPES = Object.freeze(['text', 'image', 'section', 'page', 'function', 'other']);
const SIZES = Object.freeze(['small', 'medium', 'large', 'unknown']);
const PRIORITIES = Object.freeze(['normal', 'urgent']);
const ACTIONS = Object.freeze(['accept', 'reject', 'start', 'done']);
const RECORD_FIELDS = Object.freeze([
  'id', 'salesClientId', 'siteKey', 'source', 'sourceVerified', 'requestedBy',
  'type', 'title', 'description', 'pageUrl', 'elementRef', 'attachments', 'priority',
  'size', 'outOfScope', 'summary', 'status', 'month', 'quotaUnits', 'countedAt',
  'overQuota', 'dueAt', 'jobId', 'agentQuotaUnits', 'createdAt', 'doneAt', 'history',
]);

const CLASSIFY_SYSTEM = 'Classify one website change request. Answer JSON with size (small, medium, large or unknown), type (text, image, section, page, function or other), outOfScope (boolean) and summary (one short sentence).';
const CLASSIFY_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['size', 'type', 'outOfScope', 'summary'],
  properties: {
    size: { type: 'string', enum: [...SIZES] },
    type: { type: 'string', enum: [...TYPES] },
    outOfScope: { type: 'boolean' },
    summary: { type: 'string' },
  },
});

let clock = () => new Date();
let llmOverride = null;

export function setChangeRequestClockForTests(fn = null) {
  clock = typeof fn === 'function' ? fn : () => new Date();
}

export function setChangeRequestLlmForTests(llm = null) {
  llmOverride = llm || null;
}

function nowDate() {
  const value = clock();
  return value instanceof Date ? value : new Date(value);
}

function nowIso() {
  return nowDate().toISOString();
}

const OSLO_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Oslo', year: 'numeric', month: '2-digit', day: '2-digit' });

/** The Europe/Oslo calendar day of an instant. A date-only value is that day. */
export function osloDayOf(iso) {
  const raw = String(iso ?? '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return '';
  return OSLO_DAY.format(new Date(ms));
}

export function osloMonthOf(iso) {
  const day = osloDayOf(iso);
  return day ? day.slice(0, 7) : '';
}

export function dueDateFor(countedAt, days = 10) {
  const iso = addWorkDays(countedAt, days);
  return iso ? iso.slice(0, 10) : '';
}

function isPlain(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function changeRequestPath(dataDir) {
  return join(dataDir || getPersistentDataDir(), CHANGE_REQUEST_FILE);
}

function cloneRecord(row) {
  if (!isPlain(row)) return null;
  const copy = {
    ...row,
    elementRef: isPlain(row.elementRef) ? { ...row.elementRef } : (row.elementRef ?? null),
    attachments: Array.isArray(row.attachments) ? row.attachments.map((item) => (isPlain(item) ? { ...item } : item)) : [],
    history: Array.isArray(row.history) ? row.history.map((item) => ({ ...item })) : [],
  };
  delete copy.flags;
  return copy;
}

function readDoc(dataDir) {
  const current = readHotJson(changeRequestPath(dataDir), { fresh: true });
  const requests = Array.isArray(current?.requests) ? current.requests.map(cloneRecord).filter(Boolean) : [];
  return requests;
}

export function readChangeRequests(dataDir) {
  return readDoc(dataDir);
}

export function changeRequestStorePath(dataDir) {
  return changeRequestPath(dataDir);
}

function mutateRequests(dataDir, fn) {
  let outcome = { write: false };
  updateHotJson(changeRequestPath(dataDir), (current) => {
    const requests = Array.isArray(current?.requests) ? current.requests.map(cloneRecord).filter(Boolean) : [];
    outcome = fn(requests) || { write: false };
    if (outcome.write !== true) return undefined;
    return { version: 1, requests };
  });
  return outcome;
}

function pushHistory(record, entry) {
  record.history = [...(record.history || []), entry].slice(-HISTORY_MAX);
}

export function changeRequestsEnabled(settings) {
  const node = settings?.changeRequests;
  if (!node || node.enabled !== true) return false;
  if (node.paused && typeof node.paused === 'object') return false;
  return true;
}

function slaDays(dataDir) {
  try {
    const days = Number(getAutomationSettings({ dataDir })?.changeRequests?.slaWorkDays);
    return Number.isFinite(days) && days > 0 ? days : 10;
  } catch {
    return 10;
  }
}

export function siteLiveAt(client) {
  const go = client?.makerRun?.goLive;
  if (go && go.target === 'production' && go.liveVerifiedAt) return String(go.liveVerifiedAt);
  const event = client?.delivery?.events?.liveVerifiedAt;
  if (event) return String(event);
  if (client?.progression?.live === true) return String(client.hubSite?.createdAt || client.contractSignedAt || '');
  return '';
}

export function requestCounts(client, atIso) {
  const live = siteLiveAt(client);
  if (!live) return false;
  const liveMs = Date.parse(live);
  const atMs = Date.parse(atIso);
  return Number.isFinite(liveMs) && Number.isFinite(atMs) && atMs >= liveMs;
}

function planQuota(client, atIso) {
  const raw = isPlain(client?.sitePlan) ? client.sitePlan : null;
  const plan = raw ? normalizeSitePlan(raw) : null;
  const fromPlan = plan ? plan.changesPerMonth : Number(raw?.changesPerMonth);
  const changes = Number.isFinite(fromPlan) ? fromPlan : CHANGES_PER_MONTH;
  const enforcement = (plan?.enforcement || raw?.enforcement) === 'block' ? 'block' : 'track';
  const until = String(plan?.serviceTerms?.unlimited?.until || '');
  const day = osloDayOf(atIso);
  const untilDay = /^\d{4}-\d{2}-\d{2}/.test(until) ? until.slice(0, 10) : '';
  const unlimited = Boolean(untilDay) && Boolean(day) && day <= untilDay;
  return { limit: unlimited ? null : changes, enforcement };
}

function usedUnits(requests, clientId, period, exceptId = '') {
  return requests.reduce((sum, row) => {
    if (!row || row.id === exceptId || row.salesClientId !== clientId || row.month !== period || row.status === 'rejected') return sum;
    const units = Number(row.quotaUnits);
    return sum + (Number.isInteger(units) && units > 0 ? units : 0);
  }, 0);
}

export function quotaFor(client, { dataDir, at, requests = null } = {}) {
  const when = at || nowIso();
  const period = osloMonthOf(when);
  const { limit } = planQuota(client, when);
  const rows = requests || readDoc(dataDir);
  return { used: usedUnits(rows, client?.id || '', period), limit, period };
}

export function flagsFor(record, at = nowIso()) {
  const flags = [];
  const today = osloDayOf(at);
  if (record?.status !== 'done' && record?.dueAt && today && record.dueAt < today) flags.push('overdue');
  if (record?.overQuota === true) flags.push('over-quota');
  if (record?.agentQuotaUnits !== null && record?.agentQuotaUnits !== undefined && record.agentQuotaUnits !== record.quotaUnits) {
    flags.push('agent-quota-differs');
  }
  return flags;
}

export function publicRecord(record) {
  const out = {};
  for (const key of RECORD_FIELDS) out[key] = record?.[key];
  return out;
}

export function recordView(record, at = nowIso()) {
  return { ...publicRecord(record), flags: flagsFor(record, at) };
}

export function listItem(record) {
  return {
    id: record.id,
    title: record.title,
    status: record.status,
    createdAt: record.createdAt,
    doneAt: record.doneAt || '',
  };
}

export function jobViewOf(record) {
  const description = String(record?.description ?? '');
  const element = isPlain(record?.elementRef)
    ? { route: String(record.elementRef.route ?? ''), selectorKey: String(record.elementRef.selectorKey ?? ''), textExcerpt: String(record.elementRef.textExcerpt ?? '') }
    : null;
  const attachmentUrls = (Array.isArray(record?.attachments) ? record.attachments : [])
    .map((item) => (typeof item === 'string' ? item : item?.url))
    .filter((url) => typeof url === 'string' && url);
  return {
    id: record.id,
    type: record.type,
    title: record.title,
    description: description.slice(0, 500),
    descriptionTruncated: description.length > 500,
    pageUrl: record.pageUrl || '',
    elementRef: element,
    attachmentUrls,
    priority: record.priority,
    size: record.size,
    outOfScope: record.outOfScope === true,
    summary: record.summary || '',
    quotaUnits: Number.isInteger(record.quotaUnits) ? record.quotaUnits : 0,
  };
}

export function jobInputOf(record) {
  return { changeRequestIds: [record.id], changeRequests: [jobViewOf(record)] };
}

// Refuse loopback, private, link-local and internal hosts so a consumer that fetches
// attachments is not an SSRF path from a client CMS.
function privateHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host || host === 'localhost') return true;
  if (['.localhost', '.local', '.internal', '.lan', '.home.arpa'].some((suffix) => host.endsWith(suffix))) return true;
  if (host.includes(':')) {
    if (host === '::' || host === '::1' || /^f[cd]/.test(host) || /^fe[89ab]/.test(host)) return true;
    return /^::ffff:/.test(host);
  }
  if (!host.includes('.')) return true;
  const m = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  return /^[\d.]+$/.test(host) || /^0x/i.test(host);
}

function httpsUrl(value) {
  if (typeof value !== 'string' || value.length < 9 || value.length > 500) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && Boolean(url.hostname) && !privateHost(url.hostname);
  } catch {
    return false;
  }
}

function attachmentName(url) {
  try {
    const last = new URL(url).pathname.split('/').filter(Boolean).pop() || '';
    const name = decodeURIComponent(last).slice(0, 120);
    return name || 'file';
  } catch {
    return 'file';
  }
}

function validUnits(value) {
  return Number.isInteger(value) && value >= 0 && value <= 10;
}

/** { field } when the intake body is outside the limits, else the stored fields. Unknown keys are dropped. */
export function parseIntake(body) {
  if (!isPlain(body)) return { field: 'type' };
  const type = body.type;
  if (!TYPES.includes(type)) return { field: 'type' };
  if (typeof body.title !== 'string' || body.title.length < 1 || body.title.length > 120) return { field: 'title' };
  const description = body.description === undefined ? '' : body.description;
  if (typeof description !== 'string' || description.length > 4000) return { field: 'description' };
  const pageUrl = body.pageUrl === undefined ? '' : body.pageUrl;
  if (typeof pageUrl !== 'string' || pageUrl.length > 300 || (pageUrl !== '' && (!pageUrl.startsWith('/') || pageUrl.startsWith('//') || pageUrl.includes('://')))) {
    return { field: 'pageUrl' };
  }
  let elementRef = null;
  if (body.elementRef !== undefined && body.elementRef !== null) {
    if (!isPlain(body.elementRef)) return { field: 'elementRef' };
    const route = body.elementRef.route === undefined ? '' : body.elementRef.route;
    const selectorKey = body.elementRef.selectorKey === undefined ? '' : body.elementRef.selectorKey;
    const textExcerpt = body.elementRef.textExcerpt === undefined ? '' : body.elementRef.textExcerpt;
    if (typeof route !== 'string' || route.length > 200) return { field: 'elementRef' };
    if (typeof selectorKey !== 'string' || selectorKey.length > 120) return { field: 'elementRef' };
    if (typeof textExcerpt !== 'string') return { field: 'elementRef' };
    elementRef = { route, selectorKey, textExcerpt: textExcerpt.slice(0, 200) };
  }
  const attachments = body.attachments === undefined ? [] : body.attachments;
  if (!Array.isArray(attachments) || attachments.length > 10 || attachments.some((item) => !httpsUrl(item))) return { field: 'attachments' };
  const priority = body.priority === undefined ? 'normal' : body.priority;
  if (!PRIORITIES.includes(priority)) return { field: 'priority' };
  return {
    value: {
      type,
      title: body.title,
      description,
      pageUrl,
      elementRef,
      attachments: attachments.map((url) => ({ url, name: attachmentName(url) })),
      priority,
    },
  };
}

function ruleClassify(input) {
  const hay = `${input.title || ''} ${input.description || ''}`.toLowerCase();
  const rules = [
    ['image', ['bilde', 'bilder', 'image', 'photo', 'foto']],
    ['text', ['tekst', 'text', 'ordlyd', 'overskrift']],
    ['section', ['seksjon', 'section', 'bolk']],
    ['page', ['underside', ' side', 'page']],
    ['function', ['funksjon', 'function', 'skjema']],
  ];
  let type = TYPES.includes(input.type) ? input.type : 'other';
  for (const [name, words] of rules) {
    if (words.some((word) => hay.includes(word))) {
      type = name;
      break;
    }
  }
  const outOfScope = /utenfor|out of scope|nytt nettsted|new website|ny nettside/.test(hay);
  const summary = String(input.title || '').trim().slice(0, 160) || type;
  return { size: 'unknown', type, outOfScope, summary };
}

function classificationFrom(result) {
  const data = isPlain(result?.data) ? result.data : result;
  if (!isPlain(data) || !SIZES.includes(data.size) || !TYPES.includes(data.type) || typeof data.outOfScope !== 'boolean') return null;
  const summary = String(data.summary ?? '').trim().slice(0, 300);
  if (!summary) return null;
  return { size: data.size, type: data.type, outOfScope: data.outOfScope, summary };
}

async function defaultLlm() {
  const { getHubLlm } = await import('./llm/index.js');
  return getHubLlm();
}

/** Size, type, outOfScope and summary. The rule-based classifier answers when the provider throws or returns nothing usable. */
export async function classifyChange(input, { llm, salesClientId = '' } = {}) {
  const facade = llm || llmOverride || await defaultLlm();
  try {
    const result = await facade.json({
      task: 'change.classify',
      system: CLASSIFY_SYSTEM,
      user: JSON.stringify({ type: input.type || '', title: input.title || '', description: input.description || '' }),
      schema: CLASSIFY_SCHEMA,
      ctx: { salesClientId, dataClass: 'personal' },
    });
    const parsed = classificationFrom(result);
    if (parsed) return parsed;
  } catch {
    // Provider missing or the call failed: the keyword classifier below answers.
  }
  return ruleClassify(input);
}

function blankRecord(fields, { salesClientId, siteKey, source, sourceVerified, requestedBy, classified, at }) {
  return {
    id: `cr_${randomBytes(8).toString('hex')}`,
    salesClientId,
    siteKey: siteKey || '',
    source,
    sourceVerified: sourceVerified === true,
    requestedBy,
    type: classified.type,
    title: fields.title,
    description: fields.description,
    pageUrl: fields.pageUrl,
    elementRef: fields.elementRef,
    attachments: fields.attachments,
    priority: fields.priority,
    size: classified.size,
    outOfScope: classified.outOfScope === true,
    summary: classified.summary,
    status: 'received',
    month: '',
    quotaUnits: 0,
    countedAt: '',
    overQuota: false,
    dueAt: '',
    jobId: '',
    agentQuotaUnits: null,
    createdAt: at,
    doneAt: '',
    history: [{ at, by: requestedBy, action: 'create', to: 'received' }],
  };
}

/**
 * Stores one received request. Unverified intake is capped at 20 per site per Oslo day (the 21st
 * is refused and not stored). Returns { ok, status, body }.
 */
export async function createChangeRequest({
  fields, salesClientId, siteKey = '', source = 'cms', sourceVerified = false, requestedBy = '', client = null, dataDir, llm = null,
} = {}) {
  const at = nowIso();
  if (!sourceVerified) {
    // Refuse before the provider call so a flood of unverified posts costs no model calls.
    const day = osloDayOf(at);
    const taken = readDoc(dataDir).filter((row) => row.siteKey === siteKey && row.sourceVerified !== true && osloDayOf(row.createdAt) === day).length;
    if (taken >= UNVERIFIED_PER_SITE_DAY) return { ok: false, status: 429, body: { ok: false, code: 'rate-limited' } };
  }
  const classified = await classifyChange(fields, { llm, salesClientId });
  const record = blankRecord(fields, { salesClientId, siteKey, source, sourceVerified, requestedBy, classified, at });
  const outcome = mutateRequests(dataDir, (requests) => {
    if (!sourceVerified) {
      const day = osloDayOf(at);
      const taken = requests.filter((row) => row.siteKey === siteKey && row.sourceVerified !== true && osloDayOf(row.createdAt) === day).length;
      if (taken >= UNVERIFIED_PER_SITE_DAY) return { write: false, status: 429, code: 'rate-limited' };
    }
    requests.push(record);
    return { write: true, request: record, quota: quotaFor(client, { at, requests }) };
  });
  if (outcome.write !== true) return { ok: false, status: outcome.status || 429, body: { ok: false, code: outcome.code || 'rate-limited' } };
  return {
    ok: true,
    status: 201,
    body: { ok: true, id: record.id, status: 'received', sourceVerified: record.sourceVerified, quota: outcome.quota },
    request: outcome.request,
  };
}

function allowed(action, status) {
  if (action === 'accept' || action === 'reject') return status === 'received' || (action === 'reject' && status === 'accepted');
  if (action === 'start') return status === 'accepted';
  if (action === 'done') return status === 'in-progress';
  return false;
}

function applyFields(record, body, by, at) {
  if (body.size !== undefined && body.size !== record.size) {
    pushHistory(record, { at, by, action: 'edit', field: 'size', from: record.size, to: body.size });
    record.size = body.size;
  }
  if (body.outOfScope !== undefined && body.outOfScope !== record.outOfScope) {
    pushHistory(record, { at, by, action: 'edit', field: 'outOfScope', from: record.outOfScope, to: body.outOfScope });
    record.outOfScope = body.outOfScope;
  }
  if (typeof body.note === 'string' && body.note.trim()) {
    pushHistory(record, { at, by, action: 'note', field: 'note', to: body.note.trim().slice(0, 500) });
  }
}

/**
 * Staff status change. A block-mode accept that would pass the month's limit writes nothing.
 * Returns { ok, status, code?, field?, request, quota }.
 */
export async function applyChangeAction(id, body, { dataDir, by = 'staff', client = null } = {}) {
  const input = isPlain(body) ? body : {};
  const action = input.action;
  if (action !== undefined && !ACTIONS.includes(action)) return { ok: false, status: 400, code: 'bad-request', field: 'action' };
  if (input.quotaUnits !== undefined && !validUnits(input.quotaUnits)) return { ok: false, status: 400, code: 'bad-request', field: 'quotaUnits' };
  if (input.size !== undefined && !SIZES.includes(input.size)) return { ok: false, status: 400, code: 'bad-request', field: 'size' };
  if (input.outOfScope !== undefined && typeof input.outOfScope !== 'boolean') return { ok: false, status: 400, code: 'bad-request', field: 'outOfScope' };
  if (input.note !== undefined && typeof input.note !== 'string') return { ok: false, status: 400, code: 'bad-request', field: 'note' };
  if (!action && input.quotaUnits === undefined && input.size === undefined && input.outOfScope === undefined) {
    return { ok: false, status: 400, code: 'bad-request', field: 'action' };
  }
  let startedJobId = '';
  if (action === 'start') {
    const current = getChangeRequest(id, { dataDir });
    if (!current) return { ok: false, status: 404, code: 'not-found' };
    if (current.status !== 'accepted') return { ok: false, status: 409, code: 'invalid-transition' };
    if (current.sourceVerified && !current.jobId) {
      const { enqueueJob } = await import('./delivery-jobs.js');
      const result = enqueueJob({
        salesClientId: current.salesClientId,
        kind: 'change_request',
        input: jobInputOf(current),
        createdBy: by,
      }, { dataDir });
      if (result?.ok && result.job?.id) startedJobId = result.job.id;
    }
  }
  const at = nowIso();
  const outcome = mutateRequests(dataDir, (requests) => {
    const index = requests.findIndex((row) => row.id === id);
    if (index === -1) return { write: false, status: 404, code: 'not-found' };
    const record = requests[index];
    if (action && !allowed(action, record.status)) return { write: false, status: 409, code: 'invalid-transition' };
    if (action === 'accept') {
      const units = input.quotaUnits === undefined ? 1 : input.quotaUnits;
      const counts = requestCounts(client, at);
      const { limit, enforcement } = planQuota(client, at);
      const period = osloMonthOf(at);
      const used = usedUnits(requests, record.salesClientId, period, record.id);
      if (counts && limit !== null && enforcement === 'block' && used + units > limit) {
        return { write: false, status: 409, code: 'over-quota' };
      }
      record.status = 'accepted';
      record.quotaUnits = units;
      record.countedAt = counts ? at : '';
      record.month = counts ? period : '';
      record.overQuota = Boolean(counts && limit !== null && used + units > limit);
      record.dueAt = counts ? dueDateFor(at, slaDays(dataDir)) : '';
      pushHistory(record, { at, by, action: 'accept', from: 'received', to: 'accepted' });
      applyFields(record, input, by, at);
    } else if (action === 'reject') {
      const from = record.status;
      record.status = 'rejected';
      if (input.quotaUnits !== undefined) record.quotaUnits = input.quotaUnits;
      pushHistory(record, { at, by, action: 'reject', from, to: 'rejected' });
      applyFields(record, input, by, at);
    } else if (action === 'start') {
      record.status = 'in-progress';
      const jobId = startedJobId || (typeof input.jobId === 'string' ? input.jobId : '');
      if (jobId) record.jobId = jobId;
      pushHistory(record, { at, by, action: 'start', from: 'accepted', to: 'in-progress' });
      applyFields(record, input, by, at);
    } else if (action === 'done') {
      record.status = 'done';
      record.doneAt = at;
      pushHistory(record, { at, by, action: 'done', from: 'in-progress', to: 'done' });
      applyFields(record, input, by, at);
    } else {
      if (input.quotaUnits !== undefined && input.quotaUnits !== record.quotaUnits) {
        const counts = Boolean(record.countedAt);
        const { limit, enforcement } = planQuota(client, record.countedAt || at);
        const period = record.month || osloMonthOf(at);
        const used = usedUnits(requests, record.salesClientId, period, record.id);
        if (counts && limit !== null && enforcement === 'block' && used + input.quotaUnits > limit) {
          return { write: false, status: 409, code: 'over-quota' };
        }
        pushHistory(record, { at, by, action: 'edit', field: 'quotaUnits', from: record.quotaUnits, to: input.quotaUnits });
        record.quotaUnits = input.quotaUnits;
        if (counts) record.overQuota = Boolean(limit !== null && used + input.quotaUnits > limit);
      }
      applyFields(record, input, by, at);
    }
    requests[index] = record;
    return { write: true, request: record, quota: quotaFor(client, { at, requests }) };
  });
  if (outcome.write !== true) {
    return { ok: false, status: outcome.status || 409, code: outcome.code || 'invalid-transition', ...(outcome.field ? { field: outcome.field } : {}) };
  }
  return { ok: true, status: 200, request: outcome.request, quota: outcome.quota };
}

export function recordAgentQuotaUnits(id, units, { dataDir, by = 'maker' } = {}) {
  if (!Number.isInteger(units) || units < 0 || units > 10) return { ok: false, status: 400, code: 'bad-request', field: 'agentQuotaUnits' };
  const at = nowIso();
  const outcome = mutateRequests(dataDir, (requests) => {
    const record = requests.find((row) => row.id === id);
    if (!record) return { write: false, status: 404, code: 'not-found' };
    const previous = record.quotaUnits;
    record.agentQuotaUnits = units;
    pushHistory(record, { at, by, action: 'agent-quota', field: 'agentQuotaUnits', to: units });
    if (record.quotaUnits !== previous) record.quotaUnits = previous;
    return { write: true, request: record };
  });
  if (outcome.write !== true) return { ok: false, status: outcome.status || 404, code: outcome.code || 'not-found' };
  return { ok: true, status: 200, request: outcome.request };
}

/** One client's requests out of rows already read (a caller that lists many clients reads the store once). */
export function clientRequestsFrom(requests, salesClientId, { status = '' } = {}) {
  return requests
    .filter((row) => row.salesClientId === salesClientId && (!status || row.status === status))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || (a.id < b.id ? 1 : -1));
}

export function listForClient(salesClientId, { dataDir, status = '' } = {}) {
  return clientRequestsFrom(readDoc(dataDir), salesClientId, { status });
}

export function getChangeRequest(id, { dataDir } = {}) {
  return readDoc(dataDir).find((row) => row.id === id) || null;
}

function rowsForClient(clientId, dataDir) {
  return readDoc(dataDir).filter((row) => row.salesClientId === clientId);
}

registerStore({
  id: 'change-requests',
  label: 'Endringsforespørsler',
  files: [CHANGE_REQUEST_FILE],
  clientKey: 'salesClientId',
  retention: { text: '24 måneder'.padEnd(21, ' ') },
  personalData: 'The change the client asked for, the page it refers to, and who sent it',
  purpose: 'Doing the changes the contract includes',
  legalBasis: 'Contract',
  processors: ['Hostinger'],
  writers: ['lib/change-requests.js:changeRequestPath(dataDir)'],
  order: 40,
  export(clientId, ctx = {}) {
    return { records: rowsForClient(clientId, ctx.dataDir) };
  },
  erase(clientId, ctx = {}) {
    const mine = rowsForClient(clientId, ctx.dataDir);
    if (!mine.length) return { action: 'none', records: 0, files: [] };
    if (ctx.dryRun === false) {
      mutateRequests(ctx.dataDir, (requests) => {
        const next = requests.filter((row) => row.salesClientId !== clientId);
        requests.splice(0, requests.length, ...next);
        return { write: true };
      });
    }
    return { action: 'delete', records: mine.length, files: [CHANGE_REQUEST_FILE] };
  },
  purge(ctx = {}) {
    const months = Number(ctx.settings?.retention?.changeRequestsMonths);
    const span = Number.isFinite(months) && months > 0 ? months : 24;
    const now = ctx.now instanceof Date ? ctx.now : new Date();
    const cutoff = new Date(now.getTime());
    cutoff.setUTCMonth(cutoff.getUTCMonth() - span);
    const all = readDoc(ctx.dataDir);
    const keep = all.filter((row) => {
      const at = Date.parse(row.createdAt || '');
      return !Number.isFinite(at) || at >= cutoff.getTime();
    });
    const removed = all.length - keep.length;
    if (removed && ctx.dryRun === false) {
      mutateRequests(ctx.dataDir, (requests) => {
        requests.splice(0, requests.length, ...keep);
        return { write: true };
      });
    }
    return { items: removed ? [{ file: CHANGE_REQUEST_FILE, removed }] : [] };
  },
});
