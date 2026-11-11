/**
 * The hub's DataForSEO ledger, one file per month (seo-ops/dfs-ledger-YYYY-MM.json, written through
 * lib/seo-ops/store.js, kept 13 months). It books and alerts; by default it never stops a call.
 *
 *   reserve({ purpose, siteKey, tierId, estUsd, taskKey, progressKey, size })
 *       size ({ pages, locales, products } or a number) scales the expected spend; the soft stop is
 *       only above softBudget.refuseMultiple times that expected amount
 *       -> { allowed: true, month, over: [...], projected }
 *       what a call would do to the caps. `allowed` is true unless softBudget is enabled and this
 *       call is past its multiple or a loop. softBudget off (the default) leaves the answer unchanged.
 *   reserveChecked(same)  reserve(), then records a due soft alert once
 *   book({ purpose, siteKey, tierId, costUsd, endpoint, ref, at })
 *       -> { ok: true, month, totals, alerts } | { ok: false, error, message }
 *   noteBalance(usd)  the last known DataForSEO account balance (shared with the Maker)
 *
 * Soft caps come from seo-ops/settings.json (defaults in lib/seo-ops/store.js): budgets.monthlyUsd
 * for all hub spend in a month, budgets.byPurpose[purpose], budgets.perSiteMonthlyUsd[tierId] per
 * site, and balanceFloorUsd against the last known balance minus what was booked since. When a
 * booking takes a cap to 100 % or more, an alert is recorded in the month file once per cap and
 * logged; the work continues.
 *
 * Stops stay where they were: lib/dataforseo-maps.js refuses a Maps call when its lifetime total
 * (dataforseo-maps-spend.json, all months together) plus the call would pass
 * DATAFORSEO_MAPS_BUDGET_USD (default $50), and lib/dataforseo-serp.js keeps the Infokort lifetime
 * and daily caps. By default the ledger adds no stop. softBudget (seo-ops settings, off unless
 * enabled) can refuse reserve() only.
 *
 * With seo.dfsLedger on (automation settings, default off) those two modules also book every paid
 * call here (bookDfsSpendIfEnabled): Maps ranking as 'maps', Infokort search as 'infokort'.
 * A booking the store refuses (a month outside the 13 kept, an unknown purpose) is an error:
 * it is returned, logged and counted (dfsLedgerErrors), never dropped silently.
 */
import { getAutomationSettings } from '../../data/automation-settings.js';
import { createSeoOpsStore, defaultSeoOpsSettings, SeoOpsStoreError } from './store.js';

export const DFS_PURPOSES = Object.freeze(['tracking', 'maps', 'infokort', 'aiVisibility', 'audits', 'local']);
export const DFS_LEDGER_MAX_ENTRIES = 5000;

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function usd(value) {
  return Math.round((Number(value) || 0) * 1e6) / 1e6;
}

function monthOf(date) {
  return new Date(date).toISOString().slice(0, 7);
}

function text(value, max = 120) {
  return String(value ?? '').trim().slice(0, max);
}

function emptyTotals() {
  return { usd: 0, calls: 0, byPurpose: {}, bySite: {}, bySitePurpose: {} };
}

function normalizeTotals(totals) {
  const base = isPlainObject(totals) ? totals : {};
  return {
    usd: usd(base.usd),
    calls: Number(base.calls) || 0,
    byPurpose: isPlainObject(base.byPurpose) ? { ...base.byPurpose } : {},
    bySite: isPlainObject(base.bySite) ? { ...base.bySite } : {},
    bySitePurpose: isPlainObject(base.bySitePurpose) ? { ...base.bySitePurpose } : {},
  };
}

/** The caps that apply to one booking: [{ key, kind, capUsd, spentUsd }] (spent before it). */
function capsFor({ purpose, siteKey, tierId }, totals, settings) {
  const budgets = isPlainObject(settings?.budgets) ? settings.budgets : defaultSeoOpsSettings().budgets;
  const caps = [];
  const monthly = Number(budgets.monthlyUsd);
  if (Number.isFinite(monthly) && monthly >= 0) caps.push({ key: 'monthly', kind: 'monthly', capUsd: monthly, spentUsd: totals.usd });
  const byPurpose = Number(budgets.byPurpose?.[purpose]);
  if (Number.isFinite(byPurpose) && byPurpose >= 0) caps.push({ key: `purpose:${purpose}`, kind: 'purpose', capUsd: byPurpose, spentUsd: usd(totals.byPurpose[purpose]) });
  const perSite = Number(budgets.perSiteMonthlyUsd?.[tierId]);
  if (siteKey && Number.isFinite(perSite) && perSite >= 0) caps.push({ key: `site:${siteKey}`, kind: 'site', capUsd: perSite, spentUsd: usd(totals.bySite[siteKey]) });
  return caps;
}

function sitePurposeKey(siteKey, purpose) {
  return `${siteKey}|${purpose}`;
}

function entriesSum(entries, purpose, siteKey) {
  let sum = 0;
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (entry?.purpose === purpose && entry?.siteKey === siteKey) sum += Number(entry.costUsd) || 0;
  }
  return usd(sum);
}

/** Project-size factor for the expected spend: pages x locales x products, each at least 1. */
function sizeFactor(size) {
  if (typeof size === 'number') return Number.isFinite(size) && size >= 1 ? size : 1;
  if (!isPlainObject(size)) return 1;
  let factor = 1;
  for (const key of ['pages', 'locales', 'products']) {
    const v = Number(size[key]);
    if (Number.isFinite(v) && v >= 1) factor *= v;
  }
  return factor;
}

const errorCounts = new Map();

/** Booking errors counted in this process by code (for the health view and tests). */
export function dfsLedgerErrors() {
  return Object.fromEntries(errorCounts);
}

export function resetDfsLedgerErrorsForTests() {
  errorCounts.clear();
}

function reportError(code, message, log) {
  errorCounts.set(code, (errorCounts.get(code) || 0) + 1);
  log?.error?.(`[dfs-ledger] booking error ${code}: ${message}`);
  return { ok: false, error: code, message };
}

/**
 * A ledger over a store. `store` defaults to a fresh seo-ops store, `now` to the store clock,
 * `settings` to seo-ops/settings.json read at each call, `onAlert(alert)` sees each new alert.
 */
export function createDfsLedger({ store = null, now = null, settings = null, onAlert = null, log = console } = {}) {
  const clock = typeof now === 'function' ? now : () => new Date();
  const seoStore = store || createSeoOpsStore({ now: clock });
  const readSettings = () => {
    if (settings) return settings;
    try {
      return seoStore.readSettings();
    } catch {
      return defaultSeoOpsSettings();
    }
  };

  function currentTotals(month) {
    try {
      const doc = seoStore.readLedger(month);
      return { totals: normalizeTotals(doc?.totals), balance: doc?.balance || null };
    } catch {
      return { totals: emptyTotals(), balance: null };
    }
  }

  const loops = new Map();

  function readMonth(month) {
    try {
      return seoStore.readLedger(month);
    } catch {
      return null;
    }
  }

  function spentSitePurpose(doc, purpose, siteKey) {
    const kept = doc?.totals?.bySitePurpose;
    const key = sitePurposeKey(siteKey, purpose);
    if (isPlainObject(kept) && Object.prototype.hasOwnProperty.call(kept, key)) return usd(kept[key]);
    return entriesSum(doc?.entries, purpose, siteKey);
  }

  function expectedUsdFor(soft, tierId, purpose, size = null) {
    const perSite = Number(soft?.expectedUsd?.perSiteMonthlyUsd?.[tierId]);
    if (!tierId || !Number.isFinite(perSite) || perSite <= 0) return null;
    const shares = soft?.expectedUsd?.purposeShare;
    let share = 1;
    if (isPlainObject(shares) && Object.prototype.hasOwnProperty.call(shares, purpose)) {
      share = Number(shares[purpose]);
      if (!Number.isFinite(share) || share <= 0 || share > 1) return null;
    }
    return usd(perSite * share * sizeFactor(size));
  }

  function refuseMultipleOf(soft) {
    const multiple = Number(soft?.refuseMultiple);
    return Number.isFinite(multiple) && multiple > 0 ? multiple : 5;
  }

  /** True when this call is the loopRepeats-th identical reserve inside the window. */
  function loopRefused(taskKey, progressKey, soft, scope = '') {
    const asKey = (v) => (typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v)) ? String(v).trim() : '');
    const task = asKey(taskKey) ? `${scope}|${asKey(taskKey)}` : '';
    const progress = asKey(progressKey);
    if (!task || !progress) return false;
    const windowMin = Number(soft?.loopWindowMinutes);
    const windowMs = (Number.isFinite(windowMin) && windowMin > 0 ? windowMin : 60) * 60 * 1000;
    const repeatsRaw = Number(soft?.loopRepeats);
    const repeats = Number.isFinite(repeatsRaw) && repeatsRaw >= 1 ? Math.max(2, repeatsRaw) : 3;
    const nowMs = new Date(clock()).getTime();
    for (const [k, r] of loops) {
      if (!r.times.some((ts) => nowMs - ts < windowMs)) loops.delete(k);
    }
    let row = loops.get(task);
    if (!row || row.progress !== progress) row = { progress, times: [] };
    row.times = row.times.filter((ts) => nowMs - ts < windowMs);
    row.times.push(nowMs);
    loops.set(task, row);
    return row.times.length >= repeats;
  }

  function softView({ purpose, siteKey, tierId, est, month, soft, size }) {
    const expected = expectedUsdFor(soft, tierId, purpose, size);
    if (expected == null || !siteKey) return null;
    const doc = readMonth(month);
    const projected = usd(spentSitePurpose(doc, purpose, siteKey) + est);
    if (projected > expected * refuseMultipleOf(soft)) return { refuse: true };
    if (projected >= expected) {
      const key = `soft:${siteKey}:${purpose}`;
      const already = Array.isArray(doc?.alerts) && doc.alerts.some((alert) => alert?.key === key);
      return { alert: !already };
    }
    return null;
  }

  function reserve({ purpose, siteKey = '', tierId = '', estUsd = 0, taskKey, progressKey, size = null } = {}) {
    const month = monthOf(clock());
    const { totals, balance } = currentTotals(month);
    const est = Math.max(0, usd(estUsd));
    const site = text(siteKey);
    const tier = text(tierId, 40);
    const settingsNow = readSettings();
    const over = [];
    for (const cap of capsFor({ purpose, siteKey: site, tierId: tier }, totals, settingsNow)) {
      if (cap.spentUsd + est >= cap.capUsd) over.push(cap.key);
    }
    const floor = Number(settingsNow?.balanceFloorUsd);
    if (balance && Number.isFinite(Number(balance.usd)) && Number.isFinite(floor) && Number(balance.usd) - est < floor) over.push('balance-floor');
    const base = { allowed: true, month, over, projected: usd(totals.usd + est) };
    const soft = settingsNow?.softBudget;
    if (!soft || soft.enabled !== true) return base;
    if (loopRefused(taskKey, progressKey, soft, `${site}|${purpose}`)) return { ...base, allowed: false, reason: 'loop-detected' };
    const view = softView({ purpose, siteKey: site, tierId: tier, est, month, soft, size });
    if (view?.refuse) return { ...base, allowed: false, reason: 'soft-budget-exceeded' };
    if (view?.alert) return { ...base, softAlert: true };
    return base;
  }

  async function reserveChecked(input = {}) {
    const verdict = reserve(input);
    if (verdict.softAlert !== true) return verdict;
    const site = text(input.siteKey);
    const purpose = String(input.purpose || '');
    const key = `soft:${site}:${purpose}`;
    const soft = readSettings()?.softBudget;
    const expected = expectedUsdFor(soft, text(input.tierId, 40), purpose, input.size);
    const projected = usd(spentSitePurpose(readMonth(verdict.month), purpose, site) + Math.max(0, usd(input.estUsd)));
    const when = new Date(clock()).toISOString();
    let recorded = null;
    try {
      await seoStore.updateLedger(verdict.month, (draft) => {
        const alerts = Array.isArray(draft.alerts) ? draft.alerts : [];
        if (alerts.some((alert) => alert?.key === key)) return null;
        recorded = { at: when, key, kind: 'soft', capUsd: expected, spentUsd: projected, purpose };
        draft.alerts = alerts.concat(recorded);
        return undefined;
      });
    } catch (error) {
      log?.error?.(`[dfs-ledger] soft alert ${key} was not recorded: ${error?.message || error}`);
      return verdict;
    }
    if (recorded) {
      log?.warn?.(`[dfs-ledger] ${recorded.key} reached: $${Number(recorded.spentUsd).toFixed(4)} of $${Number(recorded.capUsd).toFixed(2)} in ${verdict.month}; work continues`);
      try {
        onAlert?.(recorded);
      } catch {
        // an alert sink never breaks a reserve
      }
    }
    return verdict;
  }

  async function book({ purpose, siteKey = '', tierId = '', costUsd = 0, endpoint = '', ref = '', at = null } = {}) {
    if (!DFS_PURPOSES.includes(purpose)) return reportError('invalid-purpose', `unknown purpose "${purpose}"`, log);
    const when = at ? new Date(at) : clock();
    if (!Number.isFinite(when.getTime())) return reportError('invalid-key', `booking time is not a date: ${at}`, log);
    const month = monthOf(when);
    const cost = Math.max(0, usd(costUsd));
    const site = text(siteKey);
    const tier = text(tierId, 40);
    const settingsNow = readSettings();
    const fresh = [];
    try {
      const doc = await seoStore.updateLedger(month, (draft) => {
        const totals = normalizeTotals(draft.totals);
        const caps = capsFor({ purpose, siteKey: site, tierId: tier }, totals, settingsNow);
        const entry = { at: when.toISOString(), purpose, costUsd: cost };
        if (site) entry.siteKey = site;
        if (tier) entry.tierId = tier;
        if (endpoint) entry.endpoint = text(endpoint, 80);
        if (ref) entry.ref = text(ref, 80);
        const entries = Array.isArray(draft.entries) ? draft.entries : [];
        entries.push(entry);
        draft.entries = entries.length > DFS_LEDGER_MAX_ENTRIES ? entries.slice(-DFS_LEDGER_MAX_ENTRIES) : entries;
        totals.usd = usd(totals.usd + cost);
        totals.calls += 1;
        totals.byPurpose[purpose] = usd((totals.byPurpose[purpose] || 0) + cost);
        if (site) {
          totals.bySite[site] = usd((totals.bySite[site] || 0) + cost);
          const spKey = sitePurposeKey(site, purpose);
          // a month written before bySitePurpose existed starts from what its visible entries add up to
          const prior = Object.prototype.hasOwnProperty.call(totals.bySitePurpose, spKey)
            ? totals.bySitePurpose[spKey]
            : entriesSum(entries.slice(0, -1), purpose, site);
          totals.bySitePurpose[spKey] = usd((Number(prior) || 0) + cost);
        }
        draft.totals = totals;
        const alerts = Array.isArray(draft.alerts) ? draft.alerts : [];
        const known = new Set(alerts.map((alert) => alert.key));
        for (const cap of caps) {
          const after = usd(cap.spentUsd + cost);
          if (after >= cap.capUsd && !known.has(cap.key)) {
            const alert = { at: entry.at, key: cap.key, kind: cap.kind, capUsd: cap.capUsd, spentUsd: after, purpose };
            alerts.push(alert);
            fresh.push(alert);
          }
        }
        if (isPlainObject(draft.balance) && Number.isFinite(Number(draft.balance.usd))) {
          draft.balance = { ...draft.balance, usd: usd(Number(draft.balance.usd) - cost) };
          const floor = Number(settingsNow?.balanceFloorUsd);
          if (Number.isFinite(floor) && draft.balance.usd < floor && !known.has('balance-floor')) {
            const alert = { at: entry.at, key: 'balance-floor', kind: 'balance-floor', capUsd: floor, spentUsd: draft.balance.usd, purpose };
            alerts.push(alert);
            fresh.push(alert);
          }
        }
        draft.alerts = alerts;
        return undefined;
      });
      for (const alert of fresh) {
        log?.warn?.(`[dfs-ledger] ${alert.key} reached: $${alert.spentUsd.toFixed(4)} of $${Number(alert.capUsd).toFixed(2)} in ${month}; work continues`);
        try {
          onAlert?.(alert);
        } catch {
          // an alert sink never breaks a booking
        }
      }
      return { ok: true, month, totals: doc.totals, alerts: fresh };
    } catch (error) {
      const code = error instanceof SeoOpsStoreError ? error.code : 'error';
      return reportError(code, error?.message || String(error), log);
    }
  }

  /** Records the account balance read elsewhere; bookings after it count down from it. */
  async function noteBalance(balanceUsd, { at = null } = {}) {
    const value = Number(balanceUsd);
    if (!Number.isFinite(value)) return reportError('invalid-balance', `not a number: ${balanceUsd}`, log);
    const when = at ? new Date(at) : clock();
    try {
      await seoStore.updateLedger(monthOf(when), (draft) => {
        draft.balance = { usd: usd(value), at: when.toISOString() };
        return undefined;
      });
      return { ok: true };
    } catch (error) {
      return reportError(error instanceof SeoOpsStoreError ? error.code : 'error', error?.message || String(error), log);
    }
  }

  function summary(month = monthOf(clock())) {
    const { totals, balance } = currentTotals(month);
    let alerts = [];
    try {
      alerts = seoStore.readLedger(month)?.alerts || [];
    } catch {
      alerts = [];
    }
    return { month, totals, balance, alerts, caps: readSettings()?.budgets || null };
  }

  return { reserve, reserveChecked, book, noteBalance, summary };
}

// ---------------------------------------------------------------- the switch

let sharedLedger = null;

/** True when seo.dfsLedger is on and not paused (automation settings). Never throws. */
export function dfsLedgerEnabled({ settings = null } = {}) {
  try {
    const resolved = settings || getAutomationSettings();
    const node = resolved?.seo?.dfsLedger;
    return node?.enabled === true && !node.paused;
  } catch {
    return false;
  }
}

/** Tests: the ledger bookDfsSpendIfEnabled uses (null goes back to the default). */
export function setSharedDfsLedgerForTests(ledger) {
  sharedLedger = ledger;
}

async function tierForSite(siteKey) {
  if (!siteKey) return '';
  try {
    const hub = await import('../../data/hub.js');
    const site = hub.getSiteByKey(siteKey);
    return text(site?.sitePlan?.tierId || site?.planSource?.tierId || site?.websitePlan, 40);
  } catch {
    return '';
  }
}

/**
 * Books a paid call into the ledger when seo.dfsLedger is on; does nothing (returns null) when it
 * is off. Never throws and never blocks the caller: the booking runs in the background and its
 * result (or error) is in the returned promise.
 */
export function bookDfsSpendIfEnabled(entry = {}, { settings = null } = {}) {
  if (!dfsLedgerEnabled({ settings })) return null;
  if (!sharedLedger) sharedLedger = createDfsLedger();
  const ledger = sharedLedger;
  return (async () => {
    const tierId = entry.tierId || await tierForSite(text(entry.siteKey));
    return ledger.book({ ...entry, tierId });
  })().catch((error) => reportError('error', error?.message || String(error), console));
}
