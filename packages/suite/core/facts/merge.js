/**
 * Merges facts a customer states into a stored record, with add / replace / delete semantics.
 *
 * A schema maps field keys to where they live in the record and how they grow:
 *   { fields: { [key]: { path: ['a','b'], kind: 'single'|'append'|'multi', compare?: 'digits', maxChars?, pattern?, hint? } }, maxChars? }
 * - single: one value; a new value replaces it.
 * - append: free text that grows one line per `add`.
 * - multi: several short values joined by " / " (phone numbers, emails).
 */

export const FIELD_ACTIONS = ['add', 'replace', 'delete'];

function compact(value = '') {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

export function fold(value = '') {
  return compact(value).toLowerCase();
}

function comparable(field, value) {
  return field?.compare === 'digits' ? String(value || '').replace(/\D/g, '') : fold(value);
}

export function getPath(record, path = []) {
  return path.reduce((obj, key) => (obj && typeof obj === 'object' ? obj[key] : undefined), record);
}

/** Copy-on-write set; every object along the path is a fresh copy. */
export function setPath(record, path = [], value) {
  const [head, ...rest] = path;
  const base = record && typeof record === 'object' ? record : {};
  return { ...base, [head]: rest.length ? setPath(base[head], rest, value) : value };
}

/** New stored value for one field. Unclear intent is `add`, so existing data is never lost by accident. */
export function mergeFieldValue(field = {}, existing, value, action = 'add') {
  const kind = field.kind || 'single';
  const old = typeof existing === 'string' ? existing.trim() : compact(existing);
  const incoming = compact(value);
  if (action === 'delete') {
    if (!incoming || !old) return '';
    if (kind === 'append') {
      const lines = old.split(/\n+/);
      const kept = lines.filter((line) => !fold(line).includes(fold(incoming)));
      if (kept.length < lines.length) return kept.join('\n');
      return fold(old) === fold(incoming) ? '' : old;
    }
    if (kind === 'multi') {
      return old.split(/\s*\/\s*/).filter((part) => comparable(field, part) !== comparable(field, incoming)).join(' / ');
    }
    return '';
  }
  if (!incoming) return old;
  if (action === 'replace' || !old) return incoming;
  if (kind === 'append') {
    if (fold(old).includes(fold(incoming))) return old;
    if (fold(incoming).includes(fold(old))) return incoming;
    return `${old}\n${incoming}`.slice(-4000);
  }
  if (kind === 'multi') {
    const parts = old.split(/\s*\/\s*/);
    return parts.some((part) => comparable(field, part) === comparable(field, incoming)) ? old : `${old} / ${incoming}`;
  }
  return incoming;
}

export function pickAction(value, allowed, fallback) {
  const raw = fold(value);
  return allowed.includes(raw) ? raw : fallback;
}

/** Cleans AI output into { fields, fieldActions }: known keys only, length caps, pattern checks, `add` by default. */
export function normalizeFieldOps(schema = {}, fields = {}, actions = {}) {
  const outFields = {};
  const outActions = {};
  const rawFields = fields && typeof fields === 'object' ? fields : {};
  const rawActions = actions && typeof actions === 'object' ? actions : {};
  for (const [key, field] of Object.entries(schema.fields || {})) {
    const value = compact(rawFields[key]).slice(0, field.maxChars || schema.maxChars || 500);
    const action = pickAction(rawActions[key], FIELD_ACTIONS, 'add');
    if (action === 'delete') {
      outActions[key] = 'delete';
      if (value) outFields[key] = value;
      continue;
    }
    if (!value) continue;
    if (field.pattern && !new RegExp(field.pattern, field.patternFlags || '').test(value)) continue;
    outFields[key] = value;
    outActions[key] = action;
  }
  return { fields: outFields, fieldActions: outActions };
}

export function applyFieldOps(record = {}, schema = {}, fields = {}, actions = {}) {
  let next = { ...record };
  const keys = new Set([...Object.keys(fields || {}), ...Object.keys(actions || {})]);
  for (const key of keys) {
    const field = schema.fields?.[key];
    if (!field?.path) continue;
    next = setPath(next, field.path, mergeFieldValue(field, getPath(next, field.path), fields?.[key] || '', actions?.[key] || 'add'));
  }
  return next;
}

/** Current values per key, for the model to compare against. */
export function snapshotFields(record = {}, schema = {}, maxChars = 300) {
  const out = {};
  for (const [key, field] of Object.entries(schema.fields || {})) {
    const value = getPath(record, field.path);
    const text = typeof value === 'string' ? value.trim() : compact(value);
    if (text) out[key] = text.slice(0, maxChars);
  }
  return out;
}

/** People by name: add, update (patch only given keys), remove. */
export function mergePeople(list = [], ops = [], { patchKeys = ['title', 'phone', 'email'], create = (op) => ({ ...op }) } = {}) {
  const next = [...list];
  for (const person of ops) {
    const index = next.findIndex((row) => fold(row?.name) === fold(person.name));
    if (person.action === 'remove') {
      if (index >= 0) next.splice(index, 1);
      continue;
    }
    if (index >= 0) {
      const patch = Object.fromEntries(patchKeys.filter((key) => person[key]).map((key) => [key, person[key]]));
      next[index] = { ...next[index], ...patch };
      continue;
    }
    next.push(create(person));
  }
  return next;
}

/** Named groups of titled items ({categoryName, items:[{title}]}): add titles, replace the group, remove titles or the whole group. */
export function mergeGroups(groups = [], ops = []) {
  let next = [...groups];
  for (const group of ops) {
    const index = next.findIndex((row) => fold(row?.categoryName) === fold(group.categoryName));
    const hit = index >= 0 ? next[index] : null;
    const items = hit?.items || [];
    if (group.action === 'remove') {
      if (!hit) continue;
      if (!group.titles.length) {
        next = next.filter((_, i) => i !== index);
        continue;
      }
      const drop = new Set(group.titles.map(fold));
      next[index] = { ...hit, items: items.filter((item) => !drop.has(fold(item?.title))) };
      continue;
    }
    const fresh = group.action === 'replace'
      ? group.titles.map((title) => ({ title }))
      : [...items, ...group.titles.filter((title) => !items.some((item) => fold(item?.title) === fold(title))).map((title) => ({ title }))];
    if (hit) next[index] = { ...hit, items: fresh };
    else next.push({ categoryName: group.categoryName, items: fresh });
  }
  return next;
}

/**
 * Drops named items from catalogs ({categories:[{name, products:[{title|name}]}]}).
 * A target matches the exact title, "Category: Title", or (5+ chars) part of the title.
 */
export function removeNamedItems(catalogs = [], titles = []) {
  const targets = titles.map(fold).filter(Boolean);
  const drop = (product, categoryName) => {
    const title = fold(product?.title || product?.name);
    if (!title) return false;
    const labelled = `${fold(categoryName)}: ${title}`;
    return targets.some((target) => title === target || labelled === target || (target.length >= 5 && title.includes(target)));
  };
  return catalogs.map((catalog) => ({
    ...catalog,
    categories: (catalog.categories || []).map((category) => ({
      ...category,
      products: (category.products || []).filter((product) => !drop(product, category.name)),
    })),
  }));
}

/**
 * Weekly hours: `parsed` = {action:'set'|..., status, days[7], touched:[dayIndex]}.
 * `update` changes only the named days; with no action, naming 1–3 days reads as a change, not a full week.
 */
export function mergeWeekHours(current = {}, parsed = {}, action = '') {
  if (!['set', 'always', 'not-relevant'].includes(parsed.action)) return current;
  const existing = Array.isArray(current?.days) && current.days.length === parsed.days.length
    && ['set', 'always'].includes(current?.status) ? current.days : null;
  const update = parsed.action === 'set' && existing
    && (action === 'update' || (!action && (parsed.touched || []).length <= 3));
  const days = update ? existing.map((day, index) => (parsed.touched.includes(index) ? parsed.days[index] : day)) : parsed.days;
  return { ...(current || {}), status: parsed.status, days };
}
