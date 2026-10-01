// Client domain setup + help-request kinds (Kundedata → Bedrifts kort).

export const HOSTINGER_NAMESERVERS = ['ns1.dns-parking.com', 'ns2.dns-parking.com'];

export const DOMAIN_HELP_OWNED = 'domain-nameservers-owned';
export const DOMAIN_HELP_BUY = 'domain-nameservers-buy';

export const DOMAIN_HELP_LABELS = {
  [DOMAIN_HELP_OWNED]: 'Hjelp kunde sette opp navnservere på eid domene',
  [DOMAIN_HELP_BUY]: 'Hjelp kunde sette opp navnservere på ikke-eid domene',
};

const DOMAIN_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/i;

export function normalizeDomainInput(value = '') {
  let text = String(value || '').trim().toLowerCase();
  text = text.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '').split(':')[0].trim();
  return text;
}

export function isValidDomainName(value = '') {
  const domain = normalizeDomainInput(value);
  return DOMAIN_RE.test(domain) && domain.includes('.') && !domain.startsWith('.') && !domain.endsWith('.');
}

export function emptyDomainSetup() {
  return {
    domain: '',
    ownership: '',
    status: '',
    helpBuy: false,
    helpNameservers: false,
    nameserversConfirmed: false,
    requestKind: '',
    requestSentAt: '',
    updatedAt: '',
  };
}

export function normalizeDomainSetup(input = {}, fallback = {}) {
  const src = input && typeof input === 'object' ? input : {};
  const base = fallback && typeof fallback === 'object' ? fallback : emptyDomainSetup();
  const ownershipRaw = String(src.ownership || base.ownership || '').trim();
  const ownership = ownershipRaw === 'owned' || ownershipRaw === 'buy' ? ownershipRaw : '';
  const kindRaw = String(src.requestKind || base.requestKind || '').trim();
  const requestKind = kindRaw === DOMAIN_HELP_OWNED || kindRaw === DOMAIN_HELP_BUY ? kindRaw : '';
  return {
    domain: normalizeDomainInput(src.domain || base.domain || ''),
    ownership,
    status: String(src.status || base.status || '').trim(),
    helpBuy: Boolean(src.helpBuy ?? base.helpBuy),
    helpNameservers: Boolean(src.helpNameservers ?? base.helpNameservers),
    nameserversConfirmed: Boolean(src.nameserversConfirmed ?? base.nameserversConfirmed),
    requestKind,
    requestSentAt: String(src.requestSentAt || base.requestSentAt || '').trim(),
    updatedAt: String(src.updatedAt || base.updatedAt || '').trim(),
  };
}

export function domainHelpLabel(kind = '') {
  return DOMAIN_HELP_LABELS[String(kind || '').trim()] || '';
}

export function domainHelpMessage({ kind, domain, businessName = '' } = {}) {
  const label = domainHelpLabel(kind);
  const host = normalizeDomainInput(domain);
  const name = String(businessName || '').trim();
  const lines = [
    label || 'Domenehjelp',
    name ? `Bedrift: ${name}` : '',
    host ? `Domene: ${host}` : '',
    kind === DOMAIN_HELP_OWNED
      ? 'Kunden eier domenet og trenger hjelp med navnservere.'
      : 'Kunden må kjøpe domenet først og ba om hjelp.',
  ].filter(Boolean);
  return lines.join('\n');
}
