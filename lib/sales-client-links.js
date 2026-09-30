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
