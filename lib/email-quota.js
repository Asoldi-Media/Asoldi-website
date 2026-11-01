/**
 * Email quota ledger and fair share for client-site sends through Brevo.
 *
 * One ledger file, email-ledger.json, holds today's counters (Oslo day) and 60 days of summaries.
 * Every change runs under withFileLock('email-ledger.json'), so two hub workers that share the
 * data dir never lose an update. An unreadable ledger fails closed: no send is admitted.
 *
 * Classes:
 *   p1  recovery, back-in-stock and test sends (test is also capped per site per day)
 *   s   double-opt-in and welcome: a signup sub-cap outside the p1 budget
 *   p2  review request and win-back
 *   p3  campaigns
 *   a   Asoldi's own marketing (reserve, plus the unused pool late in the day)
 *
 * Limits (settings.quota, data/email-store.js):
 *   L  = quota.limit (daily mode) or floor(remaining month / days left × 1.5) (monthly mode)
 *   P  = L − safety − asoldiReserve, the client pool
 *   p1 needs pool room and site.p1 < perSiteP1Max
 *   s  needs pool room, site.s < perSiteSignupMax and today's s < signupPoolMax
 *   p2/p3 need pool room beyond the p1 reserve still open (until p1ReserveUntilHour) and, before
 *      borrowAfterHour, site.p2 + site.p3 < fairShare; p3 is also capped by perSiteCampaignMax
 *   a  uses asoldiReserve, plus the unused pool from p1ReserveUntilHour
 *   The total never exceeds L − safety.
 * Per-recipient counters are keyed per site (siteId:hash), so one site's sends never limit another's.
 */
import { EMAIL_FILES, readEmailSettings, readJson, withFileLock, writeJsonAtomic } from '../data/email-store.js';

export const QUOTA_CLASSES = Object.freeze(['p1', 's', 'p2', 'p3', 'a']);
const SITE_CLASSES = ['p1', 's', 'p2', 'p3'];
const HISTORY_DAYS = 60;
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const MAX_CAMPAIGN_RECIPIENT_ROWS = 50_000;

const dayFormatters = new Map();
const partFormatters = new Map();

function dayFormatter(tz) {
  if (!dayFormatters.has(tz)) {
    dayFormatters.set(tz, new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }));
  }
  return dayFormatters.get(tz);
}

function partFormatter(tz) {
  if (!partFormatters.has(tz)) {
    partFormatters.set(tz, new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }));
  }
  return partFormatters.get(tz);
}

function zone(settings) {
  const tz = String(settings?.quota?.resetTz || 'Europe/Oslo');
  try {
    dayFormatter(tz);
    return tz;
  } catch {
    return 'Europe/Oslo';
  }
}

/** YYYY-MM-DD of `now` in the time zone (Intl day key, so DST needs no special case). */
export function osloDayKey(now = Date.now(), tz = 'Europe/Oslo') {
  return dayFormatter(tz).format(new Date(now));
}

/** Hour of day (0-23) of `now` in the time zone. */
export function osloHour(now = Date.now(), tz = 'Europe/Oslo') {
  const parts = partFormatter(tz).formatToParts(new Date(now));
  return Number(parts.find((part) => part.type === 'hour')?.value || 0) % 24;
}

/** The first instant after `now` where pred(t) holds, searched in 15-minute steps, then to the second. */
function nextInstant(now, pred, maxMs = 2 * DAY_MS) {
  const step = 15 * MINUTE_MS;
  let lo = now;
  let hi = null;
  for (let t = now + step; t <= now + maxMs; t += step) {
    if (pred(t)) {
      hi = t;
      break;
    }
    lo = t;
  }
  if (hi === null) return now + maxMs;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (pred(mid)) hi = mid;
    else lo = mid;
  }
  return hi;
}

/** The next local midnight (the next day key), DST-safe. */
export function nextResetAt(now = Date.now(), tz = 'Europe/Oslo') {
  const today = osloDayKey(now, tz);
  const at = nextInstant(now, (t) => osloDayKey(t, tz) !== today, 26 * HOUR_MS);
  return Math.ceil(at / 1000) * 1000;
}

/** The next instant, today, where the local hour reaches `hour`; null when it already has. */
function todayAtHour(now, hour, tz) {
  if (osloHour(now, tz) >= hour) return null;
  const today = osloDayKey(now, tz);
  const at = nextInstant(now, (t) => osloDayKey(t, tz) !== today || osloHour(t, tz) >= hour, 26 * HOUR_MS);
  return osloDayKey(at, tz) === today ? Math.ceil(at / 1000) * 1000 : null;
}

function daysInMonth(dayKey) {
  const [y, m] = dayKey.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function addDays(dayKey, days) {
  const [y, m, d] = dayKey.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function emptyLedger(day = '') {
  return {
    version: 1,
    day,
    total: 0,
    asoldi: 0,
    bySite: {},
    byRecipient: {},
    demand: { p23: [] },
    lastCampaign: {},
    month: { key: day.slice(0, 7), usedBeforeToday: 0 },
    brevoCreditsAtSync: null,
    reconciledAt: '',
    history: [],
  };
}

function normalizeLedger(raw, day) {
  if (!isPlainObject(raw)) return emptyLedger(day);
  const out = { ...emptyLedger(String(raw.day || day)), ...raw };
  out.total = Math.max(0, num(raw.total));
  out.asoldi = Math.max(0, num(raw.asoldi));
  out.bySite = isPlainObject(raw.bySite) ? raw.bySite : {};
  out.byRecipient = isPlainObject(raw.byRecipient) ? raw.byRecipient : {};
  out.demand = { p23: Array.isArray(raw.demand?.p23) ? raw.demand.p23.map(String) : [] };
  out.lastCampaign = isPlainObject(raw.lastCampaign) ? raw.lastCampaign : {};
  out.month = isPlainObject(raw.month) ? { key: String(raw.month.key || ''), usedBeforeToday: Math.max(0, num(raw.month.usedBeforeToday)) } : { key: out.day.slice(0, 7), usedBeforeToday: 0 };
  out.history = Array.isArray(raw.history) ? raw.history.slice(-HISTORY_DAYS) : [];
  return out;
}

function byClassTotals(ledger) {
  const totals = { p1: 0, s: 0, p2: 0, p3: 0, a: ledger.asoldi };
  for (const row of Object.values(ledger.bySite)) {
    for (const cls of SITE_CLASSES) totals[cls] += num(row?.[cls]);
  }
  return totals;
}

/** Moves the ledger to `day`: yesterday becomes a history row, counters reset. Returns true when it moved. */
function rollover(ledger, day, settings) {
  if (ledger.day === day) return false;
  if (ledger.day) {
    ledger.history.push({ day: ledger.day, total: ledger.total, byClass: byClassTotals(ledger) });
    ledger.history = ledger.history.slice(-HISTORY_DAYS);
  }
  const sameMonth = ledger.day && ledger.day.slice(0, 7) === day.slice(0, 7) && ledger.month?.key === day.slice(0, 7);
  ledger.month = { key: day.slice(0, 7), usedBeforeToday: sameMonth ? num(ledger.month.usedBeforeToday) + ledger.total : 0 };
  ledger.day = day;
  ledger.total = 0;
  ledger.asoldi = 0;
  ledger.bySite = {};
  ledger.byRecipient = {};
  ledger.demand = { p23: [] };
  ledger.brevoCreditsAtSync = null;
  ledger.reconciledAt = '';
  const keepDays = Math.max(1, num(settings?.quota?.perRecipientCampaignEveryDays, 3));
  const cutoff = addDays(day, -keepDays);
  for (const [key, last] of Object.entries(ledger.lastCampaign)) if (String(last) <= cutoff) delete ledger.lastCampaign[key];
  return true;
}

/** Today's day limit L: quota.limit, or the monthly pace in monthly mode. */
export function dayLimit(settings, ledger) {
  const q = settings.quota || {};
  const limit = Math.max(0, num(q.limit, 300));
  if (q.mode !== 'monthly') return limit;
  const remaining = Math.max(0, limit - num(ledger.month?.usedBeforeToday));
  const day = Number(ledger.day.slice(8, 10)) || 1;
  const daysLeft = Math.max(1, daysInMonth(ledger.day) - day + 1);
  return Math.min(remaining, Math.floor((remaining / daysLeft) * 1.5));
}

function limits(settings, ledger) {
  const q = settings.quota || {};
  const L = dayLimit(settings, ledger);
  const safety = Math.max(0, num(q.safety, 15));
  const asoldiReserve = Math.max(0, num(q.asoldiReserve, 0));
  return {
    L,
    cap: Math.max(0, L - safety),
    P: Math.max(0, L - safety - asoldiReserve),
    asoldiReserve,
    p1Reserve: Math.max(0, num(q.p1Reserve, 75)),
    p1ReserveUntilHour: num(q.p1ReserveUntilHour, 20),
    perSiteP1Max: Math.max(0, num(q.perSiteP1Max, 40)),
    perSiteSignupMax: Math.max(0, num(q.perSiteSignupMax, 10)),
    signupPoolMax: Math.max(0, num(q.signupPoolMax, 40)),
    perSiteMin: Math.max(0, num(q.perSiteMin, 10)),
    perSiteCampaignMax: Math.max(0, num(q.perSiteCampaignMax, 100)),
    perSiteTestMax: Math.max(0, num(q.perSiteTestMax, 20)),
    borrowAfterHour: num(q.borrowAfterHour, 16),
    perRecipientMarketingPerDay: Math.max(0, num(q.perRecipientMarketingPerDay, 2)),
    perRecipientCampaignEveryDays: Math.max(0, num(q.perRecipientCampaignEveryDays, 3)),
  };
}

function siteRow(ledger, siteId) {
  const row = ledger.bySite[siteId];
  return isPlainObject(row) ? row : {};
}

function clientUsed(ledger) {
  return Math.max(0, ledger.total - ledger.asoldi);
}

function fairShareOf(ledger, lim) {
  const demand = Math.max(1, ledger.demand.p23.length);
  return Math.max(lim.perSiteMin, Math.floor(Math.max(0, lim.P - lim.p1Reserve - lim.signupPoolMax) / demand));
}

function p1ReserveRemaining(ledger, lim, hour) {
  if (hour >= lim.p1ReserveUntilHour) return 0;
  return Math.max(0, lim.p1Reserve - byClassTotals(ledger).p1);
}

function poolStatus(ledger, lim) {
  if (lim.P <= 0) return 'exhausted';
  const used = clientUsed(ledger);
  if (used >= lim.P) return 'exhausted';
  return used / lim.P >= 0.7 ? 'tight' : 'ok';
}

function siteRemaining(ledger, lim, siteId, hour) {
  const row = siteRow(ledger, siteId);
  const room = Math.max(0, lim.P - clientUsed(ledger));
  const share = hour >= lim.borrowAfterHour ? room : Math.max(0, fairShareOf(ledger, lim) - num(row.p2) - num(row.p3));
  return {
    p1: Math.min(room, Math.max(0, lim.perSiteP1Max - num(row.p1))),
    s: Math.min(room, Math.max(0, lim.perSiteSignupMax - num(row.s)), Math.max(0, lim.signupPoolMax - byClassTotals(ledger).s)),
    p23: Math.min(Math.max(0, room - p1ReserveRemaining(ledger, lim, hour)), share),
  };
}

function quotaUnavailable(cause) {
  const error = new Error('email quota ledger is unreadable');
  error.code = 'quota_unavailable';
  if (cause?.code) error.causeCode = cause.code;
  return error;
}

/**
 * The quota service. `store` reads and writes the ledger (default: email-ledger.json under the
 * file lock); tests pass a memory store. `settings` returns the email settings.
 */
export function createEmailQuota({
  store = null,
  settings = () => readEmailSettings(),
  now: clock = () => Date.now(),
} = {}) {
  const io = store || {
    read: () => readJson(EMAIL_FILES.ledger, null),
    write: (value) => writeJsonAtomic(EMAIL_FILES.ledger, value),
    lock: (fn) => withFileLock(EMAIL_FILES.ledger, fn),
  };

  function load(cfg, t) {
    let raw;
    try {
      raw = io.read();
    } catch (error) {
      throw quotaUnavailable(error);
    }
    const day = osloDayKey(t, zone(cfg));
    const ledger = normalizeLedger(raw, day);
    const moved = rollover(ledger, day, cfg);
    return { ledger, moved, day };
  }

  /** Read-modify-write under the lock. mutate returns { result, changed }. */
  function update(t, mutate) {
    return io.lock(async () => {
      const cfg = settings();
      const { ledger, moved } = load(cfg, t);
      const { result, changed } = await mutate(ledger, cfg);
      if (changed || moved) {
        try {
          io.write(ledger);
        } catch (error) {
          throw quotaUnavailable(error);
        }
      }
      return result;
    });
  }

  /**
   * Admit `count` sends of class `cls` for a site, or say why not.
   * Options: kind (a test send is also capped per site), recipientHash with marketing:true (the
   * per-recipient daily cap, keyed per site), campaign:true (the per-recipient campaign spacing).
   * Resolves { ok: true, remaining, ticket } or { ok: false, code: 'recipient_rate'|'quota', retryAt }.
   * Rejects with code 'quota_unavailable' when the ledger cannot be read or written (fail closed).
   */
  async function tryAcquire({ siteId, cls, count = 1, now, kind = '', recipientHash = '', marketing = false, campaign = false } = {}) {
    const id = String(siteId || '').trim();
    const n = Math.max(1, Math.floor(num(count, 1)));
    if (!QUOTA_CLASSES.includes(cls)) throw new Error(`tryAcquire: unknown class ${cls}`);
    if (cls !== 'a' && !id) throw new Error('tryAcquire: siteId required');
    const t = num(now, clock());
    return update(t, (ledger, cfg) => {
      const tz = zone(cfg);
      const lim = limits(cfg, ledger);
      const hour = osloHour(t, tz);
      const recipientKey = recipientHash ? `${id}:${recipientHash}` : '';
      let changed = false;
      const reject = (code, retryAt = null) => ({ result: { ok: false, code, retryAt: new Date(retryAt ?? nextResetAt(t, tz)).toISOString() }, changed });

      if (recipientKey && marketing) {
        const used = num(ledger.byRecipient[recipientKey]?.marketing);
        if (used + n > lim.perRecipientMarketingPerDay) return reject('recipient_rate');
      }
      if (recipientKey && campaign && lim.perRecipientCampaignEveryDays > 0) {
        const last = String(ledger.lastCampaign[recipientKey] || '');
        if (last && last > addDays(ledger.day, -lim.perRecipientCampaignEveryDays)) {
          const next = addDays(last, lim.perRecipientCampaignEveryDays);
          // The first instant of that local day.
          const at = nextInstant(t, (x) => osloDayKey(x, tz) >= next, (lim.perRecipientCampaignEveryDays + 1) * DAY_MS);
          return reject('recipient_rate', at);
        }
      }

      const row = siteRow(ledger, id);
      const used = clientUsed(ledger);
      const totals = byClassTotals(ledger);
      if (ledger.total + n > lim.cap) return reject('quota');
      if (cls === 'p1') {
        if (used + n > lim.P || num(row.p1) + n > lim.perSiteP1Max) return reject('quota');
        if (kind === 'test' && num(row.test) + n > lim.perSiteTestMax) return reject('quota');
      } else if (cls === 's') {
        if (used + n > lim.P || num(row.s) + n > lim.perSiteSignupMax || totals.s + n > lim.signupPoolMax) return reject('quota');
      } else if (cls === 'p2' || cls === 'p3') {
        if (!ledger.demand.p23.includes(id)) {
          ledger.demand.p23.push(id);
          changed = true;
        }
        const reserve = p1ReserveRemaining(ledger, lim, hour);
        if (used + reserve + n > lim.P) {
          const at = reserve > 0 ? todayAtHour(t, lim.p1ReserveUntilHour, tz) : null;
          return reject('quota', at);
        }
        if (hour < lim.borrowAfterHour && num(row.p2) + num(row.p3) + n > fairShareOf(ledger, lim)) {
          return reject('quota', todayAtHour(t, lim.borrowAfterHour, tz));
        }
        if (cls === 'p3' && num(row.p3) + n > lim.perSiteCampaignMax) return reject('quota');
      } else if (cls === 'a') {
        const late = hour >= lim.p1ReserveUntilHour;
        const fromReserve = ledger.asoldi + n <= lim.asoldiReserve;
        if (!fromReserve && !(late && used + ledger.asoldi + n <= lim.cap)) {
          return reject('quota', todayAtHour(t, lim.p1ReserveUntilHour, tz));
        }
      }

      ledger.total += n;
      if (cls === 'a') {
        ledger.asoldi += n;
      } else {
        const next = { ...row };
        next[cls] = num(next[cls]) + n;
        if (kind === 'test') next.test = num(next.test) + n;
        ledger.bySite[id] = next;
      }
      if (recipientKey && marketing) {
        ledger.byRecipient[recipientKey] = { marketing: num(ledger.byRecipient[recipientKey]?.marketing) + n };
      }
      if (recipientKey && campaign) {
        const keys = Object.keys(ledger.lastCampaign);
        if (keys.length >= MAX_CAMPAIGN_RECIPIENT_ROWS) delete ledger.lastCampaign[keys[0]];
        ledger.lastCampaign[recipientKey] = ledger.day;
      }
      changed = true;
      return {
        result: {
          ok: true,
          remaining: siteRemaining(ledger, lim, id, hour),
          pool: poolStatus(ledger, lim),
          ticket: { siteId: id, cls, count: n, day: ledger.day, kind, recipientKey, marketing: Boolean(recipientKey && marketing), campaign: Boolean(recipientKey && campaign) },
        },
        changed,
      };
    });
  }

  /** Gives back what a ticket took (Brevo refused the send). A ticket from another day changes nothing. */
  async function release(ticket, { now } = {}) {
    if (!ticket || !QUOTA_CLASSES.includes(ticket.cls)) return false;
    const t = num(now, clock());
    return update(t, (ledger) => {
      if (ledger.day !== ticket.day) return { result: false, changed: false };
      const n = Math.max(1, num(ticket.count, 1));
      ledger.total = Math.max(0, ledger.total - n);
      if (ticket.cls === 'a') {
        ledger.asoldi = Math.max(0, ledger.asoldi - n);
      } else {
        const row = { ...siteRow(ledger, ticket.siteId) };
        row[ticket.cls] = Math.max(0, num(row[ticket.cls]) - n);
        if (ticket.kind === 'test') row.test = Math.max(0, num(row.test) - n);
        ledger.bySite[ticket.siteId] = row;
      }
      if (ticket.marketing && ticket.recipientKey && ledger.byRecipient[ticket.recipientKey]) {
        const left = Math.max(0, num(ledger.byRecipient[ticket.recipientKey].marketing) - n);
        if (left) ledger.byRecipient[ticket.recipientKey] = { marketing: left };
        else delete ledger.byRecipient[ticket.recipientKey];
      }
      if (ticket.campaign && ticket.recipientKey && ledger.lastCampaign[ticket.recipientKey] === ledger.day) {
        delete ledger.lastCampaign[ticket.recipientKey];
      }
      return { result: true, changed: true };
    });
  }

  /**
   * Brevo's account view is the truth for what is left: when it shows fewer credits than the
   * ledger would still admit, today's total is raised so that at most `credits` more are admitted.
   * `account` is getBrevoAccount()'s answer. Resolves { adjusted, credits, total }.
   */
  async function reconcileWithBrevo(account, { now } = {}) {
    const plans = Array.isArray(account?.plan) ? account.plan : [];
    const entry = plans.find((p) => p && p.creditsType === 'sendLimit' && Number.isFinite(Number(p.credits)))
      || plans.find((p) => p && Number.isFinite(Number(p.credits)) && p.credits !== null);
    const t = num(now, clock());
    return update(t, (ledger, cfg) => {
      if (!entry) return { result: { adjusted: false, credits: null, total: ledger.total }, changed: false };
      const credits = Math.max(0, Math.floor(Number(entry.credits)));
      const lim = limits(cfg, ledger);
      const target = Math.max(0, lim.cap - credits);
      const adjusted = ledger.total < target;
      if (adjusted) ledger.total = target;
      ledger.brevoCreditsAtSync = credits;
      ledger.reconciledAt = new Date(t).toISOString();
      return { result: { adjusted, credits, total: ledger.total, planType: String(entry.type || '') }, changed: true };
    });
  }

  function view(t) {
    const cfg = settings();
    const { ledger } = load(cfg, t);
    const lim = limits(cfg, ledger);
    const tz = zone(cfg);
    return { cfg, ledger, lim, tz, hour: osloHour(t, tz) };
  }

  /** P2/P3 fair share for a site today (the same number for every site). */
  function fairShare(_siteId, { now } = {}) {
    const { ledger, lim } = view(num(now, clock()));
    return fairShareOf(ledger, lim);
  }

  /**
   * The site API view: the site's own numbers and a coarse pool status ('ok' below 70 % use,
   * 'tight' from 70 %, 'exhausted'). No pool totals and nothing about other sites.
   */
  function siteQuotaView(siteId, { now } = {}) {
    const t = num(now, clock());
    const { cfg, ledger, lim, tz, hour } = view(t);
    const row = siteRow(ledger, String(siteId || ''));
    return {
      day: ledger.day,
      mode: cfg.quota?.mode === 'monthly' ? 'monthly' : 'daily',
      site: {
        used: { p1: num(row.p1), s: num(row.s), p2: num(row.p2), p3: num(row.p3) },
        caps: { p1: lim.perSiteP1Max, s: lim.perSiteSignupMax, p23: fairShareOf(ledger, lim) },
        fairShare: fairShareOf(ledger, lim),
        remaining: siteRemaining(ledger, lim, String(siteId || ''), hour),
      },
      pool: poolStatus(ledger, lim),
      nextResetAt: new Date(nextResetAt(t, tz)).toISOString(),
    };
  }

  /** Superadmin view: pool numbers, per-site usage and history (no recipient keys). */
  function quotaSnapshot({ now } = {}) {
    const t = num(now, clock());
    const { cfg, ledger, lim, tz, hour } = view(t);
    return {
      day: ledger.day,
      mode: cfg.quota?.mode === 'monthly' ? 'monthly' : 'daily',
      limit: lim.L,
      cap: lim.cap,
      pool: { size: lim.P, used: clientUsed(ledger), status: poolStatus(ledger, lim), p1ReserveRemaining: p1ReserveRemaining(ledger, lim, hour) },
      total: ledger.total,
      asoldi: ledger.asoldi,
      byClass: byClassTotals(ledger),
      bySite: JSON.parse(JSON.stringify(ledger.bySite)),
      sitesWithP23Demand: ledger.demand.p23.length,
      fairShare: fairShareOf(ledger, lim),
      brevoCreditsAtSync: ledger.brevoCreditsAtSync,
      reconciledAt: ledger.reconciledAt,
      nextResetAt: new Date(nextResetAt(t, tz)).toISOString(),
      history: ledger.history.slice(-HISTORY_DAYS),
    };
  }

  /** Days a campaign of `remaining` recipients needs at today's share: { perDay, days, finishDay }. */
  function estimateFinish({ siteId, remaining = 0, now } = {}) {
    const t = num(now, clock());
    const { ledger, lim } = view(t);
    const perDay = Math.max(1, Math.min(fairShareOf(ledger, lim), lim.perSiteCampaignMax));
    const days = Math.max(1, Math.ceil(Math.max(0, num(remaining)) / perDay));
    void siteId;
    return { perDay, days, finishDay: addDays(ledger.day, days - 1) };
  }

  return { tryAcquire, release, reconcileWithBrevo, fairShare, siteQuotaView, quotaSnapshot, estimateFinish };
}

/** In-memory ledger store for simulations and tests (same lock semantics in one process). */
export function memoryLedgerStore(initial = null) {
  let value = initial ? JSON.parse(JSON.stringify(initial)) : null;
  let chain = Promise.resolve();
  return {
    read: () => (value ? JSON.parse(JSON.stringify(value)) : null),
    write: (next) => {
      value = JSON.parse(JSON.stringify(next));
    },
    lock: (fn) => {
      const run = chain.then(fn);
      chain = run.then(() => undefined, () => undefined);
      return run;
    },
    peek: () => value,
  };
}

let defaultQuota = null;
function quota() {
  if (!defaultQuota) defaultQuota = createEmailQuota();
  return defaultQuota;
}

export const tryAcquire = (input) => quota().tryAcquire(input);
export const release = (ticket, options) => quota().release(ticket, options);
export const reconcileWithBrevo = (account, options) => quota().reconcileWithBrevo(account, options);
export const fairShare = (siteId, options) => quota().fairShare(siteId, options);
export const siteQuotaView = (siteId, options) => quota().siteQuotaView(siteId, options);
export const quotaSnapshot = (options) => quota().quotaSnapshot(options);
export const estimateFinish = (input) => quota().estimateFinish(input);
