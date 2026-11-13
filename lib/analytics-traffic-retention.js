// Visit-statistics retention: day files under client-analytics-traffic/<site>/<YYYY-MM-DD>.jsonl.
// The switch retention.analyticsTraffic defaults off. Off or paused, this touches nothing.
// shadow counts due files and stores a report. auto deletes them, except while safe mode is on,
// when auto only reports. A file named for UTC day D can hold a row from Oslo day D or D+1, so it
// is due only when D+1 is before the cutoff (today in Oslo, minus 26 months).
import { getAutomationSettings } from '../data/automation-settings.js';
import {
  listTrafficDayFiles,
  removeTrafficDayFile,
  trafficFolderExists,
  writeTrafficRetentionReport,
} from '../data/client-analytics.js';
import { acquireLease } from '../data/email-store.js';
import { isSafeModeActive } from './safe-mode.js';

export const TRAFFIC_RETENTION_MONTHS = 26;
const LEASE_NAME = 'analytics-traffic-retention';
const LEASE_MS = 10 * 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;

const OSLO = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Oslo',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hourCycle: 'h23',
});

function osloDay(ms) {
  const parts = OSLO.formatToParts(new Date(ms)).reduce((acc, part) => {
    acc[part.type] = part.value;
    return acc;
  }, {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** The ISO day n days after `day`, or '' when `day` is not a real calendar day. */
function addDays(day, n) {
  const ms = Date.parse(`${day}T12:00:00.000Z`);
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== day) return '';
  return new Date(ms + n * DAY_MS).toISOString().slice(0, 10);
}

/** 'YYYY-MM-DD': today in Europe/Oslo minus 26 calendar months, clamped to the target month. */
export function trafficRetentionCutoffDay(now = Date.now()) {
  const ms = typeof now === 'number' ? now : Date.parse(now);
  const [yearText, monthText, dayText] = osloDay(ms).split('-');
  const shifted = Number(yearText) * 12 + (Number(monthText) - 1) - TRAFFIC_RETENTION_MONTHS;
  const targetYear = Math.floor(shifted / 12);
  const targetMonth = shifted - targetYear * 12;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  const day = Math.min(Number(dayText), lastDay);
  return `${targetYear}-${String(targetMonth + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * A UTC day file is due when every Oslo day it can hold (D and D+1) is before the cutoff. A name
 * that is not a real calendar day (2020-13-45) is never due.
 */
export function trafficDayFileIsDue(day, cutoffDay) {
  const next = addDays(day, 1);
  return next !== '' && next < cutoffDay;
}

function switchState(settings) {
  const node = settings?.retention?.analyticsTraffic;
  if (!node || node.enabled !== true) return 'off';
  if (node.paused) return 'paused';
  return node.mode === 'auto' ? 'auto' : 'shadow';
}

/**
 * One retention pass. Reads the switch before any disk access. Returns
 * { ran: false, reason } or { ran: false, busy: true } or the counts report.
 */
export async function runTrafficRetention({ now = Date.now(), settings, acquire = acquireLease, logger = console, remove = removeTrafficDayFile } = {}) {
  const state = switchState(settings || getAutomationSettings());
  if (state === 'off' || state === 'paused') return { ran: false, reason: state };
  if (!trafficFolderExists()) return { ran: false, reason: 'no-data' };

  const lease = await acquire(LEASE_NAME, LEASE_MS);
  if (!lease) return { ran: false, busy: true };
  try {
    const cutoffDay = trafficRetentionCutoffDay(now);
    const due = listTrafficDayFiles().filter((entry) => trafficDayFileIsDue(entry.day, cutoffDay));
    const mode = state === 'auto' && !isSafeModeActive() ? 'auto' : 'shadow';
    let removed = 0;
    let failed = 0;
    let removedBytes = 0;
    if (mode === 'auto') {
      for (const entry of due) {
        if (remove(entry)) {
          removed += 1;
          removedBytes += entry.bytes;
        } else failed += 1;
      }
    }
    const report = {
      ran: true,
      mode,
      cutoffDay,
      months: TRAFFIC_RETENTION_MONTHS,
      sites: new Set(due.map((entry) => entry.siteDir)).size,
      files: due.length,
      bytes: due.reduce((sum, entry) => sum + entry.bytes, 0),
      removedBytes,
      removed,
      failed,
      oldestDay: due.reduce((min, entry) => (min === null || entry.day < min ? entry.day : min), null),
      at: new Date(now).toISOString(),
    };
    writeTrafficRetentionReport(report);
    const n = mode === 'auto' ? removed : due.length;
    if (n > 0) {
      const line = mode === 'auto'
        ? `[analytics-retention] deleted ${n} day file(s), ${report.removedBytes} byte(s), cutoff ${cutoffDay}`
        : `[analytics-retention] shadow: would delete ${n} day file(s), ${report.bytes} byte(s), cutoff ${cutoffDay}`;
      logger?.log?.(line);
    }
    if (failed > 0) logger?.error?.(`[analytics-retention] ${failed} day file(s) could not be deleted`);
    return report;
  } finally {
    await lease.release().catch(() => {});
  }
}

/**
 * First run firstDelayMs after start, then every everyMs. Timers are unref'ed and every error is
 * logged, never thrown. Returns { stop }.
 */
export function startTrafficRetentionLoop({ firstDelayMs = 15 * 60_000, everyMs = 24 * 60 * 60_000, run = runTrafficRetention, logger = console } = {}) {
  const tick = () => {
    Promise.resolve()
      .then(() => run({ now: Date.now(), logger }))
      .catch((error) => logger?.error?.('[analytics-retention] failed:', error?.code || error?.message || 'error'));
  };
  let interval = null;
  const first = setTimeout(() => {
    tick();
    interval = setInterval(tick, everyMs);
    interval.unref?.();
  }, firstDelayMs);
  first.unref?.();
  return {
    stop() {
      clearTimeout(first);
      if (interval) clearInterval(interval);
      interval = null;
    },
  };
}
