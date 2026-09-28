import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { getPublicSalesPreviewUrl } from './sales-preview-import.js';
import {
  calendarDurationForMode,
  CLIENT_MEETING_DURATION_MINUTES,
} from './sales-meeting-duration.js';
import {
  renderBrandedSalesEmailHtml,
  renderResponsiveSalesEmailHtml,
  renderSalesEmailDocument,
  renderSalesEmailPreviewIndex,
} from './sales-email-layout.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EMAIL_ASSET_DIR = join(__dirname, '..', 'public', 'email', 'sales');
const SITE_URL = 'https://asoldi.com';
export const SALES_EMAIL_FROM = 'Asoldi <contact@asoldi.com>';

export function resolveSalesEmailFrom() {
  return sanitize(process.env.RESEND_FROM)
    || sanitize(process.env.SMTP_FROM)
    || SALES_EMAIL_FROM;
}
const SIGNER_NAME = 'Mvh Damian fra Asoldi.com';
const SIGNER_EMAIL = 'damian@asoldi.com';
const SIGNER_PHONE = '+47 48 33 91 91';

const FOOTER_LINKS = {
  facebook: 'https://www.facebook.com/people/Asoldi-markedsf%C3%B8ring/61568284364048/',
  instagram: 'https://www.instagram.com/asoldimedia/',
  youtube: 'https://www.youtube.com/@AsoldiMedia',
  vilkar: `${SITE_URL}/vilkar`,
  personvern: `${SITE_URL}/personvern`,
  kontakt: `${SITE_URL}/booking`,
  mail: 'mailto:kontakt@asoldi.com',
};

const ASSET_FILES = {
  heroDesktop: { file: 'hero-banner.jpg', cid: 'asoldi-hero-desktop', type: 'image/jpeg' },
  heroMobile: { file: 'hero-mobile.jpg', cid: 'asoldi-hero-mobile', type: 'image/jpeg' },
  envelope: { file: 'envelope.png', cid: 'asoldi-envelope', type: 'image/png' },
  logoMark: { file: 'logo-mark.png', cid: 'asoldi-logo-mark', type: 'image/png' },
  logoMarkOrange: { file: 'logo-mark-orange.png', cid: 'asoldi-logo-mark-orange', type: 'image/png' },
  facebook: { file: 'icon-facebook.png', cid: 'asoldi-icon-facebook', type: 'image/png' },
  instagram: { file: 'icon-instagram.png', cid: 'asoldi-icon-instagram', type: 'image/png' },
  youtube: { file: 'icon-youtube.png', cid: 'asoldi-icon-youtube', type: 'image/png' },
  avatarBlank: { file: 'avatar-blank.png', cid: 'asoldi-avatar-blank', type: 'image/png' },
  reviewAvatar: { file: 'christopher.png', cid: 'asoldi-review-avatar', type: 'image/png' },
  customersBadge: { file: 'customers-badge.png', cid: 'asoldi-customers-badge', type: 'image/png' },
};

function sanitize(value = '') {
  return String(value ?? '').trim();
}

function escapeHtml(value = '') {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeIcsText(value = '') {
  return sanitize(value)
    .replace(/\\/g, '\\\\')
    .replace(/\r?\n/g, '\\n')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;');
}

function escapeIcsParam(value = '') {
  return sanitize(value)
    .replace(/\\/g, '\\\\')
    .replace(/\r?\n/g, ' ')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;')
    .replace(/:/g, '\\:');
}

function formatOrgNumberForEmail(value = '') {
  const digits = sanitize(value).replace(/\D+/g, '');
  if (digits.length !== 9) return sanitize(value);
  return `${digits.slice(0, 3)} ${digits.slice(3, 6)} ${digits.slice(6)}`;
}

function isEmail(value = '') {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(sanitize(value));
}

function extractFirstName(name = '') {
  const clean = sanitize(name);
  if (!clean) return 'der';
  return clean.split(/\s+/)[0] || 'der';
}

function signerFirstName(sender = {}) {
  if (sanitize(sender?.name)) return sanitize(sender.name);
  const full = sanitize(sender?.fullName);
  if (full) return full.split(/\s+/)[0];
  return 'Damian';
}

function parseEmailFromHeader(value = '') {
  const raw = sanitize(value);
  if (!raw) return '';
  const bracketMatch = raw.match(/<([^>]+)>/);
  const candidate = sanitize(bracketMatch?.[1] || raw);
  return isEmail(candidate) ? candidate.toLowerCase() : '';
}

function resolveOrganizerEmail(client, explicitOrganizerEmail = '') {
  const explicit = sanitize(explicitOrganizerEmail);
  if (isEmail(explicit)) return explicit.toLowerCase();
  const fromHeader = parseEmailFromHeader(resolveSalesEmailFrom());
  if (fromHeader) return fromHeader;
  return 'contact@asoldi.com';
}

function osloDate(iso) {
  const ms = new Date(iso).getTime();
  if (!Number.isFinite(ms)) return null;
  return new Date(ms);
}

export function formatMeetingDate(iso) {
  const d = osloDate(iso);
  if (!d) return 'Avtales nærmere';
  return d.toLocaleString('nb-NO', {
    dateStyle: 'full',
    timeStyle: 'short',
    timeZone: 'Europe/Oslo',
  });
}

function formatMeetingSlot(iso) {
  const d = osloDate(iso);
  if (!d) return 'avtalt tid';
  const weekday = d.toLocaleDateString('nb-NO', { weekday: 'long', timeZone: 'Europe/Oslo' });
  const day = d.toLocaleDateString('nb-NO', { day: 'numeric', timeZone: 'Europe/Oslo' }).replace(/\./g, '');
  const month = d.toLocaleDateString('nb-NO', { month: 'short', timeZone: 'Europe/Oslo' }).replace(/\./g, '');
  const time = d.toLocaleTimeString('nb-NO', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Oslo' });
  return `${weekday} ${day}. ${month} kl ${time}`;
}

function formatMeetingShort(iso) {
  const d = osloDate(iso);
  if (!d) return 'avtalt tid';
  const date = d.toLocaleDateString('nb-NO', {
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
    timeZone: 'Europe/Oslo',
  });
  const time = d.toLocaleTimeString('nb-NO', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Oslo' });
  return `${date} kl ${time}`;
}

function formatIcsDate(iso) {
  const ms = new Date(iso).getTime();
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms);
  const pad = (v) => String(v).padStart(2, '0');
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

function isInPerson(client) {
  return sanitize(client?.meetingMode) === 'in-person';
}

export function normalizeSalesReminderKind(kind = '') {
  const raw = sanitize(kind).toLowerCase();
  if (raw === '1h' || raw === 'reminder-1h' || raw === '1-hour' || raw === '1hour') return '1h';
  if (raw === '3d' || raw === 'reminder-3d' || raw === '3-day' || raw === '3days' || raw === '72h') return '3d';
  return '24h';
}

function reminderHorizon(kind = '24h') {
  if (kind === '1h') return 'om 1 time';
  if (kind === '3d') return 'om 3 dager';
  return 'om 24 timer';
}

function reminderTitle(kind = '24h', inPerson = false) {
  if (kind === '1h') return 'Møtet starter om 1 time';
  if (kind === '3d') return inPerson ? 'Fysisk møte om 3 dager' : 'Online møte om 3 dager';
  return 'Gleder oss til møtet';
}

function buildMapsUrl(client) {
  if (!isInPerson(client)) return '';
  const query = sanitize(client?.meetingPlace);
  if (!query) return '';
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}

function isRealMeetLink(value = '') {
  const url = sanitize(value);
  if (!/^https:\/\/meet\.google\.com\//i.test(url)) return false;
  if (/asoldi-(sim|email)-test|lookup\/asoldi/i.test(url)) return false;
  return /meet\.google\.com\/[a-z0-9]{3}-[a-z0-9]{4}-[a-z0-9]{3}/i.test(url);
}

function websiteUrl(client) {
  const domain = sanitize(client?.websiteDomain);
  if (!domain) return '';
  if (/^https?:\/\//i.test(domain)) return domain;
  return `https://${domain.replace(/^\/+/, '')}`;
}

function customNeedPhrase(client) {
  const custom = sanitize(client?.details?.emailCustomNeed);
  if (custom) return custom;
  return '[spesifikke behov fra samtalen]';
}

function previewSiteUrl(client) {
  const published = getPublicSalesPreviewUrl(client);
  if (published) return published;
  if (sanitize(client?.id)) return `${SITE_URL}/sales-preview/${encodeURIComponent(client.id)}/`;
  return `${SITE_URL}/sales-preview/`;
}

function unsubscribeUrl(client, siteUrl = SITE_URL) {
  const id = sanitize(client?.id);
  const query = id ? `?c=${encodeURIComponent(id)}` : '';
  const base = (sanitize(siteUrl) || SITE_URL).replace(/\/$/, '');
  return `${base}/email/avmeld${query}`;
}

export function resolveSalesEmailAssetBase(origin = '') {
  const explicit = sanitize(origin) || sanitize(process.env.PUBLIC_SITE_URL) || SITE_URL;
  return `${explicit.replace(/\/$/, '')}/email/sales`;
}

export function buildSalesEmailAssets({ assetBase = '', embed = false } = {}) {
  const base = sanitize(assetBase) || resolveSalesEmailAssetBase();
  const assets = {};
  for (const [key, spec] of Object.entries(ASSET_FILES)) {
    assets[key] = embed ? `cid:${spec.cid}` : `${base}/${spec.file}`;
  }
  return assets;
}

export function buildSalesEmailInlineAttachments() {
  return Object.values(ASSET_FILES)
    .map((spec) => {
      const path = join(EMAIL_ASSET_DIR, spec.file);
      if (!existsSync(path)) return null;
      return {
        filename: spec.file,
        path,
        cid: spec.cid,
        contentType: spec.type,
        contentDisposition: 'inline',
      };
    })
    .filter(Boolean);
}

function footerLinksFor(client, siteUrl = SITE_URL) {
  return {
    ...FOOTER_LINKS,
    unsubscribe: unsubscribeUrl(client, siteUrl),
  };
}

function signerHtml({ mergeTags = false, sender = {} } = {}) {
  const emailAddress = sanitize(sender.fromEmail) || SIGNER_EMAIL;
  const email = mergeOrValue(mergeTags, '{{signerEmail}}', escapeHtml(emailAddress));
  const phoneValue = signerPhoneFor(sender);
  const phone = mergeOrValue(mergeTags, '{{signerPhone}}', escapeHtml(phoneValue));
  const name = mergeOrValue(mergeTags, '{{signerName}}', escapeHtml(signerFirstName(sender)));
  return `
    <p style="margin:0 0 8px;">
      Mvh ${name} fra <a href="${SITE_URL}" target="_blank" style="color:#FF5B00;text-decoration:underline;">Asoldi.com</a>
    </p>
    <p style="margin:0 0 10px;color:#5b5b5b;">P.S. Svar på denne e-posten hvis du må flytte møtet.</p>
    <p style="margin:0;">
      <a href="mailto:${mergeTags ? '{{signerEmail}}' : emailAddress}" style="color:#1a1a1a;text-decoration:none;">${email}</a>
      &nbsp;|&nbsp;
      <a href="tel:${phoneValue.replace(/[^\d+]/g, '')}" style="color:#1a1a1a;text-decoration:none;">${phone}</a>
    </p>`;
}

/** The signing rep's phone: their user profile number, else the office fallback. */
function signerPhoneFor(sender = {}) {
  return sanitize(sender?.phone) || SIGNER_PHONE;
}

function meetOrMapsCta(client, calendar = {}) {
  if (isInPerson(client)) {
    const maps = buildMapsUrl(client);
    return { label: 'Åpne i Kart', url: maps };
  }
  const meet = sanitize(calendar?.meetLink);
  if (isRealMeetLink(meet)) return { label: 'Åpne Google Meet', url: meet };
  const htmlLink = sanitize(calendar?.htmlLink);
  if (htmlLink) return { label: 'Åpne i kalenderen', url: htmlLink };
  return { label: '', url: '' };
}

function mergeOrValue(useMergeTags, token, value) {
  return useMergeTags ? token : value;
}

function thankYouBodyHtml(client, calendar = {}, { mergeTags = false } = {}) {
  const firstName = mergeOrValue(mergeTags, '{{firstName}}', escapeHtml(extractFirstName(client?.contactPerson)));
  const whenShort = mergeOrValue(mergeTags, '{{meetingWhen}}', escapeHtml(formatMeetingShort(client?.meetingAt)));
  const business = mergeOrValue(mergeTags, '{{businessName}}', escapeHtml(sanitize(client?.businessName) || 'bedriften din'));
  if (isInPerson(client)) {
    const place = mergeOrValue(mergeTags, '{{meetingPlace}}', escapeHtml(sanitize(client?.meetingPlace) || 'avtalt adresse'));
    return `
    <p style="margin:0 0 14px;">Hei ${firstName},</p>
    <p style="margin:0 0 14px;">Takk for at du booket møte med oss <strong>${whenShort}</strong>.</p>
    <p style="margin:0 0 14px;">
      Under samtalen kommer vi til å se på nettsiden til ${business}, og gleder oss til å gå gjennom den med deg.
    </p>
    <p style="margin:0 0 14px;">Vi møtes hos dere på <strong>${place}</strong>. Vi har satt av ca. 30 minutter.</p>
    <p style="margin:0;">Vi sender en påminnelse før møtet, og ringer deg litt i forkant så alt er klart.</p>`;
  }
  return `
    <p style="margin:0 0 14px;">Hei ${firstName},</p>
    <p style="margin:0 0 14px;">Takk for at du booket møte med oss <strong>${whenShort}</strong>.</p>
    <p style="margin:0 0 14px;">
      Under samtalen kommer vi til å se på nettsiden til ${business}, og gleder oss til å gå gjennom den med deg.
    </p>
    <p style="margin:0 0 8px;">Trykk på knappen under for å gå inn i Google Meet.</p>`;
}

function reminderBodyHtml(client, reminderKind = '24h', { mergeTags = false } = {}) {
  const firstName = mergeOrValue(mergeTags, '{{firstName}}', escapeHtml(extractFirstName(client?.contactPerson)));
  const whenShort = mergeOrValue(mergeTags, '{{meetingWhen}}', escapeHtml(formatMeetingShort(client?.meetingAt)));
  const inPerson = isInPerson(client);
  const kind = normalizeSalesReminderKind(reminderKind);
  const horizon = reminderHorizon(kind);
  const extra = kind === '1h'
    ? (inPerson
      ? 'Sett av et par minutter til å finne frem, så vi kommer raskt i gang.'
      : 'Åpne gjerne 2 minutter før, så vi kommer raskt i gang.')
    : '';
  const ctaHint = inPerson ? '' : 'Trykk på knappen under for å gå inn i Google Meet.';
  return `
    <!-- asoldi-reminder-v3 -->
    <p style="margin:0 0 14px;">Hei ${firstName},</p>
    <p style="margin:0 0 14px;">Vennlig påminnelse: møtet vårt starter ${horizon}. ${whenShort}.</p>
    ${extra ? `<p style="margin:0 0 14px;">${extra}</p>` : ''}
    ${ctaHint ? `<p style="margin:0 0 8px;">${ctaHint}</p>` : ''}`;
}

function reminderAgendaHtml(client, { mergeTags = false } = {}) {
  if (isInPerson(client)) {
    return `<p style="margin:0 0 8px;">Adresse: ${mergeOrValue(mergeTags, '{{meetingPlace}}', escapeHtml(sanitize(client?.meetingPlace) || 'Avtales nærmere'))}</p>`;
  }
  return '';
}

function buildPlainText(lines = []) {
  return lines.filter((line) => line !== null && line !== undefined).join('\n');
}

function withLayout(client, calendar, options, view) {
  const embed = Boolean(options?.embed);
  const mergeTags = Boolean(options?.mergeTags);
  const sender = options?.sender || {};
  const assets = buildSalesEmailAssets({
    assetBase: options?.assetBase,
    embed,
  });
  const payload = {
    ...view,
    assets,
    footerLinks: footerLinksFor(client, options?.siteUrl),
    year: new Date().getFullYear(),
    // Offer emails pass their own signature (no "flytte møtet" P.S.).
    signerHtml: view.signerHtml || signerHtml({ mergeTags, sender }),
    mobileTitle: view.mobileTitle || 'Møtet er bekreftet',
    showUnsubscribe: false,
  };
  const previewVariant = sanitize(options?.previewVariant);
  let html;
  if (previewVariant === 'desktop' || previewVariant === 'pc') {
    html = renderBrandedSalesEmailHtml({ ...payload, variant: 'desktop' });
  } else if (previewVariant === 'mobile' || previewVariant === 'phone') {
    html = renderBrandedSalesEmailHtml({ ...payload, variant: 'mobile' });
  } else {
    html = renderResponsiveSalesEmailHtml(payload);
  }
  return {
    html,
    attachments: embed ? buildSalesEmailInlineAttachments() : [],
    from: sanitize(options?.sender?.from) || resolveSalesEmailFrom(),
    replyTo: sanitize(options?.sender?.replyTo) || sanitize(options?.sender?.fromEmail) || SIGNER_EMAIL,
  };
}

/** Branded Asoldi shell (hero, card, footer) for non-meeting sales emails such as the offer (tilbud). */
export function buildSalesLayoutEmail(client, view = {}, options = {}) {
  return withLayout(client, client?.calendar || {}, options, view);
}

export const SALES_SIGNER = { name: 'Damian', email: SIGNER_EMAIL, phone: SIGNER_PHONE, siteUrl: SITE_URL };

export function getSalesEmailPreviewClient(overrides = {}) {
  const meetingAt = sanitize(overrides.meetingAt) || '2026-09-16T12:00:00.000Z';
  const meetingMode = sanitize(overrides.meetingMode) === 'in-person' ? 'in-person' : 'online';
  const inPerson = meetingMode === 'in-person';
  return {
    id: 'preview-asoldi',
    product: 'asoldi',
    businessName: inPerson ? 'Asoldi' : 'Asoldi',
    contactPerson: 'Damian Hegdal Chapan',
    contactEmail: 'daracha777@gmail.com',
    meetingMode,
    meetingDurationMinutes: 30,
    agreedTime: true,
    meetingAt,
    websiteDomain: 'asoldi.com',
    meetingPlace: inPerson ? 'Østre berg 10, Trondheim' : '',
    details: {
      emailCustomNeed: '',
    },
    calendar: inPerson
      ? {
        meetLink: '',
        htmlLink: 'https://calendar.google.com',
      }
      : {
        meetLink: 'https://meet.google.com/aaa-bbbb-ccc',
        htmlLink: 'https://calendar.google.com',
      },
    ...overrides,
    meetingMode: sanitize(overrides.meetingMode) === 'in-person' ? 'in-person' : (sanitize(overrides.meetingMode) === 'online' ? 'online' : meetingMode),
  };
}

export function buildSalesEmailPreviewPage(kind = 'thank-you', options = {}) {
  const modeRaw = sanitize(options.meetingMode || options.mode).toLowerCase();
  const meetingMode = modeRaw === 'in-person' || modeRaw === 'irl' || modeRaw === 'physical' ? 'in-person' : 'online';
  const client = options.client || getSalesEmailPreviewClient({ meetingMode });
  const calendar = options.calendar || client.calendar || {};
  const view = sanitize(options.previewVariant || options.view).toLowerCase();
  const reminderKind = normalizeSalesReminderKind(options.reminderKind);
  if (!view || view === 'index' || view === 'both') {
    const base = sanitize(options.previewBasePath)
      || (kind === 'reminder' ? '/email/preview/sales-reminder' : '/email/preview/sales-thank-you');
    const extra = kind === 'reminder' ? `&kind=${encodeURIComponent(reminderKind)}` : '';
    const modeQuery = `&mode=${encodeURIComponent(meetingMode)}`;
    return renderSalesEmailPreviewIndex({
      pcHref: `${base}?view=pc${modeQuery}${extra}`,
      phoneHref: `${base}?view=phone${modeQuery}${extra}`,
    });
  }
  const previewVariant = view === 'phone' || view === 'mobile' ? 'mobile' : 'desktop';
  const message = kind === 'reminder'
    ? buildSalesReminderEmail(client, calendar, reminderKind, {
      assetBase: options.assetBase,
      siteUrl: options.siteUrl,
      previewVariant,
    })
    : buildSalesThankYouEmail(client, calendar, {
      assetBase: options.assetBase,
      siteUrl: options.siteUrl,
      previewVariant,
    });
  const note = escapeHtml(
    previewVariant === 'mobile'
      ? 'Samme mal som sendes, vist i 390px. Google Calendar-feltet i Gmail kommer i tillegg når invitasjonen sendes.'
      : 'Samme mal som sendes, vist i PC-bredde. Oransje bakgrunn, hero og footer er full bredde. Tekstkortet er 800px.'
  );
  return renderSalesEmailDocument({
    title: message.subject,
    html: message.html,
    note,
    frame: previewVariant === 'mobile' ? 'mobile' : 'desktop',
  });
}

export function buildSalesThankYouEmail(client, calendar = {}, options = {}) {
  const mergeTags = Boolean(options?.mergeTags);
  const inPerson = isInPerson(client);
  const slot = mergeTags ? '{{meetingSlot}}' : formatMeetingSlot(client?.meetingAt);
  const subject = inPerson
    ? `Bekreftet: fysisk møte ${slot}`
    : `Bekreftet: online møte ${slot}`;
  const cta = inPerson ? { label: '', url: '' } : meetOrMapsCta(client, calendar);
  const layout = withLayout(client, calendar, options, {
    preheader: inPerson
      ? `Vi har satt av 30 min til ${mergeTags ? '{{businessName}}' : (sanitize(client?.businessName) || 'dere')} — adressen er i e-posten.`
      : `Vi har satt av ${CLIENT_MEETING_DURATION_MINUTES} min til ${mergeTags ? '{{businessName}}' : (sanitize(client?.businessName) || 'dere')} — Meet-lenken er her.`,
    title: inPerson ? 'Fysisk møte bekreftet' : 'Møtet bekreftet',
    mobileTitle: inPerson ? 'Fysisk møte bekreftet' : 'Møtet er bekreftet',
    bodyHtml: thankYouBodyHtml(client, calendar, { mergeTags }),
    agendaHtml: '',
    closingHtml: '',
    ctaLabel: cta.label,
    ctaUrl: inPerson ? '' : (mergeTags ? '{{meetLink}}' : cta.url),
    showTestimonial: true,
  });

  const text = buildPlainText([
    'Møtet bekreftet',
    '',
    `Hei ${extractFirstName(client?.contactPerson)},`,
    '',
    `Takk for at du booket møte med oss ${formatMeetingShort(client?.meetingAt)}.`,
    `Under samtalen kommer vi til å se på nettsiden til ${sanitize(client?.businessName) || 'bedriften din'}, og gleder oss til å gå gjennom den med deg.`,
    '',
    inPerson
      ? `Adresse: ${sanitize(client?.meetingPlace) || 'Avtales nærmere'}`
      : (isRealMeetLink(calendar?.meetLink) ? `Google Meet: ${calendar.meetLink}` : 'Møtelenke kommer i kalenderinvitasjonen.'),
    inPerson ? 'Vi har satt av ca. 30 minutter.' : null,
    inPerson ? 'Vi sender en påminnelse før møtet, og ringer deg litt i forkant så alt er klart.' : null,
    '',
    'Svar på denne e-posten hvis du må flytte møtet.',
    '',
    SIGNER_NAME,
    SIGNER_EMAIL,
    SIGNER_PHONE,
  ]);

  return {
    subject,
    text,
    html: layout.html,
    from: layout.from,
    replyTo: layout.replyTo,
    attachments: layout.attachments,
  };
}

export function buildSalesReminderEmail(client, calendar = {}, reminderKind = '24h', options = {}) {
  const mergeTags = Boolean(options?.mergeTags);
  const inPerson = isInPerson(client);
  const kind = normalizeSalesReminderKind(reminderKind);
  const horizon = reminderHorizon(kind);
  const subject = inPerson
    ? `Påminnelse: Fysisk møte med Asoldi ${horizon}`
    : `Påminnelse: Online møte med Asoldi ${horizon}`;
  const cta = inPerson ? { label: '', url: '' } : meetOrMapsCta(client, calendar);
  const layout = withLayout(client, calendar, options, {
    preheader: `Møtet starter ${horizon}.`,
    title: reminderTitle(kind, inPerson),
    mobileTitle: reminderTitle(kind, inPerson),
    bodyHtml: reminderBodyHtml(client, kind, { mergeTags }),
    agendaHtml: reminderAgendaHtml(client, { mergeTags }),
    closingHtml: '',
    ctaLabel: cta.label,
    ctaUrl: inPerson ? '' : (mergeTags ? '{{meetLink}}' : cta.url),
    showTestimonial: true,
  });

  const text = buildPlainText([
    `Hei ${extractFirstName(client?.contactPerson)},`,
    '',
    `Vennlig påminnelse: møtet vårt starter ${horizon}. ${formatMeetingShort(client?.meetingAt)}.`,
    inPerson
      ? `Adresse: ${sanitize(client?.meetingPlace) || 'Avtales nærmere'}`
      : (isRealMeetLink(calendar?.meetLink) ? `Google Meet: ${calendar.meetLink}` : ''),
    '',
    SIGNER_NAME,
  ]);

  return {
    subject,
    text,
    html: layout.html,
    from: layout.from,
    replyTo: layout.replyTo,
    attachments: layout.attachments,
  };
}

function buildInviteUid(client, calendar = {}, organizerEmail = '') {
  const eventId = sanitize(calendar?.eventId);
  if (eventId) return `${eventId}@asoldi-calendar`;
  const baseId = sanitize(client?.id) || 'sales-meeting';
  const when = sanitize(client?.meetingAt).replace(/[^0-9TZ]/g, '') || String(Date.now());
  const host = sanitize(organizerEmail).replace(/[^a-zA-Z0-9.-]/g, '') || 'asoldi.com';
  return `${baseId}-${when}@${host}`;
}

export function buildSalesCalendarInvite(client, calendar = {}, options = {}) {
  const attendeeEmail = sanitize(client?.contactEmail).toLowerCase();
  if (!isEmail(attendeeEmail)) return null;
  const startIso = sanitize(client?.meetingAt);
  const startMs = new Date(startIso).getTime();
  if (!Number.isFinite(startMs)) return null;

  const inPerson = isInPerson(client);
  const meetLink = inPerson ? '' : sanitize(calendar?.meetLink);
  const sequence = Number(calendar?.inviteSequence);
  const inviteSequence = Number.isFinite(sequence) && sequence > 0 ? Math.trunc(sequence) : 0;
  const organizerEmail = resolveOrganizerEmail(client, options?.organizerEmail);
  const organizerName = sanitize(options?.organizerName) || 'Asoldi';
  const attendeeName = sanitize(client?.contactPerson) || sanitize(client?.businessName) || attendeeEmail;
  const duration = calendarDurationForMode(client?.meetingMode);
  const endMs = startMs + duration * 60 * 1000;
  const location = inPerson
    ? (sanitize(client?.meetingPlace) || 'Avtales nærmere')
    : (isRealMeetLink(meetLink) ? meetLink : (sanitize(calendar?.htmlLink) || 'Google Meet'));
  const summary = inPerson
    ? `${sanitize(client?.businessName) || 'Kunde'} · Fysisk møte med Asoldi`
    : `${sanitize(client?.businessName) || 'Kunde'} · Online møte med Asoldi`;
  const description = [
    'Takk for at du booker møte med oss.',
    `Kontaktperson: ${sanitize(client?.contactPerson) || '—'}`,
    `Bedrift: ${sanitize(client?.businessName) || '—'}`,
    `Varighet: ca. ${CLIENT_MEETING_DURATION_MINUTES} minutter`,
    inPerson ? `Adresse: ${location}` : (isRealMeetLink(meetLink) ? `Google Meet: ${meetLink}` : `Sted: ${location}`),
    sanitize(calendar?.htmlLink) ? `Kalenderlenke: ${sanitize(calendar.htmlLink)}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  const icsLines = [
    'BEGIN:VCALENDAR',
    'PRODID:-//Asoldi//Sales Meeting Invite//NO',
    'VERSION:2.0',
    'CALSCALE:GREGORIAN',
    'METHOD:REQUEST',
    'BEGIN:VEVENT',
    `UID:${escapeIcsText(buildInviteUid(client, calendar, organizerEmail))}`,
    `DTSTAMP:${formatIcsDate(new Date().toISOString())}`,
    `DTSTART:${formatIcsDate(startIso)}`,
    `DTEND:${formatIcsDate(new Date(endMs).toISOString())}`,
    `SUMMARY:${escapeIcsText(summary)}`,
    `DESCRIPTION:${escapeIcsText(description)}`,
    `LOCATION:${escapeIcsText(location)}`,
    `ORGANIZER;CN=${escapeIcsParam(organizerName)}:mailto:${organizerEmail}`,
    `ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE;CN=${escapeIcsParam(attendeeName)}:mailto:${attendeeEmail}`,
    `SEQUENCE:${inviteSequence}`,
    'STATUS:CONFIRMED',
    'TRANSP:OPAQUE',
    sanitize(calendar?.htmlLink) ? `URL:${escapeIcsText(sanitize(calendar.htmlLink))}` : '',
    !inPerson && isRealMeetLink(meetLink) ? `X-GOOGLE-CONFERENCE:${escapeIcsText(meetLink)}` : '',
    'END:VEVENT',
    'END:VCALENDAR',
  ].filter(Boolean);

  return {
    method: 'REQUEST',
    filename: inPerson ? 'asoldi-fysisk-mote.ics' : 'asoldi-online-mote.ics',
    content: `${icsLines.join('\r\n')}\r\n`,
  };
}

export function buildOnlineCalendarInvite(client, calendar = {}, options = {}) {
  if (isInPerson(client)) return null;
  return buildSalesCalendarInvite(client, calendar, options);
}

export function renderSalesUnsubscribePage({ clientId = '' } = {}) {
  const id = sanitize(clientId);
  return `<!doctype html>
<html lang="nb">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Avmeld e-postmarkedsføring | Asoldi</title>
</head>
<body style="margin:0;background:#050505;color:#fff;font-family:Arial,Helvetica,sans-serif;">
  <div style="max-width:560px;margin:12vh auto;padding:24px;text-align:center;">
    <p style="color:#FF5B00;letter-spacing:0.08em;text-transform:uppercase;font-size:12px;">Asoldi</p>
    <h1 style="font-size:28px;font-weight:normal;">Avmeld e-postmarkedsføring</h1>
    <p style="color:#cfcfcf;line-height:1.6;">
      Denne siden kobles snart til e-postlistene våre.
      ${id ? `Forespørselen er registrert for kunde <strong>${escapeHtml(id)}</strong>.` : ''}
      Svar på e-posten fra oss hvis du vil avslutte e-poster med en gang.
    </p>
    <p><a href="${SITE_URL}" style="color:#FF5B00;">Tilbake til asoldi.com</a></p>
  </div>
</body>
</html>`;
}

export const EMAIL_MERGE_FIELDS = [
  { token: '{{firstName}}', label: 'Fornavn', sample: 'Damian' },
  { token: '{{fullName}}', label: 'Fullt navn', sample: 'Damian Hegdal Chapan' },
  { token: '{{businessName}}', label: 'Bedrift', sample: 'Asoldi' },
  { token: '{{meetingWhen}}', label: 'Møtetid (kort)', sample: '16.09.26 kl 14:00' },
  { token: '{{meetingSlot}}', label: 'Møtetid (emne)', sample: 'onsdag 16. sep kl 14:00' },
  { token: '{{meetLink}}', label: 'Meet-lenke', sample: 'https://meet.google.com/aaa-bbbb-ccc' },
  { token: '{{mapsUrl}}', label: 'Kart-lenke', sample: 'https://www.google.com/maps/search/?api=1&query=Østre+berg+10' },
  { token: '{{websiteUrl}}', label: 'Nettside', sample: 'https://asoldi.com' },
  { token: '{{need}}', label: 'Behov fra samtalen', sample: 'nettside og synlighet' },
  { token: '{{meetingPlace}}', label: 'Møtested', sample: 'Østre berg 10' },
  { token: '{{orgNumber}}', label: 'Org. nr', sample: '934 327 497' },
  { token: '{{businessAddress}}', label: 'Forretningsadresse', sample: 'Østre berg 10, 7014 Trondheim' },
  { token: '{{signerName}}', label: 'Avsender', sample: 'Alexander' },
  { token: '{{signerEmail}}', label: 'Avsender-epost', sample: SIGNER_EMAIL },
  { token: '{{signerPhone}}', label: 'Telefon', sample: SIGNER_PHONE },
];

export function salesEmailMergeMap(client = {}, calendar = {}, sender = {}) {
  const meet = sanitize(calendar?.meetLink || client?.calendar?.meetLink);
  return {
    firstName: extractFirstName(client?.contactPerson),
    fullName: sanitize(client?.contactPerson),
    businessName: sanitize(client?.businessName) || 'bedriften din',
    meetingWhen: formatMeetingShort(client?.meetingAt),
    meetingSlot: formatMeetingSlot(client?.meetingAt),
    meetLink: isInPerson(client) ? '' : (isRealMeetLink(meet) ? meet : sanitize(calendar?.htmlLink || '')),
    mapsUrl: buildMapsUrl(client),
    websiteUrl: websiteUrl(client),
    need: customNeedPhrase(client),
    meetingPlace: sanitize(client?.meetingPlace) || 'Avtales nærmere',
    orgNumber: formatOrgNumberForEmail(client?.orgNumber),
    businessAddress: sanitize(client?.businessAddress) || sanitize(client?.meetingPlace),
    signerName: signerFirstName(sender),
    signerEmail: sanitize(sender.fromEmail) || SIGNER_EMAIL,
    signerPhone: signerPhoneFor(sender),
  };
}

export function htmlToPlainText(html = '') {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/\s+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

export function rewriteSalesEmailAssetsToHosted(html = '') {
  let next = String(html || '');
  const hostedBase = resolveSalesEmailAssetBase();
  for (const spec of Object.values(ASSET_FILES)) {
    const file = spec.file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    next = next.replace(new RegExp(`cid:${spec.cid}\\b`, 'g'), `${hostedBase}/${spec.file}`);
    next = next.replace(
      new RegExp(`(?:https?:\\/\\/[^"'\\s]+)?\\/?email\\/sales\\/${file}`, 'g'),
      `${hostedBase}/${spec.file}`
    );
  }
  return next;
}

export function embedInlineEmailAssets(html = '') {
  return {
    html: rewriteSalesEmailAssetsToHosted(html),
    attachments: [],
  };
}

export const EMPTY_EMAIL_HTML = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;background:#ffffff;">
  <tr>
    <td style="padding:32px 24px;font-family:Arial,Helvetica,sans-serif;color:#1a1a1a;">
      <h1 style="margin:0 0 16px;font-size:24px;font-weight:normal;">Ny e-post</h1>
      <p style="margin:0 0 12px;">Hei {{firstName}},</p>
      <p style="margin:0;">Lim inn eller bygg malen her. Bruk flettefeltene til venstre.</p>
    </td>
  </tr>
</table>`;

