/**
 * Turns a free-text client message into Kundedata.
 * The assistant files what was actually said. It does not invent the rest.
 */

import { deepseekChatJson, isDeepseekConfigured } from '../deepseek.js';
import { parseOpeningHoursAnswer } from './intake.js';

const FIELD_PATHS = {
  companyAddress: ['generalInfo', 'companyAddress'],
  companyPhone: ['generalInfo', 'companyPhone'],
  companyEmail: ['generalInfo', 'companyEmail'],
  websiteUrl: ['generalInfo', 'websiteUrl'],
  instagramUrl: ['generalInfo', 'instagramUrl'],
  facebookUrl: ['generalInfo', 'facebookUrl'],
  industry: ['businessCard', 'industry'],
  websiteGoal: ['businessCard', 'websiteGoal'],
  town: ['websiteCreatorQuestions', 'town'],
  country: ['websiteCreatorQuestions', 'country'],
  websiteLanguage: ['generalInfo', 'websiteLanguage'],
  toneOfVoice: ['websiteCreatorQuestions', 'toneOfVoice'],
  businessWhat: ['websiteCreatorQuestions', 'businessWhat'],
  businessStory: ['websiteCreatorQuestions', 'businessStory'],
  differentiator: ['websiteCreatorQuestions', 'differentiator'],
  targetAudience: ['websiteCreatorQuestions', 'targetAudience'],
  keyMessage: ['websiteCreatorQuestions', 'keyMessage'],
  extraContext: ['websiteCreatorQuestions', 'extraContext'],
  wantedPages: ['websiteCreatorQuestions', 'wantedPages'],
  orgNumber: ['brandIdentity', 'orgNumber'],
  primaryColor: ['brandIdentity', 'colors', 'primary'],
  secondaryColor: ['brandIdentity', 'colors', 'secondary'],
  accentColor: ['brandIdentity', 'colors', 'accent'],
};

const COLOR_KEYS = new Set(['primaryColor', 'secondaryColor', 'accentColor']);

function compact(value = '') {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function setPath(bank, path, value) {
  const next = { ...bank };
  if (path.length === 2) {
    next[path[0]] = { ...(bank[path[0]] || {}), [path[1]]: value };
    return next;
  }
  const mid = { ...(bank[path[0]] || {}) };
  mid[path[1]] = { ...(mid[path[1]] || {}), [path[2]]: value };
  next[path[0]] = mid;
  return next;
}

const MEDIA_BUCKETS = [
  'mainHeroImages',
  'aboutImages',
  'teamImages',
  'locationImages',
  'logos',
  'icons',
  'illustrationImages',
  'offeringImages',
  'galleryImages',
  'uncategorized',
];

export function emptyNote() {
  return {
    reply: '',
    chapter: '',
    hoursText: '',
    people: [],
    partners: [],
    productText: '',
    mediaFiles: [],
    fields: {},
  };
}

export function normalizeNote(raw = {}) {
  const note = emptyNote();
  note.reply = compact(raw.reply).slice(0, 400);
  const chapter = compact(raw.chapter);
  if (['products', 'media', 'logo', 'staff', 'hours', 'affiliations'].includes(chapter)) note.chapter = chapter;
  note.hoursText = compact(raw.hoursText).slice(0, 500);
  note.productText = compact(raw.productText).slice(0, 4000);
  note.mediaFiles = (Array.isArray(raw.mediaFiles) ? raw.mediaFiles : []).map((row) => {
    const fileName = compact(row?.fileName || row?.filename || row?.name);
    const bucket = compact(row?.bucket);
    if (!fileName) return null;
    return {
      fileName,
      bucket: MEDIA_BUCKETS.includes(bucket) ? bucket : 'uncategorized',
      isLogo: Boolean(row?.isLogo) || bucket === 'logos',
    };
  }).filter(Boolean).slice(0, 24);
  note.people = (Array.isArray(raw.people) ? raw.people : []).map((person) => ({
    name: compact(person?.name),
    title: compact(person?.title),
    phone: compact(person?.phone),
    email: compact(person?.email).toLowerCase(),
  })).filter((person) => person.name.length > 1).slice(0, 20);
  note.partners = (Array.isArray(raw.partners) ? raw.partners : []).map((group) => ({
    categoryName: compact(group?.categoryName) || 'Partnere',
    titles: (Array.isArray(group?.titles) ? group.titles : []).map((title) => compact(title)).filter((title) => title.length > 1).slice(0, 30),
  })).filter((group) => group.titles.length).slice(0, 8);
  const fields = raw.fields && typeof raw.fields === 'object' ? raw.fields : {};
  for (const key of Object.keys(FIELD_PATHS)) {
    const value = compact(fields[key]).slice(0, 500);
    if (!value) continue;
    if (COLOR_KEYS.has(key) && !/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(value)) continue;
    note.fields[key] = value;
  }
  return note;
}

export function noteHasChanges(note = emptyNote()) {
  return Boolean(
    note.chapter
    || note.hoursText
    || note.productText
    || note.mediaFiles.length
    || note.people.length
    || note.partners.length
    || Object.keys(note.fields).length
  );
}

export function applyNoteToBank(bank = {}, note = emptyNote()) {
  let next = { ...bank };
  if (note.hoursText) {
    const parsed = parseOpeningHoursAnswer(note.hoursText);
    if (parsed.action === 'set' || parsed.action === 'always' || parsed.action === 'not-relevant') {
      next = {
        ...next,
        openingHours: {
          ...(next.openingHours || {}),
          status: parsed.status,
          days: parsed.days,
        },
      };
    }
  }
  if (note.people.length) {
    next = {
      ...next,
      staff: [
        ...(next.staff || []),
        ...note.people.map((person) => ({
          id: '',
          title: person.title,
          name: person.name,
          phone: person.phone,
          email: person.email,
          imageUrl: '',
        })),
      ],
    };
  }
  if (note.partners.length) {
    const affiliations = [...(next.affiliations || [])];
    for (const group of note.partners) {
      const items = group.titles.map((title) => ({ title }));
      const hitIndex = affiliations.findIndex((row) => String(row.categoryName || '').toLowerCase() === group.categoryName.toLowerCase());
      if (hitIndex >= 0) {
        const hit = affiliations[hitIndex];
        affiliations[hitIndex] = { ...hit, items: [...(hit.items || []), ...items] };
      } else {
        affiliations.push({ categoryName: group.categoryName, items });
      }
    }
    next = { ...next, affiliations };
  }
  for (const [key, value] of Object.entries(note.fields)) {
    next = setPath(next, FIELD_PATHS[key], value);
  }
  return next;
}

export async function interpretLooseNote(text = '', bank = {}) {
  const raw = compact(text);
  if (raw.length < 8 || !isDeepseekConfigured()) return null;
  try {
    const parsed = await deepseekChatJson({
      temperature: 0.2,
      maxTokens: 900,
      system: `Du tar imot det en kunde skriver og sorterer det i kundedata. Du finner ikke på fakta, og du spør ikke om noe de ikke nevnte.
Svar JSON:
{
  "reply": "én kort bekreftelse på norsk av det du faktisk la inn, eller tom streng",
  "chapter": "products"|"media"|"logo"|"staff"|"hours"|"affiliations"|null,
  "hoursText": "bare hvis de oppga åpningstider, gjerne «mandag 09:00-17:00» eller «åpent hele tiden»",
  "people": [{"name":"","title":"","phone":"","email":""}],
  "partners": [{"categoryName":"","titles":[""]}],
  "productText": "bare hvis de listet produkter, tjenester eller en meny",
  "mediaFiles": [{ "fileName": "", "bucket": "logos"|"mainHeroImages"|"aboutImages"|"teamImages"|"locationImages"|"icons"|"illustrationImages"|"offeringImages"|"galleryImages"|"uncategorized", "isLogo": false }],
  "fields": {
    "companyAddress": "",
    "companyPhone": "",
    "companyEmail": "",
    "websiteUrl": "",
    "instagramUrl": "",
    "facebookUrl": "",
    "industry": "",
    "websiteGoal": "",
    "town": "",
    "country": "",
    "websiteLanguage": "",
    "toneOfVoice": "",
    "businessWhat": "",
    "businessStory": "",
    "differentiator": "",
    "targetAudience": "",
    "keyMessage": "",
    "extraContext": "",
    "wantedPages": "",
    "orgNumber": "",
    "primaryColor": "",
    "secondaryColor": "",
    "accentColor": ""
  }
}
chapter settes bare når de ber om å bytte kapittel. mediaFiles bare når de sier hva et vedlegg er (logo, hovedbilde, ansatte, …). Farger kun som #hex. Tomme felt betyr at de ikke sa det.`,
      user: JSON.stringify({
        message: raw,
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
