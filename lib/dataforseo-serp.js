/**
 * Kundekort / Infokort DataForSEO live SERP (organic + maps).
 * Persistent lifetime + daily caps, disk cache, and paid-operator strip.
 * Maps ranking for client analytics stays in dataforseo-maps.js.
 */
import { createHash } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { getDataFilePath, writeDataJson } from '../data/storage-path.js';

export const SERP_CALL_USD = 0.002;
export const SERP_CACHE_MS = 14 * 24 * 60 * 60 * 1000;
const SPEND_FILE = 'dataforseo-serp-spend.json';
const CACHE_FILE = 'dataforseo-serp-cache.json';
const MAX_CACHE_KEYS = 400;
const MAX_LEDGER_CALLS = 2000;

const PAID_OPERATOR_RE = /\b(?:allinanchor|allintext|allintitle|allinurl|cache|define|definition|filetype|id|inanchor|info|intext|intitle|inurl|link|site):/gi;

function compact(value = '') {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

export function osloDay(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Oslo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

export function stripPaidSearchOperators(query = '') {
  return compact(String(query || '').replace(PAID_OPERATOR_RE, ' ').replace(/["'`]+/g, ' '));
}

export function serpBudgetUsd(env = process.env) {
  const n = Number(env.SALES_LINK_DATAFORSEO_BUDGET_USD);
  return Number.isFinite(n) && n >= 0 ? n : 5;
}

export function serpDailyBudgetUsd(env = process.env) {
  const n = Number(env.SALES_LINK_DATAFORSEO_DAILY_USD);
  return Number.isFinite(n) && n >= 0 ? n : 0.4;
}

export function shouldRefuseSerpCall(summary = {}, { worstCase = SERP_CALL_USD } = {}) {
  const cost = Number(worstCase) || SERP_CALL_USD;
  const budget = Number(summary.budgetUsd);
  const daily = Number(summary.dailyBudgetUsd);
  const spent = Number(summary.spentUsd) || 0;
  const today = Number(summary.dailyUsd) || 0;
  if (Number.isFinite(budget) && spent + cost > budget) return true;
  if (Number.isFinite(daily) && today + cost > daily) return true;
  return false;
}

function emptyLedger(day = osloDay()) {
  return { totalUsd: 0, dailyUsd: 0, day, calls: [] };
}

function persistEnabled(persist) {
  if (persist === false) return false;
  if (persist === true) return true;
  return !process.env.NODE_TEST_CONTEXT;
}

let memoryLedger = emptyLedger();
let memoryCache = {};

export function resetSerpSpendForTests(partial = {}) {
  memoryLedger = { ...emptyLedger(), ...partial, calls: [] };
  memoryCache = {};
}

function rollDay(ledger) {
  const today = osloDay();
  if (ledger.day !== today) {
    ledger.day = today;
    ledger.dailyUsd = 0;
  }
  return ledger;
}

export function readSerpSpendLedger({ persist } = {}) {
  if (!persistEnabled(persist)) {
    return rollDay(memoryLedger);
  }
  const file = getDataFilePath(SPEND_FILE);
  if (!existsSync(file)) {
    memoryLedger = emptyLedger();
    return memoryLedger;
  }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    memoryLedger = rollDay({
      totalUsd: Number(parsed?.totalUsd) || 0,
      dailyUsd: Number(parsed?.dailyUsd) || 0,
      day: parsed?.day || osloDay(),
      calls: Array.isArray(parsed?.calls) ? parsed.calls : [],
    });
    return memoryLedger;
  } catch {
    memoryLedger = emptyLedger();
    return memoryLedger;
  }
}

function writeLedger(ledger, persist) {
  memoryLedger = ledger;
  if (!persistEnabled(persist)) return ledger;
  writeDataJson(getDataFilePath(SPEND_FILE), ledger);
  return ledger;
}

export function serpSpendSummary(env = process.env, { persist } = {}) {
  const ledger = readSerpSpendLedger({ persist });
  const budgetUsd = serpBudgetUsd(env);
  const dailyBudgetUsd = serpDailyBudgetUsd(env);
  return {
    budgetUsd,
    dailyBudgetUsd,
    spentUsd: ledger.totalUsd,
    dailyUsd: ledger.dailyUsd,
    day: ledger.day,
    remainingUsd: Math.max(0, Math.round((budgetUsd - ledger.totalUsd) * 1e6) / 1e6),
    remainingDailyUsd: Math.max(0, Math.round((dailyBudgetUsd - ledger.dailyUsd) * 1e6) / 1e6),
    calls: ledger.calls.length,
  };
}

export function noteSerpSpend(entry = {}, { persist } = {}) {
  const ledger = readSerpSpendLedger({ persist });
  const cost = Math.max(SERP_CALL_USD, Number(entry.costUsd) || 0);
  ledger.calls.push({ ...entry, costUsd: cost });
  if (ledger.calls.length > MAX_LEDGER_CALLS) ledger.calls = ledger.calls.slice(-MAX_LEDGER_CALLS);
  ledger.totalUsd = Math.round((ledger.totalUsd + cost) * 1e6) / 1e6;
  ledger.dailyUsd = Math.round((ledger.dailyUsd + cost) * 1e6) / 1e6;
  return writeLedger(ledger, persist);
}

function cacheKey(endpoint, query) {
  return createHash('sha1').update(`${endpoint}\n${query}`).digest('hex');
}

function readCacheStore(persist) {
  if (!persistEnabled(persist)) return memoryCache;
  const file = getDataFilePath(CACHE_FILE);
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    memoryCache = parsed && typeof parsed === 'object' ? parsed : {};
    return memoryCache;
  } catch {
    memoryCache = {};
    return memoryCache;
  }
}

function writeCacheStore(store, persist) {
  memoryCache = store;
  if (!persistEnabled(persist)) return;
  const keys = Object.keys(store);
  if (keys.length > MAX_CACHE_KEYS) {
    const keep = keys
      .map((key) => ({ key, at: Date.parse(store[key]?.at || '') || 0 }))
      .sort((a, b) => b.at - a.at)
      .slice(0, MAX_CACHE_KEYS);
    const next = {};
    for (const row of keep) next[row.key] = store[row.key];
    memoryCache = next;
  }
  writeDataJson(getDataFilePath(CACHE_FILE), memoryCache);
}

export function readSerpCache(endpoint, query, { persist, maxAgeMs = SERP_CACHE_MS } = {}) {
  const store = readCacheStore(persist);
  const row = store[cacheKey(endpoint, query)];
  const at = Date.parse(row?.at || '');
  if (!row || !Number.isFinite(at) || Date.now() - at > maxAgeMs) return null;
  return row.payload;
}

export function writeSerpCache(endpoint, query, payload, { persist } = {}) {
  const store = readCacheStore(persist);
  store[cacheKey(endpoint, query)] = { at: new Date().toISOString(), payload };
  writeCacheStore(store, persist);
}

export function prepareSerpQuery(query = '') {
  return stripPaidSearchOperators(query);
}
