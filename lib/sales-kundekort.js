/**
 * Sales Kundekort page 1, for the developer project document.
 * Read-only showcase. Later AI briefs read this plus meeting-booker audio
 * and the sales-meeting transcript; this file does not generate that text.
 */
import { splitSalesLinkLines, websiteUrlFromDomain } from './sales-client-links.js';

function text(value = '') {
  return String(value ?? '').trim();
}

function detailsOf(source = {}) {
  if (source.details && typeof source.details === 'object') return source.details;
  if (source.kundekort && typeof source.kundekort === 'object') return source.kundekort;
  return {};
}

export function persistClientBrief(raw = null) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const short = text(input.short).slice(0, 400);
  const full = text(input.full).slice(0, 8000);
  if (!short && !full) return null;
  return {
    short,
    full,
    generatedAt: text(input.generatedAt),
    source: text(input.source),
  };
}

export function salesKundekortView(source = {}) {
  const row = source && typeof source === 'object' ? source : {};
  const nested = row.kundekort && typeof row.kundekort === 'object' ? row.kundekort : null;
  const details = detailsOf(nested || row);
  const pick = (...keys) => {
    for (const key of keys) {
      if (row[key] != null && text(row[key])) return text(row[key]);
      if (nested && nested[key] != null && text(nested[key])) return text(nested[key]);
      if (details[key] != null && text(details[key])) return text(details[key]);
    }
    return '';
  };
  const product = text(row.product || nested?.product).toLowerCase() === 'ssu' ? 'ssu' : 'asoldi';
  const otherLinks = splitSalesLinkLines(pick('otherLinks'));
  return {
    product,
    productLabel: product === 'ssu' ? 'SSU' : 'Nettside',
    businessName: pick('businessName'),
    contactPerson: pick('contactPerson'),
    contactEmail: pick('contactEmail'),
    websiteEmail: pick('websiteEmail'),
    contactPhone: pick('contactPhone'),
    industry: pick('industry'),
    websiteDomain: pick('websiteDomain'),
    orgNumber: pick('orgNumber'),
    meetingPlace: pick('meetingPlace'),
    businessAddress: pick('businessAddress'),
    instagramUrl: pick('instagramUrl'),
    facebookUrl: pick('facebookUrl'),
    proffUrl: pick('proffUrl'),
    googleBusinessProfile: pick('googleBusinessProfile'),
    otherLinks,
    notes: pick('notes'),
  };
}

export function clientIdentityBrief(source = {}) {
  const stored = persistClientBrief(source?.clientBrief || source?.kundekort?.clientBrief);
  return {
    short: stored?.short || '',
    full: stored?.full || '',
    generatedAt: stored?.generatedAt || '',
    source: stored?.source || '',
    ready: Boolean(stored?.short || stored?.full),
  };
}

/** Card chip next to domain / workshop. Industry stands in until the short brief exists. */
export function compactClientIdentityLine(source = {}) {
  const brief = clientIdentityBrief(source);
  if (brief.short) return brief.short;
  return salesKundekortView(source).industry;
}

export function kundekortHref(value = '', kind = 'url') {
  const raw = text(value);
  if (!raw) return '';
  if (kind === 'email') return raw.includes('@') ? `mailto:${raw}` : '';
  if (kind === 'phone') return `tel:${raw.replace(/[^\d+]/g, '')}`;
  if (kind === 'domain') return websiteUrlFromDomain(raw);
  if (/^https?:\/\//i.test(raw)) return raw;
  if (/^mailto:/i.test(raw) || /@/.test(raw)) return raw.startsWith('mailto:') ? raw : `mailto:${raw}`;
  if (/^www\./i.test(raw) || raw.includes('.')) return websiteUrlFromDomain(raw);
  return '';
}
