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
import { LEGAL_URLS } from './legal-urls.js';
import { contractAddressFor } from './offer-readiness.js';
import { SERVICE_MEANINGS_EN } from './service-meanings.js';
import { contractDeliverySentence, normalizeDueDate } from './website-due.js';

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
function priceLineFor(listed, { mvaIncluded = false, total = false } = {}) {
  const label = total ? 'Monthly price (total)' : 'Monthly price';
  if (mvaIncluded) {
    const exMva = Math.round(listed / 1.25);
    return `${label}: ${formatKr(listed)} incl. VAT (${formatKr(exMva)} excl. VAT – VAT is included in the quoted price), billed monthly.`;
  }
  return `${label}: ${formatKr(listed)} excl. VAT (${formatKr(withMva(listed))} incl. VAT), billed monthly.`;
}

function contractBlocksForTier(tier) {
  const spec = tier.contract || {};
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

function scopeForTier(tier, { mvaIncluded = false } = {}) {
  return {
    heading: 'The Client has selected the following service tier:',
    title: tier.contract.title,
    priceLine: priceLineFor(tier.monthlyExMva, { mvaIncluded }),
    blocks: contractBlocksForTier(tier),
    deliveryWeeks: tier.deliveryWeeks,
    deliveryWorkDays: workDaysFromDeliveryWeeks(tier.deliveryWeeks),
    extraTerms: [],
    tierNumber: tier.tierNumber,
    tierId: tier.id,
  };
}

function scopeForSummary(summary = {}, { mvaIncluded = false } = {}) {
  const products = Array.isArray(summary.products) ? summary.products : [];
  const listed = Number(summary.monthlyExMva) || products.reduce((sum, item) => sum + (Number(item.priceExMva) || 0), 0);
  const unit = mvaIncluded ? 'incl. VAT' : 'excl. VAT';
  const blocks = products.map((item) => ({
    lead: `${text(item.name) || 'Product'}${Number(item.pages) ? ` – up to ${item.pages} main pages` : ''}${Number(item.priceExMva) ? ` (${formatKr(item.priceExMva)} ${unit} / month)` : ''}`,
    bullets: Array.isArray(item.includes) ? item.includes.map(text).filter(Boolean) : [],
  }));
  if (text(summary.scopeSummary)) blocks.unshift({ lead: text(summary.scopeSummary), bullets: [] });
  const weeks = Number(summary.deliveryWeeks) || products.reduce((max, item) => Math.max(max, Number(item.deliveryWeeks) || 0), 0) || 4;
  const workDays = Number(summary.deliveryWorkDays)
    || products.reduce((max, item) => Math.max(max, Number(item.deliveryWorkDays) || 0), 0)
    || workDaysFromDeliveryWeeks(weeks);
  return {
    heading: 'The Client has selected the following custom service scope (verified offer):',
    title: text(summary.title) || 'Custom scope – Website + agreed services',
    priceLine: priceLineFor(listed, { mvaIncluded, total: true }),
    blocks,
    deliveryWeeks: weeks,
    deliveryWorkDays: workDays,
    extraTerms: Array.isArray(summary.extraTerms) ? summary.extraTerms.map(text).filter(Boolean) : [],
    tierNumber: 0,
  };
}

/**
 * A plain tier offer uses the static tier text. A verified summary (custom tier, or a tier plus agreed
 * additions) wins when `preferSummary` is set; the tier checkbox still reflects the base tier.
 */
function withDeliverySentence(scope, dueDate = '') {
  const date = normalizeDueDate(dueDate);
  return {
    ...scope,
    dueDate: date,
    deliverySentence: contractDeliverySentence({
      weeks: scope.deliveryWeeks,
      workDays: scope.deliveryWorkDays,
      dueDate: date,
      tierId: scope.tierId || '',
    }),
  };
}

function alternativesFromOffer(offer = {}) {
  const raw = Array.isArray(offer?.alternatives) ? offer.alternatives : [];
  const list = raw.filter((alt) => Array.isArray(alt?.products) && alt.products.length);
  return list.length >= 2 ? list.slice(0, 2) : [];
}

function scopeFromAlternative(alt = {}, { mvaIncluded = false, dueDate = '' } = {}) {
  const tierId = String(alt?.tierId || '');
  const tier = tierId && tierId !== CUSTOM_TIER_ID ? tierById(tierId) : null;
  const products = Array.isArray(alt.products) ? alt.products : [];
  const custom = !tier || products.some((item) => item?.kind === 'custom' && item?.tierId !== tier.id);
  if (!custom && tier) return withDeliverySentence(scopeForTier(tier, { mvaIncluded }), dueDate);
  const listed = products.reduce((sum, item) => sum + (Number(item?.priceExMva) || 0), 0);
  const weeks = products.reduce((max, item) => Math.max(max, Number(item?.deliveryWeeks) || 0), 0);
  return withDeliverySentence(scopeForSummary({
    title: text(products[0]?.name) || 'Custom scope – Website + agreed services',
    products,
    monthlyExMva: listed,
    deliveryWeeks: weeks,
    extraTerms: [],
    scopeSummary: '',
  }, { mvaIncluded }), dueDate);
}

function resolveAlternativeScopes(alternatives = [], options = {}) {
  return alternatives.map((alt) => scopeFromAlternative(alt, options));
}

function resolveScope({ tierId = '', summary = null, preferSummary = false, mvaIncluded = false, dueDate = '' } = {}) {
  const tier = tierId && tierId !== CUSTOM_TIER_ID ? tierById(tierId) : null;
  if (summary && (preferSummary || !tier)) {
    const scope = scopeForSummary(summary, { mvaIncluded });
    if (tier) {
      scope.tierNumber = tier.tierNumber;
      scope.heading = 'The Client has selected the following service tier with agreed additions (verified offer):';
    }
    return withDeliverySentence(scope, dueDate);
  }
  if (tier) return withDeliverySentence(scopeForTier(tier, { mvaIncluded }), dueDate);
  throw new Error('Contract needs a website tier or a verified custom summary.');
}

const INCORPORATED_LEGAL = [
  `The same service meanings, monthly work, KPIs and general terms are also published at ${LEGAL_URLS.vilkar}.`,
  `Privacy information is published at ${LEGAL_URLS.personvern}.`,
  `The Data Processing Agreement (databehandleravtale) is published at ${LEGAL_URLS.databehandleravtale}.`,
  'Those pages, as they stand on the signing date of this Agreement, form part of this Agreement. The parties, price, chosen scope, service meanings in Section 5, late-payment rule, liability cap, ownership and offboarding terms in this document prevail if they conflict with the website.',
];

const PAYMENT_TERMS = [
  'Monthly payments are made on the 1st of each month.',
  'The first month is billed with pro-rated pricing, calculated as: (Monthly price ÷ days in month) × days remaining in the month after delivery.',
  'First-month invoice is due within 7 days of product delivery.',
  'All subsequent invoices are due within 7 days of issue.',
  'Accepted payment methods: Bank transfer and Stripe.',
  'There is no setup fee for starting the subscription.',
  'Late payments are charged as statutory default interest and collection fees under applicable Norwegian law (forsinkelsesrente og gebyrer etter gjeldende norsk lov). Continued non-payment may result in service suspension and contract termination (see Section 13).',
];

const DURATION_TERMS = [
  'Minimum binding period: 6 months.',
  "Cancellation requires 15 days' notice, and the Client pays for the entire cancellation month.",
  'Clients cannot downgrade to a lower tier once higher-level functionality has been added.',
  'The Client permanently owns the website content, design and any custom code developed specifically for them. Ownership does not revert to Asoldi after cancellation or after any waiting period.',
  'Within seven (7) business days after the subscription ends, Asoldi delivers access to the website files as they stand at termination (a snapshot of the live site).',
  'If the Client wants Asoldi to install the site on a new host or domain, that work is optional and billed at the then-current hosting setup / migration fee published on asoldi.com. This Agreement does not fix that fee, because it can change.',
  'If the Client leaves the Asoldi hosting network, they keep the exported website as it is at termination, but they lose ongoing subscription services: continual website updates, the Asoldi client backlink network, CMS product updates, location-based SEO blog writing, SEO operations, support and other running services described in the Terms.',
];

function contractBodySections() {
  return [
    {
      heading: '4. Incorporated legal documents',
      paragraphs: ['The following published documents form part of this Agreement:'],
      bullets: INCORPORATED_LEGAL,
    },
    {
      heading: '5. Scope of work and service meanings',
      paragraphs: [
        'Section 1 is the short list of what this Client has bought. The descriptions below say what those services mean. They apply to every standard website tier and to a custom scope that uses the same service names. A service that is not listed in Section 1 is not included.',
      ],
      topics: SERVICE_MEANINGS_EN,
      after: [
        'Revisions include: text iteration, adding a section, or adding functionality. Fixing typos or correcting factual errors is not considered a revision.',
        'Redesigns or work outside the plan will incur additional costs agreed upon by both parties.',
        `The Norwegian public wording of the same catalogue is at ${LEGAL_URLS.vilkar}.`,
      ],
    },
    {
      heading: '6. Delivery guarantee',
      paragraphs: ['If Asoldi fails to deliver the website within the timeframe stated in Section 1, the Client receives one (1) month of service free of charge.'],
    },
    {
      heading: '7. Hosting failure',
      paragraphs: [
        'If Asoldi becomes unable to host the website for any reason for a prolonged amount of time, the Client receives one (1) month of service free of charge.',
        'Any further liability for damage arising from such a failure is limited as stated in Section 12: six (6) months of the chosen tier’s fees (excluding VAT), except where mandatory Norwegian law provides otherwise.',
      ],
    },
    {
      heading: '8. Intellectual property and ownership',
      numbered: [
        'During the subscription period, the Client has full rights to use the website.',
        'The Client permanently owns the website content (including customer and form data the Client controls), the website design, and any custom code developed specifically for them. This ownership does not revert to Asoldi.',
        'Asoldi owns the hosting environment, DNS management tooling, the Asoldi CMS software, shared platform components and third-party licenses. Leaving the subscription does not transfer those platform assets.',
        'After cancellation Asoldi delivers the site files within seven (7) business days (see Section 3). The Client may hire Asoldi to install the export on a new host at the hosting setup fee published on asoldi.com.',
      ],
    },
    {
      heading: '9. Support and maintenance',
      paragraphs: ['Support hours: 09:00–16:00 (CET).', 'Response times:'],
      bullets: ['Standard requests: 1–3 days', 'Urgent issues: within 1 day'],
    },
    {
      heading: '10. Client responsibilities',
      paragraphs: ['The Client must provide, within a reasonable time after signing:'],
      bullets: [
        'Logo(s)',
        'Images and/or videos needed for the website',
        'Domain access so Asoldi can connect the domain to hosting',
        'Any other material that is necessary to build and launch the website',
      ],
      after: [
        'Optionally, the Client may also provide inspiration materials, a colour scheme and the preferred site language. These help the build but are not required for Asoldi to start.',
        'If the Client does not provide the necessary details and access in Section 10 within a reasonable time, Sections 6 and 7 do not apply: the Client is not entitled to free service or other compensation for late delivery or hosting failure caused or prolonged by that delay.',
      ],
    },
    {
      heading: '11. GDPR and data processing',
      paragraphs: [
        'The Client is the data controller for personal data collected via the Client website (forms, ecommerce, email lists and similar). Asoldi is the data processor.',
        `The Data Processing Agreement at ${LEGAL_URLS.databehandleravtale} applies and describes storage locations, subprocessors, security, deletion and end-of-contract handling.`,
        `Asoldi’s own processing of the Client as Asoldi’s customer is described in ${LEGAL_URLS.personvern}.`,
      ],
      numbered: [
        'Asoldi may access Client website data only to host, maintain, secure and operate the service.',
        'The Client is responsible for GDPR compliance toward its own end customers, including privacy notices on its website.',
      ],
    },
    {
      heading: '12. Limitation of liability',
      paragraphs: ['Asoldi is not liable for:'],
      bullets: ['Indirect, incidental, or consequential damages', 'Loss of revenue, business, or data'],
      after: [
        'Asoldi’s aggregate liability arising out of this Agreement is limited to the subscription fees paid by the Client for the six (6) months immediately preceding the claim (excluding VAT), except where mandatory Norwegian law provides otherwise.',
        'The person that signs confirms that they have the authority to make marketing decisions within the business this contract refers to. If not, this contract is invalid.',
      ],
    },
    {
      heading: '13. Portfolio rights',
      paragraphs: ["Asoldi may display the Client's website in portfolios, advertisements, and promotional materials unless the Client opts out."],
    },
    {
      heading: '14. Payment default and suspension',
      paragraphs: ['If payment is not received within 7 days of the due date, a reminder will be sent to the Client.', 'If payment is not received within 14 days of the due date:'],
      bullets: [
        'The website may be temporarily suspended (taken offline) until payment is received',
        'Statutory default interest and collection fees under applicable Norwegian law (forsinkelsesrente og gebyrer etter gjeldende norsk lov) will apply',
      ],
      after: [
        'If payment is not received within 30 days, outstanding amounts may be sent to debt collection in accordance with Norwegian law. The Client remains liable for all unpaid invoices.',
        'Asoldi reserves the right to suspend services immediately if fraudulent payment activity is detected.',
      ],
    },
    {
      heading: '15. Governing law',
      paragraphs: ['This Agreement is governed by the laws of Norway.'],
    },
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
export async function buildContractPdf({ client = {}, tierId = '', summary = null, preferSummary = false, mvaIncluded = false, date = new Date(), blank = false, dueDate = '', alternatives = [], chosenOfferIndex = null } = {}) {
  const dualScopes = Array.isArray(alternatives) && alternatives.length >= 2
    ? resolveAlternativeScopes(alternatives, { mvaIncluded, dueDate })
    : null;
  const scope = dualScopes ? dualScopes[0] : resolveScope({ tierId, summary, preferSummary, mvaIncluded, dueDate });
  const partyName = blank ? '[Business name]' : text(client.businessName) || '[Business name]';
  const partyOrg = blank ? '[Org. number]' : formatOrg(client.orgNumber) || '[Org. number]';
  const partyAddress = blank ? '[Business address]' : contractAddressFor(client) || '[Business address]';
  const partyOwner = blank ? '[Contact person]' : text(client.contactPerson) || '[Contact person]';
  const partyEmail = blank ? '[Email]' : text(client.contactEmail) || '[Email]';

  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN },
    info: {
      Title: `Service Agreement – ${scope.title}`,
      Author: ASOLDI.legalName,
      Subject: `Website service agreement for ${partyName}`,
    },
  });
  const chunks = [];
  doc.on('data', (chunk) => chunks.push(chunk));
  const done = new Promise((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
  const w = makeWriter(doc);

  w.h1('SERVICE AGREEMENT');
  w.p('Between', { bold: true, gap: 0.1 });
  w.kv('Service Provider', ASOLDI.legalName);
  w.kv('Org. nr.', ASOLDI.orgNumber);
  w.kv('Address', ASOLDI.address);
  w.kv('Email', ASOLDI.email);
  doc.moveDown(0.4);
  w.p('And', { bold: true, gap: 0.1 });
  w.kv('Client', partyName);
  w.kv('Org. nr.', partyOrg);
  w.kv('Address', partyAddress);
  w.kv('Innehaver / signatory', partyOwner);
  w.kv('Email', partyEmail);
  doc.moveDown(0.6);

  w.p(`This Service Agreement ("Agreement") is entered into between ${ASOLDI.legalName} ("Service Provider" or "Asoldi") and the above-named client ("Client").`);
  w.p('The purpose of this Agreement is to define the terms under which Asoldi provides website development, hosting, maintenance and digital services to the Client under the service scope described in Section 1. The project starts the day the contract is signed by both parties.');
  w.p(`The published Terms (${LEGAL_URLS.vilkar}), Privacy Policy (${LEGAL_URLS.personvern}) and Data Processing Agreement (${LEGAL_URLS.databehandleravtale}) form part of this Agreement as they stand on the signing date.`);

  w.h2('1. SERVICE SCOPE');
  if (dualScopes) {
    w.p('The Client is offered the following alternative service scopes. The Client selects Tilbud 1 or Tilbud 2 at signing.');
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
        w.p('Additional terms for this scope:', { gap: 0.1 });
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
      w.p('Additional terms for this scope:', { gap: 0.1 });
      w.bullets(scope.extraTerms);
    }
  }
  w.p('All prices are stated per month excluding VAT (25 % VAT is added on the invoice). The service is a running monthly subscription covering development, hosting and maintenance.');

  w.h2('2. PAYMENT TERMS');
  w.numbered(PAYMENT_TERMS);

  w.h2('3. CONTRACT DURATION & CANCELLATION');
  w.numbered(DURATION_TERMS);

  for (const section of contractBodySections()) writeContractSection(w, section);

  w.ensureSpace(280);
  w.h2('CONTRACT & SCOPE SIGNING');
  w.p('By signing below, both parties agree to all terms stated in this Agreement.');
  w.p('Chosen scope:', { gap: 0.15 });
  const rowY = doc.y;
  if (dualScopes) {
    const chosen = chosenOfferIndex === 0 || chosenOfferIndex === 1 ? chosenOfferIndex : null;
    w.checkbox('Tilbud 1', chosen === 0, MARGIN, rowY);
    w.checkbox('Tilbud 2', chosen === 1, MARGIN + 140, rowY);
  } else {
    w.checkbox('Tier 1', scope.tierNumber === 1, MARGIN, rowY);
    w.checkbox('Tier 2', scope.tierNumber === 2, MARGIN + 90, rowY);
    w.checkbox('Tier 3', scope.tierNumber === 3, MARGIN + 180, rowY);
    w.checkbox('Custom scope (Section 1)', scope.tierNumber === 0, MARGIN + 270, rowY);
  }
  doc.x = MARGIN;
  doc.y = rowY + 26;

  const colWidth = (doc.page.width - MARGIN * 2 - 30) / 2;
  const sigY = doc.y;
  const rightX = MARGIN + colWidth + 30;

  doc.font('Helvetica-Bold').fontSize(BODY_SIZE).text(`For ${ASOLDI.legalName}:`, MARGIN, sigY, { width: colWidth });
  doc.font('Helvetica').text('Signature:', MARGIN, sigY + 16, { width: colWidth });
  doc.font('Helvetica-Bold').text(`For Client (${partyName}):`, rightX, sigY, { width: colWidth });
  doc.font('Helvetica').text(`Signature (${partyOwner}):`, rightX, sigY + 16, { width: colWidth });

  const lineY = sigY + 78;
  drawAsoldiSignature(doc, MARGIN, lineY, colWidth - 8, 52);
  doc.moveTo(MARGIN, lineY).lineTo(MARGIN + colWidth, lineY).lineWidth(0.8).stroke('#222222');
  doc.font('Helvetica').fontSize(BODY_SIZE).text(`Date: ${blank ? '____________' : formatDateNo(date)}`, MARGIN, lineY + 8, { width: colWidth });
  doc.moveTo(rightX, lineY).lineTo(rightX + colWidth, lineY).lineWidth(0.8).stroke('#222222');
  doc.text('Date: ____________', rightX, lineY + 8, { width: colWidth });

  doc.end();
  return done;
}

/** Same agreement text as the PDF, as sections the client portal can scroll. */
export function contractArticleModel({ client = {}, tierId = '', summary = null, preferSummary = false, mvaIncluded = false, date = new Date(), dueDate = '', alternatives = [], chosenOfferIndex = null } = {}) {
  const dualScopes = Array.isArray(alternatives) && alternatives.length >= 2
    ? resolveAlternativeScopes(alternatives, { mvaIncluded, dueDate })
    : null;
  const scope = dualScopes ? dualScopes[0] : resolveScope({ tierId, summary, preferSummary, mvaIncluded, dueDate });
  const partyName = text(client.businessName) || '[Business name]';
  const partyOrg = formatOrg(client.orgNumber) || '[Org. number]';
  const partyAddress = contractAddressFor(client) || '[Business address]';
  const partyOwner = text(client.contactPerson) || '[Contact person]';
  const partyEmail = text(client.contactEmail) || '[Email]';
  return {
    title: 'Service agreement',
    provider: ASOLDI,
    client: {
      name: partyName,
      orgNumber: partyOrg,
      address: partyAddress,
      signatory: partyOwner,
      email: partyEmail,
    },
    intro: [
      `This Service Agreement ("Agreement") is entered into between ${ASOLDI.legalName} ("Service Provider" or "Asoldi") and ${partyName} ("Client").`,
      'The purpose of this Agreement is to define the terms under which Asoldi provides website development, hosting, maintenance and digital services to the Client under the service scope described in Section 1. The project starts the day the contract is signed by both parties.',
      `The published Terms (${LEGAL_URLS.vilkar}), Privacy Policy (${LEGAL_URLS.personvern}) and Data Processing Agreement (${LEGAL_URLS.databehandleravtale}) form part of this Agreement as they stand on the signing date.`,
    ],
    scope,
    alternativeScopes: dualScopes,
    chosenOfferIndex: chosenOfferIndex === 0 || chosenOfferIndex === 1 ? chosenOfferIndex : null,
    paymentTerms: PAYMENT_TERMS,
    durationTerms: DURATION_TERMS,
    sections: contractBodySections(),
    signedAtLabel: formatDateNo(date),
    asoldiSigned: true,
  };
}

/** Contract inputs for a stored offer: verified summary wins over the plain tier text. */
export function contractInputsForOffer(offer = {}) {
  const summary = offer?.contract?.summary || null;
  const tierId = String(offer?.tierId || '');
  const hasCustomProducts = Array.isArray(offer?.products) && offer.products.some((item) => item?.kind !== 'tier');
  const alternatives = alternativesFromOffer(offer);
  const chosen = offer?.chosenOfferIndex;
  return {
    tierId,
    summary,
    preferSummary: Boolean(summary) && (tierId === CUSTOM_TIER_ID || hasCustomProducts || !tierById(tierId)),
    mvaIncluded: Boolean(offer?.mvaIncluded),
    dueDate: normalizeDueDate(offer?.dueDate),
    alternatives,
    chosenOfferIndex: chosen === 0 || chosen === 1 ? chosen : null,
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
