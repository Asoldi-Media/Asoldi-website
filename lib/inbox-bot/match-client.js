import { inboxBotStage } from './stage.js';

export function parseEmailAddress(value = '') {
  const raw = String(value || '').trim().toLowerCase();
  const angled = raw.match(/<([^>]+)>/);
  const email = (angled ? angled[1] : raw).replace(/^mailto:/, '').trim();
  return /@/.test(email) ? email : '';
}

export function digitsOnly(value = '') {
  return String(value || '').replace(/\D+/g, '');
}

function nameKey(value = '') {
  return String(value || '').toLowerCase().replace(/[^a-z0-9æøåäöü]+/gi, ' ').replace(/\s+/g, ' ').trim();
}

export function matchSalesClient(clients = [], { from = '', match = {} } = {}) {
  const list = Array.isArray(clients) ? clients : [];
  const fromEmail = parseEmailAddress(from);
  const org = digitsOnly(match.orgNumber).slice(0, 9);
  const business = nameKey(match.businessName);
  const hintEmail = parseEmailAddress(match.email);

  const emailsOf = (client) => [client.clientEmail, client.contactEmail, client.websiteEmail]
    .map((entry) => parseEmailAddress(entry))
    .filter(Boolean);
  // Only the sender's own address counts as the client writing; an address found in the body is a hint.
  const emailHits = fromEmail ? list.filter((client) => emailsOf(client).includes(fromEmail)) : [];
  if (new Set(emailHits.map((client) => client.id)).size > 1) {
    // One address on two cards: the bot never guesses which card; a person sees it on the later-stage card.
    return { client: emailHits.find((client) => inboxBotStage(client) !== 'meeting') || emailHits[0], via: 'ambiguous' };
  }
  if (emailHits[0]) return { client: emailHits[0], via: 'email' };
  const hintHit = hintEmail ? list.find((client) => emailsOf(client).includes(hintEmail)) : null;
  if (hintHit) return { client: hintHit, via: 'hint' };

  if (org.length === 9) {
    const orgHit = list.find((client) => digitsOnly(client.orgNumber) === org);
    if (orgHit) return { client: orgHit, via: 'org' };
  }

  if (business.length > 3) {
    const nameHit = list.find((client) => {
      const name = nameKey(client.businessName);
      return name && (name.includes(business) || business.includes(name));
    });
    if (nameHit) return { client: nameHit, via: 'name' };
  }

  return { client: null, via: '' };
}
