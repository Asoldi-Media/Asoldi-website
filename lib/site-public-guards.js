/**
 * Limits and payload checks for the hub endpoints that a client site reaches with its site key
 * alone. The site key is a public identifier (it is written into each site's form HTML), so these
 * endpoints treat every caller as anonymous:
 *
 *  - POST /api/client-forms/:siteKey   (visitor forms, sent on as e-mail)
 *  - POST /api/hub/analytics/collect   (page view events the CMS passes on)
 *  - POST /api/hub/analytics/commerce  (the shop summary the CMS passes on)
 *
 * Each gets a size cap, a structural check and a sliding-window limit per site and address. A call
 * that carries a valid site credential (lib/site-credentials.js) comes from the site's own server,
 * which passes on many visitors from one address, so it is limited per site only.
 */

function clean(value) {
  return String(value ?? '').trim();
}

/**
 * Sliding-window counter. hit(key) counts one call and answers { ok, retryAfterSec }; a refused call
 * is not counted. Memory is bounded: at capacity the least recently used keys go first.
 */
export function createWindowLimiter({ windowMs = 60_000, max = 60, maxKeys = 10_000, now = () => Date.now() } = {}) {
  const hits = new Map();

  function recent(key) {
    const list = hits.get(key);
    if (!list) return [];
    const t = now();
    while (list.length && t - list[0] >= windowMs) list.shift();
    if (!list.length) hits.delete(key);
    return list;
  }

  function trim() {
    if (hits.size <= maxKeys) return;
    for (const key of hits.keys()) {
      if (hits.size <= maxKeys) return;
      hits.delete(key);
    }
  }

  return {
    peek(key, limit = max) {
      const list = recent(key);
      if (list.length >= limit) return { ok: false, retryAfterSec: Math.max(1, Math.ceil((list[0] + windowMs - now()) / 1000)) };
      return { ok: true, retryAfterSec: 0 };
    },
    hit(key, limit = max) {
      const verdict = this.peek(key, limit);
      if (!verdict.ok) return verdict;
      const list = recent(key);
      list.push(now());
      hits.delete(key);
      hits.set(key, list);
      trim();
      return verdict;
    },
    size() {
      return hits.size;
    },
    reset() {
      hits.clear();
    },
  };
}

// ── Analytics events ─────────────────────────────────────────────────────────

export const MAX_EVENTS_PER_CALL = 100;
const EVENT_MAX_AGE_MS = 35 * 24 * 60 * 60 * 1000;
const EVENT_MAX_AHEAD_MS = 10 * 60 * 1000;
const EVENT_TYPE_RE = /^[a-z][a-z0-9_.:-]{0,39}$/i;

function text(value, max) {
  return typeof value === 'string' || typeof value === 'number' ? String(value).slice(0, max) : '';
}

/**
 * The fields the client CMS stores for a page event (website-cms server/analytics-events.js), with
 * the same lengths. Events that are not objects, have an unusable type or a time outside the last
 * 35 days are dropped. Returns at most MAX_EVENTS_PER_CALL events.
 */
export function normalizeTrafficEvents(events, { now = Date.now() } = {}) {
  if (!Array.isArray(events)) return [];
  const out = [];
  for (const event of events.slice(0, MAX_EVENTS_PER_CALL)) {
    if (!event || typeof event !== 'object' || Array.isArray(event)) continue;
    const type = clean(event.type || 'pageview');
    if (!EVENT_TYPE_RE.test(type)) continue;
    const parsed = Date.parse(event.at || event.timestamp || '');
    const at = Number.isFinite(parsed) ? parsed : now;
    if (at < now - EVENT_MAX_AGE_MS || at > now + EVENT_MAX_AHEAD_MS) continue;
    const ms = Number(event.ms);
    out.push({
      type,
      visitorId: text(event.visitorId, 80),
      sessionId: text(event.sessionId, 80),
      path: text(event.path, 300) || '/',
      href: text(event.href, 300),
      referrer: text(event.referrer, 500),
      ua: text(event.ua, 300),
      host: text(event.host, 200),
      ms: Number.isFinite(ms) && ms >= 0 ? Math.min(Math.round(ms), 86_400_000) : 0,
      at: new Date(at).toISOString(),
    });
  }
  return out;
}

// ── Commerce summary ─────────────────────────────────────────────────────────

export const COMMERCE_FIELDS = Object.freeze([
  'orders', 'cancelled', 'revenue', 'aov', 'unitsSold', 'itemsPerOrder', 'conversionRate', 'customers',
  'returningCustomers', 'newCustomers', 'returningRate', 'topProducts', 'series', 'funnel', 'abandonment', 'range',
]);
export const MAX_COMMERCE_BYTES = 64 * 1024;
const MAX_DEPTH = 4;
const MAX_ARRAY = 400;
const MAX_KEYS = 40;
const MAX_STRING = 300;
const MAX_NUMBER = 1e12;

/** JSON-like value with bounded depth, array length, key count, string length and finite numbers. */
function boundedValue(value, depth) {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) && Math.abs(value) <= MAX_NUMBER ? value : null;
  if (typeof value === 'string') return value.slice(0, MAX_STRING);
  if (depth >= MAX_DEPTH) return null;
  if (Array.isArray(value)) return value.slice(0, MAX_ARRAY).map((item) => boundedValue(item, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).slice(0, MAX_KEYS)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
      out[key.slice(0, 60)] = boundedValue(value[key], depth + 1);
    }
    return out;
  }
  return null;
}

/**
 * { ok, payload } with only the known summary fields, each bounded; { ok: false, reason } for a
 * body that is not an object or is larger than MAX_COMMERCE_BYTES once serialised.
 */
export function sanitizeCommercePayload(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, reason: 'not-an-object' };
  let size = 0;
  try {
    size = Buffer.byteLength(JSON.stringify(body));
  } catch {
    return { ok: false, reason: 'not-json' };
  }
  if (size > MAX_COMMERCE_BYTES) return { ok: false, reason: 'too-large' };
  const payload = {};
  for (const field of COMMERCE_FIELDS) {
    if (body[field] !== undefined) payload[field] = boundedValue(body[field], 0);
  }
  return { ok: true, payload };
}

// ── Visitor forms ────────────────────────────────────────────────────────────

export const MAX_FORM_FIELDS = 40;
export const MAX_FORM_VALUE = 5000;
export const MAX_FORM_NAME = 100;
export const MAX_FORM_TOTAL = 20_000;

/** null when the extracted fields are within the limits, else a short reason. */
export function formFieldsProblem(fields) {
  const entries = Object.entries(fields || {});
  if (entries.length > MAX_FORM_FIELDS) return 'too-many-fields';
  let total = 0;
  for (const [name, value] of entries) {
    if (name.length > MAX_FORM_NAME) return 'field-name-too-long';
    const length = String(value ?? '').length;
    if (length > MAX_FORM_VALUE) return 'field-too-long';
    total += name.length + length;
  }
  return total > MAX_FORM_TOTAL ? 'form-too-large' : null;
}

/**
 * Limits for one public endpoint: per (site, address) for anonymous calls, and per site for all
 * calls. `credentialValid` (the site's own server) skips the address bucket.
 */
export function createSiteRequestLimits({ windowMs = 60_000, perSiteAddress = 60, perSite = 600, now } = {}) {
  const limiter = createWindowLimiter({ windowMs, max: perSite, ...(now ? { now } : {}) });
  return {
    take({ siteId, address, credentialValid = false }) {
      const site = clean(siteId).slice(0, 80) || '-';
      if (!credentialValid) {
        const pair = limiter.peek(`p:${site}\n${clean(address).slice(0, 64)}`, perSiteAddress);
        if (!pair.ok) return pair;
      }
      const whole = limiter.peek(`s:${site}`, perSite);
      if (!whole.ok) return whole;
      if (!credentialValid) limiter.hit(`p:${site}\n${clean(address).slice(0, 64)}`, perSiteAddress);
      limiter.hit(`s:${site}`, perSite);
      return { ok: true, retryAfterSec: 0 };
    },
    reset() {
      limiter.reset();
    },
  };
}
