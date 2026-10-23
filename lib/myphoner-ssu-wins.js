import * as myphonerApi from './myphoner-api.js';
import * as myphonerIntegration from '../data/myphoner-integration.js';
import * as sales from '../data/sales.js';
import { myphonerSyncSkipReason } from './test-clients.js';

const DEFAULT_SSU_LIST_IDS = ['210172'];
const DEFAULT_SSU_WINS_LIST_IDS = ['216843'];
const DEFAULT_SSU_WINS_LIST_NAME = 'SSU wins';

const FIELD_SYNONYMS = {
  company_name: ['company_name', 'name', 'brreg_name', 'business_name', 'company', 'primary_identifier'],
  first_name: ['first_name', 'contact_person', 'full_name', 'secondary_identifier'],
  last_name: ['last_name'],
  title: ['title'],
  website: ['website'],
  work_office_phone: ['work_office_phone', 'business_phone'],
  mobile_phone: ['mobile_phone', 'phone', 'tertiary_identifier'],
  e_mail: ['e_mail', 'email'],
  name: ['name', 'company_name', 'brreg_name', 'primary_identifier'],
  contact_person: ['contact_person', 'full_name', 'secondary_identifier'],
  phone: ['phone', 'mobile_phone', 'tertiary_identifier'],
  business_phone: ['business_phone', 'work_office_phone'],
  email: ['email', 'e_mail'],
};

let listsCache = { expiresAt: 0, lists: [] };
let columnsCache = new Map();
let destIndexCache = { listId: '', expiresAt: 0, leads: [], byPhone: new Map(), byEmail: new Map() };

function sanitizeText(value = '') {
  return String(value ?? '').trim();
}

function isLikelyMissingValue(value = '') {
  const raw = sanitizeText(value).toLowerCase();
  if (!raw) return true;
  return [
    'not found',
    'n/a',
    'na',
    'none',
    'null',
    'unknown',
    'ikke funnet',
    'ikke tilgjengelig',
    'ingen',
    '-',
    '--',
  ].includes(raw);
}

function sanitizeFieldValue(value = '') {
  const cleaned = sanitizeText(String(value ?? '').replace(/\uFFFD/g, ''));
  if (isLikelyMissingValue(cleaned)) return '';
  return cleaned;
}

function nowIso() {
  return new Date().toISOString();
}

function parseIdList(raw, fallback = []) {
  const fromRaw = String(raw || '')
    .split(/[,;\s]+/)
    .map((entry) => sanitizeText(entry))
    .filter(Boolean);
  return new Set([...fallback, ...fromRaw]);
}

function normalizeListName(value = '') {
  return sanitizeText(value).toLowerCase().replace(/\s+/g, ' ');
}

function normalizeEmail(value = '') {
  const email = sanitizeFieldValue(value).toLowerCase();
  return email.includes('@') ? email : '';
}

function normalizePhoneDigits(value = '') {
  return String(value || '').replace(/\D+/g, '');
}

function phonesMatch(a = '', b = '') {
  const left = normalizePhoneDigits(a);
  const right = normalizePhoneDigits(b);
  if (!left || !right) return false;
  if (left === right) return true;
  const minLen = 8;
  if (left.length < minLen && right.length < minLen) return false;
  return left.endsWith(right) || right.endsWith(left);
}

export function isSsuWinsSyncEnabled() {
  return String(process.env.MYPHONER_SSU_WINS_SYNC_ENABLED || '1') !== '0';
}

export function getConfiguredSsuListIds() {
  return parseIdList(process.env.MYPHONER_SSU_LIST_IDS, DEFAULT_SSU_LIST_IDS);
}

export function getConfiguredSsuWinsListIds() {
  return parseIdList(process.env.MYPHONER_SSU_WINS_LIST_IDS, DEFAULT_SSU_WINS_LIST_IDS);
}

export function getConfiguredSsuWinsListName() {
  return sanitizeText(process.env.MYPHONER_SSU_WINS_LIST_NAME) || DEFAULT_SSU_WINS_LIST_NAME;
}

export function isSsuWinsList({ listId = '', listName = '' } = {}) {
  const id = sanitizeText(listId);
  if (id && getConfiguredSsuWinsListIds().has(id)) return true;
  return normalizeListName(listName) === normalizeListName(getConfiguredSsuWinsListName());
}

export function isSsuSourceList({ listId = '', listName = '' } = {}) {
  if (isSsuWinsList({ listId, listName })) return false;
  const id = sanitizeText(listId);
  if (id && getConfiguredSsuListIds().has(id)) return true;
  return normalizeListName(listName) === 'ssu';
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function eventKind(event = {}) {
  return sanitizeText(event?.kind || event?.type || event?.event || event?.action).toLowerCase();
}

function isWinnerEvent(event = {}) {
  const kind = eventKind(event);
  return kind === 'winner' || kind === 'won';
}

export function isWinnerLead(lead = {}) {
  const source = myphonerApi.unwrapMyPhonerLead(lead);
  const state = sanitizeText(source.state || source.status).toLowerCase();
  if (state === 'won' || state === 'winner') return true;
  if (isWinnerEvent(source.last_event) || isWinnerEvent(source.last_action_or_note)) return true;
  const events = Array.isArray(source.events) ? source.events : [];
  if (events.some((event) => isWinnerEvent(event))) return true;
  const outcome = sanitizeText(source.outcome).toLowerCase();
  return outcome === 'winner';
}

export function collectLeadComments(lead = {}) {
  const source = myphonerApi.unwrapMyPhonerLead(lead);
  const events = [
    ...(Array.isArray(source.events) ? source.events : []),
    source.last_event,
    source.last_action_or_note,
  ].filter(Boolean);
  const seen = new Set();
  const comments = [];
  for (const event of events) {
    const comment = sanitizeFieldValue(event?.comment);
    if (!comment) continue;
    const key = comment.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    comments.push({
      kind: eventKind(event),
      category: sanitizeText(event?.category),
      comment,
      createdAt: sanitizeText(event?.created_at || event?.createdAt),
    });
  }
  const direct = sanitizeFieldValue(source.comment);
  if (direct && !seen.has(direct.toLowerCase())) {
    comments.push({ kind: 'comment', category: '', comment: direct, createdAt: '' });
  }
  comments.sort((a, b) => {
    const aWinner = a.kind === 'winner' || a.kind === 'won' ? 0 : 1;
    const bWinner = b.kind === 'winner' || b.kind === 'won' ? 0 : 1;
    if (aWinner !== bWinner) return aWinner - bWinner;
    return String(a.createdAt).localeCompare(String(b.createdAt));
  });
  return comments;
}

export function formatLeadCommentBlock(comments = []) {
  return (Array.isArray(comments) ? comments : [])
    .map((entry) => {
      const text = sanitizeFieldValue(entry?.comment || entry);
      if (!text) return '';
      const kind = sanitizeText(entry?.kind);
      if (kind && kind !== 'winner' && kind !== 'won' && kind !== 'comment') {
        return `[${kind}] ${text}`;
      }
      return text;
    })
    .filter(Boolean)
    .join('\n\n');
}

export function getWinnerCategory(lead = {}) {
  const source = myphonerApi.unwrapMyPhonerLead(lead);
  const events = [
    source.last_event,
    source.last_action_or_note,
    ...(Array.isArray(source.events) ? source.events : []),
  ];
  for (const event of events) {
    if (isWinnerEvent(event) && sanitizeText(event?.category)) return sanitizeText(event.category);
  }
  return sanitizeText(source.category);
}

async function hydrateLead(lead = {}) {
  const source = myphonerApi.unwrapMyPhonerLead(lead);
  if (Array.isArray(source.events) && source.events.length) return source;
  const leadId = getLeadId(source);
  if (!leadId) return source;
  const response = await myphonerApi.fetchMyPhonerLeadById(leadId);
  if (!response.success) return source;
  return myphonerApi.unwrapMyPhonerLead(response.data);
}

async function attachCommentsToDestLead(targetLeadId, sourceLead) {
  const destId = sanitizeText(targetLeadId);
  if (!destId) return { ok: false, error: 'Missing target lead id.' };
  const comments = collectLeadComments(sourceLead);
  let comment = formatLeadCommentBlock(comments);
  if (!comment) {
    const sourceLeadId = getLeadId(sourceLead);
    try {
      comment = sanitizeFieldValue(sales.getSalesClientByMyphonerLeadId(sourceLeadId)?.myphoner?.winnerComment);
    } catch {
      comment = '';
    }
  }
  if (!comment) return { ok: true, skipped: 'no-comments' };
  const destResponse = await myphonerApi.fetchMyPhonerLeadById(destId);
  if (destResponse.success) {
    const destLead = myphonerApi.unwrapMyPhonerLead(destResponse.data);
    const existing = formatLeadCommentBlock(collectLeadComments(destLead));
    if (existing && existing.toLowerCase().includes(comment.slice(0, 80).toLowerCase())) {
      return { ok: true, skipped: 'comment-already-present' };
    }
  }
  const category = getWinnerCategory(sourceLead);
  const response = await myphonerApi.markMyPhonerLeadWinner(destId, { comment, category });
  if (!response.success) {
    const fallback = await myphonerApi.markMyPhonerLeadWinner(destId, { comment });
    if (!fallback.success) {
      return { ok: false, error: fallback.error || response.error || 'Failed attaching comment.' };
    }
  }
  return { ok: true, attached: true };
}

export function getLeadId(lead = {}) {
  const source = myphonerApi.unwrapMyPhonerLead(lead);
  return sanitizeText(source.id || source.lead_id || source.leadId);
}

export function getLeadListMeta(lead = {}) {
  const source = myphonerApi.unwrapMyPhonerLead(lead);
  const listLocation = sanitizeText(source.list_location || source.listLocation || source.list_id || source.listId);
  const listId = sanitizeText(
    myphonerApi.extractMyPhonerIdFromResource(listLocation, 'lists') || source.list_id || source.listId
  );
  const listName = sanitizeText(source.list_name || source.listName);
  return { listId, listName };
}

function collectSourceFields(lead = {}) {
  const source = myphonerApi.unwrapMyPhonerLead(lead);
  const leadData = source.lead_data && typeof source.lead_data === 'object' ? source.lead_data : {};
  const fields = {};
  for (const [key, value] of Object.entries(leadData)) {
    const text = sanitizeFieldValue(value);
    if (!key || !text) continue;
    fields[String(key)] = text;
  }
  const primary = sanitizeFieldValue(source.primary_identifier);
  const secondary = sanitizeFieldValue(source.secondary_identifier);
  const tertiary = sanitizeFieldValue(source.tertiary_identifier);
  if (primary && !fields.primary_identifier) fields.primary_identifier = primary;
  if (secondary && !fields.secondary_identifier) fields.secondary_identifier = secondary;
  if (tertiary && !fields.tertiary_identifier) fields.tertiary_identifier = tertiary;
  if (primary && !fields.name) fields.name = primary;
  if (secondary && !fields.contact_person) fields.contact_person = secondary;
  if (tertiary && !fields.phone) fields.phone = tertiary;
  return fields;
}

function pickSourceValue(fields, keys = []) {
  for (const key of keys) {
    const value = sanitizeFieldValue(fields[key]);
    if (value) return { key, value };
  }
  return { key: '', value: '' };
}

function splitPersonName(value = '') {
  const parts = sanitizeText(value).split(/\s+/).filter(Boolean);
  if (!parts.length) return { first: '', last: '' };
  if (parts.length === 1) return { first: parts[0], last: '' };
  return { first: parts[0], last: parts.slice(1).join(' ') };
}

export function mapLeadToTargetColumns(lead = {}, targetColumns = []) {
  const fields = collectSourceFields(lead);
  const keys = (Array.isArray(targetColumns) ? targetColumns : [])
    .map((column) => sanitizeText(column?.key || column))
    .filter(Boolean);
  const payload = {};
  const usedSourceKeys = new Set();

  for (const targetKey of keys) {
    const synonyms = FIELD_SYNONYMS[targetKey] || [targetKey];
    const picked = pickSourceValue(fields, synonyms);
    if (!picked.value) continue;
    payload[targetKey] = picked.value;
    if (picked.key) usedSourceKeys.add(picked.key);
  }

  if (keys.includes('first_name') || keys.includes('last_name')) {
    const hasExplicitFirst = sanitizeText(fields.first_name);
    const hasExplicitLast = sanitizeText(fields.last_name);
    if (!hasExplicitFirst || !hasExplicitLast) {
      const person = sanitizeText(fields.contact_person || fields.full_name || fields.secondary_identifier);
      const split = splitPersonName(person);
      if (keys.includes('first_name') && split.first && (!payload.first_name || payload.first_name === person)) {
        payload.first_name = split.first;
      }
      if (keys.includes('last_name') && split.last && !payload.last_name) {
        payload.last_name = split.last;
      }
    }
  }

  if (keys.includes('title') && !payload.title) {
    const extras = ['industry', 'orgnr', 'address']
      .map((key) => {
        const value = sanitizeText(fields[key]);
        if (!value || usedSourceKeys.has(key)) return '';
        if (key === 'orgnr') return `Orgnr ${value}`;
        return value;
      })
      .filter(Boolean);
    if (extras.length) payload.title = extras.join(' · ');
  }

  return payload;
}

async function loadLists({ force = false } = {}) {
  if (!force && listsCache.lists.length && Date.now() < listsCache.expiresAt) {
    return { success: true, data: listsCache.lists };
  }
  const response = await myphonerApi.listMyPhonerLists();
  if (!response.success) return response;
  const lists = Array.isArray(response.data) ? response.data : [];
  listsCache = { lists, expiresAt: Date.now() + 5 * 60 * 1000 };
  return { success: true, data: lists };
}

export async function resolveSsuWinsLists({ force = false } = {}) {
  const response = await loadLists({ force });
  if (!response.success) {
    return { ok: false, error: response.error || 'Failed loading MyPhoner lists.' };
  }
  const lists = Array.isArray(response.data) ? response.data : [];
  const source = lists.find((list) =>
    isSsuSourceList({ listId: sanitizeText(list?.id), listName: sanitizeText(list?.name) })
  );
  const target = lists.find((list) =>
    isSsuWinsList({ listId: sanitizeText(list?.id), listName: sanitizeText(list?.name) })
  );
  if (!source?.id) {
    return { ok: false, error: 'SSU source list was not found in MyPhoner.' };
  }
  if (!target?.id) {
    return { ok: false, error: 'SSU wins target list was not found in MyPhoner.' };
  }
  return {
    ok: true,
    source: { id: sanitizeText(source.id), name: sanitizeText(source.name), leadsCount: Number(source.leads_count) || 0 },
    target: { id: sanitizeText(target.id), name: sanitizeText(target.name), leadsCount: Number(target.leads_count) || 0 },
  };
}

async function loadTargetColumns(listId) {
  const key = sanitizeText(listId);
  const cached = columnsCache.get(key);
  if (cached && Date.now() < cached.expiresAt) return cached.columns;
  const response = await myphonerApi.getMyPhonerListColumns(key);
  const columns = response.success && Array.isArray(response.data) ? response.data : [];
  columnsCache.set(key, { columns, expiresAt: Date.now() + 10 * 60 * 1000 });
  return columns;
}

function indexDestLeads(leads = []) {
  const byPhone = new Map();
  const byEmail = new Map();
  for (const lead of leads) {
    const source = myphonerApi.unwrapMyPhonerLead(lead);
    const fields = collectSourceFields(source);
    const phones = [fields.mobile_phone, fields.phone, fields.work_office_phone, fields.business_phone, source.tertiary_identifier];
    for (const phone of phones) {
      const digits = normalizePhoneDigits(phone);
      if (digits) byPhone.set(digits, source);
    }
    const email = normalizeEmail(fields.e_mail || fields.email);
    if (email) byEmail.set(email, source);
  }
  return { byPhone, byEmail };
}

async function loadDestIndex(listId, { force = false } = {}) {
  const key = sanitizeText(listId);
  if (
    !force &&
    destIndexCache.listId === key &&
    Date.now() < destIndexCache.expiresAt &&
    Array.isArray(destIndexCache.leads)
  ) {
    return destIndexCache;
  }
  const response = await myphonerApi.listAllMyPhonerLeadsInList(key, { per_page: 100, order: 'last_updated_first' }, { maxPages: 30 });
  const leads = response.success && Array.isArray(response.data) ? response.data : [];
  const indexed = indexDestLeads(leads);
  destIndexCache = {
    listId: key,
    expiresAt: Date.now() + 2 * 60 * 1000,
    leads,
    ...indexed,
  };
  return destIndexCache;
}

function findExistingDestLead(lead, destIndex) {
  const fields = collectSourceFields(lead);
  const phones = [fields.phone, fields.mobile_phone, fields.business_phone, fields.tertiary_identifier];
  for (const phone of phones) {
    const digits = normalizePhoneDigits(phone);
    if (!digits) continue;
    const direct = destIndex.byPhone.get(digits);
    if (direct) return direct;
    for (const [existingDigits, existingLead] of destIndex.byPhone.entries()) {
      if (phonesMatch(digits, existingDigits)) return existingLead;
    }
  }
  const email = normalizeEmail(fields.email || fields.e_mail);
  if (email && destIndex.byEmail.get(email)) return destIndex.byEmail.get(email);
  return null;
}

function extractCreatedLeadId(payload) {
  const lead = myphonerApi.unwrapMyPhonerLead(payload);
  return sanitizeText(lead?.id || payload?.id || payload?.lead_id);
}

async function finishCopiedLead({
  sourceLead,
  sourceLeadId,
  targetLeadId,
  lists,
  created = false,
  skipped = '',
  mappedFields = [],
} = {}) {
  const commentResult = await attachCommentsToDestLead(targetLeadId, sourceLead);
  myphonerIntegration.markSsuWinnerCopied(sourceLeadId, {
    targetLeadId: sanitizeText(targetLeadId),
    sourceListId: lists.source.id,
    targetListId: lists.target.id,
    phone: sanitizeText(collectSourceFields(sourceLead).phone),
    email: sanitizeText(collectSourceFields(sourceLead).email),
    copiedAt: nowIso(),
  });
  destIndexCache.expiresAt = 0;
  return {
    ok: Boolean(commentResult?.ok !== false),
    created,
    skipped: skipped || undefined,
    leadId: sourceLeadId,
    targetLeadId: sanitizeText(targetLeadId),
    targetListId: lists.target.id,
    mappedFields,
    commentAttached: Boolean(commentResult?.attached),
    commentSkipped: sanitizeText(commentResult?.skipped),
    error: commentResult?.ok === false ? commentResult.error : undefined,
  };
}

/** WS8.56: a lead that belongs to a test sales client is never copied to Myphoner. */
function testClientSkip(leadId) {
  const id = sanitizeText(leadId);
  if (!id) return '';
  return myphonerSyncSkipReason(sales.getSalesClientByMyphonerLeadId(id));
}

export async function copySsuWinnerToWinsList(lead = {}, options = {}) {
  if (!isSsuWinsSyncEnabled() && !options.force) {
    return { ok: true, skipped: 'disabled' };
  }
  const earlyId = getLeadId(myphonerApi.unwrapMyPhonerLead(lead));
  if (testClientSkip(earlyId)) return { ok: true, skipped: 'test-client', leadId: earlyId };
  const hydrated = await hydrateLead(lead);
  const sourceLead = myphonerApi.unwrapMyPhonerLead(hydrated);
  const sourceLeadId = getLeadId(sourceLead);
  if (!sourceLeadId) return { ok: false, error: 'Missing source lead id.' };
  if (testClientSkip(sourceLeadId)) return { ok: true, skipped: 'test-client', leadId: sourceLeadId };

  const listMeta = getLeadListMeta(sourceLead);
  if (isSsuWinsList(listMeta)) {
    return { ok: true, skipped: 'already-on-ssu-wins', leadId: sourceLeadId };
  }
  if (!options.ignoreSourceList && !isSsuSourceList(listMeta)) {
    return { ok: true, skipped: 'not-ssu-source', leadId: sourceLeadId, listId: listMeta.listId, listName: listMeta.listName };
  }
  if (!options.assumeWinner && !isWinnerLead(sourceLead)) {
    return { ok: true, skipped: 'not-winner', leadId: sourceLeadId };
  }

  const lists = await resolveSsuWinsLists();
  if (!lists.ok) return lists;

  const already = myphonerIntegration.getCopiedSsuWinner(sourceLeadId);
  if (already?.targetLeadId && !options.forceRecreate) {
    return finishCopiedLead({
      sourceLead,
      sourceLeadId,
      targetLeadId: already.targetLeadId,
      lists,
      skipped: 'already-copied',
    });
  }

  const destIndex = await loadDestIndex(lists.target.id, { force: Boolean(options.refreshDestIndex) });
  const existing = findExistingDestLead(sourceLead, destIndex);
  if (existing?.id && !options.forceRecreate) {
    return finishCopiedLead({
      sourceLead,
      sourceLeadId,
      targetLeadId: existing.id,
      lists,
      skipped: 'already-in-target',
    });
  }

  const columns = await loadTargetColumns(lists.target.id);
  const payload = mapLeadToTargetColumns(sourceLead, columns);
  if (!Object.keys(payload).length) {
    return { ok: false, error: 'Mapped lead payload was empty.', leadId: sourceLeadId };
  }

  const createResponse = await myphonerApi.createMyPhonerLeadInList(lists.target.id, payload);
  if (!createResponse.success) {
    return {
      ok: false,
      error: createResponse.error || 'Failed creating lead in SSU wins.',
      status: createResponse.status,
      leadId: sourceLeadId,
    };
  }

  let targetLeadId = extractCreatedLeadId(createResponse.data);
  if (!targetLeadId) {
    destIndexCache.expiresAt = 0;
    const refreshed = await loadDestIndex(lists.target.id, { force: true });
    targetLeadId = sanitizeText(findExistingDestLead(sourceLead, refreshed)?.id);
  }
  if (!targetLeadId) {
    return { ok: false, error: 'Created SSU wins lead but could not read its id.', leadId: sourceLeadId };
  }
  return finishCopiedLead({
    sourceLead,
    sourceLeadId,
    targetLeadId,
    lists,
    created: true,
    mappedFields: Object.keys(payload),
  });
}

function collectSalesSsuLeadIds() {
  try {
    return (sales.getSalesClients() || [])
      .filter((client) => sales.isSsuSalesProduct(client?.product) && sanitizeText(client?.myphoner?.leadId))
      .map((client) => sanitizeText(client.myphoner.leadId));
  } catch {
    return [];
  }
}

async function collectSsuWinnerLeads(sourceListId, options = {}) {
  const includeHistorical = options.includeHistorical !== false;
  const listedResponse = await myphonerApi.listAllMyPhonerLeadsInList(
    sourceListId,
    { per_page: 100, order: 'last_updated_first' },
    { maxPages: Math.max(20, Number(options.maxPages) || 50) }
  );
  if (!listedResponse.success) {
    return { ok: false, error: listedResponse.error || 'Failed listing SSU leads.', scanned: 0, hydrated: 0, winners: [] };
  }
  const listed = Array.isArray(listedResponse.data) ? listedResponse.data : [];
  const winnersById = new Map();
  const addWinner = (lead) => {
    const id = getLeadId(lead);
    if (id) winnersById.set(id, lead);
  };

  for (const lead of listed) {
    if (isWinnerLead(lead)) addWinner(lead);
  }

  let hydrated = 0;
  if (includeHistorical) {
    const pending = listed.filter((lead) => {
      const state = sanitizeText(lead?.state || lead?.status).toLowerCase();
      const id = getLeadId(lead);
      return id && state && state !== 'new' && !winnersById.has(id);
    });
    for (const lead of pending) {
      const full = await hydrateLead(lead);
      hydrated += 1;
      if (isWinnerLead(full)) addWinner(full);
      await sleep(150);
    }
  }

  for (const leadId of collectSalesSsuLeadIds()) {
    if (winnersById.has(leadId)) continue;
    const response = await myphonerApi.fetchMyPhonerLeadById(leadId);
    hydrated += 1;
    if (!response.success) continue;
    const full = myphonerApi.unwrapMyPhonerLead(response.data);
    const meta = getLeadListMeta(full);
    if (!isSsuSourceList(meta) && meta.listId && meta.listId !== sanitizeText(sourceListId)) continue;
    if (isWinnerLead(full) || options.includeSalesWinners !== false) addWinner(full);
    await sleep(150);
  }

  return {
    ok: true,
    scanned: listed.length,
    hydrated,
    winners: Array.from(winnersById.values()),
  };
}

export async function backfillSsuWinnersToWinsList(options = {}) {
  if (!isSsuWinsSyncEnabled() && !options.force) {
    return { ok: true, skipped: 'disabled' };
  }
  if (!myphonerApi.isMyPhonerConfigured()) {
    return { ok: false, skipped: 'myphoner-not-configured' };
  }

  const lists = await resolveSsuWinsLists({ force: true });
  if (!lists.ok) return lists;

  const includeHistorical = options.includeHistorical !== false;
  const collected = await collectSsuWinnerLeads(lists.source.id, {
    includeHistorical,
    maxPages: options.maxPages,
  });
  if (!collected.ok) {
    return { ok: false, error: collected.error, scanned: collected.scanned || 0 };
  }

  const summary = {
    ok: true,
    sourceListId: lists.source.id,
    sourceListName: lists.source.name,
    targetListId: lists.target.id,
    targetListName: lists.target.name,
    scanned: collected.scanned,
    hydrated: collected.hydrated,
    winners: collected.winners.length,
    created: 0,
    skipped: 0,
    commentsAttached: 0,
    failed: 0,
    errors: [],
  };

  await loadDestIndex(lists.target.id, { force: true });

  for (const winner of collected.winners) {
    const result = await copySsuWinnerToWinsList(winner, {
      force: true,
      assumeWinner: true,
      ignoreSourceList: false,
    });
    if (result?.created) summary.created += 1;
    else if (result?.ok && result?.skipped) summary.skipped += 1;
    else {
      summary.failed += 1;
      if (result?.error) summary.errors.push(result.error);
    }
    if (result?.commentAttached) summary.commentsAttached += 1;
  }

  myphonerIntegration.setSsuWinsBackfillState({
    sourceListId: lists.source.id,
    targetListId: lists.target.id,
    lastBackfillAt: nowIso(),
    historicalBackfillVersion: includeHistorical ? 'historical-v2' : undefined,
    lastBackfillSummary: {
      scanned: summary.scanned,
      hydrated: summary.hydrated,
      winners: summary.winners,
      created: summary.created,
      skipped: summary.skipped,
      commentsAttached: summary.commentsAttached,
      failed: summary.failed,
    },
  });

  return summary;
}

const HISTORICAL_BACKFILL_VERSION = 'historical-v2';

export async function maybeBackfillSsuWinners(options = {}) {
  if (!isSsuWinsSyncEnabled() && !options.force) {
    return { ok: true, skipped: 'disabled' };
  }
  const includeHistorical = options.includeHistorical !== false;
  if (includeHistorical) {
    const currentVersion = sanitizeText(myphonerIntegration.getSsuWinsState()?.historicalBackfillVersion);
    if (currentVersion === HISTORICAL_BACKFILL_VERSION && !options.forceHistorical) {
      return backfillSsuWinnersToWinsList({ ...options, includeHistorical: false });
    }
  }
  return backfillSsuWinnersToWinsList({ ...options, includeHistorical });
}
