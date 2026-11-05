// CMS fleet monitor: a daily review of the client CMS sites the hub knows, and an hourly health ping.
//
// Review (background job cmsEnforcement, switch cmsFleet.monitor):
//   - proposes feature enforcement ('on') for a site in 'log' whose CMS reported no would-block hit
//     in the last 7 days (Oslo dates), sent a verified heartbeat within 24 hours, reports its feature
//     tree and gets the tree through site-config, and has been watched for at least 7 days;
//   - writes one digest a day for Asoldi staff: sites without contact for more than 24 hours, new
//     settings conflicts, recent would-block hits, failed migrations, sites the last health ping did
//     not reach, and the open proposals. shadow stores it; auto also mails it to alerts.to through
//     lib/email.js (the safe-mode outbox while safe mode is on);
//   - with cmsFleet.autoApplyFlip, the monitor in auto and safe mode off, applies a proposal nobody
//     dismissed for 3 days. In safe mode the review only reports.
// Health ping (background job cmsWakePing, switch cmsFleet.wakePing): GET /api/cms/health on every CMS
// site once an hour (5 s timeout). It wakes idle apps so their schedulers catch up and records
// whether the site answered. In safe mode only loopback hosts are pinged unless publicRead is allowed.
//
// State: <data dir>/cms-fleet-monitor.json (site ids, proposal states, ping results, digest text and
// the last flips). With both switches off neither job reads or writes anything. Superadmin flips,
// reverts and dismissals (lib/routes/cms-fleet-routes.js) work whatever the switches say; a flip
// changes site.featureEnforcement through hub.updateSiteSpecs and writes a cmsSpecHistory row, as
// PUT /api/hub/sites/:id/cms-spec does.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { domainToASCII } from 'node:url';
import { updateJsonLocked } from '../data/atomic-json.js';
import { getAutomationSettings } from '../data/automation-settings.js';
import { readCmsFeatureSettings, siteConfigModeFor } from '../data/cms-feature-settings.js';
import { acquireLease } from '../data/email-store.js';
import { featureEnforcementOf, normalizeBlockHistory } from '../data/feature-spec-model.js';
import { siteReachedByCms } from '../data/hub.js';
import { getPersistentDataDir } from '../data/storage-path.js';
import { appendHistory } from './cms-spec.js';
import { isSafeModeActive, safeModeAllows } from './safe-mode.js';

export const CMS_FLEET_FILE = 'cms-fleet-monitor.json';
export const CLEAN_DAYS = 7;
export const HEARTBEAT_FRESH_MS = 24 * 60 * 60 * 1000;
export const AUTO_APPLY_AFTER_MS = 3 * 24 * 60 * 60 * 1000;
export const WAKE_TIMEOUT_MS = 5000;
export const WAKE_EVERY_MS = 60 * 60 * 1000;
export const REVIEW_CHECK_EVERY_MS = 15 * 60 * 1000;
export const REVIEW_AT = '07:00';
export const FLIPS_KEPT = 50;
export const FLIP_BY_MONITOR = 'cms-fleet-monitor';

const DAY_MS = 24 * 60 * 60 * 1000;
const REVIEW_LEASE_MS = 10 * 60 * 1000;
const TOP_MAX = 10;
const INACTIVE_PHASES = new Set(['cancelled', 'archived']);
const PROPOSAL_STATUSES = new Set(['open', 'dismissed', 'applied']);
// Names that would set an object's prototype instead of a key; never used as site keys here.
const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const OSLO = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Oslo',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

// What this process already reviewed (state file -> Oslo day), so a state file that cannot be
// written never turns into a digest every 15 minutes.
const reviewedMemo = new Map();

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function toMs(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const ms = Date.parse(String(value || ''));
  return Number.isFinite(ms) ? ms : 0;
}

function iso(ms) {
  return new Date(ms).toISOString();
}

function text(value, max = 300) {
  return String(value ?? '').trim().slice(0, max);
}

function latestMs(...values) {
  return Math.max(0, ...values.map(toMs));
}

function osloParts(ms) {
  return OSLO.formatToParts(new Date(ms)).reduce((acc, part) => ({ ...acc, [part.type]: part.value }), {});
}

/** 'YYYY-MM-DD' in Oslo for an epoch ms. */
export function osloDay(ms) {
  const parts = osloParts(ms);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** 'HH:MM' in Oslo for an epoch ms. */
export function osloTime(ms) {
  const parts = osloParts(ms);
  return `${parts.hour}:${parts.minute}`;
}

/** 'YYYY-MM-DD' plus n calendar days. */
export function addDays(day, n) {
  return new Date(Date.parse(`${day}T12:00:00.000Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

/**
 * The monitor switches as plain states: monitor 'off' | 'shadow' | 'auto' | 'paused', autoApplyFlip,
 * wakePing 'off' | 'on' | 'paused', and the digest recipient (alerts.to).
 */
export function fleetSettings(settings) {
  const node = isPlainObject(settings?.cmsFleet) ? settings.cmsFleet : {};
  const monitor = isPlainObject(node.monitor) ? node.monitor : {};
  const wake = isPlainObject(node.wakePing) ? node.wakePing : {};
  let monitorState = 'off';
  if (monitor.enabled === true) monitorState = isPlainObject(monitor.paused) ? 'paused' : monitor.mode === 'auto' ? 'auto' : 'shadow';
  let wakeState = 'off';
  if (wake.enabled === true) wakeState = isPlainObject(wake.paused) ? 'paused' : 'on';
  return {
    monitor: monitorState,
    autoApplyFlip: node.autoApplyFlip === true,
    wakePing: wakeState,
    to: text(settings?.alerts?.to, 200),
  };
}

/** The sites the monitor looks at: a CMS has reported in, and the site is not cancelled or archived. */
export function cmsSites(sites) {
  return (Array.isArray(sites) ? sites : []).filter((site) => site?.id && !RESERVED_KEYS.has(site.id) && siteReachedByCms(site) && !INACTIVE_PHASES.has(site.deliveryPhase));
}

// ---------------------------------------------------------------- state file

export function fleetStatePath({ dataDir } = {}) {
  return join(dataDir || getPersistentDataDir(), CMS_FLEET_FILE);
}

function normalizeProposal(raw) {
  if (!isPlainObject(raw) || !PROPOSAL_STATUSES.has(raw.status)) return null;
  const out = { status: raw.status, since: text(raw.since, 40) };
  for (const field of ['at', 'by', 'reason']) if (raw[field]) out[field] = text(raw[field], 300);
  if (raw.auto === true) out.auto = true;
  return out;
}

function normalizeSiteState(raw) {
  if (!isPlainObject(raw)) return {};
  const out = {};
  if (raw.watchSince) out.watchSince = text(raw.watchSince, 40);
  if (raw.resetAt) out.resetAt = text(raw.resetAt, 40);
  const proposal = normalizeProposal(raw.proposal);
  if (proposal) out.proposal = proposal;
  if (Array.isArray(raw.reportedConflicts)) out.reportedConflicts = raw.reportedConflicts.map((key) => text(key, 80)).filter(Boolean).slice(0, 30);
  if (isPlainObject(raw.wake)) out.wake = { ...raw.wake };
  return out;
}

/** Any stored object -> the full state shape. */
export function normalizeFleetState(raw) {
  const source = isPlainObject(raw) ? raw : {};
  const sites = {};
  for (const [id, row] of Object.entries(isPlainObject(source.sites) ? source.sites : {})) {
    const key = text(id, 80);
    if (key && !RESERVED_KEYS.has(key)) sites[key] = normalizeSiteState(row);
  }
  return {
    version: 1,
    sites,
    lastReviewDay: text(source.lastReviewDay, 10),
    lastReviewAt: text(source.lastReviewAt, 40),
    lastDigest: isPlainObject(source.lastDigest) ? source.lastDigest : null,
    flips: Array.isArray(source.flips) ? source.flips.filter(isPlainObject).slice(-FLIPS_KEPT) : [],
  };
}

/** The stored state, read fresh (an empty state when the file is missing or unreadable; never writes). */
export function readFleetState({ dataDir } = {}) {
  try {
    return normalizeFleetState(JSON.parse(readFileSync(fleetStatePath({ dataDir }), 'utf8')));
  } catch {
    return normalizeFleetState(null);
  }
}

function updateFleetState(dataDir, mutate) {
  return updateJsonLocked(fleetStatePath({ dataDir }), (current) => {
    const state = normalizeFleetState(current);
    const next = mutate(state);
    return next === undefined ? undefined : next;
  });
}

// ---------------------------------------------------------------- review

function sumHits(rows) {
  const top = new Map();
  let total = 0;
  for (const row of rows) {
    total += row.count;
    for (const entry of Array.isArray(row.top) ? row.top : []) {
      if (!isPlainObject(entry)) continue;
      const key = text(entry.key, 80);
      const route = text(entry.route, 200);
      const name = `${key} ${route}`;
      const current = top.get(name) || { key, route, count: 0 };
      current.count += Math.max(0, Math.round(Number(entry.count) || 0));
      top.set(name, current);
    }
  }
  return {
    total,
    days: rows.map((row) => ({ date: row.date, count: row.count })),
    top: [...top.values()].sort((a, b) => b.count - a.count || a.key.localeCompare(b.key)).slice(0, TOP_MAX),
  };
}

function listOf(value, max = 30) {
  return Array.isArray(value) ? value.map((entry) => text(entry, 120)).filter(Boolean).slice(0, max) : [];
}

function failedMigrationsOf(cms) {
  const migrations = isPlainObject(cms?.migrations) ? cms.migrations : null;
  if (!migrations) return [];
  const failed = listOf(migrations.failed);
  if (!failed.length && migrations.status === 'failed') return ['status'];
  return failed;
}

function reportsTree(cms) {
  return Number.isInteger(cms?.featuresRev) || Boolean(text(cms?.effectiveHash)) || Boolean(text(cms?.effective));
}

/**
 * One site, evaluated at `now` against the stored monitor state: contact, block hits, conflicts,
 * migrations, the last ping, and whether enforcement can be proposed (with the reasons it cannot).
 */
export function evaluateSite(site, { now = Date.now(), state = null, featureSettings = null } = {}) {
  const cms = isPlainObject(site?.cms) ? site.cms : {};
  const saved = normalizeSiteState(state?.sites?.[site?.id]);
  const today = osloDay(now);
  const windowFrom = addDays(today, -(CLEAN_DAYS - 1));
  const history = normalizeBlockHistory(cms.blockHistory);
  const lastContact = latestMs(cms.lastSeenAt, cms.lastVerifiedAt, cms.lastHeartbeatAt);
  const lastReport = latestMs(cms.lastVerifiedAt, cms.lastHeartbeatAt);
  const enforcement = featureEnforcementOf(site);
  const hits = sumHits(history.filter((row) => row.date >= windowFrom && row.count > 0));
  const recentHits = sumHits(history.filter((row) => row.date >= addDays(today, -1) && row.count > 0));
  const conflicts = listOf(cms.settingsConflicts);
  const reported = new Set(saved.reportedConflicts || []);
  const wake = saved.wake || null;
  const tree = reportsTree(cms);
  const servedToCms = siteConfigModeFor(site, featureSettings) === 'on';
  const reportFresh = Boolean(lastReport) && now - lastReport <= HEARTBEAT_FRESH_MS;

  // Watched since: the first review that saw the site in 'log' (served, reporting the tree, a fresh
  // verified heartbeat), or the oldest block history day,
  // but never before the last revert (blocks counted while enforcement was on do not count).
  const watchDay = saved.watchSince && toMs(saved.watchSince) ? osloDay(toMs(saved.watchSince)) : null;
  let observedSince = [watchDay, history[0]?.date || null].filter(Boolean).sort()[0] || null;
  const resetDay = saved.resetAt && toMs(saved.resetAt) ? osloDay(toMs(saved.resetAt)) : null;
  if (resetDay && observedSince && observedSince < resetDay) observedSince = resetDay;

  const reasons = [];
  if (enforcement !== 'log') reasons.push('not-log');
  if (!reportFresh) reasons.push('no-report');
  if (!tree) reasons.push('no-tree');
  if (!servedToCms) reasons.push('not-served');
  if (hits.total > 0) reasons.push('block-hits');
  if (!observedSince || observedSince > windowFrom) reasons.push('too-new');

  return {
    siteId: site.id,
    name: text(site.name, 120),
    domain: text(site.domain, 200),
    isTest: site.isTest === true,
    enforcement,
    packageVersion: text(cms.packageVersion, 40),
    lastContactAt: lastContact ? iso(lastContact) : null,
    lastReportAt: lastReport ? iso(lastReport) : null,
    contactAgeHours: lastContact ? Math.round(((now - lastContact) / 3_600_000) * 10) / 10 : null,
    stale: !lastContact || now - lastContact > HEARTBEAT_FRESH_MS,
    reportFresh,
    reportsTree: tree,
    servedToCms,
    hits,
    recentHits,
    conflicts,
    newConflicts: conflicts.filter((key) => !reported.has(key)),
    failedMigrations: failedMigrationsOf(cms),
    wake,
    unreachable: Boolean(wake) && wake.ok === false && !wake.skipped,
    observedSince,
    proposal: saved.proposal || null,
    proposable: reasons.length === 0,
    reasons,
  };
}

function nextSiteState(row, previous, nowIso) {
  const next = { ...previous };
  // The watch runs while the CMS gets the tree in 'log' and reports it; a gap in heartbeats does not
  // restart it (the CMS keeps counting blocks and reports them with its next heartbeat).
  if (row.enforcement !== 'log' || !row.servedToCms || !row.reportsTree) delete next.watchSince;
  else if (!next.watchSince && row.reportFresh) next.watchSince = nowIso;

  const proposal = previous.proposal || null;
  if (row.enforcement === 'on') {
    if (proposal?.status !== 'applied') delete next.proposal;
  } else if (row.enforcement !== 'log') {
    delete next.proposal;
  } else if (row.proposable) {
    if (!proposal || proposal.status === 'applied') next.proposal = { status: 'open', since: nowIso };
  } else if (proposal) {
    delete next.proposal;
  }

  if (row.conflicts.length) next.reportedConflicts = row.conflicts;
  else delete next.reportedConflicts;
  return next;
}

/**
 * The fleet at `now` (pure): every CMS site evaluated, the lists the digest uses, and the next stored
 * state (watch start, proposals, reported conflicts; ping results are kept; sites out of scope go).
 */
export function reviewFleet({ sites, state = null, now = Date.now(), featureSettings = null } = {}) {
  const current = normalizeFleetState(state);
  const nowIso = iso(now);
  const nextSites = {};
  const rows = [];
  for (const site of cmsSites(sites)) {
    const row = evaluateSite(site, { now, state: current, featureSettings });
    const next = nextSiteState(row, current.sites[site.id] || {}, nowIso);
    nextSites[site.id] = next;
    rows.push({ ...row, proposal: next.proposal || null });
  }
  const openProposal = (row) => row.proposable && row.proposal?.status === 'open';
  return {
    day: osloDay(now),
    rows,
    proposals: rows.filter(openProposal),
    stale: rows.filter((row) => row.stale),
    hits: rows.filter((row) => row.recentHits.total > 0),
    newConflicts: rows.filter((row) => row.newConflicts.length > 0),
    failedMigrations: rows.filter((row) => row.failedMigrations.length > 0),
    unreachable: rows.filter((row) => row.unreachable),
    nextState: { ...current, sites: nextSites },
  };
}

function osloStamp(isoValue) {
  const ms = toMs(isoValue);
  return ms ? `${osloDay(ms)} ${osloTime(ms)}` : 'aldri';
}

function siteLabel(row) {
  return row.domain ? `${row.name} (${row.domain})` : row.name;
}

/** The staff digest for a review: { subject, text, counts, empty }. Plain Norwegian text. */
export function buildDigest(review, { now = Date.now() } = {}) {
  const sections = [
    ['stale', 'Ingen kontakt på over 24 timer', review.stale.map((row) => `- ${siteLabel(row)}: sist kontakt ${osloStamp(row.lastContactAt)}`)],
    ['newConflicts', 'Nye innstillingskonflikter', review.newConflicts.map((row) => `- ${siteLabel(row)}: ${row.newConflicts.join(', ')}`)],
    ['hits', 'Treff som ville blitt sperret', review.hits.map((row) => {
      const top = row.recentHits.top.slice(0, 3).map((entry) => `${entry.key} ${entry.route} x${entry.count}`).join('; ');
      return `- ${siteLabel(row)}: ${row.recentHits.total} treff${top ? ` (${top})` : ''}`;
    })],
    ['failedMigrations', 'Mislykkede migreringer', review.failedMigrations.map((row) => `- ${siteLabel(row)}: ${row.failedMigrations.join(', ')}`)],
    ['unreachable', 'Ikke nåbare ved siste helsesjekk', review.unreachable.map((row) => `- ${siteLabel(row)}: ${row.wake?.status ? `HTTP ${row.wake.status}` : row.wake?.error || 'ukjent feil'}`)],
    ['proposals', 'Forslag: slå på håndheving', review.proposals.map((row) => `- ${siteLabel(row)}: ${CLEAN_DAYS} dager uten treff`)],
  ];
  const counts = Object.fromEntries(sections.map(([key, , lines]) => [key, lines.length]));
  const total = sections.reduce((sum, [, , lines]) => sum + lines.length, 0);
  const body = sections
    .filter(([, , lines]) => lines.length)
    .map(([, title, lines]) => `${title}:\n${lines.join('\n')}`)
    .join('\n\n');
  return {
    subject: `[Asoldi] CMS-flåten: ${total} merknader`,
    text: `CMS-flåten ${osloDay(now)}\n\n${body}\n\nSe Superadmin, System safety, CMS-utrulling.\n`,
    counts,
    empty: total === 0,
  };
}

async function defaultSendMail(message) {
  const { sendEmail } = await import('./email.js');
  return sendEmail(message);
}

function errorText(error) {
  return text(error?.message || error, 200) || 'error';
}

/**
 * The daily review. Does nothing (and reads no state) while cmsFleet.monitor is off or paused; once
 * per Oslo day from REVIEW_AT, under a lease. Returns { ran, reason? } or { ran, day, proposals,
 * mailed, digest, applied }.
 */
export async function runFleetReview({
  hub,
  settings = null,
  featureSettings = null,
  now = Date.now(),
  dataDir,
  sendMail = defaultSendMail,
  flip = flipSites,
  lease = acquireLease,
  log = console,
} = {}) {
  const resolved = settings || getAutomationSettings({ dataDir });
  const switches = fleetSettings(resolved);
  if (switches.monitor === 'off' || switches.monitor === 'paused') return { ran: false, reason: switches.monitor };
  const file = fleetStatePath({ dataDir });
  const today = osloDay(now);
  if (reviewedMemo.get(file) === today || readFleetState({ dataDir }).lastReviewDay === today) return { ran: false, reason: 'done-today' };
  if (osloTime(now) < REVIEW_AT) return { ran: false, reason: 'too-early' };
  const held = await lease('cms-fleet-review', REVIEW_LEASE_MS);
  if (!held) return { ran: false, reason: 'busy' };
  try {
    const sites = hub.getAllSites();
    const features = featureSettings || readCmsFeatureSettings({ dataDir });
    const willMail = switches.monitor === 'auto' && Boolean(switches.to);
    let review = null;
    let digest = null;
    let already = false;
    updateFleetState(dataDir, (state) => {
      if (state.lastReviewDay === today) {
        already = true;
        return undefined;
      }
      review = reviewFleet({ sites, state, now, featureSettings: features });
      digest = buildDigest(review, { now });
      return {
        ...review.nextState,
        lastReviewDay: today,
        lastReviewAt: iso(now),
        lastDigest: {
          day: today,
          at: iso(now),
          mailed: false,
          empty: digest.empty,
          counts: digest.counts,
          subject: digest.subject,
          text: digest.text,
          ...(willMail && !digest.empty ? { pending: true } : {}),
        },
      };
    });
    reviewedMemo.set(file, today);
    if (already || !review) return { ran: false, reason: 'done-today' };

    let mailed = false;
    if (willMail && !digest.empty) {
      let error = '';
      try {
        await sendMail({ to: switches.to, subject: digest.subject, text: digest.text });
        mailed = true;
      } catch (err) {
        error = errorText(err);
        log?.warn?.(`[cms-fleet] digest mail failed: ${error}`);
      }
      updateFleetState(dataDir, (state) => {
        if (state.lastDigest?.day !== today) return undefined;
        const { pending: _pending, ...rest } = state.lastDigest;
        return { ...state, lastDigest: { ...rest, mailed, ...(error ? { error } : {}) } };
      });
    }

    const applied = [];
    if (switches.monitor === 'auto' && switches.autoApplyFlip && !isSafeModeActive()) {
      const due = review.proposals.filter((row) => now - toMs(row.proposal?.since) >= AUTO_APPLY_AFTER_MS);
      if (due.length) {
        const results = await flip({
          hub,
          siteIds: due.map((row) => row.siteId),
          to: 'on',
          by: FLIP_BY_MONITOR,
          reason: `auto: no objection in ${Math.round(AUTO_APPLY_AFTER_MS / DAY_MS)} days`,
          now,
          dataDir,
          auto: true,
        });
        for (const result of results) if (result.ok && !result.unchanged) applied.push(result.siteId);
      }
    }
    return { ran: true, day: today, proposals: review.proposals.map((row) => row.siteId), mailed, digest: digest.counts, applied };
  } finally {
    try {
      await held.release?.();
    } catch {
      // the lease runs out on its own
    }
  }
}

// ---------------------------------------------------------------- flips and dismissals

/**
 * Sets featureEnforcement to `to` ('on' from 'log', or 'log' from 'on') for each site, with a
 * cmsSpecHistory row, and records it in the monitor state. Returns one row per site:
 * { siteId, ok, from, to, unchanged?, status?, error? }.
 */
export function flipSites({ hub, siteIds = [], to, by = '', reason = '', now = Date.now(), dataDir, auto = false } = {}) {
  if (to !== 'on' && to !== 'log') throw new Error('flipSites: to must be on or log');
  const at = iso(now);
  const results = [];
  for (const siteId of [...new Set((Array.isArray(siteIds) ? siteIds : []).map((id) => text(id, 80)).filter(Boolean))]) {
    let from = null;
    const result = hub.updateSiteSpecs(siteId, (site) => {
      from = featureEnforcementOf(site);
      if (from === to) return { ok: true, unchanged: true };
      if (to === 'on' && from !== 'log') return { ok: false, status: 409, error: 'not-in-log' };
      if (to === 'log' && from !== 'on') return { ok: false, status: 409, error: 'not-on' };
      return {
        ok: true,
        featureEnforcement: to,
        cmsSpecHistory: appendHistory(site.cmsSpecHistory, { at, by: text(by, 120), reason: text(reason, 300), featureEnforcement: { from, to } }),
      };
    });
    if (result?.ok) results.push({ siteId, ok: true, from, to, ...(result.unchanged ? { unchanged: true } : {}) });
    else results.push({ siteId, ok: false, from, to, status: result?.status || 400, error: result?.error || 'failed' });
  }
  const changed = results.filter((row) => row.ok && !row.unchanged);
  if (changed.length) {
    updateFleetState(dataDir, (state) => {
      for (const row of changed) {
        const site = { ...(state.sites[row.siteId] || {}) };
        if (to === 'on') {
          site.proposal = { status: 'applied', since: site.proposal?.since || at, at, by: text(by, 120), ...(auto ? { auto: true } : {}) };
        } else {
          delete site.proposal;
          site.watchSince = at;
          site.resetAt = at;
        }
        state.sites[row.siteId] = site;
        state.flips.push({ siteId: row.siteId, at, by: text(by, 120), from: row.from, to, auto: auto === true });
      }
      state.flips = state.flips.slice(-FLIPS_KEPT);
      return state;
    });
  }
  return results;
}

/**
 * Marks a site's proposal as dismissed (an objection: no bulk flip, no automatic apply) while the site
 * still qualifies. `proposable` lets a caller dismiss a proposal the review has not stored yet.
 * Returns { ok } or { ok: false, error: 'no-open-proposal' }.
 */
export function dismissProposal({ siteId, by = '', reason = '', now = Date.now(), dataDir, proposable = false } = {}) {
  const id = text(siteId, 80);
  const at = iso(now);
  let ok = false;
  updateFleetState(dataDir, (state) => {
    const site = { ...(state.sites[id] || {}) };
    const proposal = site.proposal;
    if (proposal?.status !== 'open' && !(proposable && !proposal)) return undefined;
    site.proposal = { status: 'dismissed', since: proposal?.since || at, at, by: text(by, 120), ...(reason ? { reason: text(reason, 300) } : {}) };
    state.sites[id] = site;
    ok = true;
    return state;
  });
  return ok ? { ok: true } : { ok: false, error: 'no-open-proposal' };
}

/** What the Superadmin card shows: switches, every CMS site evaluated now, the proposals and the log. */
export function fleetOverview({ hub, dataDir, now = Date.now(), settings = null, featureSettings = null } = {}) {
  const resolved = settings || getAutomationSettings({ dataDir });
  const features = featureSettings || readCmsFeatureSettings({ dataDir });
  const state = readFleetState({ dataDir });
  const rows = cmsSites(hub.getAllSites()).map((site) => evaluateSite(site, { now, state, featureSettings: features }));
  return {
    settings: fleetSettings(resolved),
    safeMode: isSafeModeActive(),
    day: osloDay(now),
    rows,
    proposals: rows.filter((row) => row.proposable && row.proposal?.status !== 'dismissed').map((row) => row.siteId),
    lastReview: state.lastReviewDay ? { day: state.lastReviewDay, at: state.lastReviewAt } : null,
    lastDigest: state.lastDigest,
    flips: state.flips.slice(-20).reverse(),
  };
}

// ---------------------------------------------------------------- health ping

/** The host (and port) to ping from a stored domain, punycode for a Unicode name; '' when not usable. */
export function wakeHost(domain) {
  let value = String(domain ?? '').trim().toLowerCase().replace(/^https?:\/\//, '');
  value = value.split(/[/?#]/)[0];
  if (!value || /[\s@\\]/.test(value)) return '';
  const match = /^(\[[0-9a-f:.]+\]|[^:[\]]+)(?::(\d{1,5}))?$/.exec(value);
  if (!match) return '';
  const [, name, port] = match;
  if (port && (Number(port) < 1 || Number(port) > 65535)) return '';
  let hostname = name;
  if (!name.startsWith('[')) {
    hostname = domainToASCII(name.replace(/\.$/, ''));
    if (!hostname || !/^[a-z0-9.-]+$/.test(hostname)) return '';
  }
  return port ? `${hostname}:${port}` : hostname;
}

/** True for localhost, *.localhost, 127.x.x.x and [::1] (with or without a port). */
export function isLoopbackHost(host) {
  const name = String(host || '').replace(/:\d+$/, '');
  return name === 'localhost' || name.endsWith('.localhost') || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(name) || name === '[::1]';
}

function errorCode(error) {
  const code = error?.cause?.code || error?.code;
  if (code) return text(code, 60);
  return text(error?.cause?.message || error?.message || error, 80) || 'error';
}

async function pingSite(site, { fetchImpl, timeoutMs, publicAllowed, at }) {
  const host = wakeHost(site.domain);
  if (!host) return { at, ok: false, skipped: 'no-domain' };
  const loopback = isLoopbackHost(host);
  if (!loopback && !publicAllowed) return { at, ok: false, skipped: 'safe-mode' };
  const url = `${loopback ? 'http' : 'https'}://${host}/api/cms/health`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  const started = performance.now();
  try {
    const res = await fetchImpl(url, { method: 'GET', headers: { accept: 'application/json' }, cache: 'no-store', signal: controller.signal });
    try {
      await res.body?.cancel?.();
    } catch {
      // the body is not needed
    }
    return { at, ok: res.ok === true, status: Number(res.status) || 0, ms: Math.round(performance.now() - started) };
  } catch (error) {
    return { at, ok: false, error: controller.signal.aborted ? 'timeout' : errorCode(error), ms: Math.round(performance.now() - started) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The hourly health ping. Does nothing (no request, no write) while cmsFleet.wakePing is off or
 * paused. Otherwise GETs /api/cms/health on every CMS site, a few at a time, and stores each result.
 */
export async function wakePing({
  hub,
  settings = null,
  now = Date.now(),
  dataDir,
  fetchImpl = globalThis.fetch,
  timeoutMs = WAKE_TIMEOUT_MS,
  concurrency = 4,
} = {}) {
  const switches = fleetSettings(settings || getAutomationSettings({ dataDir }));
  if (switches.wakePing !== 'on') return { ran: false, reason: switches.wakePing };
  const sites = cmsSites(hub.getAllSites());
  const publicAllowed = !isSafeModeActive() || safeModeAllows('publicRead');
  const at = iso(now);
  const results = {};
  const queue = [...sites];
  const worker = async () => {
    while (queue.length) {
      const site = queue.shift();
      results[site.id] = await pingSite(site, { fetchImpl, timeoutMs, publicAllowed, at });
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, queue.length)) }, worker));
  if (Object.keys(results).length) {
    updateFleetState(dataDir, (state) => {
      for (const [id, wake] of Object.entries(results)) state.sites[id] = { ...(state.sites[id] || {}), wake };
      return state;
    });
  }
  return { ran: true, results };
}

// ---------------------------------------------------------------- background jobs

function startLoop(run, { firstMs, everyMs }) {
  let running = false;
  let stopped = false;
  const tick = async () => {
    if (running || stopped) return;
    running = true;
    try {
      await run();
    } finally {
      running = false;
    }
  };
  const first = setTimeout(tick, firstMs);
  first.unref?.();
  const timer = setInterval(tick, everyMs);
  timer.unref?.();
  return {
    stop() {
      stopped = true;
      clearTimeout(first);
      clearInterval(timer);
    },
    runNow: tick,
  };
}

/** The cmsEnforcement job: checks every 15 minutes whether today's review is due. Returns { stop, runNow }. */
export function startCmsFleetMonitor({ hub, dataDir, log = console, firstMs = 60_000, everyMs = REVIEW_CHECK_EVERY_MS } = {}) {
  return startLoop(async () => {
    try {
      const result = await runFleetReview({ hub, dataDir, log });
      if (result.ran) {
        log?.log?.(`[cms-fleet] review ${result.day}: proposals=${result.proposals.length} mailed=${result.mailed} applied=${result.applied.length}`);
      }
    } catch (error) {
      log?.error?.('[cms-fleet] review failed:', errorText(error));
    }
  }, { firstMs, everyMs });
}

/** The cmsWakePing job: the health ping once an hour. Returns { stop, runNow }. */
export function startCmsWakePing({ hub, dataDir, log = console, firstMs = 120_000, everyMs = WAKE_EVERY_MS } = {}) {
  return startLoop(async () => {
    try {
      const result = await wakePing({ hub, dataDir });
      if (result.ran) {
        const rows = Object.values(result.results);
        log?.log?.(`[cms-fleet] health ping: sites=${rows.length} unreachable=${rows.filter((row) => row.ok === false && !row.skipped).length}`);
      }
    } catch (error) {
      log?.error?.('[cms-fleet] health ping failed:', errorText(error));
    }
  }, { firstMs, everyMs });
}

/** Tests only: forget what this process reviewed. */
export function resetCmsFleetMemoryForTests() {
  reviewedMemo.clear();
}
