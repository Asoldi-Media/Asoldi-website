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

function topics(items = []) {
  return items
    .filter((item) => item && (item.title || item.text))
    .map((item) => (
      `${item.title ? `<p><strong>${escapeHtml(item.title)}</strong></p>` : ''}${item.text ? `<p>${escapeHtml(item.text)}</p>` : ''}`
    ))
    .join('');
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
  const dual = Array.isArray(article.alternativeScopes) && article.alternativeScopes.length >= 2;
  function scopeHtml(scope) {
    const scopeBlocks = (scope.blocks || []).map((block) => (
      `${block.lead ? `<p>${escapeHtml(block.lead)}</p>` : ''}${bullets(block.bullets || [])}`
    )).join('');
    return [
      `<p><strong>${escapeHtml(scope.title)}</strong></p>`,
      `<p>${escapeHtml(scope.priceLine)}</p>`,
      scopeBlocks,
      `<p><strong>${escapeHtml(scope.deliverySentence || '')}</strong></p>`,
      bullets(scope.extraTerms || []),
    ].join('');
  }
  const later = (article.sections || []).map((section) => (
    `<h2>${escapeHtml(section.heading)}</h2>${paragraphs(section.paragraphs || [])}${bullets(section.bullets || [])}${numbered(section.numbered || [])}${topics(section.topics || [])}${paragraphs(section.after || [])}`
  )).join('');
  const scopeSection = dual
    ? [
      '<p>The Client is offered the following alternative service scopes. The Client selects Tilbud 1 or Tilbud 2 at signing.</p>',
      ...article.alternativeScopes.map((scope, index) => (
        `<p><strong>Tilbud ${index + 1}</strong></p>${scopeHtml(scope)}`
      )),
    ].join('')
    : [
      `<p>${escapeHtml(article.scope.heading)}</p>`,
      scopeHtml(article.scope),
    ].join('');
  const choiceNote = dual
    ? '<p>Choose Tilbud 1 or Tilbud 2 below, then accept the agreement in the client portal.</p>'
    : '<p>The client signs this agreement in the client portal by clicking “Jeg aksepterer avtalen”.</p>';
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
    scopeSection,
    '<p>All prices are stated per month excluding VAT unless the offer says the price includes VAT. The service is a running monthly subscription covering development, hosting and maintenance.</p>',
    '<h2>2. Payment terms</h2>',
    numbered(article.paymentTerms),
    '<h2>3. Contract duration and cancellation</h2>',
    numbered(article.durationTerms),
    later,
    '<h2>Contract and scope signing</h2>',
    '<p>By signing below, both parties agree to all terms stated in this Agreement.</p>',
    dual ? '<p><strong>Chosen scope:</strong> Tilbud 1 or Tilbud 2.</p>' : '',
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
    choiceNote,
    '</section>',
    '</div>',
    '</article>',
  ].join('');
}
