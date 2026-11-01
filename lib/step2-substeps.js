// Step 2 substep keys a Website Maker reports for a run (client.makerRun.step2Substeps).
//
// The four legacy keys are always kept, as before. A Maker that has more substeps sends
// `step2SubstepOrder` (its substep ids in pipeline order) next to `step2Substeps` in its status
// callback; the ids in that order are kept too, after the legacy four. The order is stored in
// makerRun.ext.step2SubstepOrder so later writes keep the extra keys. Without an order (sent or
// stored) every normalizer here returns exactly what it returned before the order existed. A sent
// order that lists no id past the legacy four removes the stored one, so the client reads as before
// again (the extra chip, queue target and status key go).
//
// Pure module (no Node imports): the developer card bundle imports it.

export const LEGACY_STEP2_SUBSTEP_KEYS = Object.freeze([
  'generate-text',
  'inject-media',
  'layout-colors-style',
  'maps-embed-sync',
]);

const SUBSTEP_ID = /^[a-z0-9-]{3,40}$/;
export const MAX_STEP2_SUBSTEPS = 10;

// Substeps after the legacy four that the hub has a chip, a queue target and a score for.
export const KNOWN_STEP2_EXTRA_SUBSTEPS = Object.freeze({
  'bind-cta-data': Object.freeze({
    chipId: '2.5',
    label: 'CTA og priser',
    after: 'maps-embed-sync',
    score: 500,
    readyFlag: 'bindCtaDataReady',
  }),
});

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** A sent or stored order: valid ids only (lowercase letters, digits, dashes; 3 to 40 chars), no repeats, at most 10. null when none is usable. */
export function normalizeStep2SubstepOrder(value) {
  if (!Array.isArray(value)) return null;
  const out = [];
  for (const raw of value) {
    const id = String(raw ?? '').trim();
    if (!SUBSTEP_ID.test(id) || out.includes(id)) continue;
    out.push(id);
    if (out.length >= MAX_STEP2_SUBSTEPS) break;
  }
  return out.length ? out : null;
}

/** The order a makerRun record or patch carries: the one it sends, else the one stored in ext. */
export function makerRunStep2SubstepOrder(makerRun = {}) {
  const run = isPlainObject(makerRun) ? makerRun : {};
  return normalizeStep2SubstepOrder(run.step2SubstepOrder)
    || normalizeStep2SubstepOrder(isPlainObject(run.ext) ? run.ext.step2SubstepOrder : null);
}

/** The substep keys to keep: the legacy four, then the order's other ids in order (max 10 in all). */
export function step2SubstepKeys(order = null) {
  const keys = [...LEGACY_STEP2_SUBSTEP_KEYS];
  for (const id of normalizeStep2SubstepOrder(order) || []) {
    if (keys.length >= MAX_STEP2_SUBSTEPS) break;
    if (!keys.includes(id)) keys.push(id);
  }
  return keys;
}

/** The extra (non-legacy) substep keys a makerRun keeps. */
export function makerRunExtraStep2Keys(makerRun = {}) {
  return step2SubstepKeys(makerRunStep2SubstepOrder(makerRun)).slice(LEGACY_STEP2_SUBSTEP_KEYS.length);
}

/**
 * Stores a sent order in ext (a copy; the other ext keys are kept). A sent order with no id past the
 * legacy four removes a stored order instead (and an ext left empty). Returns `target` unchanged when
 * `raw` sends no usable order.
 */
export function withStoredStep2SubstepOrder(target, raw = {}) {
  const sent = normalizeStep2SubstepOrder(isPlainObject(raw) ? raw.step2SubstepOrder : null);
  if (!sent || !isPlainObject(target)) return target;
  const ext = isPlainObject(target.ext) ? target.ext : {};
  if (step2SubstepKeys(sent).length === LEGACY_STEP2_SUBSTEP_KEYS.length) {
    if (!Object.prototype.hasOwnProperty.call(ext, 'step2SubstepOrder')) return target;
    const rest = { ...ext };
    delete rest.step2SubstepOrder;
    if (Object.keys(rest).length) target.ext = rest;
    else delete target.ext;
    return target;
  }
  target.ext = { ...ext, step2SubstepOrder: sent };
  return target;
}

/** Inserts each known extra entry the run keeps right after its `after` anchor (or at the end). */
export function insertKnownExtras(list = [], extraKeys = [], { idOf = (entry) => entry, build } = {}) {
  const out = [...list];
  for (const key of extraKeys) {
    const known = KNOWN_STEP2_EXTRA_SUBSTEPS[key];
    if (!known || typeof build !== 'function') continue;
    const entry = build(key, known);
    if (out.some((row) => idOf(row) === idOf(entry))) continue;
    const anchor = out.findIndex((row) => idOf(row) === known.after);
    if (anchor < 0) out.push(entry);
    else out.splice(anchor + 1, 0, entry);
  }
  return out;
}
