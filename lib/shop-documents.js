/**
 * Sales documents for client shops: the CMS sends a structured document, the hub
 * renders the PDF (bokføringsforskriften kap. 5 fields) and emails it from
 * "<shop name> <asoldi address>" with the shop as Reply-To.
 *
 * Abuse guard: content is a fixed template (every field escaped), the recipient is
 * the buyer on the document (gift card recipient / magic link are the only explicit
 * `to`), each document is sent once unless `resend`, and sends are rate limited.
 */
import { createHash } from 'crypto';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import PDFDocument from 'pdfkit';
import { getDataFilePath } from '../data/storage-path.js';
import { formatMailbox, parseMailbox, resolveTransactionalFrom, sendEmail } from './email.js';
import { ShopPaymentError, assertSiteUrl, getStripeCheckout } from './shop-payments.js';

const SENT_FILE = 'shop-documents-sent.json';
const MAX_SENT_KEYS = 20_000;
const MAX_RESENDS = 5;
const SITE_LIMIT_PER_HOUR = 300;
const RECIPIENT_LIMIT_PER_HOUR = 20;

export const DOCUMENT_KINDS = ['order', 'booking', 'giftcard', 'shipped', 'credit-note', 'renewal', 'withdrawal', 'booking-cancelled', 'magic-link', 'cart-reminder'];
const PDF_KINDS = new Set(['order', 'booking', 'credit-note', 'renewal', 'giftcard']);
const TITLES = {
  order: 'Kvittering',
  booking: 'Bookingbekreftelse',
  giftcard: 'Gavekort',
  shipped: 'Ordren din er sendt',
  'credit-note': 'Kreditnota',
  renewal: 'Kvittering – fornyelse',
  withdrawal: 'Angremelding mottatt',
  'booking-cancelled': 'Booking avbestilt',
  'magic-link': 'Logg inn på Min side',
  'cart-reminder': 'Du har varer i handlekurven',
};

const deps = { sendEmail, now: () => Date.now() };
const windows = new Map();

/** Tests swap the mailer and clock. */
export function setShopDocumentDeps(next = {}) {
  Object.assign(deps, next);
  windows.clear();
}

function clean(value, max = 500) {
  return String(value ?? '').trim().slice(0, max);
}

function validEmail(value) {
  const v = clean(value, 200).toLowerCase();
  return /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/.test(v) ? v : '';
}

function httpUrl(value) {
  try {
    const url = new URL(clean(value, 1000));
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : '';
  } catch {
    return '';
  }
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

const WIN_ANSI_EXTRA = new Set('€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ');
/** pdfkit's built-in Helvetica only has WinAnsi glyphs. */
function pdfText(value) {
  return String(value ?? '')
    .replace(/[\u2212\u2010\u2011]/g, '-')
    .replace(/[\u202f\u2009\u2007]/g, ' ')
    .replace(/[^\n\x20-\xff]/g, (c) => (WIN_ANSI_EXTRA.has(c) ? c : '?'));
}

export function formatMoney(minor, currency = 'nok') {
  const code = clean(currency || 'nok', 3).toUpperCase() || 'NOK';
  try {
    const fmt = new Intl.NumberFormat('nb-NO', { style: 'currency', currency: code });
    const digits = fmt.resolvedOptions().maximumFractionDigits;
    return fmt.format((Number(minor) || 0) / 10 ** digits);
  } catch {
    return `${((Number(minor) || 0) / 100).toFixed(2)} ${code}`;
  }
}

function formatDate(value, withTime = false) {
  const d = new Date(value || Date.now());
  if (!Number.isFinite(d.getTime())) return '';
  return new Intl.DateTimeFormat('nb-NO', withTime ? { dateStyle: 'full', timeStyle: 'short', timeZone: 'Europe/Oslo' } : { dateStyle: 'medium', timeZone: 'Europe/Oslo' }).format(d);
}

function rows(list) {
  return Array.isArray(list) ? list.filter((x) => x && typeof x === 'object') : [];
}

function liveBookings(doc) {
  return rows(doc.bookings).filter((b) => b.start && b.end);
}

// ── PDF ───────────────────────────────────────────────────────────────────────

function collect(pdf) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    pdf.on('data', (c) => chunks.push(c));
    pdf.on('end', () => resolve(Buffer.concat(chunks)));
    pdf.on('error', reject);
  });
}

function sellerLines(seller = {}) {
  const raw = clean(seller.orgNumber, 40);
  const digits = raw.replace(/\D+/g, '');
  const org = digits.length === 9 ? `${digits.slice(0, 3)} ${digits.slice(3, 6)} ${digits.slice(6)}` : raw;
  return [
    clean(seller.address, 300),
    org ? `Org.nr. ${org}${seller.vatRegistered ? ' MVA' : ''}` : '',
    seller.foretaksregisteret ? 'Foretaksregisteret' : '',
    [clean(seller.email, 200), clean(seller.phone, 40)].filter(Boolean).join(' · '),
  ].filter(Boolean);
}

function renderGiftcardPage(pdf, doc) {
  const card = doc.giftcard || {};
  const cur = doc.currency;
  pdf.font('Helvetica-Bold').fontSize(14).text(pdfText(doc.seller?.name || doc.siteName), { align: 'center' });
  pdf.moveDown(2);
  pdf.font('Helvetica-Bold').fontSize(30).text('GAVEKORT', { align: 'center' });
  pdf.moveDown(0.5);
  pdf.font('Helvetica').fontSize(22).text(pdfText(formatMoney(card.amountMinor, cur)), { align: 'center' });
  pdf.moveDown(1.5);
  if (card.recipientName) pdf.fontSize(13).text(pdfText(`Til: ${clean(card.recipientName, 120)}`), { align: 'center' });
  if (doc.buyer?.name) pdf.fontSize(13).text(pdfText(`Fra: ${clean(doc.buyer.name, 120)}`), { align: 'center' });
  if (card.message) {
    pdf.moveDown();
    pdf.font('Helvetica-Oblique').fontSize(12).text(pdfText(`«${clean(card.message, 500)}»`), { align: 'center' });
  }
  pdf.moveDown(2);
  pdf.font('Helvetica').fontSize(11).text('Kode', { align: 'center' });
  pdf.font('Courier-Bold').fontSize(24).text(pdfText(clean(card.code, 40)), { align: 'center' });
  pdf.moveDown();
  pdf.font('Helvetica').fontSize(11);
  if (card.expiresAt) pdf.text(pdfText(`Gyldig til ${formatDate(card.expiresAt)}`), { align: 'center' });
  if (doc.siteUrl) pdf.text(pdfText(`Bruk koden i kassen på ${doc.siteUrl}`), { align: 'center' });
}

function renderSalesDocument(pdf, doc) {
  const left = pdf.page.margins.left;
  const right = pdf.page.width - pdf.page.margins.right;
  const bottom = pdf.page.height - pdf.page.margins.bottom;
  const cur = doc.currency;
  const top = pdf.y;

  pdf.font('Helvetica-Bold').fontSize(15).text(pdfText(doc.seller?.name || doc.siteName), left, top, { width: 280 });
  pdf.font('Helvetica').fontSize(9);
  for (const line of sellerLines(doc.seller)) pdf.text(pdfText(line), { width: 280 });
  const sellerBottom = pdf.y;

  pdf.font('Helvetica-Bold').fontSize(18).text(pdfText(TITLES[doc.kind] || 'Kvittering'), left + 300, top, { width: right - left - 300, align: 'right' });
  pdf.font('Helvetica').fontSize(10);
  const meta = [`Nr. ${clean(doc.number, 40)}`, `Dato ${formatDate(doc.date)}`];
  if (doc.kind === 'credit-note' && doc.creditFor) meta.push(`Krediterer ordre ${clean(doc.creditFor, 40)}`);
  if (doc.kind === 'renewal' && doc.orderNumber && doc.orderNumber !== doc.number) meta.push(`Ordre ${clean(doc.orderNumber, 40)}`);
  for (const line of meta) pdf.text(pdfText(line), { width: right - left - 300, align: 'right' });

  pdf.y = Math.max(sellerBottom, pdf.y) + 18;
  const buyer = doc.buyer || {};
  const buyerLines = [clean(buyer.name, 120), clean(buyer.address, 300), clean(buyer.email, 200), clean(buyer.phone, 40)].filter(Boolean);
  if (buyerLines.length) {
    pdf.font('Helvetica-Bold').fontSize(10).text('Kunde', left);
    pdf.font('Helvetica').fontSize(10);
    for (const line of buyerLines) pdf.text(pdfText(line), left);
    pdf.moveDown();
  }
  if (doc.kind === 'credit-note' && doc.reason) {
    pdf.font('Helvetica').fontSize(10).text(pdfText(`Årsak: ${clean(doc.reason, 300)}`), left);
    pdf.moveDown(0.5);
  }

  const cols = [
    { label: 'Beskrivelse', x: left, w: 240, align: 'left' },
    { label: 'Antall', x: left + 245, w: 45, align: 'right' },
    { label: 'Pris', x: left + 295, w: 75, align: 'right' },
    { label: 'MVA', x: left + 375, w: 35, align: 'right' },
    { label: 'Sum', x: left + 415, w: right - left - 415, align: 'right' },
  ];
  const drawRow = (cells, bold = false) => {
    pdf.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9.5);
    const height = Math.max(...cells.map((c, i) => pdf.heightOfString(pdfText(c), { width: cols[i].w })));
    if (pdf.y + height > bottom - 20) pdf.addPage();
    const y = pdf.y;
    cells.forEach((c, i) => pdf.text(pdfText(c), cols[i].x, y, { width: cols[i].w, align: cols[i].align }));
    pdf.y = y + height + 4;
  };
  drawRow(cols.map((c) => c.label), true);
  pdf.moveTo(left, pdf.y - 2).lineTo(right, pdf.y - 2).lineWidth(0.5).stroke();

  for (const line of rows(doc.lines)) {
    let name = clean(line.name, 300);
    if (line.booking?.start) name += `\n${formatDate(line.booking.start, true)}${line.booking.staffName ? ` – ${clean(line.booking.staffName, 80)}` : ''}`;
    if (line.discountMinor > 0) name += `\nRabatt ${formatMoney(-line.discountMinor, cur)}`;
    drawRow([name, String(line.quantity || 1), formatMoney(line.unitMinor, cur), `${Number(line.rate) || 0} %`, formatMoney(line.totalMinor, cur)]);
  }
  if (doc.shipping?.amountMinor > 0 || doc.shipping?.name) {
    drawRow([`Frakt: ${clean(doc.shipping.name, 120)}`, '1', formatMoney(doc.shipping.amountMinor, cur), '', formatMoney(doc.shipping.amountMinor, cur)]);
  }
  pdf.moveTo(left, pdf.y).lineTo(right, pdf.y).lineWidth(0.5).stroke();
  pdf.y += 6;

  const sumRow = (label, value, bold = false) => {
    if (pdf.y > bottom - 20) pdf.addPage();
    const y = pdf.y;
    pdf.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 11 : 9.5);
    pdf.text(pdfText(label), left + 245, y, { width: 165, align: 'right' });
    pdf.text(pdfText(value), left + 415, y, { width: right - left - 415, align: 'right' });
    pdf.y = y + (bold ? 16 : 13);
  };
  // Line totals are already discounted; this only states how much of it was the code.
  for (const d of rows(doc.discounts)) {
    if (d.amountMinor > 0) sumRow(`Herav rabatt ${clean(d.title || d.code, 60)}`, formatMoney(d.amountMinor, cur));
  }
  for (const t of rows(doc.taxLines)) {
    sumRow(`MVA ${Number(t.rate) || 0} % av ${formatMoney(t.netMinor, cur)}`, formatMoney(t.taxMinor, cur));
  }
  sumRow(doc.kind === 'credit-note' ? 'Kreditert totalt' : 'Totalt inkl. MVA', formatMoney(doc.totalMinor, cur), true);
  for (const g of rows(doc.giftcardPayments)) {
    if (g.amountMinor > 0) sumRow(`Gavekort${g.last4 ? ` …${clean(g.last4, 4)}` : ''}`, formatMoney(-g.amountMinor, cur));
  }
  if (rows(doc.giftcardPayments).length) {
    sumRow(doc.kind === 'credit-note' ? 'Tilbakeført til kort/PayPal' : 'Betalt', formatMoney(doc.amountPaidMinor, cur));
  }

  pdf.moveDown(1.5);
  pdf.font('Helvetica').fontSize(9.5);
  const foot = [];
  if (doc.paymentMethod) foot.push(`Betalingsmåte: ${clean(doc.paymentMethod, 60)}`);
  if (!doc.seller?.vatRegistered) foot.push('Selger er ikke registrert i Merverdiavgiftsregisteret.');
  if (doc.kind === 'order' && doc.withdrawal?.text) {
    foot.push(clean(doc.withdrawal.text, 1200));
    if (doc.withdrawal.formUrl) foot.push(`Angreskjema: ${clean(doc.withdrawal.formUrl, 300)}`);
  }
  for (const line of foot) {
    if (pdf.y > bottom - 30) pdf.addPage();
    pdf.text(pdfText(line), left, pdf.y, { width: right - left });
    pdf.moveDown(0.4);
  }
}

export async function renderShopDocumentPdf(doc) {
  const pdf = new PDFDocument({ size: 'A4', margin: 50, info: { Title: `${TITLES[doc.kind] || 'Dokument'} ${clean(doc.number, 40)}`, Author: clean(doc.seller?.name || doc.siteName, 120) } });
  const done = collect(pdf);
  if (doc.kind === 'giftcard') renderGiftcardPage(pdf, doc);
  else renderSalesDocument(pdf, doc);
  pdf.end();
  return done;
}

// ── Calendar ──────────────────────────────────────────────────────────────────

function icsDate(value) {
  return new Date(value).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function icsText(value) {
  return String(value ?? '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/[,;]/g, (c) => `\\${c}`);
}

export function bookingIcs(doc, { cancel = false } = {}) {
  const list = liveBookings(doc).filter((b) => Number.isFinite(Date.parse(b.start)) && Number.isFinite(Date.parse(b.end)));
  if (!list.length) return '';
  let host = 'asoldi.com';
  try {
    host = new URL(doc.siteUrl).hostname || host;
  } catch {
    /* keep default */
  }
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Asoldi//Shop//NO', `METHOD:${cancel ? 'CANCEL' : 'PUBLISH'}`];
  for (const b of list) {
    lines.push(
      'BEGIN:VEVENT',
      `UID:${icsText(clean(b.id, 80))}@${host}`,
      `DTSTAMP:${icsDate(deps.now())}`,
      `DTSTART:${icsDate(b.start)}`,
      `DTEND:${icsDate(b.end)}`,
      `SUMMARY:${icsText(`${clean(b.productName, 120)} – ${clean(doc.seller?.name || doc.siteName, 120)}`)}`,
      `LOCATION:${icsText(clean(doc.seller?.address, 300))}`,
      `DESCRIPTION:${icsText([b.staffName ? `Med ${clean(b.staffName, 80)}` : '', `Ordre ${clean(doc.number, 40)}`, doc.accountUrl ? `Avbestill: ${clean(doc.accountUrl, 300)}` : ''].filter(Boolean).join('\n'))}`,
      `STATUS:${cancel ? 'CANCELLED' : 'CONFIRMED'}`,
      ...(cancel ? ['SEQUENCE:1'] : []),
      'END:VEVENT'
    );
  }
  lines.push('END:VCALENDAR');
  return `${lines.join('\r\n')}\r\n`;
}

// ── Email ─────────────────────────────────────────────────────────────────────

function button(url, label) {
  return `<p style="margin:24px 0"><a href="${esc(url)}" style="background:#111;color:#fff;padding:12px 20px;border-radius:6px;text-decoration:none;display:inline-block">${esc(label)}</a></p>`;
}

function linesTable(doc) {
  const cur = doc.currency;
  const body = rows(doc.lines)
    .map((l) => `<tr><td style="padding:4px 8px 4px 0">${esc(l.quantity || 1)} × ${esc(clean(l.name, 300))}</td><td style="padding:4px 0;text-align:right;white-space:nowrap">${esc(formatMoney(l.totalMinor, cur))}</td></tr>`)
    .join('');
  const ship = doc.shipping?.name ? `<tr><td style="padding:4px 8px 4px 0">Frakt: ${esc(clean(doc.shipping.name, 120))}</td><td style="text-align:right">${esc(formatMoney(doc.shipping.amountMinor, cur))}</td></tr>` : '';
  const total = doc.totalMinor != null ? `<tr><td style="padding:8px 8px 0 0;font-weight:bold">Totalt</td><td style="padding:8px 0 0;text-align:right;font-weight:bold">${esc(formatMoney(doc.totalMinor, cur))}</td></tr>` : '';
  return `<table style="width:100%;border-collapse:collapse;font-size:14px">${body}${ship}${total}</table>`;
}

function bookingList(doc) {
  const list = liveBookings(doc);
  if (!list.length) return '';
  return `<ul>${list.map((b) => `<li><strong>${esc(formatDate(b.start, true))}</strong> – ${esc(clean(b.productName, 120))}${b.staffName ? ` med ${esc(clean(b.staffName, 80))}` : ''}</li>`).join('')}</ul>`;
}

export function documentEmail(doc) {
  const shop = clean(doc.seller?.name || doc.siteName, 120) || 'Butikken';
  const cur = doc.currency;
  const account = httpUrl(doc.accountUrl);
  let subject = `${TITLES[doc.kind]} – ${shop}`;
  let body = '';
  switch (doc.kind) {
    case 'order':
    case 'renewal': {
      subject = doc.kind === 'renewal' ? `Abonnementet ditt er fornyet – ${shop}` : `Takk for bestillingen – ordre ${clean(doc.number, 40)} – ${shop}`;
      body = `<p>${doc.kind === 'renewal' ? 'Abonnementet ditt er fornyet. Kvitteringen ligger vedlagt.' : 'Takk for bestillingen! Kvitteringen ligger vedlagt som PDF.'}</p>${linesTable(doc)}${bookingList(doc)}`;
      const downloads = rows(doc.downloads).filter((d) => httpUrl(d.url));
      if (downloads.length) body += `<p><strong>Nedlastinger</strong></p><ul>${downloads.map((d) => `<li><a href="${esc(httpUrl(d.url))}">${esc(clean(d.name, 200))}</a></li>`).join('')}</ul>`;
      if (doc.kind === 'order' && doc.withdrawal?.text) {
        const form = httpUrl(doc.withdrawal.formUrl);
        body += `<p style="font-size:13px;color:#555">${esc(clean(doc.withdrawal.text, 1200))}${form ? ` <a href="${esc(form)}">Angreskjema</a>.` : ''}</p>`;
      }
      if (account) body += button(account, 'Se ordren på Min side');
      break;
    }
    case 'booking':
      subject = `Bookingen er bekreftet – ${shop}`;
      body = `<p>Bookingen din er bekreftet. Kalenderinvitasjon og kvittering ligger vedlagt.</p>${bookingList(doc)}${linesTable(doc)}`;
      if (account) body += `<p>Må du avbestille? Gjør det på Min side.</p>${button(account, 'Min side')}`;
      break;
    case 'booking-cancelled':
      subject = `Bookingen er avbestilt – ${shop}`;
      body = `<p>Denne bookingen er avbestilt:</p>${bookingList(doc)}`;
      break;
    case 'giftcard': {
      const card = doc.giftcard || {};
      subject = `${card.recipientName ? `${clean(card.recipientName, 80)}, du` : 'Du'} har fått et gavekort fra ${shop}`;
      body = `<p>Her er gavekortet på <strong>${esc(formatMoney(card.amountMinor, cur))}</strong>${doc.buyer?.name ? ` fra ${esc(clean(doc.buyer.name, 120))}` : ''}.</p>`;
      if (card.message) body += `<p style="font-style:italic">«${esc(clean(card.message, 500))}»</p>`;
      body += `<p style="font-size:22px;font-family:monospace;letter-spacing:2px"><strong>${esc(clean(card.code, 40))}</strong></p>`;
      if (card.expiresAt) body += `<p>Gyldig til ${esc(formatDate(card.expiresAt))}.</p>`;
      if (httpUrl(doc.siteUrl)) body += button(httpUrl(doc.siteUrl), `Handle hos ${shop}`);
      break;
    }
    case 'shipped': {
      const s = doc.shipment || {};
      const track = httpUrl(s.trackingUrl);
      subject = `Ordre ${clean(doc.number, 40)} er sendt – ${shop}`;
      body = `<p>Ordren din er på vei${s.carrier ? ` med ${esc(clean(s.carrier, 60))}` : ''}.</p>`;
      if (s.trackingNumber) body += `<p>Sporingsnummer: <strong>${esc(clean(s.trackingNumber, 80))}</strong></p>`;
      if (track) body += button(track, 'Spor pakken');
      break;
    }
    case 'credit-note':
      subject = `Refusjon for ordre ${clean(doc.creditFor || doc.orderNumber, 40)} – ${shop}`;
      body = `<p>Vi har refundert <strong>${esc(formatMoney(doc.totalMinor, cur))}</strong>. Kreditnota ${esc(clean(doc.number, 40))} ligger vedlagt. Det kan ta noen dager før beløpet vises på kontoen din.</p>`;
      break;
    case 'withdrawal':
      subject = `Vi har mottatt angremeldingen din – ordre ${clean(doc.number, 40)}`;
      body = `<p>Vi bekrefter at vi ${esc(formatDate(doc.withdrawal?.at, true))} mottok angremelding for ordre ${esc(clean(doc.number, 40))}.</p>`;
      if (doc.withdrawal?.text) body += `<blockquote>${esc(clean(doc.withdrawal.text, 1000))}</blockquote>`;
      body += '<p>Vi tar kontakt om retur. Pengene betales tilbake senest 14 dager etter at vi har mottatt varene eller bevis på at de er sendt.</p>';
      break;
    case 'magic-link':
      subject = `Logg inn hos ${shop}`;
      body = `<p>Klikk for å logge inn på Min side. Lenken virker i 15 minutter og kan brukes én gang.</p>${button(httpUrl(doc.link), 'Logg inn')}<p style="font-size:13px;color:#555">Ba du ikke om dette, kan du se bort fra e-posten.</p>`;
      break;
    case 'cart-reminder':
      subject = `Du glemte noe i handlekurven – ${shop}`;
      body = `<p>Du har fortsatt varer i handlekurven:</p>${linesTable(doc)}${button(httpUrl(doc.recoveryUrl) || httpUrl(doc.siteUrl), 'Fullfør kjøpet')}<p style="font-size:13px;color:#555">Du får denne ene påminnelsen fordi du ba om det i kassen. Vi sender ikke flere.</p>`;
      break;
    default:
      break;
  }
  const html = `<!doctype html><html><body style="font-family:Arial,Helvetica,sans-serif;color:#111;max-width:560px;margin:0 auto;padding:24px"><h2 style="margin:0 0 16px">${esc(shop)}</h2>${body}<hr style="border:none;border-top:1px solid #ddd;margin:24px 0"><p style="font-size:12px;color:#777">${esc(sellerLines(doc.seller).join(' · '))}</p></body></html>`;
  const text = html.replace(/<(br|\/p|\/li|\/tr|\/h2)>/g, '\n').replace(/<\/td>(?!\s*<\/tr>)/g, '\t').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\n{3,}/g, '\n\n').trim();
  return { subject: subject.slice(0, 200), html, text };
}

// ── Sending ───────────────────────────────────────────────────────────────────

function readSent() {
  const path = getDataFilePath(SENT_FILE);
  if (!existsSync(path)) return {};
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

function writeSent(map) {
  const entries = Object.entries(map);
  const kept = entries.length > MAX_SENT_KEYS ? Object.fromEntries(entries.sort((a, b) => b[1].at - a[1].at).slice(0, MAX_SENT_KEYS)) : map;
  writeFileSync(getDataFilePath(SENT_FILE), JSON.stringify(kept));
}

function hashPart(value) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 16);
}

/** One key per real-world document; magic links are never deduped. */
function dedupeKey(siteId, doc) {
  const n = clean(doc.number, 40);
  const part = {
    giftcard: () => hashPart(doc.giftcard?.code),
    shipped: () => clean(doc.shipment?.id || doc.shipment?.at, 60),
    withdrawal: () => clean(doc.withdrawal?.at, 40),
    'booking-cancelled': () => liveBookings(doc).map((b) => clean(b.id, 40)).join(','),
    'cart-reminder': () => clean(doc.providerId, 120),
  }[doc.kind];
  if (doc.kind === 'magic-link') return '';
  return `${siteId}:${doc.kind}:${n}:${part ? part() : ''}`;
}

function rateLimit(key, limit) {
  const now = deps.now();
  const hits = (windows.get(key) || []).filter((t) => now - t < 3_600_000);
  if (hits.length >= limit) throw new ShopPaymentError('For mange e-poster akkurat nå. Prøv igjen senere.', 429, 'rate_limited');
  hits.push(now);
  windows.set(key, hits);
}

async function resolveRecipient(site, doc, explicitTo) {
  if (doc.kind === 'magic-link') {
    doc.link = assertSiteUrl(site, doc.link, 'link');
    return validEmail(explicitTo);
  }
  if (doc.kind === 'cart-reminder') {
    if (doc.provider !== 'stripe') throw new ShopPaymentError('Cart reminders need a Stripe checkout.');
    const session = await getStripeCheckout(site, doc.providerId);
    if (session.status !== 'expired' || session.paid) throw new ShopPaymentError('Checkout is not abandoned.', 409);
    if (!session.reminderConsent) throw new ShopPaymentError('The buyer did not ask for a reminder.', 409, 'no_consent');
    // The CMS restores its own cart; a Stripe recovery session would be a payment the CMS has no order for.
    doc.recoveryUrl = clean(doc.recoveryUrl) ? assertSiteUrl(site, doc.recoveryUrl, 'recoveryUrl') : '';
    return validEmail(session.customerEmail);
  }
  if (doc.kind === 'giftcard' && explicitTo) return validEmail(explicitTo);
  return validEmail(doc.buyer?.email);
}

/** Renders + emails one shop document for `site`. */
export async function sendShopDocument(site, body = {}) {
  const raw = body.document;
  if (!raw || typeof raw !== 'object' || !DOCUMENT_KINDS.includes(raw.kind)) throw new ShopPaymentError('Unknown document kind.');
  const doc = { ...raw, currency: clean(raw.currency || 'nok', 3).toLowerCase() };
  if (!['magic-link', 'cart-reminder'].includes(doc.kind) && !clean(doc.number, 40)) throw new ShopPaymentError('Document number is required.');
  if (doc.kind === 'giftcard' && !clean(doc.giftcard?.code, 40)) throw new ShopPaymentError('Gift card code is required.');

  const to = await resolveRecipient(site, doc, body.to);
  if (!to) throw new ShopPaymentError('No valid recipient email.', 400, 'no_recipient');

  const key = dedupeKey(site.id, doc);
  const sent = key ? readSent() : {};
  const prior = key ? sent[key] : null;
  if (prior && (!body.resend || doc.kind === 'cart-reminder')) return { ok: true, skipped: true };
  if (prior && prior.count > MAX_RESENDS) throw new ShopPaymentError('Dokumentet er allerede sendt mange ganger.', 429, 'resend_limit');

  rateLimit(`site:${site.id}`, SITE_LIMIT_PER_HOUR);
  rateLimit(`to:${site.id}:${to}`, RECIPIENT_LIMIT_PER_HOUR);

  const { subject, html, text } = documentEmail(doc);
  const attachments = [];
  if (PDF_KINDS.has(doc.kind)) {
    const file = `${doc.kind === 'giftcard' ? 'gavekort' : doc.kind === 'credit-note' ? 'kreditnota' : 'kvittering'}-${clean(doc.number, 40).replace(/[^\w-]+/g, '') || 'dokument'}.pdf`;
    attachments.push({ filename: file, content: await renderShopDocumentPdf(doc), contentType: 'application/pdf' });
  }
  if (doc.kind === 'booking' || doc.kind === 'booking-cancelled') {
    const ics = bookingIcs(doc, { cancel: doc.kind === 'booking-cancelled' });
    if (ics) attachments.push({ filename: doc.kind === 'booking' ? 'booking.ics' : 'avbestilt.ics', content: Buffer.from(ics, 'utf8'), contentType: 'text/calendar; charset=UTF-8' });
  }
  const shopName = clean(doc.seller?.name || doc.siteName || site.name, 80) || 'Butikk';
  const fromAddress = parseMailbox(resolveTransactionalFrom()).address;
  await deps.sendEmail({
    to,
    subject,
    html,
    text,
    from: formatMailbox(shopName.replace(/[<>"]/g, ''), fromAddress),
    replyTo: validEmail(doc.seller?.email) || undefined,
    bcc: false,
    attachments,
  });
  if (key) {
    const fresh = readSent();
    fresh[key] = { at: deps.now(), count: (fresh[key]?.count || 0) + 1 };
    writeSent(fresh);
  }
  return { ok: true, skipped: false };
}
