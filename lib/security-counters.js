/**
 * In-memory security event counters for the admin security status and the
 * read-only hub probe (spike detection). Nothing here is persisted: counters
 * reset on restart, which is fine for "how many in the last hour".
 */

const WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_STAMPS_PER_KIND = 5000;

const events = new Map();

export function noteSecurityEvent(kind, { now = Date.now() } = {}) {
  const key = String(kind || '').trim();
  if (!key) return;
  const row = events.get(key) || { total: 0, stamps: [] };
  row.total += 1;
  row.stamps.push(now);
  if (row.stamps.length > MAX_STAMPS_PER_KIND) row.stamps.splice(0, row.stamps.length - MAX_STAMPS_PER_KIND);
  events.set(key, row);
}

/** { kind: { total, lastHour, lastDay, lastAt } } since process start. */
export function securityCounters({ now = Date.now() } = {}) {
  const out = {};
  for (const [kind, row] of events) {
    row.stamps = row.stamps.filter((t) => now - t < WINDOW_MS);
    out[kind] = {
      total: row.total,
      lastHour: row.stamps.filter((t) => now - t < 60 * 60 * 1000).length,
      lastDay: row.stamps.length,
      lastAt: row.stamps.length ? new Date(row.stamps[row.stamps.length - 1]).toISOString() : null,
    };
  }
  return out;
}

export function resetSecurityCounters() {
  events.clear();
}
