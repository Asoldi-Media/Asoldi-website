/**
 * Offer (tilbud) email: the Norwegian template from "Produkt tilbud email template - asoldi.pdf"
 * rendered inside the branded Asoldi sales shell.
 *
 * Structure (marker attributes let sales / admin / AI replace parts without touching the rest):
 *   data-offer-slot="intro"     short "takk for samtalen om ..." sentence
 *   data-offer-slot="project"   three paragraphs about what the project covers
 *   data-offer-slot="terms"     client terms, placed before "Hva er inkludert"
 *   #offer-products … #offer-products-end   "Hva er inkludert" product blocks + totals
 *   data-offer-slot="delivery"  delivery time
 *   data-offer-slot="benefits"  what they achieve / where it is built / why
 *
 * This module is imported by both the server (Node) and the browser (composer / admin review),
 * so it must stay free of Node-only APIs.
 */

import { CUSTOM_TIER_ID, MVA_RATE, formatKr, tierById, tierOfferProduct } from './website-tiers.js';
import { offerDeliveryPhraseNb } from './website-due.js';

const ORANGE = '#FF5B00';
const TEXT = '#1a1a1a';
const MUTED = '#5b5b5b';
const DEFAULT_DELIVERY_WEEKS = 4;

export const OFFER_TEMPLATE_KEY = 'offer';

function text(value = '') {
  return String(value ?? '').trim();
}

export function escapeHtml(value = '') {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function p(content, extra = '') {
  return `<p style="margin:0 0 14px;${extra}">${content}</p>`;
}

function h2(content) {
  return `<h2 style="margin:22px 0 10px;font-size:18px;line-height:1.3;font-weight:bold;color:${TEXT};">${content}</h2>`;
}

/**
 * Template placeholder the rep/AI must replace before sending. The data attribute lets the server find
 * leftovers even after the visual editor has reshuffled the inline style.
 */
function placeholder(label) {
  return `<span data-offer-placeholder="1" style="background:#fff3ea;color:#b34300;border-radius:4px;padding:0 4px;">[${escapeHtml(label)}]</span>`;
}

/* ------------------------------------------------------------------ totals */

/**
 * Price maths for the product list.
 *
 * `mvaIncluded` = the rep chose to absorb the VAT: the listed product price is then what the client pays
 * per month *including* 25 % MVA, so the ex-MVA share is price / 1.25. Default (false) adds 25 % on top.
 */
export function offerTotals(products = [], { mvaIncluded = false } = {}) {
  const list = Array.isArray(products) ? products : [];
  const listed = list.reduce((sum, item) => sum + (Number(item?.priceExMva) || 0), 0);
  const deliveryWeeks = list.reduce((max, item) => Math.max(max, Number(item?.deliveryWeeks) || 0), 0) || DEFAULT_DELIVERY_WEEKS;
  if (mvaIncluded) {
    const inclMva = listed;
    const exMva = Math.round(inclMva / (1 + MVA_RATE));
    return { exMva, mva: inclMva - exMva, inclMva, deliveryWeeks, count: list.length, mvaIncluded: true, listed };
  }
  const exMva = listed;
  const mva = Math.round(exMva * MVA_RATE);
  return { exMva, mva, inclMva: exMva + mva, deliveryWeeks, count: list.length, mvaIncluded: false, listed };
}

/** Per-product price with the right VAT label for the offer's MVA mode. */
export function productPriceLabel(product = {}, { mvaIncluded = false, billing = 'month' } = {}) {
  const price = Number(product?.priceExMva) || 0;
  const vat = mvaIncluded ? 'inkl. mva' : 'eks. mva';
  return `${formatKr(price)} ${vat} ${billing === 'once' ? 'engang' : 'per måned'}`;
}

export const WORKSHOP_LATER = 'Vi avtaler startdato for workshop senere.';

/** Direct workshop date from the notes page. Empty date means we agree later, unless the transcript fills it. */
export function workshopStartSentence(date = '') {
  const value = text(date);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return `Startdato for workshop: ${WORKSHOP_LATER}`;
  const [year, month, day] = value.split('-').map((part) => Number(part));
  const formatted = new Date(Date.UTC(year, month - 1, day)).toLocaleDateString('nb-NO', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
  return `Startdato for workshop: ${formatted}.`;
}

/* ---------------------------------------------------------- product blocks */

export function renderOfferProductHtml(product = {}, options = {}) {
  const name = text(product.name) || 'Produkt';
  const pages = Number(product.pages) || 0;
  const includes = Array.isArray(product.includes) ? product.includes.map(text).filter(Boolean) : [];
  const note = text(product.note);
  const items = [
    pages > 0 ? `<li style="margin:0 0 4px;">Opp til ${pages} sider</li>` : '',
    ...includes.map((line) => `<li style="margin:0 0 4px;">${escapeHtml(line)}</li>`),
  ].filter(Boolean).join('');
  return `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" data-offer-product="1" data-product-id="${escapeHtml(text(product.id))}" data-tier-id="${escapeHtml(text(product.tierId))}" style="width:100%;margin:0 0 14px;border:1px solid #ececec;border-radius:10px;">
  <tr>
    <td style="padding:14px 16px;font-size:15px;line-height:1.6;color:${TEXT};">
      <p style="margin:0 0 6px;font-size:16px;font-weight:bold;">${escapeHtml(name)}</p>
      <p style="margin:0 0 4px;">Inkluderer:</p>
      <ul style="margin:0 0 10px;padding-left:20px;">${items || '<li style="margin:0 0 4px;">Etter avtale</li>'}</ul>
      ${note ? `<p style="margin:0 0 10px;color:${MUTED};"><em>Notat:</em> ${escapeHtml(note)}</p>` : ''}
      <p style="margin:0;font-weight:bold;">Pris: ${escapeHtml(productPriceLabel(product, options))}</p>
    </td>
  </tr>
</table>`;
}

export function renderOfferTotalsHtml(products = [], options = {}) {
  const totals = offerTotals(products, options);
  const once = options.billing === 'once';
  const unit = once ? 'engang' : 'per måned';
  const fees = (Array.isArray(options.oneTimeFees) ? options.oneTimeFees : [])
    .filter((fee) => text(fee?.name) && Number(fee?.price) > 0);
  const feeHtml = fees.map((fee) => (
    `<p style="margin:0 0 4px;">${escapeHtml(text(fee.name))}: <strong>${escapeHtml(formatKr(fee.price))}</strong> eks. mva engang</p>`
  )).join('');
  const breakdown = totals.mvaIncluded
    ? `<p style="margin:0 0 4px;">Pris inkl. mva: <strong>${escapeHtml(formatKr(totals.inclMva))}</strong> ${unit}</p>
      <p style="margin:0 0 4px;">Herav MVA (25 %): ${escapeHtml(formatKr(totals.mva))} · eks. mva: ${escapeHtml(formatKr(totals.exMva))}</p>`
    : `<p style="margin:0 0 4px;">Pris eks. mva: <strong>${escapeHtml(formatKr(totals.exMva))}</strong> ${unit}</p>
      <p style="margin:0 0 4px;">MVA (25 %): ${escapeHtml(formatKr(totals.mva))}</p>`;
  const closing = once
    ? 'Engangsbetaling. Beløpet over betales én gang for oppsettet som er avtalt.'
    : 'Løpende månedlig tjeneste – nettside, hosting og vedlikehold faktureres månedlig så lenge avtalen løper.';
  return `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" data-offer-totals="1" data-billing="${once ? 'once' : 'month'}" data-mva-included="${totals.mvaIncluded ? '1' : '0'}" style="width:100%;margin:4px 0 6px;background:#fff7f2;border-radius:10px;">
  <tr>
    <td style="padding:14px 16px;font-size:15px;line-height:1.6;color:${TEXT};">
      ${breakdown}
      ${feeHtml}
      <p style="margin:0 0 8px;font-size:17px;font-weight:bold;color:${ORANGE};">Totalt: ${escapeHtml(formatKr(totals.inclMva))} inkl. mva ${unit}</p>
      <p style="margin:0;font-size:13px;color:${MUTED};">${closing}</p>
    </td>
  </tr>
</table>`;
}

export function renderOfferProductsSection(products = [], options = {}) {
  const list = Array.isArray(products) ? products : [];
  if (!list.length) {
    return `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" data-offer-empty="1" style="width:100%;margin:0 0 14px;border:1px dashed #d9d9d9;border-radius:10px;">
  <tr>
    <td style="padding:14px 16px;font-size:15px;line-height:1.6;color:${MUTED};">
      ${placeholder('Velg nettside tier for å fylle inn pakke, innhold og pris')}
    </td>
  </tr>
</table>`;
  }
  return `${list.map((item) => renderOfferProductHtml(item, options)).join('')}${renderOfferTotalsHtml(list, options)}`;
}

// Attribute order may change after a round-trip through the visual editor, so match ids anywhere in the tag.
const PRODUCTS_RE = /(<div\b[^>]*\bid="offer-products"[^>]*>)[\s\S]*?(<div\b[^>]*\bid="offer-products-end"[^>]*>\s*<\/div>)/i;

/** Swap the whole "Hva er inkludert" block. Works on the raw HTML so it can run in Node or the browser. */
export function replaceOfferProducts(html = '', products = [], options = {}) {
  const section = renderOfferProductsSection(products, options);
  const source = String(html || '');
  if (PRODUCTS_RE.test(source)) {
    return source.replace(PRODUCTS_RE, (_match, open, close) => `${open}${section}${close}`);
  }
  // Markers were removed in the editor: re-insert before "Hva som skjer fremover", else append.
  const block = `${h2('Hva er inkludert')}<div id="offer-products">${section}<div id="offer-products-end"></div></div>`;
  const anchor = source.search(/<h2[^>]*>\s*Hva som skjer fremover/i);
  if (anchor >= 0) return `${source.slice(0, anchor)}${block}${source.slice(anchor)}`;
  return `${source}${block}`;
}

/* ------------------------------------------------------- template hygiene */

// Envelope illustration + centered heading from the confirmation shell (any attribute order).
const ENVELOPE_IMG_RE = /<img\b(?=[^>]*\bwidth="160")(?=[^>]*\balt="")[^>]*>/gi;
const CENTERED_TITLE_TD_RE = /(<td\b[^>]*style="[^"]*)text-align:center;([^"]*"[^>]*>\s*<h1\b[^>]*>\s*Tilbud fra Asoldi\s*<\/h1>)/i;

/**
 * Bring an already-stored offer draft up to the current shell: no envelope icon, heading left-aligned.
 * Idempotent, so it is safe to run on every read of a non-sent offer.
 */
export function unboldOfferTermsLabel(html = '') {
  return String(html || '')
    .replace(/<strong>\s*Kundebetingelser:\s*<\/strong>\s*/gi, '')
    .replace(/\bKundebetingelser:\s*/gi, '');
}

const FORWARD_H2_RE = /<h2\b[^>]*>\s*Hva som skjer fremover\s*<\/h2>/i;
const SER_FREM_RE = /<p\b[^>]*>\s*Ser frem til å høre fra dere!/i;
const TERMS_BLOCK_RE = /<(div|p)\b[^>]*\bdata-offer-slot="terms"[^>]*>[\s\S]*?<\/\1>\s*/i;

/** Drop the extra CMS paragraph. Where the site is built belongs in the one benefits section. */
export function ensurePlatformParagraph(html = '') {
  return String(html || '')
    .replace(/<p\b[^>]*data-offer-fixed="platform"[\s\S]*?<\/p>\s*/gi, '')
    .replace(/<p\b[^>]*>\s*Nettsiden bygges i vårt eget CMS[\s\S]*?<\/p>\s*/gi, '');
}

function stripRetiredOfferParagraphs(html = '') {
  return String(html || '')
    .replace(/<p\b[^>]*>\s*Vi tar en workshop der vi går gjennom dette[\s\S]*?<\/p>\s*/gi, '')
    .replace(/<p\b[^>]*>\s*Vedlagt ligger kontrakten[\s\S]*?<\/p>\s*/gi, '')
    .replace(/Vedlagt ligger kontrakten[^<]*?levert\.\s*/gi, '')
    .replace(/<p\b[^>]*>\s*Etter at dere har sett på tilbudet og vi har mottatt svar[\s\S]*?<\/p>\s*/gi, '');
}

/** The fixed next-steps paragraph sits under the heading. Existing drafts get it back on read. */
export function ensureForwardSection(html = '') {
  const paragraph = `<p data-offer-fixed="next" style="margin:0 0 14px;">${OFFER_NEXT}</p>`;
  let source = String(html || '').replace(/<p\b[^>]*data-offer-fixed="next"[\s\S]*?<\/p>\s*/gi, '');
  const hasSentence = source.includes(OFFER_NEXT);
  const heading = source.match(FORWARD_H2_RE);
  if (heading) {
    const after = heading.index + heading[0].length;
    const nearby = source.slice(after, after + 700);
    if (!nearby.includes(OFFER_NEXT)) {
      source = `${source.slice(0, after)}${paragraph}${source.slice(after)}`;
    }
  } else if (!hasSentence) {
    const ser = source.search(SER_FREM_RE);
    const block = `${h2('Hva som skjer fremover')}${paragraph}`;
    source = ser >= 0 ? `${source.slice(0, ser)}${block}${source.slice(ser)}` : `${source}${block}`;
  }
  if (!SER_FREM_RE.test(source)) {
    const line = `<p style="margin:0 0 6px;">Ser frem til å høre fra dere!</p>`;
    const sign = source.search(/Med vennlig hilsen/i);
    source = sign >= 0 ? `${source.slice(0, sign)}${line}${source.slice(sign)}` : `${source}${line}`;
  }
  return source;
}

/** Kundebetingelser come after the project text and before "Hva er inkludert". */
export function moveOfferTermsBeforeProducts(html = '') {
  const source = String(html || '');
  const match = source.match(TERMS_BLOCK_RE);
  if (!match) return source;
  const h2At = source.search(/<h2\b[^>]*>\s*Hva er inkludert/i);
  const blockAt = source.search(TERMS_BLOCK_RE);
  if (h2At < 0 || blockAt < h2At) return source;
  const without = source.replace(TERMS_BLOCK_RE, '');
  const anchor = without.search(/<h2\b[^>]*>\s*Hva er inkludert/i);
  if (anchor < 0) return source;
  return `${without.slice(0, anchor)}${match[0]}${without.slice(anchor)}`;
}

function updateOfferIntro(html = '') {
  return String(html || '').replace(
    /(<span\b[^>]*data-offer-slot="need"[^>]*>[\s\S]*?<\/span>)\s*\.\s*Her er tilbudet, med hva som er inkludert og hva det vil koste\./i,
    `$1${OFFER_INTRO_AFTER_NEED}`
  );
}

export function refreshOfferShell(html = '') {
  const shell = unboldOfferTermsLabel(String(html || '')
    .replace(ENVELOPE_IMG_RE, '')
    .replace(CENTERED_TITLE_TD_RE, (_match, open, rest) => `${open}text-align:left;${rest}`));
  return ensureForwardSection(
    moveOfferTermsBeforeProducts(
      updateOfferIntro(stripRetiredOfferParagraphs(ensurePlatformParagraph(shell)))
    )
  );
}

const OFFER_IDENTITY_TOKENS = new Set(['firstName', 'fullName', 'businessName', 'signerName', 'signerEmail', 'signerPhone']);

/** Replace only the client and sales-rep tokens. Other tokens, including {{need}}, stay for later. */
export function resolveOfferIdentityTags(template = '', values = {}, { escape = true } = {}) {
  return String(template || '').replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (match, key) => {
    if (!OFFER_IDENTITY_TOKENS.has(key)) return match;
    const raw = values?.[key];
    if (raw == null || String(raw).trim() === '') return match;
    return escape ? escapeHtml(String(raw)) : String(raw);
  });
}

const PLACEHOLDER_TAG_RE = /<span\b[^>]*data-offer-placeholder="1"[^>]*>([\s\S]*?)<\/span>/gi;
const LEGACY_PLACEHOLDER_RE = /<span\b(?=[^>]*background:\s*#fff3ea)[^>]*>\s*\[([\s\S]*?)\]\s*<\/span>/gi;

function decodeEntities(value = '') {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, ' ');
}

/** Template placeholders still present in the email — these must be filled or deleted before sending. */
export function findOfferPlaceholders(html = '') {
  const source = String(html || '');
  const found = [];
  const seen = new Set();
  for (const re of [PLACEHOLDER_TAG_RE, LEGACY_PLACEHOLDER_RE]) {
    re.lastIndex = 0;
    let match;
    while ((match = re.exec(source))) {
      const label = decodeEntities(match[1].replace(/<[^>]+>/g, '')).replace(/^\s*\[|\]\s*$/g, '').trim();
      if (!label || seen.has(label)) continue;
      seen.add(label);
      found.push(label);
    }
  }
  return found;
}

export function replaceOfferSlot(html = '', slot = '', innerHtml = '') {
  const name = text(slot);
  if (!name) return String(html || '');
  const re = new RegExp(`(<(span|div|p)\\b[^>]*\\bdata-offer-slot="${name}"[^>]*>)[\\s\\S]*?(<\\/\\2>)`, 'i');
  const source = String(html || '');
  if (!re.test(source)) return source;
  return source.replace(re, (_match, open, _tag, close) => `${open}${innerHtml}${close}`);
}

export function replaceOfferDelivery(html = '', products = [], { tierId = '', dueDate = '' } = {}) {
  return replaceOfferSlot(html, 'delivery', escapeHtml(offerDeliveryPhraseNb({ products, tierId, dueDate })));
}

/** Tier selection from the composer: one tier product replaces any previous tier product, custom products stay. */
export function productsWithTier(products = [], tierId = '') {
  const list = Array.isArray(products) ? products.filter((item) => item?.kind !== 'tier') : [];
  if (!tierId || tierId === CUSTOM_TIER_ID) return list;
  const tier = tierById(tierId);
  if (!tier) return list;
  return [{ ...tierOfferProduct(tier), id: `prod-${tier.id}` }, ...list];
}

export function applyOfferProducts(html = '', products = [], options = {}) {
  return replaceOfferDelivery(replaceOfferProducts(html, products, options), products, options);
}

/* ------------------------------------------------------------ AI slot fill */

function paragraphs(list = []) {
  return (Array.isArray(list) ? list : [list]).map(text).filter(Boolean).map((line) => p(escapeHtml(line))).join('');
}

/**
 * Fill the nuance slots (from Fireflies + DeepSeek or from a human). Only slots with content are touched.
 * `need` is the short "[veldig kort om prosjekt / behov]" phrase in the intro sentence.
 */
function slotInner(html = '', slot = '') {
  const re = new RegExp(`<(span|div|p)\\b[^>]*\\bdata-offer-slot="${slot}"[^>]*>([\\s\\S]*?)<\\/\\1>`, 'i');
  const match = String(html || '').match(re);
  return match ? match[2] : '';
}

/** A slot still has the template blank, so meeting copy may be written there. */
export function offerSlotIsOpen(html = '', slot = '') {
  const inner = slotInner(html, slot);
  if (!inner) return false;
  if (/\{\{need\}\}/.test(inner)) return true;
  return /data-offer-placeholder\s*=\s*"1"/.test(inner);
}

export function fillOfferSlots(html = '', { need = '', project = [], terms = '', benefits = '', workshop = '' } = {}, { onlyOpen = false } = {}) {
  let next = String(html || '');
  const open = (slot) => !onlyOpen || offerSlotIsOpen(next, slot);
  if (text(need) && open('need')) next = replaceOfferSlot(next, 'need', escapeHtml(text(need)));
  if ((Array.isArray(project) ? project.some(text) : text(project)) && open('project')) {
    next = replaceOfferSlot(next, 'project', paragraphs(project));
  }
  if (text(terms) && open('terms')) {
    next = replaceOfferSlot(next, 'terms', p(escapeHtml(text(terms))));
  }
  if (text(benefits) && open('benefits')) next = replaceOfferSlot(next, 'benefits', paragraphs(benefits));
  if (text(workshop)) {
    const current = slotInner(next, 'workshop');
    const keepEdited = onlyOpen && current && !current.includes(WORKSHOP_LATER);
    if (!keepEdited) next = ensureWorkshopSentence(next, text(workshop));
  }
  return next;
}

/** Puts the workshop start sentence just before "Hva som skjer fremover". A date from the notes page always wins. */
export function ensureWorkshopSentence(html = '', sentence = '') {
  const line = text(sentence) || workshopStartSentence('');
  const paragraph = `<p data-offer-slot="workshop" style="margin:0 0 14px;">${escapeHtml(line)}</p>`;
  const source = String(html || '').replace(/<p\b[^>]*data-offer-slot="workshop"[\s\S]*?<\/p>\s*/gi, '');
  const heading = source.match(FORWARD_H2_RE);
  if (heading && heading.index != null) {
    return `${source.slice(0, heading.index)}${paragraph}${source.slice(heading.index)}`;
  }
  return `${source}${paragraph}`;
}

/* -------------------------------------------------------------- template */

function offerSignerHtml({ mergeTags = true, sender = {} } = {}) {
  const name = mergeTags ? '{{signerName}}' : escapeHtml(text(sender.name) || String(text(sender.fullName) || '').split(/\s+/)[0] || 'Damian');
  const email = mergeTags ? '{{signerEmail}}' : escapeHtml(text(sender.fromEmail) || 'damian@asoldi.com');
  // The rep's own number comes from their user profile (admin → Users → Telefon) via {{signerPhone}}.
  const phone = mergeTags ? '{{signerPhone}}' : escapeHtml(text(sender.phone) || '+47 48 33 91 91');
  return `
    <p style="margin:0 0 8px;">Med vennlig hilsen<br/><strong>${name} fra Asoldi</strong></p>
    <p style="margin:0 0 10px;color:${MUTED};">P.S: Har du spørsmål om våre priser, referanser eller tjenester kan du sjekke nettsiden vår på <a href="https://asoldi.com" target="_blank" style="color:${ORANGE};text-decoration:underline;">asoldi.com</a>.</p>
    <p style="margin:0;color:${MUTED};font-size:13px;">Kontor: Østre berg 10, Trondheim<br/>${phone} &nbsp;|&nbsp; <a href="mailto:${mergeTags ? '{{signerEmail}}' : email}" style="color:${TEXT};text-decoration:none;">${email}</a> &nbsp;|&nbsp; asoldi.com</p>`;
}

const OFFER_INTRO_BEFORE_NEED = 'Takk for samtalen om ';
const OFFER_INTRO_AFTER_NEED = ' – veldig fint å høre mer om hva dere ønsker å få til her. Basert på det vi diskuterte har jeg satt sammen et tilbud under, med en oversikt over hva som er inkludert og hva det vil koste.';
const OFFER_NEXT = 'Etter at dere har sett på tilbudet og signert kontrakten som er vedlagt vil vi avtale oppstarts tid, ha en workshop og gi deg tilgang til våre terminaler så du kan holde deg oppdatert på fremgangen i prosjektet. Ta gjerne kontakt om dere har spørsmål til tilbudet, eller ønsker å justere noe underveis – jeg hjelper gjerne til.';

/** The letter the customer already sees, with {{slots}} for the only parts the model may write. */
export function offerLetterAlreadyWritten() {
  return [
    'Hei {{firstName}},',
    `${OFFER_INTRO_BEFORE_NEED}{{need}}${OFFER_INTRO_AFTER_NEED}`,
    '{{project}}',
    '{{terms}}',
    'Hva er inkludert',
    '{{produktblokk med pakke, innhold og pris}}',
    'Leveringsdato: {{delivery}}',
    '{{benefits}}',
    'Startdato for workshop: {{workshop}}',
    'Hva som skjer fremover',
    OFFER_NEXT,
    'Ser frem til å høre fra dere!',
  ].join('\n');
}
export function buildOfferBodyHtml({ products = [], nuances = {}, mvaIncluded = false, billing = 'month', oneTimeFees = [], tierId = '', dueDate = '' } = {}) {
  const totals = offerTotals(products, { mvaIncluded });
  const productOptions = { mvaIncluded, billing, oneTimeFees };
  const projectHtml = paragraphs(nuances.project) || [
    p(placeholder('Hva prosjektet omfatter, og hva som ble snakket om')),
    p(placeholder('Mer om innholdet og hvem siden er for')),
    p(placeholder('Hvordan vi går videre med det dere beskrev')),
  ].join('');
  const termsHtml = text(nuances.terms)
    ? p(escapeHtml(text(nuances.terms)))
    : p(placeholder('Hva dere sender inn, og hvor mye dere vil være med underveis'));
  const benefitsHtml = paragraphs(nuances.benefits)
    || p(placeholder('Hva dere vil oppnå, hvor siden bygges, og hvorfor'));
  const need = text(nuances.need) ? escapeHtml(text(nuances.need)) : '{{need}}';
  const workshop = escapeHtml(text(nuances.workshop) || workshopStartSentence(''));

  return `
    <p style="margin:0 0 14px;">Hei {{firstName}},</p>
    <p data-offer-slot="intro" style="margin:0 0 14px;">${OFFER_INTRO_BEFORE_NEED}<span data-offer-slot="need">${need}</span>${OFFER_INTRO_AFTER_NEED}</p>
    <div data-offer-slot="project">${projectHtml}</div>
    <div data-offer-slot="terms">${termsHtml}</div>
    ${h2('Hva er inkludert')}
    <div id="offer-products">${renderOfferProductsSection(products, productOptions)}<div id="offer-products-end"></div></div>
    <p style="margin:0 0 14px;"><strong>Leveringsdato:</strong> <span data-offer-slot="delivery">${escapeHtml(offerDeliveryPhraseNb({ products, tierId, dueDate }))}</span></p>
    <div data-offer-slot="benefits">${benefitsHtml}</div>
    <p data-offer-slot="workshop" style="margin:0 0 14px;">${workshop}</p>
    ${h2('Hva som skjer fremover')}
    <p data-offer-fixed="next" style="margin:0 0 14px;">${OFFER_NEXT}</p>
    <p style="margin:0 0 6px;">Ser frem til å høre fra dere!</p>`;
}

export function offerSubject({ mergeTags = true, businessName = '' } = {}) {
  return `Tilbud til ${mergeTags ? '{{businessName}}' : text(businessName) || 'dere'} fra Asoldi`;
}

export const OFFER_PREHEADER = 'Her er tilbudet vi snakket om – hva som er inkludert, pris og veien videre.';

/** `full` is the transcript-filled letter. `contract` is the in-meeting send: short note + contract, no transcript slots. */
export function offerSendContentMode(value = '') {
  return text(value).toLowerCase() === 'contract' ? 'contract' : 'full';
}

/**
 * Cover copy for a contract sent while the meeting is still going.
 * `attached` is the e-mail (PDF). The portal page says the agreement is below, not attached.
 */
export function buildContractOnlyBodyHtml({ attached = true } = {}) {
  const lead = attached
    ? 'Som avtalt i møtet er kontrakten vedlagt. Den dekker pakke, pris og vilkår.'
    : 'Som avtalt i møtet ligger avtalen under. Den dekker pakke, pris og vilkår.';
  const portal = attached
    ? p('Den samme avtalen ligger på asoldi.com under Tilbud, der den kan aksepteres.')
    : '';
  return `
    <p style="margin:0 0 14px;">Hei {{firstName}},</p>
    ${p(lead)}
    ${portal}
    <p style="margin:0 0 6px;">Si ifra med en gang om noe skal justeres.</p>`;
}

export function buildContractOnlyEmail({ client = {}, sender = {}, attached = true, mergeTags = true, layout, layoutOptions = {} } = {}) {
  const preheader = attached
    ? 'Kontrakten fra møtet er vedlagt.'
    : 'Kontrakten fra møtet ligger klar.';
  const view = {
    preheader,
    title: 'Kontrakt fra Asoldi',
    mobileTitle: 'Kontrakt fra Asoldi',
    titleAlign: 'left',
    hideIllustration: true,
    bodyHtml: buildContractOnlyBodyHtml({ attached }),
    agendaHtml: '',
    closingHtml: '',
    ctaLabel: '',
    ctaUrl: '',
    showTestimonial: false,
    signerHtml: offerSignerHtml({ mergeTags, sender }),
  };
  const subject = `Kontrakt til ${mergeTags ? '{{businessName}}' : text(client?.businessName) || 'dere'} fra Asoldi`;
  if (typeof layout !== 'function') {
    return { subject, preheader, html: view.bodyHtml };
  }
  const rendered = layout(client, view, { mergeTags, sender, ...layoutOptions });
  return { subject, preheader, html: rendered.html, from: rendered.from, replyTo: rendered.replyTo };
}

/**
 * Full branded email. `layout(client, view, options)` is injected so this module has no Node-only imports
 * (the server passes buildSalesLayoutEmail from lib/sales-email.js).
 */
export function buildOfferEmail({ client = {}, products = [], nuances = {}, mvaIncluded = false, billing = 'month', oneTimeFees = [], sender = {}, mergeTags = true, layout, layoutOptions = {}, tierId = '', dueDate = '' } = {}) {
  const view = {
    preheader: OFFER_PREHEADER,
    title: 'Tilbud fra Asoldi',
    mobileTitle: 'Tilbud fra Asoldi',
    // Plain left-aligned heading, no envelope illustration (that belongs to the meeting confirmations).
    titleAlign: 'left',
    hideIllustration: true,
    bodyHtml: buildOfferBodyHtml({ products, nuances, mvaIncluded, billing, oneTimeFees, tierId, dueDate }),
    agendaHtml: '',
    closingHtml: '',
    ctaLabel: '',
    ctaUrl: '',
    showTestimonial: false,
    signerHtml: offerSignerHtml({ mergeTags, sender }),
  };
  const subject = offerSubject({ mergeTags, businessName: client?.businessName });
  if (typeof layout !== 'function') {
    return { subject, preheader: OFFER_PREHEADER, html: view.bodyHtml };
  }
  const rendered = layout(client, view, { mergeTags, sender, ...layoutOptions });
  return { subject, preheader: OFFER_PREHEADER, html: rendered.html, from: rendered.from, replyTo: rendered.replyTo };
}

/* ------------------------------------------------------- plain summaries */

/** One-line-per-product summary used in notifications and history. */
export function summarizeOfferProducts(products = [], options = {}) {
  const list = Array.isArray(products) ? products : [];
  const totals = offerTotals(list, options);
  const unit = totals.mvaIncluded ? 'inkl. mva/mnd' : 'eks. mva/mnd';
  const lines = list.map((item) => `- ${text(item.name) || 'Produkt'}${Number(item.pages) ? ` (opp til ${item.pages} sider)` : ''}: ${formatKr(item.priceExMva || 0)} ${unit}`);
  lines.push(`Totalt: ${formatKr(totals.exMva)} eks. mva (${formatKr(totals.inclMva)} inkl. mva) per måned${totals.mvaIncluded ? ' – mva er inkludert i oppgitt pris' : ''}`);
  return lines.join('\n');
}
