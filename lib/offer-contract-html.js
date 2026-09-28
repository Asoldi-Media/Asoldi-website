import { contractArticleModel, contractInputsForOffer, offerContractIsAvailable } from './offer-contract-pdf.js';

function escapeHtml(value = '') {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function paragraphs(items = []) {
  return items.filter(Boolean).map((item) => `<p>${escapeHtml(item)}</p>`).join('');
}

function bullets(items = []) {
  if (!items.length) return '';
  return `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`;
}

function numbered(items = []) {
  if (!items.length) return '';
  return `<ol>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ol>`;
}

function partyDl(rows = []) {
  const items = rows
    .filter((row) => row && row.value)
    .map((row) => `<div><dt>${escapeHtml(row.label)}</dt><dd>${escapeHtml(row.value)}</dd></div>`)
    .join('');
  return items ? `<dl>${items}</dl>` : '';
}

export function contractHtmlForOffer(offer, client = {}) {
  if (!offerContractIsAvailable(offer)) return '';
  const inputs = contractInputsForOffer(offer);
  const date = offer.sentAt || offer.updatedAt || offer.createdAt || new Date();
  const article = contractArticleModel({ client, ...inputs, date });
  const scopeBlocks = (article.scope.blocks || []).map((block) => (
    `${block.lead ? `<p>${escapeHtml(block.lead)}</p>` : ''}${bullets(block.bullets || [])}`
  )).join('');
  const later = (article.sections || []).map((section) => (
    `<h2>${escapeHtml(section.heading)}</h2>${paragraphs(section.paragraphs || [])}${bullets(section.bullets || [])}${numbered(section.numbered || [])}${paragraphs(section.after || [])}`
  )).join('');
  return [
    '<article class="offer-contract">',
    '<header class="offer-contract-masthead">',
    `<p class="offer-contract-kicker">${escapeHtml(article.provider.legalName)}</p>`,
    '<h1>Service agreement</h1>',
    '<p class="offer-contract-sub">Website development, hosting and maintenance</p>',
    `<p class="offer-contract-date">Date: ${escapeHtml(article.signedAtLabel)}</p>`,
    '</header>',
    '<div class="offer-contract-parties">',
    '<section>',
    '<h2>Service provider</h2>',
    partyDl([
      { label: 'Company', value: article.provider.legalName },
      { label: 'Org. nr.', value: article.provider.orgNumber },
      { label: 'Address', value: article.provider.address },
      { label: 'Email', value: article.provider.email },
    ]),
    '</section>',
    '<section>',
    '<h2>Client</h2>',
    partyDl([
      { label: 'Company', value: article.client.name },
      { label: 'Org. nr.', value: article.client.orgNumber },
      { label: 'Address', value: article.client.address },
      { label: 'Signatory', value: article.client.signatory },
      { label: 'Email', value: article.client.email },
    ]),
    '</section>',
    '</div>',
    paragraphs(article.intro),
    '<h2>1. Service scope</h2>',
    `<p>${escapeHtml(article.scope.heading)}</p>`,
    `<p><strong>${escapeHtml(article.scope.title)}</strong></p>`,
    `<p>${escapeHtml(article.scope.priceLine)}</p>`,
    scopeBlocks,
    `<p><strong>Delivery time: ${escapeHtml(String(article.scope.deliveryWeeks))} weeks from project start.</strong></p>`,
    bullets(article.scope.extraTerms || []),
    '<p>All prices are stated per month excluding VAT unless the offer says the price includes VAT. The service is a running monthly subscription covering development, hosting and maintenance.</p>',
    '<h2>2. Payment terms</h2>',
    numbered(article.paymentTerms),
    '<h2>3. Contract duration and cancellation</h2>',
    numbered(article.durationTerms),
    later,
    '<h2>Contract and scope signing</h2>',
    '<p>By signing below, both parties agree to all terms stated in this Agreement.</p>',
    '<div class="offer-contract-sign">',
    '<section>',
    `<h2>For ${escapeHtml(article.provider.legalName)}</h2>`,
    '<p class="offer-contract-sign-label">Signature:</p>',
    '<div class="offer-contract-sign-line">',
    '<img class="offer-contract-stamp" src="/asoldi-contract-signature.png" alt="Asoldi signature" />',
    '</div>',
    `<p class="offer-contract-sign-date">Date: ${escapeHtml(article.signedAtLabel)}</p>`,
    '</section>',
    '<section>',
    `<h2>For Client (${escapeHtml(article.client.name)})</h2>`,
    `<p class="offer-contract-sign-label">Signature (${escapeHtml(article.client.signatory)}):</p>`,
    '<div class="offer-contract-sign-line offer-contract-sign-line--empty"></div>',
    '<p class="offer-contract-sign-date">Date: ____________</p>',
    '<p>The client signs this agreement in the client portal by clicking “Jeg aksepterer avtalen”.</p>',
    '</section>',
    '</div>',
    '</article>',
  ].join('');
}
