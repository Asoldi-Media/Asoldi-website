function sanitizeText(value = '') {
  return String(value ?? '').trim();
}

const SALES_LINK_FIELDS = [
  'instagramUrl',
  'facebookUrl',
  'proffUrl',
  'googleBusinessProfile',
  'otherLinks',
];

export function splitSalesLinkLines(value = '') {
  return String(value || '')
    .split(/\r?\n|,/)
    .map((entry) => sanitizeText(entry))
    .filter(Boolean);
}

export function preferNonEmptyLink(incoming = '', existing = '') {
  return sanitizeText(incoming) || sanitizeText(existing);
}

export function looksLikeEmailLink(value = '') {
  const raw = sanitizeText(value);
  if (!raw) return false;
  if (/^mailto:/i.test(raw)) return true;
  if (/^[^\s/@]+@[^\s@]+\.[^\s@]+$/i.test(raw)) return true;
  try {
    const withProtocol = /^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(raw) ? raw : `https://${raw}`;
    const parsed = new URL(withProtocol);
    if (parsed.protocol === 'mailto:') return true;
    const host = parsed.host.toLowerCase().replace(/^www\./, '');
    if (
      host === 'gmail.com'
      || host.endsWith('.gmail.com')
      || host.includes('mail.google.')
      || host.includes('outlook.')
      || host.includes('live.com') && parsed.pathname.toLowerCase().includes('mail')
    ) {
      return true;
    }
    if (parsed.username && !parsed.password && /^[^\s@]+$/.test(parsed.username) && /\.[a-z]{2,}$/i.test(parsed.hostname)) {
      return true;
    }
  } catch {
    return /[^\s/@]+@[^\s@]+\.[^\s@]+/.test(raw);
  }
  return /(?:mailto:|[?&]email=)[^\s/@]+@[^\s@]+\.[^\s@]+/i.test(raw);
}

export function looksLikeMapsOrGoogleBusinessLink(value = '') {
  const raw = sanitizeText(value).toLowerCase();
  if (!raw) return false;
  if (raw.includes('maps.google.') || raw.includes('maps.app.goo.gl') || raw.includes('g.page')) return true;
  if (raw.includes('goo.gl') && raw.includes('/maps')) return true;
  if (
    raw.includes('google.')
    && (
      raw.includes('/maps')
      || raw.includes('/business')
      || raw.includes('query_place_id')
      || raw.includes('place_id')
      || /[?&]cid=/.test(raw)
    )
  ) {
    return true;
  }
  return false;
}

function canonicalLinkKey(value = '') {
  return sanitizeText(value).replace(/\/+$/, '').toLowerCase();
}

/** https://host from the sales client card's website domain. Emails stay blank. */
export function websiteUrlFromDomain(value = '') {
  const raw = sanitizeText(value);
  if (!raw || looksLikeEmailLink(raw)) return '';
  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const parsed = new URL(withProtocol);
    if (parsed.username) return '';
    const host = String(parsed.hostname || '').toLowerCase().replace(/^www\./, '');
    if (!host || !host.includes('.') || host === 'localhost' || host.endsWith('.localhost')) return '';
    return `https://${host}`;
  } catch {
    return '';
  }
}

export function filterCustomOtherLinks(otherLinks = '', details = {}) {
  const reserved = new Set(
    [
      details.instagramUrl,
      details.facebookUrl,
      details.proffUrl,
      details.googleBusinessProfile,
    ]
      .map((entry) => canonicalLinkKey(entry))
      .filter(Boolean)
  );
  const kept = [];
  const seen = new Set();
  for (const line of splitSalesLinkLines(otherLinks)) {
    if (looksLikeEmailLink(line) || looksLikeMapsOrGoogleBusinessLink(line)) continue;
    const key = canonicalLinkKey(line);
    if (!key || reserved.has(key) || seen.has(key)) continue;
    seen.add(key);
    kept.push(line);
  }
  return kept.join('\n');
}

export function mergeKeptSalesDetailLinks(incoming = {}, existing = {}) {
  const next = incoming && typeof incoming === 'object' ? incoming : {};
  const current = existing && typeof existing === 'object' ? existing : {};
  const merged = {};
  for (const field of SALES_LINK_FIELDS) {
    merged[field] = preferNonEmptyLink(next[field], current[field]);
  }
  return merged;
}

export function promoteGoogleBusinessFromOtherLinks(details = {}, classify = () => ({ kind: 'other', url: '' })) {
  const source = details && typeof details === 'object' ? details : {};
  const current = sanitizeText(source.googleBusinessProfile);
  const classifiedCurrent = current ? classify(current) : { kind: 'other', url: '' };
  if (classifiedCurrent.kind === 'googleBusiness' && classifiedCurrent.url) {
    const next = {
      ...source,
      googleBusinessProfile: classifiedCurrent.url,
    };
    return {
      ...next,
      otherLinks: filterCustomOtherLinks(next.otherLinks, next),
    };
  }

  const lines = splitSalesLinkLines(source.otherLinks);
  let promoted = '';
  const kept = [];
  for (const line of lines) {
    const classified = classify(line) || {};
    if (!promoted && classified.kind === 'googleBusiness' && classified.url) {
      promoted = classified.url;
      continue;
    }
    if (classified.kind === 'googleBusiness' || looksLikeMapsOrGoogleBusinessLink(line) || looksLikeEmailLink(line)) {
      continue;
    }
    kept.push(line);
  }
  if (!promoted) {
    return {
      ...source,
      otherLinks: filterCustomOtherLinks(source.otherLinks, source),
    };
  }
  const next = {
    ...source,
    googleBusinessProfile: promoted,
    otherLinks: kept.join('\n'),
  };
  return {
    ...next,
    otherLinks: filterCustomOtherLinks(next.otherLinks, next),
  };
}

/** Norwegian org numbers use MOD11 with weights 3,2,7,6,5,4,3,2. Check digit 10 is invalid. */
export function isValidNorwegianOrgNumber(value = '') {
  const digits = sanitizeText(value).replace(/\D+/g, '');
  if (digits.length !== 9) return false;
  const weights = [3, 2, 7, 6, 5, 4, 3, 2];
  let sum = 0;
  for (let i = 0; i < 8; i += 1) sum += weights[i] * Number(digits[i]);
  const remainder = sum % 11;
  const check = remainder === 0 ? 0 : 11 - remainder;
  if (check === 10) return false;
  return check === Number(digits[8]);
}

function isOrgNumberFieldKey(key = '') {
  const k = sanitizeText(key).toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!k) return false;
  if (
    k === 'orgnr'
    || k === 'orgno'
    || k === 'orgn'
    || k === 'orgnummer'
    || k === 'orgnumber'
    || k === 'brreg'
    || k === 'brregnr'
    || k === 'brregnumber'
    || k === 'mvanr'
    || k === 'mvanummer'
    || k === 'vatnumber'
  ) {
    return true;
  }
  return (
    k.endsWith('orgnr')
    || k.endsWith('orgnummer')
    || k.includes('organisasjonsnummer')
    || k.includes('organisasjonsnr')
    || k.includes('organizationnumber')
    || k.includes('organisationnumber')
    || k.includes('foretaksnummer')
    || k.includes('foretaksnr')
    || k.includes('brregnummer')
  );
}

/**
 * Read a 9-digit Norwegian org number from free text.
 * Accepts 936585345, 936 585 345, 936.585.345, 936-585-345, and NO936585345.
 */
export function extractOrganizationNumberFromText(value = '', { requireChecksum = false } = {}) {
  const raw = String(value ?? '');
  if (!raw) return '';
  const accept = (digits) => {
    if (digits.length !== 9) return '';
    if (requireChecksum && !isValidNorwegianOrgNumber(digits)) return '';
    return digits;
  };
  const compact = raw.replace(/\D+/g, '');
  if (compact.length === 9) return accept(compact);
  for (const match of raw.matchAll(/(?<!\d)(\d{3}[\s.\-]*\d{3}[\s.\-]*\d{3})(?!\d)/g)) {
    const ok = accept(String(match[1] || '').replace(/\D+/g, ''));
    if (ok) return ok;
  }
  return '';
}

/** 9-digit org number from a proff.no path or ?q= / ?orgnr= query. Alphanumeric Proff ids are ignored. */
export function organizationNumberFromProffUrl(value = '') {
  const raw = sanitizeText(value);
  if (!raw) return '';
  let parsed;
  try {
    parsed = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return extractOrganizationNumberFromText(raw);
  }
  if (!parsed.host.toLowerCase().includes('proff.no')) return '';
  const segments = parsed.pathname.split('/').map((entry) => sanitizeText(entry)).filter(Boolean);
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    const digits = segments[i].replace(/\D+/g, '');
    if (digits.length === 9) return digits;
  }
  for (const key of ['q', 'orgnr', 'organisasjonsnummer', 'org']) {
    const digits = String(parsed.searchParams.get(key) || '').replace(/\D+/g, '');
    if (digits.length === 9) return digits;
  }
  return extractOrganizationNumberFromText(`${parsed.pathname} ${parsed.search}`);
}

export function buildDirectProffUrlFromOrgNumber(organizationNumber = '') {
  const orgnr = sanitizeText(organizationNumber).replace(/\D+/g, '');
  if (orgnr.length !== 9) return '';
  return `https://www.proff.no/selskap/x/x/x/${orgnr}`;
}

/**
 * MyPhoner stores org numbers under many labels, with dots/spaces/hyphens.
 * Named org fields are trusted as 9 digits; other fields must pass MOD11.
 */
export function extractOrganizationNumberFromLead(lead = {}, leadDataMap = new Map()) {
  const map = leadDataMap instanceof Map
    ? leadDataMap
    : new Map(
      Object.entries(leadDataMap && typeof leadDataMap === 'object' && !Array.isArray(leadDataMap) ? leadDataMap : {})
    );
  const named = [];
  const others = [];
  for (const [key, value] of map.entries()) {
    if (isOrgNumberFieldKey(key)) named.push(value);
    else others.push(value);
  }
  const source = lead && typeof lead === 'object' ? lead : {};
  named.push(
    source.organisasjonsnummer,
    source.organization_number,
    source.organizationNumber,
    source.orgnr,
    source.org_nr,
    source.orgNumber
  );
  for (const value of named) {
    const org = extractOrganizationNumberFromText(value);
    if (org) return org;
  }
  for (const value of others) {
    const org = extractOrganizationNumberFromText(value, { requireChecksum: true });
    if (org) return org;
  }
  for (const value of [source.primary_identifier, source.secondary_identifier, source.comment]) {
    const org = extractOrganizationNumberFromText(value, { requireChecksum: true });
    if (org) return org;
  }
  return '';
}

export function fillProffUrlFromOrgNumber(
  proffUrl = '',
  orgNumber = '',
  { shouldResolve, buildDirect = buildDirectProffUrlFromOrgNumber } = {}
) {
  const orgnr = sanitizeText(orgNumber).replace(/\D+/g, '');
  const current = sanitizeText(proffUrl);
  if (orgnr.length !== 9) return current;
  const existing = organizationNumberFromProffUrl(current);
  const force = typeof shouldResolve === 'function' ? Boolean(shouldResolve(current)) : false;
  // Rewrite unless this URL already carries the same 9-digit org number (search URLs can force a rewrite).
  if (current && existing === orgnr && !force) return current;
  return sanitizeText(typeof buildDirect === 'function' ? buildDirect(orgnr) : '') || current;
}
