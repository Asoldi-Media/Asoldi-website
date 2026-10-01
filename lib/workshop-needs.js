import { existsSync, readFileSync } from 'fs';
import { getDataFilePath, ensurePersistentDataDir, writeDataJson } from '../data/storage-path.js';
import { getClientProfileByUserId } from '../data/client-portal.js';
import { countCatalogProducts, resolvePortalCatalogs } from './client-product-catalog.js';
import { readStoredFirefliesMeeting } from './fireflies-webhook.js';
import { listDamianMailFromClient } from './gmail-readonly.js';

const STORE_PATH = getDataFilePath('workshop-needs.json');
const MAX_QUOTE = 220;
const MAX_WORDING = 500;

const MEDIA_BUCKETS = [
  'mainHeroImages',
  'galleryImages',
  'logos',
  'icons',
  'teamImages',
  'aboutImages',
  'locationImages',
  'illustrationImages',
  'offeringImages',
  'uncategorized',
];

const DEFAULT_OPENING_DAYS = [
  { day: 'Mandag', opensAt: '08:00', closesAt: '16:00', closed: false },
  { day: 'Tirsdag', opensAt: '08:00', closesAt: '16:00', closed: false },
  { day: 'Onsdag', opensAt: '08:00', closesAt: '16:00', closed: false },
  { day: 'Torsdag', opensAt: '08:00', closesAt: '16:00', closed: false },
  { day: 'Fredag', opensAt: '08:00', closesAt: '16:00', closed: false },
  { day: 'Lørdag', opensAt: '10:00', closesAt: '14:00', closed: true },
  { day: 'Søndag', opensAt: '10:00', closesAt: '14:00', closed: true },
];

const PRODUCT_NEED_RE = /meny|menu|katalog|catalog|produktliste|tjenester/i;
const MEDIA_NEED_RE = /galleri|bilder|foto|team/i;
const HOURS_RE = /åpningstid(?:er)?|opening hours|vi har åpent|åpent\s+(?:man|mandag)|man(?:dag)?\s*(?:til|-|–)\s*fre|kl\.?\s*\d{1,2}(?:[:.]\d{2})?\s*(?:[-–]|til)\s*\d{1,2}/i;

const FORMAT_LABELS = {
  mote: 'Møte',
  'sms-ring': 'SMS/ring',
  email: 'E-post',
  sms: 'SMS',
  ring: 'Ring',
};

function sanitize(value = '') {
  return String(value ?? '').trim();
}

function nowIso() {
  return new Date().toISOString();
}

function emptyStore() {
  return { clients: {} };
}

function readStore() {
  ensurePersistentDataDir();
  if (!existsSync(STORE_PATH)) return emptyStore();
  try {
    const parsed = JSON.parse(readFileSync(STORE_PATH, 'utf8'));
    if (parsed && typeof parsed === 'object' && parsed.clients && typeof parsed.clients === 'object') {
      return parsed;
    }
  } catch {
    // Keep an empty store if the sidecar is missing or malformed.
  }
  return emptyStore();
}

function writeStore(store) {
  writeDataJson(STORE_PATH, store && typeof store === 'object' ? store : emptyStore());
}

function emptyClientRecord() {
  return {
    overrides: {},
    gmail: { lastCheckedAt: '', lastMessageId: '', evidence: {} },
    heardFacts: [],
    history: {},
    updatedAt: '',
  };
}

export function readWorkshopNeedsClient(clientId) {
  const id = sanitize(clientId);
  if (!id) return emptyClientRecord();
  const row = readStore().clients[id];
  if (!row || typeof row !== 'object') return emptyClientRecord();
  return {
    ...emptyClientRecord(),
    ...row,
    overrides: row.overrides && typeof row.overrides === 'object' ? row.overrides : {},
    gmail: {
      lastCheckedAt: sanitize(row.gmail?.lastCheckedAt),
      lastMessageId: sanitize(row.gmail?.lastMessageId),
      evidence: row.gmail?.evidence && typeof row.gmail.evidence === 'object' ? row.gmail.evidence : {},
    },
    heardFacts: Array.isArray(row.heardFacts) ? row.heardFacts : [],
    history: row.history && typeof row.history === 'object' ? row.history : {},
  };
}

function writeWorkshopNeedsClient(clientId, record) {
  const id = sanitize(clientId);
  if (!id) return;
  const store = readStore();
  store.clients[id] = {
    ...emptyClientRecord(),
    ...record,
    updatedAt: nowIso(),
  };
  writeStore(store);
}

export function appendHeardFact(clientId, fact = {}) {
  const id = sanitize(clientId);
  if (!id) return null;
  const record = readWorkshopNeedsClient(id);
  const rawId = sanitize(fact.id) || `manual.${Date.now()}`;
  const lineId = rawId.startsWith('heard.') ? rawId : `heard.${rawId}`;
  const entry = {
    id: lineId,
    title: sanitize(fact.title) || 'Hørt, ikke lagret',
    detail: sanitize(fact.detail),
    source: sanitize(fact.source) || 'note',
    quote: sanitize(fact.quote).slice(0, MAX_QUOTE),
    at: sanitize(fact.at) || nowIso(),
  };
  record.heardFacts = [...record.heardFacts.filter((row) => sanitize(row?.id) !== lineId), entry];
  writeWorkshopNeedsClient(id, record);
  return entry;
}

export function patchWorkshopNeedLine(clientId, { lineId, checked, wording } = {}) {
  const id = sanitize(clientId);
  const target = sanitize(lineId);
  if (!id) {
    const error = new Error('Sales client is required.');
    error.status = 400;
    throw error;
  }
  if (!target) {
    const error = new Error('lineId is required.');
    error.status = 400;
    throw error;
  }
  const record = readWorkshopNeedsClient(id);
  const current = record.overrides[target] && typeof record.overrides[target] === 'object'
    ? record.overrides[target]
    : {};
  const next = { ...current };
  if (checked !== undefined) {
    next.checked = Boolean(checked);
    next.checkedAt = next.checked ? nowIso() : '';
  }
  if (wording !== undefined) {
    next.wording = sanitize(wording).slice(0, MAX_WORDING);
  }
  record.overrides[target] = next;
  writeWorkshopNeedsClient(id, record);
  return record;
}

export function persistWorkshopNeedsRefresh(clientId, { lines = [], gmail = {} } = {}) {
  const id = sanitize(clientId);
  if (!id) return readWorkshopNeedsClient(id);
  const record = readWorkshopNeedsClient(id);
  const history = { ...(record.history || {}) };
  for (const line of Array.isArray(lines) ? lines : []) {
    const lineId = sanitize(line?.id);
    if (!lineId) continue;
    history[lineId] = {
      id: lineId,
      bucket: sanitize(line.bucket),
      title: sanitize(line.title),
      detail: sanitize(line.detail),
      source: sanitize(line.source),
      status: sanitize(line.status) || 'open',
    };
  }
  const evidence = { ...(record.gmail.evidence || {}) };
  for (const line of Array.isArray(lines) ? lines : []) {
    if (sanitize(line?.status) !== 'received' || !sanitize(line?.id)) continue;
    evidence[line.id] = {
      quote: sanitize(line.quote).slice(0, MAX_QUOTE),
      mailAt: sanitize(line.mailAt),
      attachmentNames: Array.isArray(line.attachmentNames) ? line.attachmentNames.map(sanitize).filter(Boolean) : [],
      messageId: sanitize(line.messageId),
    };
  }
  record.history = history;
  record.gmail = {
    lastCheckedAt: sanitize(gmail.lastCheckedAt) || record.gmail.lastCheckedAt || nowIso(),
    lastMessageId: sanitize(gmail.lastMessageId) || record.gmail.lastMessageId,
    evidence,
  };
  writeWorkshopNeedsClient(id, record);
  return record;
}

function line({ id, bucket, title, detail = '', source = '', status = 'open', extra = {} }) {
  return {
    id,
    bucket,
    title,
    detail,
    source,
    status,
    ...extra,
  };
}

export function countBankProducts(bank = {}) {
  const resolved = resolvePortalCatalogs({
    productCatalogs: bank?.productCatalogs,
    products: bank?.products,
  });
  return countCatalogProducts(resolved.productCatalogs);
}

function mediaEntryFilled(entry) {
  if (typeof entry === 'string') return Boolean(sanitize(entry));
  if (entry && typeof entry === 'object') {
    return Boolean(sanitize(entry.url || entry.src || entry.path || entry.fileName));
  }
  return false;
}

export function countBankMedia(bank = {}) {
  const media = bank?.media && typeof bank.media === 'object' ? bank.media : {};
  let count = 0;
  for (const key of MEDIA_BUCKETS) {
    const list = Array.isArray(media[key]) ? media[key] : [];
    count += list.filter(mediaEntryFilled).length;
  }
  return count;
}

export function countMakerUploads(uploads = {}) {
  if (!uploads || typeof uploads !== 'object') return 0;
  let count = 0;
  for (const value of Object.values(uploads)) {
    if (Array.isArray(value)) count += value.filter(Boolean).length;
    else if (value) count += 1;
  }
  return count;
}

export function hasKundedataLogo(bank = {}) {
  const normal = sanitize(bank?.brandIdentity?.logos?.normal);
  const mediaLogos = Array.isArray(bank?.media?.logos) ? bank.media.logos.filter(mediaEntryFilled) : [];
  return Boolean(normal) || mediaLogos.length > 0;
}

export function makerDomainFromRun(maker = {}) {
  const run = maker?.run && typeof maker.run === 'object' ? maker.run : maker;
  return sanitize(run?.metadata?.productionDomain || run?.productionDomain || run?.answers?.websiteDomain);
}

export function kundedataDomain(bank = {}) {
  return sanitize(bank?.websiteCreatorQuestions?.websiteDomain);
}

export function hasStoredDomain({ bank = {}, maker = {} } = {}) {
  return Boolean(makerDomainFromRun(maker) || kundedataDomain(bank));
}

function quoteHay(...parts) {
  return parts.map((part) => sanitize(part)).filter(Boolean).join('\n');
}

export function offerImpliesProducts(quote = {}) {
  const selected = Array.isArray(quote?.selected) ? quote.selected.map((entry) => sanitize(entry).toLowerCase()) : [];
  if (selected.includes('ecom')) return true;
  const hay = quoteHay(quote?.customSections, quote?.productNotes, quote?.productGoal);
  return PRODUCT_NEED_RE.test(hay);
}

export function offerImpliesMedia(quote = {}) {
  if (offerImpliesProducts(quote)) return true;
  const hay = quoteHay(quote?.customSections, quote?.productNotes, quote?.productGoal);
  return MEDIA_NEED_RE.test(hay);
}

export function offerImplicationUncertain(quote = {}) {
  if (offerImpliesProducts(quote) || offerImpliesMedia(quote)) return false;
  const hay = quoteHay(quote?.customSections, quote?.productNotes, quote?.productGoal);
  if (!hay) return false;
  return /\b(innhold|seksjon|sider|nettbutikk|shop)\b/i.test(hay) && hay.length >= 12;
}

function openingHoursAreDefault(bank = {}) {
  if (sanitize(bank?.openingHours?.googleBusinessSyncUrl)) return false;
  const days = Array.isArray(bank?.openingHours?.days) ? bank.openingHours.days : [];
  if (days.length !== DEFAULT_OPENING_DAYS.length) return days.length === 0;
  return DEFAULT_OPENING_DAYS.every((expected, index) => {
    const row = days[index] || {};
    return sanitize(row.day) === expected.day
      && sanitize(row.opensAt) === expected.opensAt
      && sanitize(row.closesAt) === expected.closesAt
      && Boolean(row.closed) === expected.closed;
  });
}

export function extractHoursQuote(text = '') {
  const raw = sanitize(text);
  if (!raw || !HOURS_RE.test(raw)) return '';
  const match = raw.match(HOURS_RE);
  if (!match) return '';
  const at = raw.indexOf(match[0]);
  const start = raw.lastIndexOf('.', at);
  const end = raw.indexOf('.', at + match[0].length);
  const sliceStart = start === -1 ? Math.max(0, at - 40) : start + 1;
  const sliceEnd = end === -1 ? Math.min(raw.length, at + 160) : end + 1;
  return sanitize(raw.slice(sliceStart, sliceEnd)).slice(0, MAX_QUOTE);
}

function readWorkshopAction(client = {}) {
  const action = client?.workshopAction;
  if (!action || typeof action !== 'object') return null;
  const name = sanitize(action.name);
  const format = sanitize(action.format);
  const dueAt = sanitize(action.dueAt);
  if (!name && !format && !dueAt) return null;
  return {
    name,
    format,
    dueAt,
    addToCalendar: Boolean(action.addToCalendar),
  };
}

function formatWhen(iso = '') {
  const ms = new Date(iso).getTime();
  if (!Number.isFinite(ms)) return sanitize(iso);
  return new Date(ms).toLocaleString('nb-NO', { timeZone: 'Europe/Oslo' });
}

function formatLabel(format = '') {
  const key = sanitize(format).toLowerCase();
  return FORMAT_LABELS[key] || sanitize(format);
}

function meetingQuoteOf(client = {}) {
  const quote = client?.details?.meetingQuote;
  return quote && typeof quote === 'object' ? quote : {};
}

function isWinner(client = {}) {
  return Boolean(sanitize(client?.myphoner?.leadId) || sanitize(client?.myphoner?.lastWinnerWebhookAt));
}

function clipQuote(text = '') {
  return sanitize(text).replace(/\s+/g, ' ').slice(0, MAX_QUOTE);
}

function sentenceAround(text = '', needle = '') {
  const raw = sanitize(text);
  const match = sanitize(needle);
  if (!raw) return '';
  const at = match ? raw.toLowerCase().indexOf(match.toLowerCase()) : 0;
  if (at < 0) return clipQuote(raw);
  const start = raw.lastIndexOf('.', at);
  const end = raw.indexOf('.', at + match.length);
  const sliceStart = start === -1 ? Math.max(0, at - 50) : start + 1;
  const sliceEnd = end === -1 ? Math.min(raw.length, at + 180) : end + 1;
  return clipQuote(raw.slice(sliceStart, sliceEnd));
}

function mailCoversNeed(message = {}, needId = '') {
  const hay = `${sanitize(message.text)} ${sanitize(message.subject)} ${(Array.isArray(message.attachmentNames) ? message.attachmentNames : []).join(' ')}`.toLowerCase();
  if (!hay) return false;
  if (needId === 'need.logo') return /logo/.test(hay);
  if (needId === 'need.domain') return /domene|domain/.test(hay);
  if (needId === 'need.products') return /meny|menu|katalog|catalog|produkt/.test(hay);
  if (needId === 'need.media') return /bilde|bilder|foto|galleri|media/.test(hay);
  return false;
}

function newestCoveringMessage(messages = [], needId = '') {
  const hits = (Array.isArray(messages) ? messages : []).filter((row) => mailCoversNeed(row, needId));
  if (!hits.length) return null;
  return hits.sort((a, b) => Date.parse(b.mailAt || 0) - Date.parse(a.mailAt || 0))[0];
}

function applySidecar(lines, sidecar = {}, gmailMessages = []) {
  const overrides = sidecar.overrides && typeof sidecar.overrides === 'object' ? sidecar.overrides : {};
  const evidence = sidecar.gmail?.evidence && typeof sidecar.gmail.evidence === 'object' ? sidecar.gmail.evidence : {};
  const history = sidecar.history && typeof sidecar.history === 'object' ? sidecar.history : {};
  const byId = new Map(lines.map((row) => [row.id, row]));

  for (const [lineId, snapshot] of Object.entries(history)) {
    if (byId.has(lineId) || !snapshot || typeof snapshot !== 'object') continue;
    if (sanitize(snapshot.bucket) !== 'need') continue;
    byId.set(lineId, line({
      id: lineId,
      bucket: 'need',
      title: sanitize(snapshot.title) || lineId,
      detail: sanitize(snapshot.detail),
      source: sanitize(snapshot.source) || 'history',
      status: 'filled',
    }));
  }

  return [...byId.values()].map((row) => {
    const override = overrides[row.id] && typeof overrides[row.id] === 'object' ? overrides[row.id] : {};
    const next = { ...row };
    if (sanitize(override.wording)) next.title = sanitize(override.wording).slice(0, MAX_WORDING);
    if (next.bucket === 'need' && next.status === 'open') {
      const mail = newestCoveringMessage(gmailMessages, next.id);
      const stored = evidence[next.id] && typeof evidence[next.id] === 'object' ? evidence[next.id] : null;
      const received = mail || (stored?.quote || stored?.mailAt ? stored : null);
      if (mail) {
        const keyword = next.id === 'need.logo' ? 'logo'
          : next.id === 'need.domain' ? 'domene'
            : next.id === 'need.products' ? 'produkt'
              : 'bilde';
        next.status = 'received';
        next.quote = sentenceAround(mail.text || mail.subject, keyword);
        next.mailAt = sanitize(mail.mailAt);
        next.attachmentNames = Array.isArray(mail.attachmentNames) ? mail.attachmentNames.map(sanitize).filter(Boolean) : [];
        next.messageId = sanitize(mail.id);
        next.source = 'gmail';
      } else if (received) {
        next.status = 'received';
        next.quote = sanitize(received.quote).slice(0, MAX_QUOTE);
        next.mailAt = sanitize(received.mailAt);
        next.attachmentNames = Array.isArray(received.attachmentNames) ? received.attachmentNames.map(sanitize).filter(Boolean) : [];
        next.messageId = sanitize(received.messageId);
        next.source = next.source || 'gmail';
      } else if (override.checked) {
        next.status = 'checked';
      }
    }
    return next;
  });
}

function collectedTexts({ client = {}, transcripts = [], gmailMessages = [] } = {}) {
  const blobs = [];
  for (const row of Array.isArray(transcripts) ? transcripts : []) {
    const text = typeof row === 'string' ? row : sanitize(row?.text || row?.transcript);
    if (text) blobs.push({ source: sanitize(row?.source) || 'transcript', text });
  }
  if (sanitize(client.notes)) blobs.push({ source: 'sales-notes', text: client.notes });
  const quote = meetingQuoteOf(client);
  if (sanitize(quote.productNotes)) blobs.push({ source: 'product-notes', text: quote.productNotes });
  for (const message of Array.isArray(gmailMessages) ? gmailMessages : []) {
    if (sanitize(message?.text)) blobs.push({ source: 'gmail', text: message.text });
  }
  return blobs;
}

export function evaluateWorkshopNeeds(input = {}) {
  const client = input.client && typeof input.client === 'object' ? input.client : {};
  const bank = input.bank && typeof input.bank === 'object' ? input.bank : {};
  const profile = input.profile && typeof input.profile === 'object' ? input.profile : {};
  const maker = input.maker && typeof input.maker === 'object' ? input.maker : {};
  const sidecar = input.sidecar && typeof input.sidecar === 'object' ? input.sidecar : {};
  const transcripts = Array.isArray(input.transcripts) ? input.transcripts : [];
  const gmail = input.gmail && typeof input.gmail === 'object' ? input.gmail : {};
  const gmailMessages = Array.isArray(gmail.messages) ? gmail.messages : [];
  const quote = meetingQuoteOf(client);
  const workshopAction = readWorkshopAction(client);
  const products = countBankProducts(bank);
  const media = countBankMedia(bank);
  const makerFailed = Boolean(maker.failed);
  const makerUploads = makerFailed ? 0 : countMakerUploads(maker.run?.uploads || maker.uploads || {});
  const logoPresent = hasKundedataLogo(bank);
  const domainPresent = hasStoredDomain({ bank, maker: maker.failed ? {} : maker });
  const lines = [];

  if (isWinner(client)) {
    lines.push(line({
      id: 'activity.winner',
      bucket: 'activity',
      title: 'Vinner mottatt',
      detail: sanitize(client.myphoner?.winnerComment) || sanitize(client.businessName),
      source: 'myphoner',
      status: 'filled',
    }));
  } else {
    lines.push(line({
      id: 'activity.hand-added',
      bucket: 'activity',
      title: 'Klient lagt til manuelt',
      detail: sanitize(client.businessName),
      source: 'sales',
      status: 'filled',
    }));
  }

  if (sanitize(client.meetingAt) || client.progression?.meetingHeld) {
    lines.push(line({
      id: 'activity.sales-meeting',
      bucket: 'activity',
      title: 'Salgsmøte',
      detail: [
        sanitize(client.meetingAt) ? formatWhen(client.meetingAt) : '',
        client.progression?.meetingHeld ? 'Møtet hatt' : '',
      ].filter(Boolean).join(' · '),
      source: 'sales',
      status: 'filled',
    }));
  }

  if (sanitize(client.reminders?.thankYouSentAt)) {
    lines.push(line({
      id: 'activity.confirmation-sent',
      bucket: 'activity',
      title: 'Bekreftelse sendt',
      detail: formatWhen(client.reminders.thankYouSentAt),
      source: 'sales',
      status: 'filled',
    }));
  }

  if (client.progression?.offerSent) {
    lines.push(line({
      id: 'activity.offer-sent',
      bucket: 'activity',
      title: 'Tilbud sendt',
      source: 'sales',
      status: 'filled',
    }));
  }

  if (sanitize(client.portalUserId) || sanitize(client.portalConnectedAt)) {
    lines.push(line({
      id: 'activity.portal-connected',
      bucket: 'activity',
      title: 'Portal koblet',
      detail: sanitize(client.clientEmail),
      source: 'portal',
      status: 'filled',
    }));
  }

  if (Array.isArray(client.meetings) && client.meetings.length) {
    lines.push(line({
      id: 'activity.fireflies',
      bucket: 'activity',
      title: 'Fireflies koblet',
      detail: `${client.meetings.length} møte${client.meetings.length === 1 ? '' : 'r'}`,
      source: 'fireflies',
      status: 'filled',
    }));
  }

  if (sanitize(client.makerRun?.runId)) {
    lines.push(line({
      id: 'activity.maker-run',
      bucket: 'activity',
      title: 'Maker-run koblet',
      detail: client.makerRun.runId,
      source: 'maker',
      status: 'filled',
    }));
  }

  if (workshopAction) {
    lines.push(line({
      id: 'activity.workshop-booked',
      bucket: 'activity',
      title: 'Workshop booket',
      detail: [workshopAction.name || 'Workshop', formatLabel(workshopAction.format), workshopAction.dueAt ? formatWhen(workshopAction.dueAt) : '']
        .filter(Boolean)
        .join(' · '),
      source: 'workshopAction',
      status: 'filled',
    }));
  }

  if (sanitize(client.meetingAt)) {
    lines.push(line({
      id: 'have.meeting-time',
      bucket: 'have',
      title: 'Møtetid',
      detail: formatWhen(client.meetingAt),
      source: 'sales',
      status: 'filled',
    }));
  }

  if (sanitize(client.meetingMode)) {
    lines.push(line({
      id: 'have.meeting-mode',
      bucket: 'have',
      title: 'Møteformat',
      detail: sanitize(client.meetingMode) === 'in-person' ? 'IRL' : 'Online',
      source: 'sales',
      status: 'filled',
    }));
  }

  if (sanitize(quote.productNotes) || sanitize(quote.productGoal)) {
    lines.push(line({
      id: 'have.product-notes',
      bucket: 'have',
      title: 'Produktnotater',
      detail: clipQuote(quote.productNotes || quote.productGoal),
      source: 'offer',
      status: 'filled',
    }));
  }

  const selected = Array.isArray(quote.selected) ? quote.selected.map(sanitize).filter(Boolean) : [];
  const fees = Array.isArray(quote.oneTimeAddOns) ? quote.oneTimeAddOns.map(sanitize).filter(Boolean) : [];
  if (sanitize(quote.tierId) || quote.pages || selected.length || fees.length || sanitize(quote.customSections)) {
    lines.push(line({
      id: 'have.offer',
      bucket: 'have',
      title: 'Tilbud',
      detail: [
        sanitize(quote.tierId) ? `Pakke ${quote.tierId}` : '',
        quote.pages ? `${quote.pages} sider` : '',
        selected.length ? `Tjenester: ${selected.join(', ')}` : '',
        fees.length ? `Engangs: ${fees.join(', ')}` : '',
        sanitize(quote.customSections) ? clipQuote(quote.customSections) : '',
      ].filter(Boolean).join(' · '),
      source: 'offer',
      status: 'filled',
    }));
  }

  if (sanitize(quote.startDate)) {
    lines.push(line({
      id: 'have.offer-start-date',
      bucket: 'have',
      title: 'Workshop-dato i tilbudet',
      detail: quote.startDate,
      source: 'offer',
      status: 'filled',
    }));
  }

  if (sanitize(client.notes)) {
    lines.push(line({
      id: 'have.sales-notes',
      bucket: 'have',
      title: 'Salgsnotater',
      detail: clipQuote(client.notes),
      source: 'sales',
      status: 'filled',
    }));
  }

  if (sanitize(client.myphoner?.winnerComment)) {
    lines.push(line({
      id: 'have.winner-comment',
      bucket: 'have',
      title: 'MyPhoner-kommentar',
      detail: clipQuote(client.myphoner.winnerComment),
      source: 'myphoner',
      status: 'filled',
    }));
  }

  if (sanitize(client.contactEmail)) {
    lines.push(line({
      id: 'have.contact-email',
      bucket: 'have',
      title: 'Salgskontakt',
      detail: client.contactEmail,
      source: 'sales',
      status: 'filled',
    }));
  }

  const discovery = sanitize(profile.discoveryChannel);
  if (discovery) {
    lines.push(line({
      id: 'have.discovery-channel',
      bucket: 'have',
      title: 'Hvordan de fant Asoldi',
      detail: discovery,
      source: 'portal',
      status: 'filled',
    }));
  }

  const position = sanitize(profile.position);
  if (position) {
    lines.push(line({
      id: 'have.job-title',
      bucket: 'have',
      title: 'Stilling',
      detail: position,
      source: 'portal',
      status: 'filled',
    }));
  }

  if (logoPresent) {
    lines.push(line({
      id: 'have.logo',
      bucket: 'have',
      title: 'Logo i Kundedata',
      source: 'kundedata',
      status: 'filled',
    }));
  }

  if (domainPresent) {
    lines.push(line({
      id: 'have.domain',
      bucket: 'have',
      title: 'Domene',
      detail: makerDomainFromRun(maker.failed ? {} : maker) || kundedataDomain(bank),
      source: makerDomainFromRun(maker.failed ? {} : maker) ? 'maker' : 'kundedata',
      status: 'filled',
    }));
  }

  lines.push(line({
    id: 'have.product-count',
    bucket: 'have',
    title: 'Produkter',
    detail: String(products),
    source: 'kundedata',
    status: 'filled',
  }));

  lines.push(line({
    id: 'have.media-count',
    bucket: 'have',
    title: 'Media',
    detail: String(media),
    source: 'kundedata',
    status: 'filled',
  }));

  if (!makerFailed) {
    lines.push(line({
      id: 'have.maker-uploads',
      bucket: 'have',
      title: 'Maker-opplastinger',
      detail: String(makerUploads),
      source: 'maker',
      status: 'filled',
    }));
  }

  if (workshopAction?.name) {
    lines.push(line({
      id: 'have.workshop-name',
      bucket: 'have',
      title: 'Workshop-navn',
      detail: workshopAction.name,
      source: 'workshopAction',
      status: 'filled',
    }));
  }
  if (workshopAction?.format) {
    lines.push(line({
      id: 'have.workshop-format',
      bucket: 'have',
      title: 'Workshop-format',
      detail: formatLabel(workshopAction.format),
      source: 'workshopAction',
      status: 'filled',
    }));
  }
  if (workshopAction?.dueAt) {
    lines.push(line({
      id: 'have.workshop-time',
      bucket: 'have',
      title: 'Workshop-tid',
      detail: formatWhen(workshopAction.dueAt),
      source: 'workshopAction',
      status: 'filled',
    }));
  }

  if (!logoPresent) {
    lines.push(line({
      id: 'need.logo',
      bucket: 'need',
      title: 'Logo fra kunden',
      detail: 'Mangler i Kundedata (normal logo og media.logos).',
      source: 'kundedata',
      status: 'open',
    }));
  }

  if (!domainPresent) {
    lines.push(line({
      id: 'need.domain',
      bucket: 'need',
      title: 'Domene fra kunden',
      detail: 'Mangler i Maker og Kundedata.',
      source: 'domain',
      status: 'open',
    }));
  }

  if (products === 0 && offerImpliesProducts(quote)) {
    lines.push(line({
      id: 'need.products',
      bucket: 'need',
      title: 'Produkter eller tjenesteliste',
      detail: 'Tilbudet peker på meny/katalog/tjenester, og Kundedata har 0 produkter.',
      source: 'offer',
      status: 'open',
    }));
  }

  if (media === 0 && offerImpliesMedia(quote)) {
    lines.push(line({
      id: 'need.media',
      bucket: 'need',
      title: 'Bilder fra kunden',
      detail: 'Tilbudet peker på innhold som trenger bilder, og Kundedata har 0 filer.',
      source: 'offer',
      status: 'open',
    }));
  }

  const texts = collectedTexts({ client, transcripts, gmailMessages });
  if (openingHoursAreDefault(bank)) {
    const hoursHit = texts.find((row) => extractHoursQuote(row.text));
    if (hoursHit) {
      lines.push(line({
        id: 'heard.hours',
        bucket: 'heard',
        title: 'Åpningstider hørt, ikke lagret',
        detail: 'Finnes i møte/notat/e-post, ikke i Kundedata.',
        source: hoursHit.source,
        status: 'open',
        extra: { quote: extractHoursQuote(hoursHit.text) },
      }));
    }
  } else if (!openingHoursAreDefault(bank)) {
    lines.push(line({
      id: 'have.opening-hours',
      bucket: 'have',
      title: 'Åpningstider i Kundedata',
      source: 'kundedata',
      status: 'filled',
    }));
  }

  const extraHeard = [
    ...(Array.isArray(sidecar.heardFacts) ? sidecar.heardFacts : []),
    ...(Array.isArray(client.workshop?.heardFacts) ? client.workshop.heardFacts : []),
  ];
  for (const fact of extraHeard) {
    const id = sanitize(fact?.id);
    if (!id) continue;
    lines.push(line({
      id,
      bucket: 'heard',
      title: sanitize(fact.title) || 'Hørt, ikke lagret',
      detail: sanitize(fact.detail),
      source: sanitize(fact.source) || 'note',
      status: 'open',
      extra: { quote: sanitize(fact.quote).slice(0, MAX_QUOTE) },
    }));
  }

  if (!sanitize(client.clientEmail)) {
    lines.push(line({
      id: 'unknown.client-email',
      bucket: 'unknown',
      title: 'Ingen portal-e-post',
      detail: 'Gmail hoppes over når clientEmail er tom. contactEmail brukes ikke.',
      source: 'gmail',
      status: 'open',
    }));
  } else if (gmail.skipped && sanitize(gmail.reason) !== 'no-client-email') {
    lines.push(line({
      id: 'unknown.gmail',
      bucket: 'unknown',
      title: 'Gmail ikke tilgjengelig',
      detail: gmail.reason === 'gmail-scope-missing'
        ? 'damian@asoldi.com mangler gmail.readonly. Koble til på nytt etter deploy.'
        : 'Kunne ikke lese damian@asoldi.com.',
      source: 'gmail',
      status: 'open',
    }));
  }

  if (makerFailed) {
    lines.push(line({
      id: 'unknown.maker-uploads',
      bucket: 'unknown',
      title: 'Maker-opplastinger ukjent',
      detail: 'Maker-run kunne ikke hentes. Opplastingstelleren venter.',
      source: 'maker',
      status: 'open',
    }));
  }

  if (offerImplicationUncertain(quote) && products === 0) {
    lines.push(line({
      id: 'unknown.offer-products',
      bucket: 'unknown',
      title: 'Uklart om tilbudet trenger produkter',
      detail: 'Admin avgjør. Ikke spør kunden ennå.',
      source: 'offer',
      status: 'open',
    }));
  }

  const merged = applySidecar(lines, sidecar, gmailMessages);
  return {
    clientId: sanitize(client.id),
    lines: merged,
    counts: {
      products,
      media,
      makerUploads,
    },
    materials: {
      logo: logoPresent,
      domain: domainPresent,
    },
  };
}

function defaultGetProfile(client) {
  const userId = sanitize(client?.portalUserId);
  return userId ? getClientProfileByUserId(userId) : null;
}

function defaultTranscripts(client) {
  const out = [];
  for (const ref of Array.isArray(client?.meetings) ? client.meetings : []) {
    const meetingId = sanitize(ref?.meetingId);
    const stored = meetingId ? readStoredFirefliesMeeting(meetingId) : null;
    const text = sanitize(stored?.transcript || ref?.summary);
    if (text) out.push({ source: 'transcript', text, meetingId });
  }
  return out;
}

export function summarizeMakerRun(result = {}) {
  if (result.failed) return { failed: true };
  const run = result.run && typeof result.run === 'object' ? result.run : result;
  if (!run || typeof run !== 'object') return {};
  return {
    run: {
      answers: { websiteDomain: sanitize(run.answers?.websiteDomain) },
      metadata: { productionDomain: sanitize(run.metadata?.productionDomain) },
      uploads: run.uploads && typeof run.uploads === 'object' ? run.uploads : {},
    },
  };
}

export async function loadWorkshopNeedsDocument(client, deps = {}) {
  const row = client && typeof client === 'object' ? client : {};
  const sidecar = readWorkshopNeedsClient(row.id);
  const profile = typeof deps.getProfile === 'function' ? deps.getProfile(row) : defaultGetProfile(row);
  const bank = profile?.clientDataBank && typeof profile.clientDataBank === 'object' ? profile.clientDataBank : {};
  const transcripts = typeof deps.getTranscripts === 'function' ? deps.getTranscripts(row) : defaultTranscripts(row);

  let maker = {};
  const runId = sanitize(row.makerRun?.runId);
  if (runId && typeof deps.fetchMakerRun === 'function') {
    try {
      maker = summarizeMakerRun(await deps.fetchMakerRun(runId, row) || {});
    } catch {
      maker = { failed: true };
    }
  } else if (runId && !deps.fetchMakerRun) {
    maker = { failed: true };
  }

  const clientEmail = sanitize(row.clientEmail).toLowerCase();
  let gmail = { skipped: true, reason: 'no-client-email', messages: [] };
  if (clientEmail) {
    const listMail = typeof deps.listMail === 'function' ? deps.listMail : listDamianMailFromClient;
    try {
      gmail = await listMail(clientEmail);
    } catch (error) {
      gmail = {
        skipped: true,
        reason: sanitize(error?.reason) || 'gmail-error',
        messages: [],
      };
    }
  }

  const evaluation = evaluateWorkshopNeeds({
    client: row,
    bank,
    profile,
    maker,
    transcripts,
    gmail,
    sidecar,
  });
  persistWorkshopNeedsRefresh(row.id, { lines: evaluation.lines, gmail });
  return {
    ...evaluation,
    gmail: {
      skipped: Boolean(gmail.skipped),
      reason: sanitize(gmail.reason),
      messageCount: Array.isArray(gmail.messages) ? gmail.messages.length : 0,
    },
  };
}
