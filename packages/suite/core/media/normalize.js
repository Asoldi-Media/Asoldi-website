import { MEDIA_SECTIONS } from './prompt.js';

// Model output → a strict brief. Field names for a section come from the caller
// (a harness `fieldForSection`), so the core never knows any app's folder names.

function compact(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function lower(value = '') {
  return compact(value).toLowerCase();
}

const SECTION_LABELS = {
  hero: 'Hero',
  team: 'Team',
  about: 'About',
  process: 'Process',
  offerings: 'Offerings',
  location: 'Location',
  gallery: 'Gallery',
  testimonial: 'Testimonial',
  logo: 'Logo',
  favicon: 'Favicon',
  illustration: 'Illustration',
  decoration: 'Decoration',
  video: 'Video',
  audio: 'Audio',
  skip: 'Skip',
};

export function sectionLabel(section = '') {
  return SECTION_LABELS[section] || section || 'Media';
}

const GENERIC_BRAND_TOKENS = new Set(['media', 'group', 'studio', 'company', 'digital', 'official', 'agency', 'design', 'the', 'and', 'for', 'with', 'from']);

export function transcriptMatchesClientBrand(transcript = {}, businessName = '') {
  const name = lower(businessName);
  if (!name) return true;
  const hay = lower(
    [
      ...(Array.isArray(transcript.visibleText) ? transcript.visibleText : []),
      transcript.depicts,
      transcript.fileName,
      transcript.distinguishingDetail,
      transcript.setting,
    ]
      .filter(Boolean)
      .join(' ')
  );
  if (!hay) return false;
  const tokens = name
    .split(/[\s,/&+\-]+/)
    .map((token) => token.replace(/[^a-z0-9æøå]/gi, ''))
    .filter((token) => token.length >= 4 && !GENERIC_BRAND_TOKENS.has(token));
  if (tokens.some((token) => hay.includes(token))) return true;
  const compactName = name.replace(/[^a-z0-9æøå]/gi, '');
  const compactHay = hay.replace(/[^a-z0-9æøå]/gi, '');
  if (compactName.length >= 5 && compactHay.includes(compactName)) return true;
  // Short marks ("SS&U", "K2") only count as a whole word, so "ssu" never matches inside "classum".
  const hayWords = hay.split(/\s+/).map((word) => word.replace(/[^a-z0-9æøå]/gi, ''));
  return compactName.length >= 2 && hayWords.includes(compactName);
}

export function transcriptNamesForeignBrand(transcript = {}, businessName = '') {
  const texts = (Array.isArray(transcript.visibleText) ? transcript.visibleText : []).map((value) => compact(value)).filter(Boolean);
  // Only readable words (4+ chars) can name another brand; short ones may still be the client's own mark.
  if (!texts.some((value) => value.replace(/[^a-z0-9æøå]/gi, '').length >= 4)) return false;
  return !transcriptMatchesClientBrand({ visibleText: texts, depicts: texts.join(' '), fileName: '', distinguishingDetail: '', setting: '' }, businessName);
}

function withField(next, fieldForSection) {
  if (typeof fieldForSection !== 'function') return next;
  return { ...next, primaryField: fieldForSection(next.primarySection) || '' };
}

/** A logo whose readable words name another business is portfolio work, never the site logo. */
export function demoteForeignBrandLogo(transcript = {}, businessName = '', { fieldForSection } = {}) {
  if (!transcript || typeof transcript !== 'object') return transcript;
  const section = lower(transcript.primarySection);
  const medium = lower(transcript.medium);
  const logoish = section === 'logo' || section === 'favicon' || medium === 'logo';
  const partnerHint = lower(transcript.logoKind) === 'partner';
  if (!logoish && !partnerHint) return transcript;
  const foreign = partnerHint || transcriptNamesForeignBrand(transcript, businessName);
  if (!foreign) {
    const nextKind = lower(transcript.logoKind) === 'none' || !transcript.logoKind ? 'client' : transcript.logoKind;
    return { ...transcript, logoKind: nextKind === 'unknown' ? 'client' : nextKind };
  }
  const inLogoSlot = section === 'logo' || section === 'favicon';
  if (partnerHint && !inLogoSlot) return transcript;
  const alt = lower(transcript.alternateSection);
  const nextSection = !inLogoSlot ? transcript.primarySection : alt && alt !== 'logo' && alt !== 'favicon' ? transcript.alternateSection : 'offerings';
  return withField(
    {
      ...transcript,
      logoKind: 'partner',
      primarySection: nextSection,
      primaryWhy: compact(`${transcript.primaryWhy || ''} Not this client's brand mark — place as portfolio/work, not the site logo.`).slice(0, 420),
      doNotUseFor: compact(`logo: readable brand is not ${compact(businessName) || 'this client'}. ${transcript.doNotUseFor || ''}`).slice(0, 320),
    },
    fieldForSection
  );
}

/** A photo of a product, person, place, or sign is not the header logo, even when the brand is visible. */
export function demoteSceneMarkedAsLogo(transcript = {}, { fieldForSection } = {}) {
  if (!transcript || typeof transcript !== 'object') return transcript;
  const kind = lower(transcript.logoKind);
  if (kind !== 'client' && kind !== 'unknown') return transcript;
  const medium = lower(transcript.medium);
  const section = lower(transcript.primarySection);
  const subject = lower(transcript.subjectKind);
  const people = Number(transcript.peopleCount || 0);
  const sceneSubject = ['product', 'employee', 'customer', 'place'].includes(subject);
  const scene = medium === 'photo' || transcript.background === 'photo' || people > 0 || sceneSubject;
  if (!scene) return transcript;
  const cleanMark = (section === 'logo' || section === 'favicon' || medium === 'logo' || medium === 'icon') && people === 0 && transcript.background !== 'photo' && !sceneSubject;
  if (cleanMark) return transcript;
  const alt = lower(transcript.alternateSection);
  const nextSection = section === 'logo' || section === 'favicon'
    ? (alt && alt !== 'logo' && alt !== 'favicon' ? transcript.alternateSection : 'gallery')
    : transcript.primarySection;
  return withField(
    {
      ...transcript,
      logoKind: 'none',
      logoFormat: 'none',
      primarySection: nextSection,
    },
    fieldForSection
  );
}

/** Measured shape decides favicon vs wordmark, not the model's eyeballing. */
export function applyMeasuredLogoFormat(transcript = {}, measured = {}, { fieldForSection } = {}) {
  if (!transcript || typeof transcript !== 'object') return transcript;
  const next = { ...transcript };
  const ext = String(measured.ext || '').toLowerCase();
  const maxSide = Number(measured.maxSide || Math.max(Number(measured.width || 0), Number(measured.height || 0)));
  const square = String(measured.aspectClass || next.aspectClass || '') === 'square';
  const landscape = String(measured.aspectClass || next.aspectClass || '') === 'landscape';
  const logoish = next.medium === 'logo' || next.medium === 'icon' || next.primarySection === 'logo' || next.primarySection === 'favicon';
  if (!logoish || next.logoKind === 'partner') return next;
  const field = (section) => (typeof fieldForSection === 'function' ? fieldForSection(section) : section);
  if (ext === '.ico' || (square && maxSide > 0 && maxSide <= 192 && ['.ico', '.png', '.svg'].includes(ext))) {
    next.logoFormat = 'favicon';
    if (next.logoKind === 'client' || next.primarySection === 'favicon' || next.primarySection === 'logo') {
      next.primarySection = 'favicon';
      next.primaryField = field('favicon');
    }
  } else if (landscape && (next.primarySection === 'favicon' || next.logoFormat === 'favicon' || next.medium === 'logo')) {
    next.logoFormat = next.logoFormat === 'mark' ? 'mark' : 'wordmark';
    if (next.logoKind === 'client' || next.primarySection === 'favicon' || next.primarySection === 'logo') {
      next.primarySection = 'logo';
      next.primaryField = field('logo');
    }
  }
  if (measured.hasAlpha && next.background === 'unknown' && logoish) next.background = 'transparent';
  return next;
}

function normalizeLogoKind(value = '') {
  const raw = lower(value);
  if (raw === 'client' || raw === 'own' || raw === 'brand') return 'client';
  if (raw === 'partner' || raw === 'foreign' || raw === 'third-party' || raw === 'sponsor') return 'partner';
  if (raw === 'unknown') return 'unknown';
  return 'none';
}

function normalizeLogoFormat(value = '') {
  const raw = lower(value);
  if (raw === 'wordmark' || raw === 'logotype') return 'wordmark';
  if (raw === 'mark' || raw === 'icon-mark' || raw === 'symbol') return 'mark';
  if (raw === 'favicon' || raw === 'app-icon') return 'favicon';
  return 'none';
}

function normalizeBackground(value = '') {
  const raw = lower(value);
  if (raw === 'transparent' || raw === 'alpha') return 'transparent';
  if (raw === 'solid' || raw === 'flat') return 'solid';
  if (raw === 'photo' || raw === 'scene') return 'photo';
  return 'unknown';
}

function normalizeSubjectKind(value = '') {
  const raw = lower(value);
  if (raw === 'employee' || raw === 'staff' || raw === 'team') return 'employee';
  if (raw === 'customer' || raw === 'client' || raw === 'reviewer' || raw === 'testimonial') return 'customer';
  if (raw === 'product' || raw === 'offering' || raw === 'dish') return 'product';
  if (raw === 'place' || raw === 'location' || raw === 'venue') return 'place';
  if (raw === 'graphic' || raw === 'illustration') return 'graphic';
  return 'none';
}

function clamp01(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function asTextList(value) {
  const list = Array.isArray(value) ? value : String(value || '').split(/\n|·|\|/);
  const out = [];
  for (const item of list) {
    const text = compact(item).replace(/^["']|["']$/g, '');
    if (!text || text === 'none' || text === 'n/a' || text === '-') continue;
    if (!out.includes(text)) out.push(text.slice(0, 180));
    if (out.length >= 8) break;
  }
  return out;
}

export function normalizeSection(value = '') {
  const raw = lower(value).replace(/[\s_]+/g, '-');
  if (!raw) return '';
  if (MEDIA_SECTIONS.includes(raw)) return raw;
  if (['menu', 'product', 'products', 'services', 'rooms'].includes(raw)) return 'offerings';
  if (['staff', 'employees', 'people', 'portrait'].includes(raw)) return 'team';
  if (raw === 'story' || raw === 'history') return 'about';
  if (raw === 'how-we-work' || raw === 'steps') return 'process';
  if (['venue', 'exterior', 'interior', 'map'].includes(raw)) return 'location';
  if (raw === 'banner' || raw === 'cover') return 'hero';
  if (raw === 'icon' || raw === 'ui') return 'decoration';
  if (['award', 'review', 'certificate', 'quote'].includes(raw)) return 'testimonial';
  if (raw === 'brand' || raw === 'wordmark') return 'logo';
  return '';
}

function normalizeMedium(value = '', kind = 'image') {
  const raw = lower(value);
  if (['photo', 'illustration', 'logo', 'icon', 'video', 'audio', 'other'].includes(raw)) return raw;
  if (raw === 'image' || raw === 'picture' || raw === 'photograph') return 'photo';
  if (raw === 'vector' || raw === 'drawing') return 'illustration';
  if (kind === 'video') return 'video';
  if (kind === 'audio') return 'audio';
  return 'other';
}

function normalizeUsable(value = '') {
  const raw = lower(value);
  if (raw === 'use' || raw === 'good' || raw === 'publish') return 'use';
  if (raw === 'weak' || raw === 'maybe' || raw === 'fallback') return 'weak';
  if (raw === 'skip' || raw === 'unusable' || raw === 'reject') return 'skip';
  return 'weak';
}

function buildCardLine(transcript = {}, labelFor = sectionLabel) {
  const section = transcript.primarySection || 'gallery';
  if (transcript.logoKind === 'client') {
    const bits = [transcript.logoFormat !== 'none' ? transcript.logoFormat : '', transcript.aspectClass || '', transcript.background !== 'unknown' ? transcript.background : '', transcript.distinguishingDetail || '']
      .map((part) => compact(part))
      .filter(Boolean);
    return `Client logo — ${bits.join(', ') || compact(transcript.depicts).slice(0, 90) || 'brand mark'}`;
  }
  if (transcript.logoKind === 'partner') {
    return `Partner logo — ${compact(transcript.distinguishingDetail || transcript.depicts).slice(0, 90) || 'third-party mark'}`;
  }
  const detail = compact(transcript.distinguishingDetail || transcript.depicts).slice(0, 90);
  return detail ? `${labelFor(section)} — ${detail}` : labelFor(section);
}

function normalizeExtraFields(raw = {}, extraFields = {}) {
  const out = {};
  for (const [key, fallback] of Object.entries(extraFields || {})) {
    const value = raw[key];
    if (typeof fallback === 'boolean') out[key] = value === true || lower(value) === 'true';
    else if (typeof fallback === 'number') out[key] = Number.isFinite(Number(value)) ? Number(value) : fallback;
    else if (Array.isArray(fallback)) out[key] = asTextList(value);
    else out[key] = compact(value ?? fallback).slice(0, 320);
  }
  return out;
}

function extOf(fileName = '') {
  const match = /\.([a-z0-9]{2,5})$/i.exec(String(fileName || ''));
  return match ? `.${match[1].toLowerCase()}` : '';
}

export function normalizeMediaBrief(raw = {}, { fileName = '', kind = 'image', measured = null, fieldForSection = null, labelForSection = sectionLabel, extraFields = {}, businessName = null } = {}) {
  const fieldFor = typeof fieldForSection === 'function' ? fieldForSection : () => '';
  const depicts = compact(raw.depicts || raw.summary || '').slice(0, 500);
  const primarySection = normalizeSection(raw.primarySection || raw.section || '') || (kind === 'video' ? 'video' : kind === 'audio' ? 'audio' : '');
  const alternateSection = normalizeSection(raw.alternateSection || '');
  const peopleRaw = Number(raw.peopleCount);
  const peopleCount = Number.isFinite(peopleRaw) ? Math.max(-1, Math.min(40, Math.trunc(peopleRaw))) : 0;
  const section = primarySection || 'gallery';
  let subjectKind = normalizeSubjectKind(raw.subjectKind || '');
  if (subjectKind === 'none') {
    if (section === 'team') subjectKind = 'employee';
    else if (section === 'testimonial') subjectKind = 'customer';
    else if (section === 'offerings') subjectKind = 'product';
    else if (section === 'location') subjectKind = 'place';
    else if (section === 'illustration' || section === 'decoration') subjectKind = 'graphic';
  }
  let background = normalizeBackground(raw.background || '');
  if (background === 'unknown' && measured?.hasAlpha) background = 'transparent';
  const medium = normalizeMedium(raw.medium, kind);
  let logoKind = normalizeLogoKind(raw.logoKind);
  if (logoKind === 'none' && (medium === 'logo' || section === 'logo' || section === 'favicon')) logoKind = 'unknown';
  let logoFormat = normalizeLogoFormat(raw.logoFormat);
  if (logoFormat === 'none' && section === 'favicon') logoFormat = 'favicon';
  const aspectClass = String(measured?.aspectClass || raw.aspectClass || '');
  const hasAlternate = alternateSection && alternateSection !== section;
  let next = {
    ok: Boolean(depicts && section),
    depicts,
    visibleText: asTextList(raw.visibleText),
    peopleCount,
    facesVisible: Boolean(raw.facesVisible),
    setting: compact(raw.setting || '').slice(0, 120),
    medium,
    primarySection: section,
    primaryField: fieldFor(section),
    primaryWhy: compact(raw.primaryWhy || raw.why || '').slice(0, 420),
    alternateSection: hasAlternate ? alternateSection : '',
    alternateField: hasAlternate ? fieldFor(alternateSection) : '',
    alternateWhy: compact(raw.alternateWhy || '').slice(0, 320),
    doNotUseFor: compact(raw.doNotUseFor || '').slice(0, 320),
    distinguishingDetail: compact(raw.distinguishingDetail || '').slice(0, 180),
    usable: normalizeUsable(raw.usable),
    confidence: clamp01(raw.confidence),
    logoKind,
    logoFormat,
    background,
    subjectKind,
    aspectClass,
    width: Number(measured?.width || raw.width || 0) || 0,
    height: Number(measured?.height || raw.height || 0) || 0,
    fileName,
    kind,
    ...normalizeExtraFields(raw, extraFields),
  };
  // Foreign-brand check first: the shape rule below would otherwise lift a logo-looking price list into the logo slot.
  if (typeof businessName === 'string') next = demoteForeignBrandLogo(next, businessName, { fieldForSection: fieldFor });
  next = demoteSceneMarkedAsLogo(next, { fieldForSection: fieldFor });
  next = applyMeasuredLogoFormat(next, measured || { aspectClass, ext: extOf(fileName), maxSide: Math.max(next.width, next.height) }, { fieldForSection: fieldFor });
  next.primaryField = fieldFor(next.primarySection);
  next.cardLine = buildCardLine(next, labelForSection);
  return next;
}
