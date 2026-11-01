/**
 * Builds the asoldi.delivery-brief/1 envelope from the gathered sources (sources.js), the reduced
 * extraction (reduce.js) and the stored reviews (store.js). Pure: no I/O, no clock except `now`.
 *
 * Precedence of facts, highest first: a developer review with a value, client data (Kundedata in
 * the portal), the transcript (iteration > workshop > demo > sales, decided in reduce.js), then the
 * sales card as a fallback. Product catalogs come only from Kundedata.
 *
 * The brief never carries transcript text: transcripts are referenced by sha256, quotes are short,
 * and a final pass clips any string that repeats 20 words in a row from a transcript.
 */
import { BRIEF_FACTS_SCHEMA_ID, DELIVERY_BRIEF_SCHEMA_ID } from './facts-contract.js';
import { LIST_FACT_PATHS } from './extract.js';
import { MAX_BRIEF_BYTES, storedBytes } from './store.js';
import { isPlainObject, isoOrEmpty, text } from './text.js';

export const MAX_TRANSCRIPT_RUN_WORDS = 19;
const RUN_WORDS = MAX_TRANSCRIPT_RUN_WORDS + 1;
const LIST_PATHS = new Set(LIST_FACT_PATHS);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const URL_RE = /https?:\/\/[^\s)>\]"']+/i;
const CASES = { upper: 'upper', uppercase: 'upper', store: 'upper', lower: 'lower', lowercase: 'lower', små: 'lower', title: 'title', capitalize: 'title', 'as-is': 'as-is' };
const WEIGHTS = { light: 300, regular: 400, normal: 400, medium: 500, semibold: 600, bold: 700, fet: 700, black: 900 };
const SPACING = { none: 0, tight: -0.01, normal: 0.02, wide: 0.12, wider: 0.24 };
const TRUE_WORDS = new Set(['true', 'ja', 'yes', '1', 'kun nett', 'online']);

function emptyFacts(language) {
  return {
    schema: BRIEF_FACTS_SCHEMA_ID,
    language,
    identity: { brandName: '', legalName: '', orgNumber: '' },
    logo: { status: 'unknown', mediaId: null, wordmarkSpec: null },
    contact: { email: '', scope: '', phone: '', address: '', town: '', addressVisibility: '', serviceArea: '' },
    socials: {},
    importantLinks: [],
    positioning: { businessWhat: '', services: [], audience: '', differentiators: [], priorities: [], brandCues: [], toneOfVoice: '', story: '' },
    claims: { stats: [], awards: [], certifications: [], guarantees: [], regulated: { domain: '', approvedClaims: [], mentions: [] } },
    products: { catalogs: [], focusProductId: null, productFacts: [], salesStatus: '' },
    shop: { shipping: '', returns: '' },
    timeline: { targetLaunchAt: '' },
    content: { density: '', structure: '', pagesRequested: [], pagesExcluded: [], keepAsIs: [], mediaPlan: '', reuseOldSite: { url: '', quote: '' } },
    previewFeedback: [],
    media: { manifest: [] },
  };
}

function setPath(target, path, value) {
  const keys = path.split('.');
  let node = target;
  for (const key of keys.slice(0, -1)) {
    if (!isPlainObject(node[key])) node[key] = {};
    node = node[key];
  }
  node[keys[keys.length - 1]] = value;
}

function getPath(target, path) {
  return path.split('.').reduce((node, key) => (isPlainObject(node) ? node[key] : undefined), target);
}

function transcriptSource(item) {
  return {
    kind: 'transcript',
    quote: item.quote,
    meetingId: item.meetingId,
    purpose: item.purpose,
    speaker: item.speaker,
    confidence: item.confidence,
    status: 'proposed',
    quoteVerified: true,
    factId: item.id,
  };
}

function shortSource(item) {
  return { kind: 'transcript', meeting: item.purpose, meetingId: item.meetingId, quote: item.quote, speaker: item.speaker };
}

function boolOf(value) {
  if (typeof value === 'boolean') return value;
  return TRUE_WORDS.has(text(value).toLowerCase());
}

function wordmarkFrom(facts) {
  if (!isPlainObject(facts.logo.wordmarkSpec)) facts.logo.wordmarkSpec = { text: '', case: 'as-is', weight: 700, letterSpacingEm: 0.02 };
  return facts.logo.wordmarkSpec;
}

/** Applies one single-valued transcript fact. */
function applySingleFact(facts, factSources, item) {
  const { path, value } = item;
  switch (path) {
    case 'logo.wordmarkSpec.text':
      wordmarkFrom(facts).text = text(value, 120);
      wordmarkFrom(facts).source = shortSource(item);
      break;
    case 'logo.wordmarkSpec.case':
      wordmarkFrom(facts).case = CASES[text(value).toLowerCase()] || 'as-is';
      break;
    case 'logo.wordmarkSpec.weight': {
      const number = Number.parseInt(value, 10);
      wordmarkFrom(facts).weight = Number.isFinite(number) && number >= 100 && number <= 900 ? Math.round(number / 100) * 100 : WEIGHTS[text(value).toLowerCase()] || 700;
      break;
    }
    case 'logo.wordmarkSpec.letterSpacing': {
      const word = text(value).toLowerCase();
      const number = Number.parseFloat(word);
      wordmarkFrom(facts).letterSpacingEm = Object.prototype.hasOwnProperty.call(SPACING, word) ? SPACING[word] : Number.isFinite(number) ? number : 0.02;
      break;
    }
    case 'contact.onlineOnly':
      facts.contact.onlineOnly = boolOf(value);
      break;
    case 'contact.addressVisibility': {
      const visibility = text(value).toLowerCase();
      facts.contact.addressVisibility = ['full', 'town-only', 'hidden'].includes(visibility) ? visibility : '';
      break;
    }
    case 'timeline.targetLaunchAt':
      if (!DATE_RE.test(text(value))) return false;
      facts.timeline.targetLaunchAt = text(value);
      break;
    case 'content.reuseOldSite':
      facts.content.reuseOldSite = { url: (URL_RE.exec(String(value)) || [''])[0], quote: item.quote };
      break;
    case 'products.focusProduct':
      facts.products.focusProduct = text(value, 200);
      break;
    default:
      setPath(facts, path, text(value, 500));
  }
  factSources[path] = transcriptSource(item);
  if (path.startsWith('logo.wordmarkSpec')) facts.logo.status = facts.logo.status === 'present' ? 'present' : 'text-logo';
  return true;
}

/** Applies one list transcript fact; returns its key in factSources. */
function applyListFact(facts, factSources, item) {
  const { path, value } = item;
  let list;
  let entry;
  switch (path) {
    case 'claims.stats':
      list = facts.claims.stats;
      entry = { id: item.id, value: Number(item.number), unit: text(item.unit, 40), label: text(item.label, 120), status: 'proposed', quoteVerified: true, source: shortSource(item) };
      break;
    case 'claims.regulated':
      list = facts.claims.regulated.mentions;
      entry = { text: text(value, 300), quote: item.quote, meetingId: item.meetingId };
      break;
    case 'products.productFacts':
      list = facts.products.productFacts;
      entry = { text: text(value, 300), quote: item.quote, meetingId: item.meetingId };
      break;
    case 'importantLinks':
      list = facts.importantLinks;
      entry = { label: text(value.replace(URL_RE, ''), 120) || text(value, 120), url: (URL_RE.exec(String(value)) || [''])[0], placement: 'header', quote: item.quote };
      break;
    case 'previewFeedback':
      list = facts.previewFeedback;
      entry = { text: text(value, 300), quote: item.quote, meetingId: item.meetingId };
      break;
    default:
      list = getPath(facts, path);
      if (!Array.isArray(list)) {
        list = [];
        setPath(facts, path, list);
      }
      if (list.some((existing) => text(existing).toLowerCase() === text(value).toLowerCase())) return '';
      entry = text(value, 300);
  }
  list.push(entry);
  const key = `${path}[${list.length - 1}]`;
  factSources[key] = transcriptSource(item);
  return key;
}

/** Client data from the portal (Kundedata): wins over transcript facts. */
function applyClientData(facts, factSources, bank) {
  const general = bank?.generalInfo || {};
  const questions = bank?.websiteCreatorQuestions || {};
  const set = (path, value, extra = null) => {
    const clean = typeof value === 'string' ? text(value, 500) : value;
    if (clean === '' || clean === null || clean === undefined) return;
    setPath(facts, path, clean);
    if (extra) for (const [key, other] of Object.entries(extra)) setPath(facts, key, other);
    factSources[path] = { kind: 'client', status: 'client-confirmed' };
  };
  set('identity.brandName', general.companyName || bank?.businessCard?.companyName);
  set('identity.orgNumber', bank?.brandIdentity?.orgNumber);
  set('contact.email', text(general.companyEmail).toLowerCase(), { 'contact.scope': 'public' });
  set('contact.phone', general.companyPhone);
  set('contact.address', general.companyAddress);
  set('contact.town', questions.town);
  set('socials.instagram', general.instagramUrl);
  set('socials.facebook', general.facebookUrl);
  set('positioning.businessWhat', questions.businessWhat);
  set('positioning.audience', questions.targetAudience);
  set('positioning.toneOfVoice', questions.toneOfVoice);
  set('positioning.story', questions.businessStory);
  const differentiator = text(questions.differentiator, 300);
  if (differentiator && !facts.positioning.differentiators.some((entry) => text(entry).toLowerCase() === differentiator.toLowerCase())) {
    facts.positioning.differentiators.unshift(differentiator);
    // Indexes of transcript differentiators moved by one.
    for (const key of Object.keys(factSources).filter((name) => name.startsWith('positioning.differentiators[')).sort().reverse()) {
      const index = Number(/\[(\d+)\]/.exec(key)[1]);
      factSources[`positioning.differentiators[${index + 1}]`] = factSources[key];
      delete factSources[key];
    }
    factSources['positioning.differentiators[0]'] = { kind: 'client', status: 'client-confirmed' };
  }
  for (const link of Array.isArray(general.extraLinks) ? general.extraLinks : []) {
    const url = text(link?.url, 500);
    if (!url) continue;
    facts.importantLinks.push({ label: text(link?.name, 120), url, placement: 'header' });
    factSources[`importantLinks[${facts.importantLinks.length - 1}]`] = { kind: 'client', status: 'client-confirmed' };
  }
  const catalogs = Array.isArray(bank?.productCatalogs) ? bank.productCatalogs.filter(isPlainObject) : [];
  facts.products.catalogs = catalogs;
  if (catalogs.length) factSources['products.catalogs'] = { kind: 'client', status: 'client-confirmed' };
}

/** Sales-card values only fill what nothing else gave. */
function applyCardFallbacks(facts, factSources, client) {
  const fill = (path, value) => {
    const clean = text(value, 300);
    if (!clean || text(getPath(facts, path))) return;
    setPath(facts, path, clean);
    factSources[path] = { kind: 'client', status: 'proposed' };
  };
  fill('identity.brandName', client?.brandName || client?.businessName);
  fill('identity.legalName', client?.legalName || client?.businessName);
  fill('identity.orgNumber', client?.orgNumber);
}

function reviewFor(reviews, ...keys) {
  for (const key of keys) {
    const review = reviews?.facts?.[key];
    if (isPlainObject(review)) return review;
  }
  return null;
}

/** Developer reviews: status on every reviewed fact, a value where one was given, rejected values removed. */
function applyFactReviews(facts, factSources, reviews) {
  for (const [key, source] of Object.entries(factSources)) {
    const review = reviewFor(reviews, key, source.factId);
    if (!review) continue;
    source.status = review.status;
    source.reviewedBy = text(review.by, 120);
    source.reviewedAt = isoOrEmpty(review.at);
    const match = /^([a-zA-Z.]+)\[(\d+)\]$/.exec(key);
    if (match && match[1] === 'claims.stats') {
      const stat = facts.claims.stats[Number(match[2])];
      if (stat) stat.status = review.status;
      continue;
    }
    if (review.status === 'rejected' && !match && source.kind === 'transcript') setPath(facts, key, typeof getPath(facts, key) === 'boolean' ? false : '');
  }
  for (const [key, review] of Object.entries(reviews?.facts || {})) {
    if (!isPlainObject(review) || review.value === undefined || /\[\d+\]$/.test(key) || /^f-/.test(key)) continue;
    if (LIST_PATHS.has(key)) continue;
    setPath(facts, key, review.value);
    factSources[key] = { ...(factSources[key] || {}), kind: factSources[key]?.kind || 'admin', status: review.status, reviewedBy: text(review.by, 120), reviewedAt: isoOrEmpty(review.at) };
  }
}

function directiveOf(item, reviews) {
  const review = isPlainObject(reviews?.directives?.[item.id]) ? reviews.directives[item.id] : null;
  const superseded = item.status === 'superseded';
  return {
    id: item.id,
    kind: item.kind,
    target: {
      scope: item.scope || 'section',
      area: item.area,
      route: item.route || null,
      pageKind: item.pageKind || null,
      sectionKind: item.sectionKind || null,
    },
    ask: item.ask,
    quote: item.quote,
    meetingId: item.meetingId,
    source: item.purpose,
    speaker: item.speaker,
    confidence: item.confidence,
    priority: item.priority || 'should',
    status: superseded ? 'superseded' : review?.status || 'open',
    ...(superseded ? { supersededBy: item.supersededBy } : {}),
    reviewedBy: text(review?.by, 120),
    reviewedAt: isoOrEmpty(review?.at),
    appliedInJobs: Array.isArray(review?.appliedInJobs) ? review.appliedInJobs.map((job) => text(job, 120)).filter(Boolean) : [],
  };
}

function iterationOf(item, reviews) {
  const review = isPlainObject(reviews?.directives?.[item.id]) ? reviews.directives[item.id] : null;
  const superseded = item.status === 'superseded';
  return {
    id: item.id,
    area: item.area,
    route: item.route || null,
    ask: item.ask,
    keepAsIs: item.keepAsIs === true,
    quote: item.quote,
    meetingId: item.meetingId,
    speaker: item.speaker,
    status: superseded ? 'superseded' : review?.status || 'open',
    ...(superseded ? { supersededBy: item.supersededBy } : {}),
  };
}

function availability(availabilityOf, featureKey) {
  if (!featureKey || typeof availabilityOf !== 'function') return 'unknown';
  try {
    const value = text(availabilityOf(featureKey));
    return ['available', 'partial', 'missing'].includes(value) ? value : 'unknown';
  } catch {
    return 'unknown';
  }
}

function projectItems(doc) {
  const todos = [];
  const openDecisions = [];
  const outOfScope = [];
  for (const row of Array.isArray(doc?.todos) ? doc.todos : []) {
    if (!isPlainObject(row)) continue;
    const item = { id: text(row.id, 80), category: text(row.category, 60), title: text(row.title, 180), detail: text(row.detail, 800), done: row.done === true };
    if (item.category === 'Åpne beslutninger') openDecisions.push(item);
    else if (item.category === 'Utenfor scope') outOfScope.push(item);
    else todos.push(item);
  }
  return { todos, openDecisions, outOfScope };
}

function offerView(offer, sitePlan) {
  if (!isPlainObject(offer)) return null;
  const alternatives = Array.isArray(offer.alternatives) ? offer.alternatives : [];
  const chosenIndex = offer.chosenOfferIndex === 0 || offer.chosenOfferIndex === 1 ? offer.chosenOfferIndex : null;
  const chosen = alternatives[chosenIndex ?? 0] || null;
  const products = Array.isArray(chosen?.products) ? chosen.products : Array.isArray(offer.products) ? offer.products : [];
  const includes = [];
  for (const product of products) {
    for (const entry of [product?.name, ...(Array.isArray(product?.includes) ? product.includes : [])]) {
      const value = text(entry, 160);
      if (value && !includes.includes(value)) includes.push(value);
    }
  }
  const summary = isPlainObject(offer.contract?.summary) ? offer.contract.summary : null;
  const intent = isPlainObject(offer.clientIntent) ? offer.clientIntent : null;
  return {
    id: text(offer.id, 80),
    status: text(offer.status, 40),
    acceptedAt: sitePlan && text(sitePlan.offerId) === text(offer.id) ? isoOrEmpty(sitePlan.signedAt) : '',
    title: text(summary?.title || products[0]?.name, 160),
    includes: includes.slice(0, 40),
    contractSummary: text(summary?.scopeSummary, 1200),
    ...(alternatives.length >= 2
      ? { alternatives: alternatives.slice(0, 2).map((alternative, index) => ({ index, tierId: text(alternative?.tierId, 40), title: text(alternative?.products?.[0]?.name, 160), chosen: chosenIndex === index })) }
      : {}),
    clientIntent: intent ? { headline: text(intent.headline, 280), wants: (Array.isArray(intent.wants) ? intent.wants : []).map((want) => text(want, 200)).filter(Boolean).slice(0, 8) } : null,
  };
}

function sitePlanView(plan) {
  if (!isPlainObject(plan)) return null;
  return {
    tierId: text(plan.tierId, 40),
    services: Array.isArray(plan.services) ? plan.services.map((service) => text(service, 40)) : [],
    pages: Math.max(0, Math.round(Number(plan.pages) || 0)),
    billing: plan.billing === 'once' ? 'once' : 'month',
    catalogType: plan.catalogType || null,
    languages: Array.isArray(plan.languages) ? plan.languages.map((lang) => text(lang, 10)).filter(Boolean) : [],
    signedAt: isoOrEmpty(plan.signedAt),
  };
}

function notes(items, type) {
  return items.filter((item) => item.type === type && item.status === 'active').map((item) => ({
    id: item.id,
    text: item.text,
    quote: item.quote,
    meetingId: item.meetingId,
    speaker: item.speaker,
  }));
}

// ---------------------------------------------------------------- transcript runs

const WORD_RE = /[\p{L}\p{N}]+/gu;

function wordsWithEnds(value) {
  const nfc = String(value).normalize('NFC');
  const out = [];
  WORD_RE.lastIndex = 0;
  let match;
  while ((match = WORD_RE.exec(nfc))) out.push({ word: match[0].toLowerCase(), end: match.index + match[0].length });
  return { nfc, words: out };
}

/** Every run of RUN_WORDS consecutive words in the transcripts. */
export function transcriptRunSet(transcripts, runWords = RUN_WORDS) {
  const set = new Set();
  for (const transcript of transcripts) {
    const { words } = wordsWithEnds(transcript);
    for (let i = 0; i + runWords <= words.length; i += 1) set.add(words.slice(i, i + runWords).map((entry) => entry.word).join(' '));
  }
  return set;
}

function clipString(value, runs, runWords) {
  const { nfc, words } = wordsWithEnds(value);
  if (words.length < runWords) return { value, clipped: false };
  for (let i = 0; i + runWords <= words.length; i += 1) {
    if (runs.has(words.slice(i, i + runWords).map((entry) => entry.word).join(' '))) {
      return { value: `${nfc.slice(0, words[i + runWords - 2].end)}…`, clipped: true };
    }
  }
  return { value, clipped: false };
}

/** Clips every string in `value` that repeats RUN_WORDS words in a row from a transcript. Returns { value, clipped }. */
export function clipTranscriptRuns(value, transcripts, { runWords = RUN_WORDS } = {}) {
  const runs = transcriptRunSet(transcripts, runWords);
  let clipped = 0;
  const walk = (node) => {
    if (typeof node === 'string') {
      if (!runs.size) return node;
      const result = clipString(node, runs, runWords);
      if (result.clipped) clipped += 1;
      return result.value;
    }
    if (Array.isArray(node)) return node.map(walk);
    if (!isPlainObject(node)) return node;
    const out = {};
    for (const [key, child] of Object.entries(node)) out[key] = walk(child);
    return out;
  };
  return { value: walk(value), clipped };
}

// ---------------------------------------------------------------- size

/** Drops the least useful parts until the stored brief fits `maxBytes`. Returns the list of steps taken. */
export function fitBriefSize(brief, maxBytes = MAX_BRIEF_BYTES - 8 * 1024) {
  const steps = [];
  const fits = () => storedBytes(brief) <= maxBytes;
  const trims = [
    ['superseded', () => {
      brief.directives = brief.directives.filter((item) => item.status !== 'superseded');
      brief.iterations = brief.iterations.filter((item) => item.status !== 'superseded');
    }],
    ['notes', () => {
      brief.followUps = brief.followUps.slice(0, 30);
      brief.approvalSignals = brief.approvalSignals.slice(0, 20);
      brief.requests = brief.requests.slice(0, 20);
      brief.openQuestions = brief.openQuestions.slice(0, 30);
    }],
    ['media', () => {
      brief.facts.media.manifest = brief.facts.media.manifest.slice(0, 200);
    }],
    ['lists', () => {
      brief.directives = brief.directives.slice(0, 200);
      brief.iterations = brief.iterations.slice(0, 100);
      brief.promises = brief.promises.slice(0, 100);
      brief.facts.previewFeedback = brief.facts.previewFeedback.slice(0, 50);
      brief.facts.products.productFacts = brief.facts.products.productFacts.slice(0, 50);
    }],
    ['catalogs', () => {
      // The Maker reads catalogs from the CMS setup or the client data when the brief has none.
      brief.facts.products.catalogs = [];
    }],
    ['hard', () => {
      brief.directives = brief.directives.slice(0, 60);
      brief.iterations = brief.iterations.slice(0, 30);
      brief.facts.media.manifest = brief.facts.media.manifest.slice(0, 50);
    }],
  ];
  for (const [name, trim] of trims) {
    if (fits()) break;
    trim();
    steps.push(name);
  }
  return steps;
}

// ---------------------------------------------------------------- the envelope

/**
 * @param {object} input
 * @param {object} input.client       the sales client record
 * @param {object} input.sources      gatherBriefSources() result
 * @param {object} input.extraction   { items (reduced), meetings: [{meetingId, chunks, droppedUnverified, droppedInvalid, costUsd, routes}], durationMs }
 * @param {object} input.reviews      readReviews() result
 * @param {Date}   [input.now]
 * @returns the brief without version and hash (store.saveBrief adds them)
 */
export function assembleBrief({ client, sources, extraction = {}, reviews = {}, now = new Date() }) {
  const items = Array.isArray(extraction.items) ? extraction.items : [];
  const active = items.filter((item) => item.status !== 'superseded');
  const language = text(client?.language, 10) || 'no';
  const facts = emptyFacts(language);
  const factSources = {};

  for (const item of active.filter((entry) => entry.type === 'fact')) {
    if (LIST_PATHS.has(item.path)) applyListFact(facts, factSources, item);
    else applySingleFact(facts, factSources, item);
  }
  applyClientData(facts, factSources, sources.bank);
  applyCardFallbacks(facts, factSources, client);
  applyFactReviews(facts, factSources, reviews);
  facts.media.manifest = Array.isArray(sources.media) ? sources.media : [];
  if (facts.media.manifest.some((item) => /logo/i.test(item.bucket))) facts.logo.status = 'present';
  else if (facts.logo.status === 'unknown') facts.logo.status = facts.logo.wordmarkSpec ? 'text-logo' : 'missing';
  const cmsSetup = isPlainObject(sources.cmsSetup) ? structuredClone(sources.cmsSetup) : null;
  if (isPlainObject(cmsSetup?.seller)) {
    if (!text(cmsSetup.seller.legalName)) cmsSetup.seller.legalName = facts.identity.legalName;
    if (!text(cmsSetup.seller.orgNumber)) cmsSetup.seller.orgNumber = facts.identity.orgNumber;
  }

  const promises = active.filter((item) => item.type === 'promise').map((item) => ({
    id: item.id,
    featureKey: item.featureKey || '',
    text: item.text,
    quote: item.quote,
    meetingId: item.meetingId,
    speaker: item.speaker,
    availability: availability(sources.availabilityOf, item.featureKey),
  }));
  const unbuiltPromises = [...new Set(promises.filter((item) => ['partial', 'missing'].includes(item.availability)).map((item) => item.featureKey))].sort();
  const project = projectItems(sources.projectDocument);
  const targetLaunchAt = DATE_RE.test(facts.timeline.targetLaunchAt) ? facts.timeline.targetLaunchAt : DATE_RE.test(text(client?.websiteDueOverride)) ? text(client.websiteDueOverride) : '';
  const targetLaunchSource = DATE_RE.test(facts.timeline.targetLaunchAt) ? factSources['timeline.targetLaunchAt']?.kind || 'transcript' : targetLaunchAt ? 'due-override' : '';

  const meetingStats = Array.isArray(extraction.meetings) ? extraction.meetings : [];
  const routes = [...new Set(meetingStats.flatMap((meeting) => meeting.routes || []))].sort();
  const chunkTotals = meetingStats.reduce((sum, meeting) => {
    for (const key of ['total', 'cached', 'extracted', 'failed', 'skipped']) sum[key] = (sum[key] || 0) + (Number(meeting.chunks?.[key]) || 0);
    return sum;
  }, {});

  let brief = {
    schema: DELIVERY_BRIEF_SCHEMA_ID,
    generatedAt: now.toISOString(),
    salesClientId: text(client?.id),
    inputs: {
      meetings: sources.parts.meetings,
      offerHash: sources.offerHash || '',
      planHash: sources.parts.plan || '',
      bankRevision: sources.parts.bank || '',
      gateHash: sources.gate?.inputHash || sources.parts.gate || '',
      reviewsRevision: Number(reviews?.revision) || 0,
      seoRevision: sources.seo?.revision || sources.parts.seo || '',
      promptHash: sources.promptHash || '',
      inputHash: sources.inputHash || '',
    },
    sitePlan: sitePlanView(sources.sitePlan),
    offer: offerView(sources.offer, sources.sitePlan),
    facts,
    factSources,
    directives: items.filter((item) => item.type === 'directive').map((item) => directiveOf(item, reviews)),
    iterations: items.filter((item) => item.type === 'iteration').map((item) => iterationOf(item, reviews)),
    clientApproved: Boolean(text(cmsSetup?.approval?.clientApprovedAt)),
    changeRequests: Array.isArray(sources.changeRequests) ? sources.changeRequests : [],
    todos: project.todos,
    openDecisions: project.openDecisions,
    outOfScope: project.outOfScope,
    transcripts: sources.meetings.map((meeting) => ({ meetingId: meeting.meetingId, purpose: meeting.purpose, startedAt: isoOrEmpty(meeting.startedAt), sha256: meeting.sha256, chars: meeting.chars })),
    promises,
    unbuiltPromises,
    followUps: active.filter((item) => item.type === 'followUp').map((item) => ({
      id: item.id,
      dueAt: text(item.dueAt, 40),
      who: text(item.who, 120),
      channel: text(item.channel, 40),
      text: item.text,
      quote: item.quote,
      meetingId: item.meetingId,
      confidence: item.confidence,
    })),
    approvalSignals: notes(items, 'approvalSignal'),
    requests: active.filter((item) => item.type === 'request').map((item) => ({ id: item.id, kind: item.kind, text: item.text, quote: item.quote, meetingId: item.meetingId, speaker: item.speaker })),
    openQuestions: notes(items, 'openQuestion'),
    seo: { agreedKeywords: Array.isArray(sources.seo?.agreedKeywords) ? sources.seo.agreedKeywords : [] },
    cmsSetup,
    gate: sources.gate ? { devComplete: sources.gate.devComplete, missingDev: sources.gate.missingDev, inputHash: sources.gate.inputHash, lines: sources.gate.lines } : null,
    delivery: { stage: text(client?.delivery?.stage, 40), targetLaunchAt, targetLaunchSource },
    stats: {
      extractedItems: Number(extraction.extractedItems) || items.length,
      keptItems: active.length,
      droppedUnverifiedQuotes: meetingStats.reduce((sum, meeting) => sum + (Number(meeting.droppedUnverified) || 0), 0),
      droppedInvalid: meetingStats.reduce((sum, meeting) => sum + (Number(meeting.droppedInvalid) || 0), 0),
      supersededItems: items.length - active.length,
      costUsd: Math.round(meetingStats.reduce((sum, meeting) => sum + (Number(meeting.costUsd) || 0), Number(extraction.mergeUsd) || 0) * 1e6) / 1e6,
      route: routes.join('|'),
      chunks: chunkTotals,
      durationMs: Math.max(0, Math.round(Number(extraction.durationMs) || 0)),
      bytes: 0,
      clipped: 0,
    },
  };

  const clipped = clipTranscriptRuns(brief, sources.meetings.map((meeting) => meeting.transcript));
  brief = clipped.value;
  brief.stats.clipped = clipped.clipped;
  const trimmed = fitBriefSize(brief);
  if (trimmed.length) brief.stats.trimmed = trimmed;
  brief.stats.bytes = storedBytes(brief);
  return brief;
}
