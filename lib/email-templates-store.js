import { randomBytes } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { getDataFilePath, ensurePersistentDataDir, writeDataJson } from '../data/storage-path.js';
import {
  EMPTY_EMAIL_HTML,
  EMAIL_MERGE_FIELDS,
  buildSalesCalendarInvite,
  buildSalesLayoutEmail,
  buildSalesReminderEmail,
  buildSalesThankYouEmail,
  getSalesEmailPreviewClient,
  htmlToPlainText,
  resolveSalesEmailAssetBase,
  rewriteSalesEmailAssetsToHosted,
  salesEmailMergeMap,
} from './sales-email.js';
import { wrapSalesEmailHtmlDocument } from './sales-email-layout.js';
import { applyMerge, ensureSignerMergeTags, injectEmailPreheader, stripMarketingUnsubscribe, stripRetiredEmailPhrases } from './email-merge.js';
import { parseMailbox, resolveTransactionalFrom } from './email.js';
import { OFFER_TEMPLATE_KEY, buildContractOnlyEmail, buildOfferEmail } from './offer-email.js';

const TEMPLATES_PATH = getDataFilePath('email-templates.json');
const DRAFTS_PATH = getDataFilePath('email-drafts.json');
const DRAFT_TTL_MS = 24 * 60 * 60 * 1000;

function nowIso() {
  return new Date().toISOString();
}

function makeId(prefix = 'tpl') {
  return `${prefix}-${Date.now()}-${randomBytes(4).toString('hex')}`;
}

function sanitizeText(value = '') {
  return String(value ?? '').trim();
}

function readJson(path, fallback) {
  ensurePersistentDataDir();
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

function normalizeTemplate(raw = {}) {
  const createdAt = sanitizeText(raw.createdAt) || nowIso();
  return {
    id: sanitizeText(raw.id) || makeId(),
    key: sanitizeText(raw.key),
    name: sanitizeText(raw.name) || 'Uten navn',
    subject: sanitizeText(raw.subject),
    preheader: sanitizeText(raw.preheader),
    html: stripMarketingUnsubscribe(stripRetiredEmailPhrases(ensureSignerMergeTags(String(raw.html || '')))),
    grapesProject: raw.grapesProject && typeof raw.grapesProject === 'object' ? raw.grapesProject : null,
    preset: Boolean(raw.preset),
    createdAt,
    updatedAt: sanitizeText(raw.updatedAt) || createdAt,
  };
}

function asoldiPresetHtml(builder, clientOverrides = {}) {
  const client = getSalesEmailPreviewClient(clientOverrides);
  return builder(client, client.calendar || {}, {
    mergeTags: true,
    assetBase: '/email/sales',
    previewVariant: 'desktop',
  });
}

function asoldiPresets() {
  const irlClient = { meetingMode: 'in-person' };
  const thankYou = asoldiPresetHtml(buildSalesThankYouEmail);
  const thankYouIrl = asoldiPresetHtml(buildSalesThankYouEmail, irlClient);
  const reminder3d = asoldiPresetHtml((client, calendar, options) => (
    buildSalesReminderEmail(client, calendar, '3d', options)
  ));
  const reminder3dIrl = asoldiPresetHtml((client, calendar, options) => (
    buildSalesReminderEmail(client, calendar, '3d', options)
  ), irlClient);
  const reminder24 = asoldiPresetHtml((client, calendar, options) => (
    buildSalesReminderEmail(client, calendar, '24h', options)
  ));
  const reminder24Irl = asoldiPresetHtml((client, calendar, options) => (
    buildSalesReminderEmail(client, calendar, '24h', options)
  ), irlClient);
  const reminder1h = asoldiPresetHtml((client, calendar, options) => (
    buildSalesReminderEmail(client, calendar, '1h', options)
  ));
  const reminder1hIrl = asoldiPresetHtml((client, calendar, options) => (
    buildSalesReminderEmail(client, calendar, '1h', options)
  ), irlClient);
  const offer = buildOfferEmailForClient(getSalesEmailPreviewClient(), {}, { assetBase: '/email/sales', previewVariant: 'desktop' });
  return [
    {
      key: 'thank-you',
      name: 'Bekreftelse — online møte',
      subject: thankYou.subject,
      preheader: 'Vi har satt av tid til {{businessName}} — Meet-lenken er her.',
      html: thankYou.html,
      preset: true,
    },
    {
      key: 'thank-you-in-person',
      name: 'Bekreftelse — fysisk møte',
      subject: thankYouIrl.subject,
      preheader: 'Vi har satt av tid til {{businessName}} — adressen er i e-posten.',
      html: thankYouIrl.html,
      preset: true,
    },
    {
      key: 'reminder-3d',
      name: 'Påminnelse 3 dager — online',
      subject: reminder3d.subject,
      preheader: 'Møtet starter om 3 dager.',
      html: reminder3d.html,
      preset: true,
    },
    {
      key: 'reminder-3d-in-person',
      name: 'Påminnelse 3 dager — fysisk',
      subject: reminder3dIrl.subject,
      preheader: 'Møtet starter om 3 dager.',
      html: reminder3dIrl.html,
      preset: true,
    },
    {
      key: 'reminder-24h',
      name: 'Påminnelse 24 timer — online',
      subject: reminder24.subject,
      preheader: 'Møtet starter om 24 timer.',
      html: reminder24.html,
      preset: true,
    },
    {
      key: 'reminder-24h-in-person',
      name: 'Påminnelse 24 timer — fysisk',
      subject: reminder24Irl.subject,
      preheader: 'Møtet starter om 24 timer.',
      html: reminder24Irl.html,
      preset: true,
    },
    {
      key: 'reminder-1h',
      name: 'Påminnelse 1 time — online',
      subject: reminder1h.subject,
      preheader: 'Møtet starter om 1 time.',
      html: reminder1h.html,
      preset: true,
    },
    {
      key: 'reminder-1h-in-person',
      name: 'Påminnelse 1 time — fysisk',
      subject: reminder1hIrl.subject,
      preheader: 'Møtet starter om 1 time.',
      html: reminder1hIrl.html,
      preset: true,
    },
    {
      key: OFFER_TEMPLATE_KEY,
      name: 'Tilbud — nettside',
      subject: offer.subject,
      preheader: offer.preheader,
      html: offer.html,
      preset: true,
    },
  ].map((row) => normalizeTemplate({ ...row, id: `preset-${row.key}` }));
}

function readTemplates() {
  const stored = readJson(TEMPLATES_PATH, null);
  const list = Array.isArray(stored) ? stored.map(normalizeTemplate) : [];
  const keys = new Set(list.map((row) => row.key).filter(Boolean));
  let changed = !Array.isArray(stored);
  for (const preset of asoldiPresets()) {
    if (!keys.has(preset.key)) {
      list.push(preset);
      changed = true;
      continue;
    }
    const index = list.findIndex((row) => row.key === preset.key);
    if (index === -1) continue;
    const existing = list[index];
    if (existing.preset && !existing.grapesProject && (
      existing.html !== preset.html
      || existing.subject !== preset.subject
      || existing.preheader !== preset.preheader
    )) {
      list[index] = {
        ...existing,
        html: preset.html,
        subject: preset.subject,
        preheader: preset.preheader,
        updatedAt: nowIso(),
      };
      changed = true;
    }
  }
  if (changed) writeDataJson(TEMPLATES_PATH, list);
  return list;
}

function writeTemplates(list) {
  writeDataJson(TEMPLATES_PATH, list.map(normalizeTemplate));
}

export function listEmailTemplates() {
  return readTemplates().sort((a, b) => a.name.localeCompare(b.name, 'nb'));
}

export function getEmailTemplateById(id) {
  const target = sanitizeText(id);
  return readTemplates().find((row) => row.id === target || row.key === target) || null;
}

export function saveEmailTemplate(input = {}) {
  const list = readTemplates();
  const incoming = normalizeTemplate({
    ...input,
    id: sanitizeText(input.id) || makeId(),
    updatedAt: nowIso(),
  });
  if (!incoming.name) return { ok: false, error: 'Name is required' };
  if (!incoming.html) incoming.html = EMPTY_EMAIL_HTML;
  const index = list.findIndex((row) => row.id === incoming.id);
  if (index === -1) {
    incoming.createdAt = nowIso();
    list.push(incoming);
  } else {
    incoming.createdAt = list[index].createdAt;
    incoming.preset = list[index].preset || incoming.preset;
    list[index] = incoming;
  }
  writeTemplates(list);
  return { ok: true, template: incoming };
}

export function importEmailTemplate({ name, subject, preheader, html, grapesProject, key } = {}) {
  const cleanedHtml = String(html || '').trim();
  if (!cleanedHtml) return { ok: false, error: 'HTML is required' };
  return saveEmailTemplate({
    key,
    name: name || 'Importert mal',
    subject: subject || '',
    preheader: preheader || '',
    html: cleanedHtml,
    grapesProject: grapesProject || null,
    preset: false,
  });
}

export function deleteEmailTemplate(id) {
  const list = readTemplates();
  const next = list.filter((row) => row.id !== id && row.key !== id);
  if (next.length === list.length) return { ok: false, error: 'Template not found' };
  writeTemplates(next);
  return { ok: true };
}

function readDrafts() {
  const now = Date.now();
  const rows = (readJson(DRAFTS_PATH, []) || []).filter((row) => {
    const created = Date.parse(row?.createdAt || 0);
    return Number.isFinite(created) && now - created < DRAFT_TTL_MS;
  });
  return rows;
}

function writeDrafts(rows) {
  writeDataJson(DRAFTS_PATH, rows);
}

export function saveEmailDraft(input = {}) {
  const drafts = readDrafts();
  const draft = {
    id: sanitizeText(input.id) || makeId('draft'),
    clientId: sanitizeText(input.clientId),
    templateId: sanitizeText(input.templateId),
    templateKey: sanitizeText(input.templateKey),
    to: sanitizeText(input.to),
    subject: sanitizeText(input.subject),
    preheader: sanitizeText(input.preheader),
    html: String(input.html || ''),
    createdAt: nowIso(),
  };
  const index = drafts.findIndex((row) => row.id === draft.id);
  if (index === -1) drafts.push(draft);
  else drafts[index] = draft;
  writeDrafts(drafts);
  return draft;
}

export function getEmailDraft(id) {
  const target = sanitizeText(id);
  return readDrafts().find((row) => row.id === target) || null;
}

/** Short in-meeting mail: contract PDF, no transcript-filled letter. */
export function buildContractOnlyEmailForClient(client, { sender = {}, attached = true } = {}) {
  return buildContractOnlyEmail({
    client,
    sender,
    attached,
    mergeTags: true,
    layout: buildSalesLayoutEmail,
    layoutOptions: { embed: false, assetBase: resolveSalesEmailAssetBase(), sender },
  });
}

/**
 * Offer email with merge tags. `offer` = { products, nuances } from data/sales-offers.js (may be empty).
 */
export function buildOfferEmailForClient(client, offer = {}, layoutOptions = {}) {
  return buildOfferEmail({
    client,
    products: Array.isArray(offer?.products) ? offer.products : [],
    nuances: offer?.nuances || {},
    mvaIncluded: Boolean(offer?.mvaIncluded),
    billing: offer?.billing === 'once' ? 'once' : 'month',
    oneTimeFees: Array.isArray(offer?.oneTimeFees) ? offer.oneTimeFees : [],
    sender: layoutOptions.sender || {},
    mergeTags: true,
    layout: buildSalesLayoutEmail,
    layoutOptions: { embed: false, assetBase: layoutOptions.assetBase || resolveSalesEmailAssetBase(), previewVariant: layoutOptions.previewVariant },
  });
}

export function isOfferEmailTemplate(templateKey = '') {
  return sanitizeText(templateKey).toLowerCase() === OFFER_TEMPLATE_KEY;
}

function generatedEmail(client, templateKey, sender = {}, extra = {}) {
  const calendar = client?.calendar || {};
  const options = { embed: false, assetBase: resolveSalesEmailAssetBase(), sender };
  const key = sanitizeText(templateKey).toLowerCase();
  if (key === OFFER_TEMPLATE_KEY) {
    return buildOfferEmailForClient(client, extra.offer || {}, { sender });
  }
  const source = key.includes('in-person')
    ? { ...client, meetingMode: 'in-person', meetingDurationMinutes: Number(client?.meetingDurationMinutes) || 30 }
    : client;
  if (key.includes('1h')) return buildSalesReminderEmail(source, calendar, '1h', options);
  if (key.includes('3d') || key.includes('72h')) return buildSalesReminderEmail(source, calendar, '3d', options);
  if (key.includes('reminder') || key === '24h') {
    return buildSalesReminderEmail(source, calendar, '24h', options);
  }
  return buildSalesThankYouEmail(source, calendar, options);
}

export function isReminderEmailTemplate(templateKey = '') {
  const key = sanitizeText(templateKey).toLowerCase();
  return key.includes('1h')
    || key.includes('3d')
    || key.includes('72h')
    || key.includes('reminder')
    || key === '24h';
}

export function shouldAttachCalendarInvite(templateKey = '', options = {}) {
  if (options.attachInvite === false) return false;
  if (options.attachInvite === true) return true;
  if (isOfferEmailTemplate(templateKey)) return false;
  return !isReminderEmailTemplate(templateKey);
}

export function mergeFieldsMeta() {
  return EMAIL_MERGE_FIELDS;
}

export function composeEmailForClient(client, templateKey = 'thank-you', composed = null, options = {}) {
  const key = sanitizeText(templateKey) || 'thank-you';
  const sender = options.sender || {};
  const generated = generatedEmail(client, key, sender, { offer: options.offer });
  const template = getEmailTemplateById(key);
  const values = salesEmailMergeMap(client, client?.calendar || {}, sender);
  const customHtml = String(composed?.html || '').trim();
  const htmlRaw = stripMarketingUnsubscribe(stripRetiredEmailPhrases(ensureSignerMergeTags(
    customHtml || generated.html || template?.html || ''
  )));
  const subjectRaw = String(composed?.subject || generated.subject || template?.subject || '');
  const preheaderRaw = String(composed?.preheader || template?.preheader || '');
  const html = applyMerge(htmlRaw, values, { escapeHtml: true });
  const subject = applyMerge(subjectRaw, values, { escapeHtml: false });
  const preheader = applyMerge(preheaderRaw, values, { escapeHtml: false });
  const withPreheader = injectEmailPreheader(html, preheader);
  const hostedHtml = rewriteSalesEmailAssetsToHosted(withPreheader);
  const fromHeader = resolveTransactionalFrom(sender.from || generated.from);
  const fromParsed = parseMailbox(fromHeader);
  const invite = shouldAttachCalendarInvite(key, options)
    ? buildSalesCalendarInvite(client, client?.calendar || {}, {
      organizerEmail: fromParsed.address || sender.fromEmail,
      organizerName: fromParsed.name || sender.name || 'Asoldi',
    })
    : null;
  return {
    template,
    generated,
    merged: {
      subject,
      preheader,
      html,
    },
    message: {
      ...generated,
      from: sender.from || generated.from,
      replyTo: sender.replyTo || generated.replyTo,
      subject,
      html: wrapSalesEmailHtmlDocument({ title: subject, html: hostedHtml }),
      text: htmlToPlainText(html),
      attachments: [],
      icalEvent: invite || undefined,
    },
    mergeFields: EMAIL_MERGE_FIELDS,
    values,
  };
}

