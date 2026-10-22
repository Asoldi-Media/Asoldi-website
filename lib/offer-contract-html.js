import { contractCopy } from './offer-contract-copy.js';
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
  const inputs = contractInputsForOffer(offer, client);
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
  const t = article.copy || contractCopy(article.language);
  const later = (article.sections || []).map((section) => (
    `<h2>${escapeHtml(section.heading)}</h2>${paragraphs(section.paragraphs || [])}${bullets(section.bullets || [])}${numbered(section.numbered || [])}${topics(section.topics || [])}${paragraphs(section.after || [])}`
  )).join('');
  const scopeSection = dual
    ? [
      `<p>${escapeHtml(t.dualIntro)}</p>`,
      ...article.alternativeScopes.map((scope, index) => (
        `<p><strong>Tilbud ${index + 1}</strong></p>${scopeHtml(scope)}`
      )),
    ].join('')
    : [
      `<p>${escapeHtml(article.scope.heading)}</p>`,
      scopeHtml(article.scope),
    ].join('');
  const choiceNote = dual
    ? `<p>${escapeHtml(t.dualChoiceNote)}</p>`
    : `<p>${escapeHtml(t.acceptNote)}</p>`;
  return [
    '<article class="offer-contract">',
    '<header class="offer-contract-masthead">',
    `<p class="offer-contract-kicker">${escapeHtml(article.provider.legalName)}</p>`,
    `<h1>${escapeHtml(t.htmlTitle)}</h1>`,
    `<p class="offer-contract-sub">${escapeHtml(t.htmlSub)}</p>`,
    `<p class="offer-contract-date">${escapeHtml(t.dateLabel)}: ${escapeHtml(article.signedAtLabel)}</p>`,
    '</header>',
    '<div class="offer-contract-parties">',
    '<section>',
    `<h2>${escapeHtml(t.providerHeading)}</h2>`,
    partyDl([
      { label: t.labels.company, value: article.provider.legalName },
      { label: t.labels.org, value: article.provider.orgNumber },
      { label: t.labels.address, value: article.provider.address },
      { label: t.labels.email, value: article.provider.email },
    ]),
    '</section>',
    '<section>',
    `<h2>${escapeHtml(t.clientHeading)}</h2>`,
    partyDl([
      { label: t.labels.company, value: article.client.name },
      { label: t.labels.org, value: article.client.orgNumber },
      { label: t.labels.address, value: article.client.address },
      { label: t.labels.signatory, value: article.client.signatory },
      { label: t.labels.email, value: article.client.email },
    ]),
    '</section>',
    '</div>',
    paragraphs(article.intro),
    `<h2>${escapeHtml(t.scopeHeading)}</h2>`,
    scopeSection,
    `<p>${escapeHtml(t.vatNoteHtml)}</p>`,
    `<h2>${escapeHtml(t.paymentHeading)}</h2>`,
    numbered(article.paymentTerms),
    `<h2>${escapeHtml(t.durationHeading)}</h2>`,
    numbered(article.durationTerms),
    later,
    `<h2>${escapeHtml(t.signHeading)}</h2>`,
    `<p>${escapeHtml(t.signAgree)}</p>`,
    dual ? `<p><strong>${escapeHtml(t.chosenScope)}</strong> ${escapeHtml(t.chosenDual)}</p>` : '',
    '<div class="offer-contract-sign">',
    '<section>',
    `<h2>${escapeHtml(t.forProvider(article.provider.legalName))}</h2>`,
    `<p class="offer-contract-sign-label">${escapeHtml(t.signature)}:</p>`,
    '<div class="offer-contract-sign-line">',
    '<img class="offer-contract-stamp" src="/asoldi-contract-signature.png" alt="Asoldi signature" />',
    '</div>',
    `<p class="offer-contract-sign-date">${escapeHtml(t.dateLabel)}: ${escapeHtml(article.signedAtLabel)}</p>`,
    '</section>',
    '<section>',
    `<h2>${escapeHtml(t.forClient(article.client.name))}</h2>`,
    `<p class="offer-contract-sign-label">${escapeHtml(t.signatureOf(article.client.signatory))}:</p>`,
    '<div class="offer-contract-sign-line offer-contract-sign-line--empty"></div>',
    `<p class="offer-contract-sign-date">${escapeHtml(t.dateLabel)}: ____________</p>`,
    choiceNote,
    '</section>',
    '</div>',
    '</article>',
  ].join('');
}
