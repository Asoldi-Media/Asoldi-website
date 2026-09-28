import { injectEmailPreheader } from './email-merge.js';

const ORANGE = '#FF5B00';
const ORANGE_WASH_SOLID = '#FFE8DA';
const BLACK = '#050505';
const WHITE = '#ffffff';
const TEXT = '#1a1a1a';
const MUTED = '#5b5b5b';
const FONT = 'Arial, Helvetica, sans-serif';
// Outlook cannot do fluid 100% images safely, so it gets a fixed 900px canvas.
// Everywhere else the orange, hero, and footer run edge to edge, and the white
// cards stay at 800px so the copy does not stretch across a wide inbox.
const OUTLOOK_WIDTH = 900;
const CONTENT_WIDTH = 800;
const BADGE_WIDTH = 320;

function attr(value = '') {
  return String(value || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function fontHead() {
  return `
  <style type="text/css">
    html, body { width: 100% !important; max-width: 100% !important; margin: 0 !important; padding: 0 !important; }
    body, table, td, p, a, li, h1, h2, h3 { font-family:${FONT} !important; }
    img { max-width: 100% !important; height: auto !important; }
    .email-bg, .email-hero, .email-footer { width: 100% !important; max-width: 100% !important; }
    .email-content { width: 100% !important; max-width: ${CONTENT_WIDTH}px !important; }
    .customers-badge { width: ${BADGE_WIDTH}px !important; max-width: 100% !important; height: auto !important; }
    @media only screen and (max-width: 640px) {
      .pad-title { padding: 24px 20px 0 !important; }
      .pad-body { padding: 8px 20px 24px !important; }
      .pad-quote { padding: 18px 18px 16px !important; }
      .email-gutter { padding: 16px 12px 12px !important; }
      .email-footer { padding: 24px 16px 16px !important; }
    }
  </style>`;
}

function fontStyle() {
  return `font-family:${FONT};`;
}

function socialIcon(href, src, alt) {
  return `
    <a href="${attr(href)}" target="_blank" style="display:inline-block;margin:0 7px;text-decoration:none;">
      <img src="${attr(src)}" width="32" height="32" alt="${attr(alt)}" style="display:block;border:0;width:32px;height:32px;" />
    </a>`;
}

function logoRow(assets, { color = '#ffffff', markSrc = '', homeUrl = 'https://asoldi.com' } = {}) {
  const src = markSrc || assets.logoMark;
  return `
    <table role="presentation" cellpadding="0" cellspacing="0" border="0">
      <tr>
        <td valign="middle">
          <a href="${attr(homeUrl)}" target="_blank" style="display:inline-block;text-decoration:none;color:${color};">
            <img src="${attr(src)}" width="28" height="28" alt="asoldi.com" style="display:inline-block;border:0;width:28px;height:28px;vertical-align:middle;margin-right:10px;" />
            <span style="${fontStyle()}font-size:22px;line-height:28px;color:${color};text-decoration:underline;vertical-align:middle;">asoldi.com</span>
          </a>
        </td>
      </tr>
    </table>`;
}

function reviewPortrait(assets) {
  const src = assets.reviewAvatar || assets.avatarBlank;
  return `<img src="${attr(src)}" width="40" height="40" alt="Christopher Vrioni" style="display:block;border-radius:20px;border:0;width:40px;height:40px;" />`;
}

function customersBadge(assets, { width = BADGE_WIDTH } = {}) {
  const height = Math.round((width * 76) / 453);
  return `
    <img class="customers-badge" src="${attr(assets.customersBadge)}" width="${width}" height="${height}" alt="100+ fornøyde kunder" style="display:block;border:0;width:${width}px;max-width:100%;height:auto;" />`;
}

function reviewQuote(html) {
  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;table-layout:fixed;">
      <tr>
        <td width="100%" style="width:100%;${fontStyle()}font-size:13px;line-height:1.55;color:${TEXT};word-wrap:break-word;word-break:break-word;overflow-wrap:anywhere;white-space:normal;">
          ${html}
        </td>
      </tr>
    </table>`;
}

function whiteCardOpen() {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#ffffff" style="width:100%;max-width:100%;table-layout:fixed;background:#ffffff;border-collapse:separate;border-radius:18px;overflow:hidden;">`;
}

function testimonialCard(assets) {
  return `
    ${whiteCardOpen()}
      <tr>
        <td class="pad-quote" style="padding:28px 40px 24px;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0">
            <tr>
              <td valign="middle" style="padding-right:12px;">
                ${reviewPortrait(assets)}
              </td>
              <td valign="middle" style="${fontStyle()}">
                <div style="font-size:14px;font-weight:bold;color:${TEXT};">Christopher Vrioni</div>
                <div style="font-size:12px;color:${MUTED};padding-top:2px;">Superhero Pizza and Burger</div>
              </td>
            </tr>
          </table>
          <div style="color:#F5B400;font-size:14px;letter-spacing:2px;padding:12px 0 6px;">★★★★★</div>
          <div style="padding:0 0 14px;">
            ${reviewQuote('“Super happy with the website these guys made for us at superhero burger &amp; superhero pizza... They really done a good job... the whole process was smooth from start to finish. The site is clean, easy to use, and does exactly what we need it to. They were quick to respond whenever we had questions and made sure everything worked perfectly.”')}
          </div>
          ${customersBadge(assets)}
        </td>
      </tr>
    </table>`;
}

function blackFooter(view) {
  const footerLinks = view.footerLinks || {};
  const assets = view.assets || {};
  const year = view.year || new Date().getFullYear();
  return `
    <td class="email-footer" bgcolor="${BLACK}" align="center" width="100%" style="width:100%;padding:32px 24px 22px;background-color:${BLACK};">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0">
        <tr>
          <td align="center">
            ${socialIcon(footerLinks.facebook, assets.facebook, 'Facebook')}
            ${socialIcon(footerLinks.instagram, assets.instagram, 'Instagram')}
            ${socialIcon(footerLinks.youtube, assets.youtube, 'YouTube')}
          </td>
        </tr>
      </table>
      <p style="margin:16px 0 0;${fontStyle()}font-size:12px;line-height:1.6;color:#d7d7d7;">
        © ${year} Alle rettigheter reservert<br/>
        Østre berg 10, Trondheim Norge
      </p>
      <p style="margin:12px 0 0;${fontStyle()}font-size:12px;line-height:1.7;color:#d7d7d7;">
        <a href="${attr(footerLinks.mail)}" style="color:#d7d7d7;text-decoration:underline;">Mail</a>
        &nbsp;·&nbsp;
        <a href="${attr(footerLinks.vilkar)}" style="color:#d7d7d7;text-decoration:underline;">Vilkår</a>
        &nbsp;&amp;&nbsp;
        <a href="${attr(footerLinks.personvern)}" style="color:#d7d7d7;text-decoration:underline;">personvern</a>
        &nbsp;·&nbsp;
        <a href="${attr(footerLinks.databehandleravtale)}" style="color:#d7d7d7;text-decoration:underline;">databehandleravtale</a>
        &nbsp;·&nbsp;
        <a href="${attr(footerLinks.kontakt)}" style="color:#d7d7d7;text-decoration:underline;">Kontakt oss</a>
      </p>
      ${view.showUnsubscribe
        ? `<p style="margin:10px 0 4px;${fontStyle()}font-size:11px;line-height:1.6;">
        <a href="${attr(footerLinks.unsubscribe)}" style="color:#9a9a9a;text-decoration:underline;">Avmeld e-postmarkedsføring</a>
      </p>`
        : ''}
    </td>`;
}

function ctaButton(href, label) {
  if (!href || !label) return '';
  return `
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:16px auto 18px;">
      <tr>
        <td align="center" bgcolor="${ORANGE}" style="background:${ORANGE};padding:12px 22px;border-radius:8px;">
          <a href="${attr(href)}" target="_blank" style="display:inline-block;color:#ffffff;text-decoration:none;font-weight:bold;${fontStyle()}font-size:16px;">${label}</a>
        </td>
      </tr>
    </table>`;
}

function messageCard(view) {
  const assets = view.assets || {};
  const title = view.title || view.mobileTitle || 'Møtet bekreftet';
  const envelopeSrc = assets.envelope;
  // Offer emails ask for a plain left-aligned heading without the envelope illustration.
  const titleAlign = view.titleAlign === 'left' ? 'left' : 'center';
  const showIllustration = view.hideIllustration !== true && Boolean(envelopeSrc);
  return `
    ${whiteCardOpen()}
      <tr>
        <td class="pad-title" style="padding:32px 40px ${showIllustration ? '0' : '8px'};text-align:${titleAlign};">
          <h1 style="margin:0;${fontStyle()}font-size:24px;line-height:1.3;font-weight:normal;color:${TEXT};">${title}</h1>
          ${showIllustration ? `<img src="${attr(envelopeSrc)}" width="160" alt="" style="display:block;margin:20px auto 12px;border:0;width:160px;max-width:70%;height:auto;" />` : ''}
        </td>
      </tr>
      <tr>
        <td class="pad-body" style="padding:8px 40px 32px;${fontStyle()}font-size:15px;line-height:1.65;color:${TEXT};text-align:left;">
          ${view.bodyHtml || ''}
          ${ctaButton(view.ctaUrl, view.ctaLabel)}
          ${view.agendaHtml || ''}
          ${view.closingHtml || ''}
          <div style="padding-top:8px;">${view.signerHtml || ''}</div>
        </td>
      </tr>
    </table>`;
}

function contentColumn(inner) {
  return `
    <!--[if mso]>
    <table role="presentation" width="${CONTENT_WIDTH}" cellpadding="0" cellspacing="0" border="0" align="center"><tr><td>
    <![endif]-->
    <table class="email-content" role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" align="center" style="width:100%;max-width:${CONTENT_WIDTH}px;margin:0 auto;">
      ${inner}
    </table>
    <!--[if mso]>
    </td></tr></table>
    <![endif]-->`;
}

function renderHybrid(view) {
  const assets = view.assets || {};
  const heroSrc = assets.heroDesktop || assets.heroMobile;
  const heroAlt = 'Nettside utvikling for alle — Asoldi.com';
  const testimonialRow = view.showTestimonial === false
    ? ''
    : `<tr><td style="padding:12px 0 0;">${testimonialCard(assets)}</td></tr>`;
  return `
    <!--[if mso]>
    <table role="presentation" width="${OUTLOOK_WIDTH}" cellpadding="0" cellspacing="0" border="0" align="center" bgcolor="${ORANGE_WASH_SOLID}"><tr><td>
    <![endif]-->
    <table class="email-bg" role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" align="center" bgcolor="${ORANGE_WASH_SOLID}" style="width:100%;background-color:${ORANGE_WASH_SOLID};">
      <tr>
        <td class="email-hero" bgcolor="${BLACK}" width="100%" style="width:100%;padding:0;font-size:0;line-height:0;background-color:${BLACK};">
          <!--[if mso]>
          <img src="${attr(heroSrc)}" width="${OUTLOOK_WIDTH}" alt="${attr(heroAlt)}" style="display:block;width:${OUTLOOK_WIDTH}px;height:auto;border:0;" />
          <![endif]-->
          <!--[if !mso]><!-->
          <img class="email-hero" src="${attr(heroSrc)}" alt="${attr(heroAlt)}" style="display:block;width:100%;max-width:100%;height:auto;border:0;" />
          <!--<![endif]-->
        </td>
      </tr>
      <tr>
        <td class="email-gutter" align="center" bgcolor="${ORANGE_WASH_SOLID}" style="padding:28px 16px 20px;background-color:${ORANGE_WASH_SOLID};">
          ${contentColumn(`
            <tr>
              <td>${messageCard(view)}</td>
            </tr>
            ${testimonialRow}
            <tr>
              <td align="center" style="padding:20px 0 4px;">
                ${logoRow(assets, { color: ORANGE, markSrc: assets.logoMarkOrange || assets.logoMark })}
              </td>
            </tr>
          `)}
        </td>
      </tr>
      <tr>
        ${blackFooter(view)}
      </tr>
    </table>
    <!--[if mso]>
    </td></tr></table>
    <![endif]-->`;
}

export function renderBrandedSalesEmailHtml(view = {}) {
  const table = `
  <table class="email-bg" role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${ORANGE_WASH_SOLID}" style="width:100%;max-width:100%;background-color:${ORANGE_WASH_SOLID};margin:0;padding:0;${fontStyle()}">
    <tr>
      <td align="center" bgcolor="${ORANGE_WASH_SOLID}" style="padding:0;background-color:${ORANGE_WASH_SOLID};">
        ${renderHybrid(view)}
      </td>
    </tr>
  </table>`;
  return injectEmailPreheader(table, view.preheader || '');
}

export function renderResponsiveSalesEmailHtml(view = {}) {
  return renderBrandedSalesEmailHtml(view);
}

export function wrapSalesEmailHtmlDocument({ title = 'Asoldi', html = '' } = {}) {
  return `<!doctype html>
<html lang="nb" xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta http-equiv="X-UA-Compatible" content="IE=edge" />
  <title>${attr(title)}</title>
  ${fontHead()}
</head>
<body bgcolor="${ORANGE_WASH_SOLID}" style="margin:0;padding:0;width:100%;background-color:${ORANGE_WASH_SOLID};${fontStyle()}">
${html}
</body>
</html>`;
}

export function renderSalesEmailDocument({ title = 'Asoldi', html = '', note = '', frame = 'desktop' } = {}) {
  const isMobile = frame === 'mobile';
  const banner = note
    ? `<div style="${isMobile ? 'max-width:390px;margin:0 auto 16px;' : 'margin:0 0 0;'}padding:12px 16px;${fontStyle()}font-size:13px;color:#444;background:#fff3ea;border-bottom:1px solid #ffd7bf;">${note}</div>`
    : '';
  if (isMobile) {
    return `<!doctype html>
<html lang="nb">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${attr(title)}</title>
  ${fontHead()}
</head>
<body style="margin:0;padding:24px 0;background:#e9e9e9;${fontStyle()}">
  ${banner}
  <div style="max-width:390px;margin:0 auto;background:${ORANGE_WASH_SOLID};">
    ${html}
  </div>
</body>
</html>`;
  }
  return `<!doctype html>
<html lang="nb">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${attr(title)}</title>
  ${fontHead()}
</head>
<body bgcolor="${ORANGE_WASH_SOLID}" style="margin:0;padding:0;background-color:${ORANGE_WASH_SOLID};${fontStyle()}">
  ${banner}
  ${html}
</body>
</html>`;
}

export function renderSalesEmailPreviewIndex({ pcHref = '', phoneHref = '' } = {}) {
  return `<!doctype html>
<html lang="nb">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Asoldi e-postmal — PC og telefon</title>
  ${fontHead()}
</head>
<body style="margin:0;background:#111;color:#fff;${fontStyle()}">
  <div style="width:100%;box-sizing:border-box;margin:0 auto;padding:28px 16px 40px;">
    <p style="color:#FF5B00;letter-spacing:0.08em;text-transform:uppercase;font-size:12px;">Asoldi e-post</p>
    <h1 style="font-weight:normal;margin:0 0 8px;">Velkomstmail — oransje kant til kant, innhold 800px</h1>
    <p style="color:#bbb;max-width:640px;">Hero, oransje bakgrunn og svart footer går i full bredde. Teksten ligger i et 800px kort med luft inni, så linjene ikke blir for lange. Telefon-rammen er 390px.</p>
    <p style="margin:18px 0 28px;">
      <a href="${attr(pcHref)}" style="display:inline-block;margin-right:10px;padding:12px 18px;background:#FF5B00;color:#fff;text-decoration:none;border-radius:8px;">PC-bredde</a>
      <a href="${attr(phoneHref)}" style="display:inline-block;padding:12px 18px;background:#222;color:#fff;text-decoration:none;border-radius:8px;border:1px solid #444;">Telefon-bredde</a>
    </p>
    <div style="display:flex;flex-wrap:wrap;gap:24px;align-items:flex-start;">
      <div style="flex:1 1 720px;min-width:0;">
        <p style="margin:0 0 8px;color:#888;">PC · oransje, hero og footer i full bredde</p>
        <iframe src="${attr(pcHref)}" title="PC" style="display:block;width:100%;height:1200px;border:0;background:${WHITE};border-radius:8px;"></iframe>
      </div>
      <div style="flex:0 0 390px;">
        <p style="margin:0 0 8px;color:#888;">Telefon · 390px</p>
        <iframe src="${attr(phoneHref)}" title="Telefon" width="390" height="1100" style="border:0;background:${WHITE};border-radius:8px;"></iframe>
      </div>
    </div>
  </div>
</body>
</html>`;
}
