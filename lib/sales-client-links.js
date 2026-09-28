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
    return {
      ...source,
      googleBusinessProfile: classifiedCurrent.url,
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
    kept.push(line);
  }
  if (!promoted) return source;
  return {
    ...source,
    googleBusinessProfile: promoted,
    otherLinks: kept.join('\n'),
  };
}

export function fillProffUrlFromOrgNumber(
  proffUrl = '',
  orgNumber = '',
  { shouldResolve = () => true, buildDirect = () => '' } = {}
) {
  const orgnr = sanitizeText(orgNumber).replace(/\D+/g, '');
  if (orgnr.length !== 9) return sanitizeText(proffUrl);
  const current = sanitizeText(proffUrl);
  if (current && !shouldResolve(current)) return current;
  return sanitizeText(buildDirect(orgnr)) || current;
}
