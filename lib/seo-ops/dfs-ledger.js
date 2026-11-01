/**
 * The hub's DataForSEO ledger, one file per month (seo-ops/dfs-ledger-YYYY-MM.json, written through
 * lib/seo-ops/store.js, kept 13 months). It books and alerts; it never stops a call.
 *
 *   reserve({ purpose, siteKey, tierId, estUsd })  -> { allowed: true, month, over: [...], projected }
 *       what a call would do to the caps; `allowed` is always true
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
 * and daily caps. The ledger adds no stop.
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
  return { usd: 0, calls: 0, byPurpose: {}, bySite: {} };
}

function normalizeTotals(totals) {
  const base = isPlainObject(totals) ? totals : {};
  return {
    usd: usd(base.usd),
    calls: Number(base.calls) || 0,
    byPurpose: isPlainObject(base.byPurpose) ? { ...base.byPurpose } : {},
    bySite: isPlainObject(base.bySite) ? { ...base.bySite } : {},
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

  function reserve({ purpose, siteKey = '', tierId = '', estUsd = 0 } = {}) {
    const month = monthOf(clock());
    const { totals, balance } = currentTotals(month);
    const est = Math.max(0, usd(estUsd));
    const over = [];
    for (const cap of capsFor({ purpose, siteKey: text(siteKey), tierId: text(tierId, 40) }, totals, readSettings())) {
      if (cap.spentUsd + est >= cap.capUsd) over.push(cap.key);
    }
    const floor = Number(readSettings()?.balanceFloorUsd);
    if (balance && Number.isFinite(Number(balance.usd)) && Number.isFinite(floor) && Number(balance.usd) - est < floor) over.push('balance-floor');
    return { allowed: true, month, over, projected: usd(totals.usd + est) };
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
        if (site) totals.bySite[site] = usd((totals.bySite[site] || 0) + cost);
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

  return { reserve, book, noteBalance, summary };
}

// ---------------------------------------------------------------- the switch

let sharedLedger = null;

/** True when seo.dfsLedger is on (automation settings). Never throws. */
export function dfsLedgerEnabled({ settings = null } = {}) {
  try {
    const resolved = settings || getAutomationSettings();
    return resolved?.seo?.dfsLedger?.enabled === true;
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
