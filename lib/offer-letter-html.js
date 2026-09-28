/**
 * Portal view of a sent offer letter: the email copy + product specs, without the branded
 * sales-email chrome (hero, orange wash, footer, logos).
 */

function stripEmailComments(html = '') {
  return String(html || '')
    .replace(/<!--\[if[\s\S]*?<!\[endif\]-->/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');
}

function innerUntilMatchingClose(html, start, tag) {
  const openRe = new RegExp(`<${tag}\\b[^>]*>`, 'gi');
  const closeRe = new RegExp(`</${tag}>`, 'gi');
  let depth = 1;
  let i = start;
  while (i < html.length && depth > 0) {
    openRe.lastIndex = i;
    closeRe.lastIndex = i;
    const nextOpen = openRe.exec(html);
    const nextClose = closeRe.exec(html);
    if (!nextClose) break;
    if (nextOpen && nextOpen.index < nextClose.index) {
      depth += 1;
      i = nextOpen.index + nextOpen[0].length;
    } else {
      depth -= 1;
      if (depth === 0) return html.slice(start, nextClose.index);
      i = nextClose.index + nextClose[0].length;
    }
  }
  return html.slice(start);
}

function innerOfTdWithClass(html, className) {
  const re = new RegExp(`<td\\b[^>]*\\bclass\\s*=\\s*["'][^"']*\\b${className}\\b[^"']*["'][^>]*>`, 'i');
  const match = String(html || '').match(re);
  if (!match || match.index == null) return '';
  return innerUntilMatchingClose(html, match.index + match[0].length, 'td');
}

function sliceFromGreeting(html = '') {
  const source = String(html || '');
  const startMatch = source.match(/<p\b[^>]*>\s*Hei\b/i)
    || source.match(/<(p|div)\b[^>]*\bdata-offer-slot="intro"/i)
    || source.match(/<div\b[^>]*\bid="offer-products"/i);
  if (!startMatch || startMatch.index == null) return '';
  const from = source.slice(startMatch.index);
  const footerAt = from.search(/class\s*=\s*["'][^"']*\bemail-footer\b|©\s*\d{4}\s*Alle rettigheter/i);
  const chunk = footerAt >= 0 ? from.slice(0, footerAt) : from;
  return chunk.replace(/(?:<\/td>\s*|<\/tr>\s*|<\/table>\s*)+$/i, '');
}

function stripLetterChrome(html = '') {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<h1\b[^>]*>\s*Tilbud fra Asoldi\s*<\/h1>/gi, '')
    .replace(/<img\b[^>]*>/gi, '')
    .replace(/<div\b[^>]*display:\s*none[^>]*>[\s\S]*?<\/div>/gi, '')
    .replace(/<(td|tr|table)\b[^>]*\bemail-hero\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<(td|tr|table)\b[^>]*\bemail-footer\b[\s\S]*?<\/\1>/gi, '')
    .trim();
}

function stillHasEmailChrome(html = '') {
  return /\bemail-hero\b|\bemail-footer\b|\bemail-bg\b|\bemail-gutter\b/i.test(html);
}

/**
 * Inner letter HTML for the client portal: greeting, body, "Hva er inkludert" specs, sign-off.
 * Idempotent on already-extracted markup.
 */
export function extractOfferLetterBody(html = '') {
  const source = stripEmailComments(String(html || ''));
  if (!source.trim()) return '';
  const pad = innerOfTdWithClass(source, 'pad-body');
  let body = pad || sliceFromGreeting(source) || source;
  if (stillHasEmailChrome(body)) {
    body = sliceFromGreeting(source) || stripLetterChrome(body);
  }
  return stripLetterChrome(body);
}
