/**
 * Turns a free-text client message into Kundedata.
 * The assistant files what was actually said. It does not invent the rest.
 * Merge logic + prompt builder: packages/suite/core/facts. Schema + Norwegian text: harness/asoldi/facts.js.
 */

import { deepseekChatJson, isDeepseekConfigured } from '../deepseek.js';
import { parseOpeningHoursAnswer } from './intake.js';
import {
  applyFieldOps,
  mergeFieldValue as coreMergeFieldValue,
  mergeGroups,
  mergePeople,
  mergeWeekHours,
  normalizeFieldOps,
  pickAction,
  removeNamedItems,
  snapshotFields,
} from '../../packages/suite/core/facts/merge.js';
import { buildFactPrompt } from '../../packages/suite/core/facts/prompt.js';
import {
  ASOLDI_DEFAULT_PARTNER_GROUP,
  ASOLDI_FACT_PROMPT,
  KUNDEDATA_CHAPTERS,
  KUNDEDATA_FACT_SCHEMA,
} from '../../packages/suite/harness/asoldi/facts.js';
import { KUNDEDATA_MEDIA_BUCKETS } from '../../packages/suite/harness/asoldi/media.js';

function compact(value = '') {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

/** New stored value for one Kundedata field. Unclear intent is `add`, so existing data is never lost by accident. */
export function mergeFieldValue(key, existing, value, action = 'add') {
  return coreMergeFieldValue(KUNDEDATA_FACT_SCHEMA.fields[key] || {}, existing, value, action);
}

export function emptyNote() {
  return {
    reply: '',
    chapter: '',
    hoursText: '',
    hoursAction: '',
    people: [],
    partners: [],
    productText: '',
    removeProducts: [],
    mediaFiles: [],
    fields: {},
    fieldActions: {},
  };
}

export function normalizeNote(raw = {}) {
  const note = emptyNote();
  note.reply = compact(raw.reply).slice(0, 400);
  const chapter = compact(raw.chapter);
  if (KUNDEDATA_CHAPTERS.includes(chapter)) note.chapter = chapter;
  note.hoursText = compact(raw.hoursText).slice(0, 500);
  if (note.hoursText) note.hoursAction = pickAction(raw.hoursAction, ['replace', 'update'], '');
  note.productText = compact(raw.productText).slice(0, 4000);
  note.removeProducts = (Array.isArray(raw.removeProducts) ? raw.removeProducts : [])
    .map((title) => compact(title)).filter((title) => title.length > 1).slice(0, 30);
  note.mediaFiles = (Array.isArray(raw.mediaFiles) ? raw.mediaFiles : []).map((row) => {
    const fileName = compact(row?.fileName || row?.filename || row?.name);
    const bucket = compact(row?.bucket);
    if (!fileName) return null;
    return {
      fileName,
      bucket: KUNDEDATA_MEDIA_BUCKETS.includes(bucket) ? bucket : 'uncategorized',
      isLogo: Boolean(row?.isLogo) || bucket === 'logos',
    };
  }).filter(Boolean).slice(0, 24);
  note.people = (Array.isArray(raw.people) ? raw.people : []).map((person) => ({
    name: compact(person?.name),
    title: compact(person?.title),
    phone: compact(person?.phone),
    email: compact(person?.email).toLowerCase(),
    action: pickAction(person?.action, ['add', 'update', 'remove'], 'add'),
  })).filter((person) => person.name.length > 1).slice(0, 20);
  note.partners = (Array.isArray(raw.partners) ? raw.partners : []).map((group) => ({
    categoryName: compact(group?.categoryName) || ASOLDI_DEFAULT_PARTNER_GROUP,
    titles: (Array.isArray(group?.titles) ? group.titles : []).map((title) => compact(title)).filter((title) => title.length > 1).slice(0, 30),
    action: pickAction(group?.action, ['add', 'replace', 'remove'], 'add'),
  })).filter((group) => group.titles.length || group.action === 'remove').slice(0, 8);
  const ops = normalizeFieldOps(KUNDEDATA_FACT_SCHEMA, raw.fields, raw.fieldActions);
  note.fields = ops.fields;
  note.fieldActions = ops.fieldActions;
  return note;
}

export function noteHasChanges(note = emptyNote()) {
  return Boolean(
    note.chapter
    || note.hoursText
    || note.productText
    || note.removeProducts?.length
    || note.mediaFiles.length
    || note.people.length
    || note.partners.length
    || Object.keys(note.fields).length
    || Object.keys(note.fieldActions || {}).length
  );
}

/** Field keys the note fills in (deletes are not "found"). */
export function filledFieldKeys(note = emptyNote()) {
  return Object.keys(note.fields || {}).filter((key) => note.fieldActions?.[key] !== 'delete');
}

const newStaffRow = (person) => ({ id: '', title: person.title, name: person.name, phone: person.phone, email: person.email, imageUrl: '' });

export function applyNoteToBank(bank = {}, note = emptyNote()) {
  let next = { ...bank };
  if (note.hoursText) {
    const parsed = parseOpeningHoursAnswer(note.hoursText);
    const current = next.openingHours || {};
    const hours = mergeWeekHours(current, parsed, note.hoursAction);
    if (hours !== current) next = { ...next, openingHours: hours };
  }
  if (note.people.length) next = { ...next, staff: mergePeople(next.staff || [], note.people, { create: newStaffRow }) };
  if (note.partners.length) next = { ...next, affiliations: mergeGroups(next.affiliations || [], note.partners) };
  if (note.removeProducts?.length && Array.isArray(next.productCatalogs)) {
    next = { ...next, productCatalogs: removeNamedItems(next.productCatalogs, note.removeProducts) };
  }
  return applyFieldOps(next, KUNDEDATA_FACT_SCHEMA, note.fields, note.fieldActions);
}

function currentSnapshot(bank = {}) {
  const products = [];
  for (const catalog of bank.productCatalogs || []) {
    for (const category of catalog.categories || []) {
      for (const product of category.products || []) {
        const title = compact(product?.title || product?.name);
        if (title && products.length < 60) products.push(`${compact(category.name)}: ${title}`);
      }
    }
  }
  return {
    fields: snapshotFields(bank, KUNDEDATA_FACT_SCHEMA),
    staff: (bank.staff || []).map((person) => compact(person?.name)).filter(Boolean).slice(0, 30),
    partners: (bank.affiliations || []).map((group) => ({
      categoryName: compact(group?.categoryName),
      titles: (group?.items || []).map((item) => compact(item?.title)).filter(Boolean).slice(0, 15),
    })).slice(0, 8),
    hours: bank?.openingHours?.status || '',
    products,
  };
}

export async function interpretLooseNote(text = '', bank = {}, { source = '' } = {}) {
  const raw = source === 'email' ? compact(text).slice(0, 14_000) : compact(text);
  if (raw.length < 8 || !isDeepseekConfigured()) return null;
  try {
    const parsed = await deepseekChatJson({
      temperature: 0.2,
      maxTokens: 1800,
      system: buildFactPrompt({ schema: KUNDEDATA_FACT_SCHEMA, ...ASOLDI_FACT_PROMPT, source }),
      user: JSON.stringify({
        message: raw,
        current: currentSnapshot(bank),
        alreadyFilled: {
          products: Array.isArray(bank.productCatalogs) && bank.productCatalogs.some((catalog) => (catalog.categories || []).some((category) => (category.products || []).length)),
          logo: Boolean(bank?.brandIdentity?.logos?.normal),
          hours: bank?.openingHours?.status || '',
        },
      }),
    });
    const note = normalizeNote(parsed);
    return noteHasChanges(note) ? note : null;
  } catch {
    return null;
  }
}
