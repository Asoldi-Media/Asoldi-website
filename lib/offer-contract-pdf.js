/**
 * Service agreement PDF (one per website tier, or a custom scope verified by admin).
 *
 * Text follows "Web utviklings kontrakt - template.pdf" with these updates:
 *  - only the chosen tier is described (Section 1), with price excl./incl. VAT and page count
 *  - Asoldi CMS instead of WordPress, "full export of the website files" instead of "SQL file"
 *  - parties block merged from the sales client card (blank placeholders for the template downloads)
 *
 * pdfkit's built-in Helvetica covers Norwegian characters (WinAnsi), checkboxes are drawn as rectangles.
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import PDFDocument from 'pdfkit';
import { CUSTOM_TIER_ID, formatKr, tierById, withMva, workDaysFromDeliveryWeeks } from './website-tiers.js';
import { contractAddressFor } from './offer-readiness.js';
import { contractCopy, contractMeanings, feeTitleFor, localizedTierContract, normalizeContractLanguage } from './offer-contract-copy.js';
import { contractDeliverySentence, contractProjectStartIntro, normalizeDueDate, projectStartFromQuote } from './website-due.js';

const ASOLDI_SIGNATURE_PNG = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'asoldi-contract-signature.png');

const ASOLDI = {
  legalName: 'CHAPANA (Asoldi Marketing)',
  orgNumber: '934 327 497',
  address: 'Østre Berg 10, Trondheim',
  email: 'damian@asoldi.com',
};

const MARGIN = 56;
const BODY_SIZE = 10.5;
const LINE_GAP = 2.5;

function text(value = '') {
  return String(value ?? '').trim();
}

function formatOrg(value = '') {
  const digits = text(value).replace(/\D+/g, '');
  if (digits.length !== 9) return text(value);
  return `${digits.slice(0, 3)} ${digits.slice(3, 6)} ${digits.slice(6)}`;
}

function formatDateNo(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  if (!Number.isFinite(d.getTime())) return '';
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yy = String(d.getFullYear()).slice(-2);
  return `${dd}.${mm}.${yy}`;
}

function safeFileName(value = '') {
  return text(value).replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'kunde';
}

/* --------------------------------------------------------------- content */

/**
 * Monthly fee sentence. Listed amounts are ex. VAT unless the rep absorbed the VAT (`mvaIncluded`), in which
 * case the listed amount is the all-in monthly price and the ex-VAT share is derived from it.
 */
function priceLineFor(listed, { mvaIncluded = false, total = false, language = 'nb' } = {}) {
  const t = contractCopy(language);
  const label = total ? t.monthlyPriceTotal : t.monthlyPrice;
  if (mvaIncluded) {
    const exMva = Math.round(listed / 1.25);
    return `${label}: ${formatKr(listed)} ${t.inclVat} (${formatKr(exMva)} ${t.exclVat} – ${t.vatIncludedNote}), ${t.billedMonthly}.`;
  }
  return `${label}: ${formatKr(listed)} ${t.exclVat} (${formatKr(withMva(listed))} ${t.inclVat}), ${t.billedMonthly}.`;
}

function contractBlocksForTier(tier, language = 'nb') {
  const spec = localizedTierContract(tier, language);
  const blocks = [{ lead: spec.lead, bullets: spec.includes || [] }];
  if (spec.monthlyWork?.bullets?.length) {
    blocks.push({ lead: spec.monthlyWork.lead, bullets: spec.monthlyWork.bullets });
  }
  if (spec.kpis?.bullets?.length) {
    blocks.push({ lead: spec.kpis.lead, bullets: spec.kpis.bullets });
  }
  for (const extra of spec.extraBlocks || []) {
    if (extra?.bullets?.length) blocks.push({ lead: extra.lead, bullets: extra.bullets });
  }
  return blocks;
}

function scopeForTier(tier, { mvaIncluded = false, language = 'nb' } = {}) {
  const t = contractCopy(language);
  const spec = localizedTierContract(tier, language);
  return {
    heading: t.selectedTier,
    title: spec.title,
    priceLine: priceLineFor(tier.monthlyExMva, { mvaIncluded, language }),
    blocks: contractBlocksForTier(tier, language),
    deliveryWeeks: tier.deliveryWeeks,
    deliveryWorkDays: workDaysFromDeliveryWeeks(tier.deliveryWeeks),
    extraTerms: [],
    tierNumber: tier.tierNumber,
    tierId: tier.id,
    language,
  };
}

function scopeForSummary(summary = {}, { mvaIncluded = false, language = 'nb' } = {}) {
  const t = contractCopy(language);
  const products = Array.isArray(summary.products) ? summary.products : [];
  const listed = Number(summary.monthlyExMva) || products.reduce((sum, item) => sum + (Number(item.priceExMva) || 0), 0);
  const unit = mvaIncluded ? t.inclVat : t.exclVat;
  const blocks = products.map((item) => ({
    lead: `${text(item.name) || t.product}${Number(item.pages) ? t.pagesBit(item.pages) : ''}${Number(item.priceExMva) ? ` (${formatKr(item.priceExMva)} ${unit} / ${t.language === 'en' ? 'month' : 'mnd'})` : ''}`,
    bullets: Array.isArray(item.includes) ? item.includes.map(text).filter(Boolean) : [],
  }));
  if (text(summary.scopeSummary)) blocks.unshift({ lead: text(summary.scopeSummary), bullets: [] });
  const weeks = Number(summary.deliveryWeeks) || products.reduce((max, item) => Math.max(max, Number(item.deliveryWeeks) || 0), 0) || 4;
  const workDays = Number(summary.deliveryWorkDays)
    || products.reduce((max, item) => Math.max(max, Number(item.deliveryWorkDays) || 0), 0)
    || workDaysFromDeliveryWeeks(weeks);
  return {
    heading: t.selectedCustom,
    title: text(summary.title) || t.customTitle,
    priceLine: priceLineFor(listed, { mvaIncluded, total: true, language }),
    blocks,
    deliveryWeeks: weeks,
    deliveryWorkDays: workDays,
    extraTerms: Array.isArray(summary.extraTerms) ? summary.extraTerms.map(text).filter(Boolean) : [],
    tierNumber: 0,
    language,
  };
}

/**
 * A plain tier offer uses the static tier text. A verified summary (custom tier, or a tier plus agreed
 * additions) wins when `preferSummary` is set; the tier checkbox still reflects the base tier.
 */
function normalizeOneTimeFees(list = []) {
  if (!Array.isArray(list)) return [];
  return list
    .map((fee) => ({
      name: text(fee?.name),
      price: Math.max(0, Math.round(Number(fee?.price) || 0)),
    }))
    .filter((fee) => fee.name && fee.price > 0);
}

function isAddonIncludeLine(line = '') {
  return /kassasystem|tredjeparts host|third-party host|cash.?register|\bPOS\b/i.test(String(line || ''));
}

function withOneTimeFees(scope, fees = [], { mvaIncluded = false, language = 'nb' } = {}) {
  const t = contractCopy(language);
  const items = normalizeOneTimeFees(fees);
  const blocks = (scope.blocks || []).map((block) => ({
    ...block,
    bullets: items.length
      ? (block.bullets || []).filter((line) => !isAddonIncludeLine(line))
      : (block.bullets || []),
  }));
  if (items.length) {
    const unit = mvaIncluded ? t.inclVat : t.exclVat;
    blocks.push({
      lead: t.oneTimeLead,
      bullets: items.map((fee) => `${feeTitleFor(fee.name, language)}: ${formatKr(fee.price)} ${unit}, ${t.billedOnce}`),
    });
  }
  return { ...scope, blocks, oneTimeFees: items, language };
}

function withDeliverySentence(scope, options = {}) {
  const dueDate = typeof options === 'string' ? options : options?.dueDate;
  const date = normalizeDueDate(dueDate);
  const start = projectStartFromQuote(options);
  const mvaIncluded = Boolean(typeof options === 'object' && options?.mvaIncluded);
  const language = normalizeContractLanguage(typeof options === 'object' ? options?.language : 'nb');
  const fees = typeof options === 'object' ? options?.oneTimeFees : [];
  return withOneTimeFees({
    ...scope,
    dueDate: date,
    language,
    deliverySentence: contractDeliverySentence({
      weeks: scope.deliveryWeeks,
      workDays: scope.deliveryWorkDays,
      dueDate: date,
      language,
      tierId: scope.tierId || '',
      ...start,
    }),
  }, fees, { mvaIncluded, language });
}

function alternativesFromOffer(offer = {}) {
  const raw = Array.isArray(offer?.alternatives) ? offer.alternatives : [];
  const list = raw.filter((alt) => Array.isArray(alt?.products) && alt.products.length);
  return list.length >= 2 ? list.slice(0, 2) : [];
}

function scopeFromAlternative(alt = {}, { mvaIncluded = false, dueDate = '', projectStartMode = '', projectStartDate = '', language = 'nb' } = {}) {
  const lang = normalizeContractLanguage(language);
  const t = contractCopy(lang);
  const tierId = String(alt?.tierId || '');
  const tier = tierId && tierId !== CUSTOM_TIER_ID ? tierById(tierId) : null;
  const products = Array.isArray(alt.products) ? alt.products : [];
  const wrap = {
    dueDate,
    projectStartMode,
    projectStartDate,
    mvaIncluded,
    language: lang,
    oneTimeFees: alt.oneTimeFees,
  };
  const custom = !tier || products.some((item) => item?.kind === 'custom' && item?.tierId !== tier.id);
  if (!custom && tier) return withDeliverySentence(scopeForTier(tier, { mvaIncluded, language: lang }), wrap);
  const listed = products.reduce((sum, item) => sum + (Number(item?.priceExMva) || 0), 0);
  const weeks = products.reduce((max, item) => Math.max(max, Number(item?.deliveryWeeks) || 0), 0);
  return withDeliverySentence(scopeForSummary({
    title: text(products[0]?.name) || t.customTitle,
    products,
    monthlyExMva: listed,
    deliveryWeeks: weeks,
    extraTerms: [],
    scopeSummary: '',
  }, { mvaIncluded, language: lang }), wrap);
}

function resolveAlternativeScopes(alternatives = [], options = {}) {
  return alternatives.map((alt) => scopeFromAlternative(alt, options));
}

function resolveScope({
  tierId = '',
  summary = null,
  preferSummary = false,
  mvaIncluded = false,
  dueDate = '',
  projectStartMode = '',
  projectStartDate = '',
  oneTimeFees = [],
  language = 'nb',
} = {}) {
  const lang = normalizeContractLanguage(language);
  const t = contractCopy(lang);
  const wrap = { dueDate, projectStartMode, projectStartDate, mvaIncluded, oneTimeFees, language: lang };
  const tier = tierId && tierId !== CUSTOM_TIER_ID ? tierById(tierId) : null;
  if (summary && (preferSummary || !tier)) {
    const scope = scopeForSummary(summary, { mvaIncluded, language: lang });
    if (tier) {
      scope.tierNumber = tier.tierNumber;
      scope.heading = t.selectedTierPlus;
    }
    return withDeliverySentence(scope, wrap);
  }
  if (tier) return withDeliverySentence(scopeForTier(tier, { mvaIncluded, language: lang }), wrap);
  throw new Error('Contract needs a website tier or a verified custom summary.');
}

function contractBodySections(language = 'nb') {
  const t = contractCopy(language);
  return [
    { heading: t.s4.heading, paragraphs: t.s4.paragraphs, bullets: t.s4.bullets },
    { heading: t.s5.heading, paragraphs: t.s5.paragraphs, topics: contractMeanings(language), after: t.s5.after },
    { heading: t.s6.heading, paragraphs: t.s6.paragraphs },
    { heading: t.s7.heading, paragraphs: t.s7.paragraphs },
    { heading: t.s8.heading, numbered: t.s8.numbered },
    { heading: t.s9.heading, paragraphs: t.s9.paragraphs, bullets: t.s9.bullets },
    { heading: t.s10.heading, paragraphs: t.s10.paragraphs, bullets: t.s10.bullets, after: t.s10.after },
    { heading: t.s11.heading, paragraphs: t.s11.paragraphs, numbered: t.s11.numbered },
    { heading: t.s12.heading, paragraphs: t.s12.paragraphs, bullets: t.s12.bullets, after: t.s12.after },
    { heading: t.s13.heading, paragraphs: t.s13.paragraphs },
    { heading: t.s14.heading, paragraphs: t.s14.paragraphs, bullets: t.s14.bullets, after: t.s14.after },
    { heading: t.s15.heading, paragraphs: t.s15.paragraphs },
  ];
}

function writeContractSection(w, section) {
  w.h2(section.heading);
  for (const paragraph of section.paragraphs || []) w.p(paragraph, { gap: 0.1 });
  if (section.bullets?.length) w.bullets(section.bullets);
  if (section.numbered?.length) w.numbered(section.numbered);
  for (const topic of section.topics || []) {
    if (topic.title) w.p(topic.title, { bold: true, gap: 0.1 });
    if (topic.text) w.p(topic.text);
  }
  for (const paragraph of section.after || []) w.p(paragraph);
}

/* ---------------------------------------------------------------- drawing */

function makeWriter(doc) {
  const width = doc.page.width - MARGIN * 2;
  const api = {
    h1(value) {
      doc.font('Helvetica-Bold').fontSize(18).text(value, { align: 'center' });
      doc.moveDown(0.6);
    },
    h2(value) {
      doc.moveDown(0.5);
      doc.font('Helvetica-Bold').fontSize(12.5).text(value);
      doc.moveDown(0.25);
    },
    p(value, options = {}) {
      doc.font(options.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(BODY_SIZE).text(value, { width, lineGap: LINE_GAP, ...options });
      doc.moveDown(options.gap ?? 0.35);
    },
    kv(label, value) {
      doc.font('Helvetica-Bold').fontSize(BODY_SIZE).text(`${label}: `, { continued: true, lineGap: LINE_GAP });
      doc.font('Helvetica').text(value || '');
    },
    bullets(items = [], indent = 16) {
      doc.font('Helvetica').fontSize(BODY_SIZE);
      for (const item of items) {
        doc.text(`•  ${item}`, MARGIN + indent, doc.y, { width: width - indent, lineGap: LINE_GAP });
      }
      doc.x = MARGIN;
      doc.moveDown(0.3);
    },
    numbered(items = []) {
      doc.font('Helvetica').fontSize(BODY_SIZE);
      items.forEach((item, index) => {
        doc.text(`${index + 1}.  ${item}`, MARGIN + 14, doc.y, { width: width - 14, lineGap: LINE_GAP });
      });
      doc.x = MARGIN;
      doc.moveDown(0.3);
    },
    checkbox(label, checked, x, y) {
      const size = 10;
      doc.save().lineWidth(0.8).rect(x, y, size, size).stroke('#222222');
      if (checked) {
        doc.moveTo(x + 2, y + 5).lineTo(x + 4.5, y + 8).lineTo(x + 8.5, y + 2).lineWidth(1.4).stroke('#222222');
      }
      doc.restore();
      doc.font('Helvetica').fontSize(BODY_SIZE).text(label, x + size + 6, y - 1, { lineBreak: false });
    },
    ensureSpace(height) {
      if (doc.y + height > doc.page.height - MARGIN) doc.addPage();
    },
  };
  return api;
}

/** Handwritten Asoldi signature. Bottom sits on the signature line. Returns drawn height. */
function drawAsoldiSignature(doc, x, lineY, maxWidth, maxHeight) {
  if (!existsSync(ASOLDI_SIGNATURE_PNG)) return 0;
  const img = doc.openImage(ASOLDI_SIGNATURE_PNG);
  const ratio = img.width / img.height;
  let width = maxWidth;
  let height = width / ratio;
  if (height > maxHeight) {
    height = maxHeight;
    width = height * ratio;
  }
  doc.image(img, x, lineY - height + 2, { width, height });
  return height;
}

/**
 * Build the agreement. Returns a Buffer.
 *  - tierId: 'tier-1-standard' | 'tier-2-seo' | 'tier-3-ecommerce' | 'custom'
 *  - summary: admin-verified contract summary (required when tierId is custom)
 *  - blank: true for the downloadable template (client fields left as placeholders)
 */
export async function buildContractPdf({ client = {}, tierId = '', summary = null, preferSummary = false, mvaIncluded = false, date = new Date(), blank = false, dueDate = '', alternatives = [], chosenOfferIndex = null, projectStartMode = '', projectStartDate = '', oneTimeFees = [], language = 'nb' } = {}) {
  const lang = normalizeContractLanguage(language);
  const t = contractCopy(lang);
  const start = { projectStartMode, projectStartDate };
  const wrap = { mvaIncluded, dueDate, language: lang, ...start };
  const dualScopes = Array.isArray(alternatives) && alternatives.length >= 2
    ? resolveAlternativeScopes(alternatives, wrap)
    : null;
  const scope = dualScopes ? dualScopes[0] : resolveScope({ tierId, summary, preferSummary, mvaIncluded, dueDate, oneTimeFees, language: lang, ...start });
  const partyName = blank ? t.placeholders.business : text(client.businessName) || t.placeholders.business;
  const partyOrg = blank ? t.placeholders.org : formatOrg(client.orgNumber) || t.placeholders.org;
  const partyAddress = blank ? t.placeholders.address : contractAddressFor(client) || t.placeholders.address;
  const partyOwner = blank ? t.placeholders.person : text(client.contactPerson) || t.placeholders.person;
  const partyEmail = blank ? t.placeholders.email : text(client.contactEmail) || t.placeholders.email;

  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN },
    info: {
      Title: t.pdfTitle(scope.title),
      Author: ASOLDI.legalName,
      Subject: t.pdfSubject(partyName),
    },
  });
  const chunks = [];
  doc.on('data', (chunk) => chunks.push(chunk));
  const done = new Promise((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
  const w = makeWriter(doc);

  w.h1(t.h1);
  w.p(t.between, { bold: true, gap: 0.1 });
  w.kv(t.labels.provider, ASOLDI.legalName);
  w.kv(t.labels.org, ASOLDI.orgNumber);
  w.kv(t.labels.address, ASOLDI.address);
  w.kv(t.labels.email, ASOLDI.email);
  doc.moveDown(0.4);
  w.p(t.and, { bold: true, gap: 0.1 });
  w.kv(t.labels.client, partyName);
  w.kv(t.labels.org, partyOrg);
  w.kv(t.labels.address, partyAddress);
  w.kv(t.labels.innehaver, partyOwner);
  w.kv(t.labels.email, partyEmail);
  doc.moveDown(0.6);

  w.p(t.introOpen(ASOLDI.legalName, partyName));
  w.p(`${t.introPurposeLead} ${contractProjectStartIntro({ projectStartMode, projectStartDate, language: lang })}`);
  w.p(t.introLegal);

  w.h2(t.scopeHeadingPdf);
  if (dualScopes) {
    w.p(t.dualIntro);
    dualScopes.forEach((item, index) => {
      w.p(`Tilbud ${index + 1}`, { bold: true, gap: 0.1 });
      w.p(item.title, { bold: true, gap: 0.1 });
      w.p(item.priceLine, { gap: 0.2 });
      for (const block of item.blocks) {
        if (block.lead) w.p(block.lead, { gap: 0.1 });
        if (block.bullets.length) w.bullets(block.bullets);
      }
      w.p(item.deliverySentence, { bold: true });
      if (item.extraTerms.length) {
        w.p(t.extraTermsLead, { gap: 0.1 });
        w.bullets(item.extraTerms);
      }
    });
  } else {
    w.p(scope.heading);
    w.p(scope.title, { bold: true, gap: 0.1 });
    w.p(scope.priceLine, { gap: 0.2 });
    for (const block of scope.blocks) {
      if (block.lead) w.p(block.lead, { gap: 0.1 });
      if (block.bullets.length) w.bullets(block.bullets);
    }
    w.p(scope.deliverySentence, { bold: true });
    if (scope.extraTerms.length) {
      w.p(t.extraTermsLead, { gap: 0.1 });
      w.bullets(scope.extraTerms);
    }
  }
  w.p(t.vatNote);

  w.h2(t.paymentHeadingPdf);
  w.numbered(t.paymentTerms);

  w.h2(t.durationHeadingPdf);
  w.numbered(t.durationTerms);

  for (const section of contractBodySections(lang)) writeContractSection(w, section);

  w.ensureSpace(280);
  w.h2(t.signHeadingPdf);
  w.p(t.signAgree);
  w.p(t.chosenScope, { gap: 0.15 });
  const rowY = doc.y;
  if (dualScopes) {
    const chosen = chosenOfferIndex === 0 || chosenOfferIndex === 1 ? chosenOfferIndex : null;
    w.checkbox('Tilbud 1', chosen === 0, MARGIN, rowY);
    w.checkbox('Tilbud 2', chosen === 1, MARGIN + 140, rowY);
  } else {
    w.checkbox('Tier 1', scope.tierNumber === 1, MARGIN, rowY);
    w.checkbox('Tier 2', scope.tierNumber === 2, MARGIN + 90, rowY);
    w.checkbox('Tier 3', scope.tierNumber === 3, MARGIN + 180, rowY);
    w.checkbox(t.customScopeBox, scope.tierNumber === 0, MARGIN + 270, rowY);
  }
  doc.x = MARGIN;
  doc.y = rowY + 26;

  const colWidth = (doc.page.width - MARGIN * 2 - 30) / 2;
  const sigY = doc.y;
  const rightX = MARGIN + colWidth + 30;

  doc.font('Helvetica-Bold').fontSize(BODY_SIZE).text(`${t.forProvider(ASOLDI.legalName)}:`, MARGIN, sigY, { width: colWidth });
  doc.font('Helvetica').text(`${t.signature}:`, MARGIN, sigY + 16, { width: colWidth });
  doc.font('Helvetica-Bold').text(`${t.forClient(partyName)}:`, rightX, sigY, { width: colWidth });
  doc.font('Helvetica').text(`${t.signatureOf(partyOwner)}:`, rightX, sigY + 16, { width: colWidth });

  const lineY = sigY + 78;
  drawAsoldiSignature(doc, MARGIN, lineY, colWidth - 8, 52);
  doc.moveTo(MARGIN, lineY).lineTo(MARGIN + colWidth, lineY).lineWidth(0.8).stroke('#222222');
  doc.font('Helvetica').fontSize(BODY_SIZE).text(`${t.dateLabel}: ${blank ? '____________' : formatDateNo(date)}`, MARGIN, lineY + 8, { width: colWidth });
  doc.moveTo(rightX, lineY).lineTo(rightX + colWidth, lineY).lineWidth(0.8).stroke('#222222');
  doc.text(`${t.dateLabel}: ____________`, rightX, lineY + 8, { width: colWidth });

  doc.end();
  return done;
}

/** Same agreement text as the PDF, as sections the client portal can scroll. */
export function contractArticleModel({ client = {}, tierId = '', summary = null, preferSummary = false, mvaIncluded = false, date = new Date(), dueDate = '', alternatives = [], chosenOfferIndex = null, projectStartMode = '', projectStartDate = '', oneTimeFees = [], language = 'nb' } = {}) {
  const lang = normalizeContractLanguage(language);
  const t = contractCopy(lang);
  const start = { projectStartMode, projectStartDate };
  const wrap = { mvaIncluded, dueDate, language: lang, ...start };
  const dualScopes = Array.isArray(alternatives) && alternatives.length >= 2
    ? resolveAlternativeScopes(alternatives, wrap)
    : null;
  const scope = dualScopes ? dualScopes[0] : resolveScope({ tierId, summary, preferSummary, mvaIncluded, dueDate, oneTimeFees, language: lang, ...start });
  const partyName = text(client.businessName) || t.placeholders.business;
  const partyOrg = formatOrg(client.orgNumber) || t.placeholders.org;
  const partyAddress = contractAddressFor(client) || t.placeholders.address;
  const partyOwner = text(client.contactPerson) || t.placeholders.person;
  const partyEmail = text(client.contactEmail) || t.placeholders.email;
  return {
    language: lang,
    copy: t,
    title: t.htmlTitle,
    provider: ASOLDI,
    client: {
      name: partyName,
      orgNumber: partyOrg,
      address: partyAddress,
      signatory: partyOwner,
      email: partyEmail,
    },
    intro: [
      t.introOpen(ASOLDI.legalName, partyName),
      `${t.introPurposeLead} ${contractProjectStartIntro({ projectStartMode, projectStartDate, language: lang })}`,
      t.introLegal,
    ],
    scope,
    alternativeScopes: dualScopes,
    chosenOfferIndex: chosenOfferIndex === 0 || chosenOfferIndex === 1 ? chosenOfferIndex : null,
    paymentTerms: t.paymentTerms,
    durationTerms: t.durationTerms,
    sections: contractBodySections(lang),
    signedAtLabel: formatDateNo(date),
    asoldiSigned: true,
  };
}

function oneTimeFeesFromOffer(offer = {}) {
  const top = normalizeOneTimeFees(offer?.oneTimeFees);
  if (top.length) return top;
  const alts = Array.isArray(offer?.alternatives) ? offer.alternatives : [];
  return normalizeOneTimeFees(alts[0]?.oneTimeFees);
}

/** Contract inputs for a stored offer: verified summary wins over the plain tier text. */
export function contractInputsForOffer(offer = {}, client = null) {
  const summary = offer?.contract?.summary || null;
  const tierId = String(offer?.tierId || '');
  const hasCustomProducts = Array.isArray(offer?.products) && offer.products.some((item) => item?.kind !== 'tier');
  const alternatives = alternativesFromOffer(offer);
  const chosen = offer?.chosenOfferIndex;
  const start = projectStartFromQuote(client?.details?.meetingQuote || {});
  return {
    tierId,
    summary,
    preferSummary: Boolean(summary) && (tierId === CUSTOM_TIER_ID || hasCustomProducts || !tierById(tierId)),
    mvaIncluded: Boolean(offer?.mvaIncluded),
    dueDate: normalizeDueDate(offer?.dueDate),
    ...start,
    alternatives,
    oneTimeFees: oneTimeFeesFromOffer(offer),
    chosenOfferIndex: chosen === 0 || chosen === 1 ? chosen : null,
    language: normalizeContractLanguage(offer?.contractLanguage),
  };
}

export function offerContractIsAvailable(offer = {}) {
  const inputs = contractInputsForOffer(offer);
  if (inputs.alternatives.length >= 2) {
    try {
      resolveAlternativeScopes(inputs.alternatives, inputs);
      return true;
    } catch {
      return false;
    }
  }
  if (inputs.summary) return true;
  return Boolean(inputs.tierId && inputs.tierId !== CUSTOM_TIER_ID && tierById(inputs.tierId));
}

export function contractFileName({ client = {}, tierId = '', blank = false } = {}) {
  const tier = tierById(tierId);
  const tierPart = tier ? `Tier-${tier.tierNumber}-${safeFileName(tier.shortName)}` : 'Skreddersydd';
  if (blank) return `Asoldi-kontrakt-${tierPart}-mal.pdf`;
  return `Asoldi-kontrakt-${tierPart}-${safeFileName(client.businessName)}.pdf`;
}
