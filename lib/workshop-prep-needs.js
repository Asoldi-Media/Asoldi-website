/**
 * Client-facing gaps for the pre-workshop mail: T01 still-need lines plus
 * Prosjektdokument red/orange dots the client can actually send.
 */

const SKIP_DOT_IDS = new Set([
  'google-place-id',
  'google-place-name',
  'color-primary',
  'color-secondary',
  'color-accent',
  'language',
  'catalog-layout',
  'category-name',
  'product-compare',
  'product-contact-price',
  'product-subtitle',
  'product-allergens',
  'product-included',
  'product-options',
  'product-extra',
  'partner-category',
  'business-name',
  'org-number',
  'company-email',
  'phone',
]);

function sanitize(value = '') {
  return String(value ?? '').trim();
}

function keyOf(title = '', id = '') {
  return `${sanitize(id).toLowerCase()}|${sanitize(title).toLowerCase()}`;
}

export function mergePrepNeedLines({ t01Lines = [], dots = [] } = {}) {
  const out = [];
  const seen = new Set();

  for (const row of Array.isArray(t01Lines) ? t01Lines : []) {
    const title = sanitize(row?.title);
    if (!title) continue;
    const id = sanitize(row?.id);
    const stamp = keyOf(title, id);
    if (seen.has(stamp) || seen.has(keyOf(title, ''))) continue;
    seen.add(stamp);
    seen.add(keyOf(title, ''));
    out.push({
      id: id || `need-${out.length + 1}`,
      title,
      detail: sanitize(row?.detail),
      source: 't01',
    });
  }

  for (const row of Array.isArray(dots) ? dots : []) {
    const id = sanitize(row?.id);
    if (SKIP_DOT_IDS.has(id)) continue;
    const mark = sanitize(row?.mark);
    if (mark !== 'red' && mark !== 'orange') continue;
    const title = sanitize(row?.label) || id;
    if (!title) continue;
    const stamp = keyOf(title, id);
    if (seen.has(stamp) || seen.has(keyOf(title, ''))) continue;
    seen.add(stamp);
    seen.add(keyOf(title, ''));
    out.push({
      id: id || `dot-${out.length + 1}`,
      title,
      detail: sanitize(row?.detail),
      source: 'document',
    });
  }

  return out;
}
