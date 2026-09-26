/**
 * Which sales-client fields must be filled before an offer (tilbud) + contract can be sent.
 * Used by the composer banner (frontend) and enforced on the send / request-review routes (server).
 */
import { resolveWebsiteEmail } from './sales-website-email.js';

const REQUIRED_FIELDS = [
  { key: 'businessName', label: 'Bedriftsnavn' },
  { key: 'orgNumber', label: 'Org. nr (9 siffer)' },
  { key: 'businessAddress', label: 'Adresse' },
  { key: 'contactPerson', label: 'Kontaktperson (innehaver)' },
  { key: 'contactEmail', label: 'E-post til kontaktperson' },
];

function text(value) {
  return String(value ?? '').trim();
}

function isEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text(value));
}

/** Address on the contract. The map/meeting address on the card is the one that counts; an older stored forretningsadresse is only a fallback. */
export function contractAddressFor(client = {}) {
  return text(client.meetingPlace) || text(client.businessAddress);
}

function digits(value) {
  return text(value).replace(/\D+/g, '');
}

/** Values shown on the client card, before any offer-page edits. */
export function clientCardParty(client = {}) {
  return {
    businessName: text(client.businessName),
    orgNumber: digits(client.orgNumber),
    address: contractAddressFor(client),
    contactPerson: text(client.contactPerson),
    contactEmail: text(client.contactEmail),
  };
}

/**
 * Contract identity for this offer. A non-empty offer.party field replaces the card,
 * except the recipient: Til is the website email from the client card (contact email
 * when that field was left as the contact address). An explicit `to` still wins for send.
 */
export function resolveOfferParty(client = {}, offer = {}, { to = '' } = {}) {
  const card = clientCardParty(client);
  const party = offer?.party && typeof offer.party === 'object' ? offer.party : {};
  const org = digits(party.orgNumber);
  return {
    businessName: text(party.businessName) || card.businessName,
    orgNumber: org || card.orgNumber,
    address: text(party.address) || card.address,
    contactPerson: text(party.contactPerson) || card.contactPerson,
    contactEmail: text(to) || resolveWebsiteEmail(client),
  };
}

/** Client view used for the contract PDF and the offer email merge. Does not write the card. */
export function clientWithOfferParty(client = {}, offer = {}, { to = '' } = {}) {
  const party = resolveOfferParty(client, offer, { to });
  return {
    ...client,
    businessName: party.businessName,
    orgNumber: party.orgNumber,
    businessAddress: party.address,
    meetingPlace: party.address,
    contactPerson: party.contactPerson,
    contactEmail: party.contactEmail,
  };
}

export function offerMissingFields(client = {}) {
  const missing = [];
  for (const field of REQUIRED_FIELDS) {
    let value = text(client[field.key]);
    if (field.key === 'businessAddress') value = contractAddressFor(client);
    if (field.key === 'orgNumber') value = value.replace(/\D+/g, '').length === 9 ? value : '';
    if (field.key === 'contactEmail') value = isEmail(value) ? value : '';
    if (!value) missing.push({ key: field.key, label: field.label });
  }
  return missing;
}

export function offerIsReady(client = {}) {
  return offerMissingFields(client).length === 0;
}

export function offerReadinessMessage(missing = []) {
  if (!missing.length) return '';
  return `Mangler: ${missing.map((item) => item.label).join(', ')}.`;
}

export { REQUIRED_FIELDS as OFFER_REQUIRED_FIELDS };
