// Delivery backfill (WS8.41): gives existing clients and hub sites the delivery data later batches
// rely on, without changing what any client sees.
//
// Steps (each idempotent; a second apply changes nothing):
//   site-plans      client.sitePlan (source `backfill`) for signed website clients, from the
//                   resolver's evidence. SSU clients never get one. Dual offers without a chosen
//                   alternative and clients without evidence are listed, not written.
//   plan-source     hub site planSource {kind:'backfill', tierId, derivedFeatures} for sites linked
//                   to a sales client. Nothing is re-derived: websitePlan and the live flags stay as
//                   they are, and planSource carries no services, so the automatic-post check keeps
//                   reading the site's tier. Differences from the plan are reported as warnings.
//   delivery-stage  the derived stage for signed website clients, and email stamps (with their
//                   legacy mirrors) for clients whose stage is strictly past the last stage at
//                   which that email can still be due, so no new email kind goes to clients past
//                   it and an email that is still due is never marked as sent.
//                   progression.live and domainConnected are never written.
//
// Modes: `dry-run` (default) writes only the report. `apply` takes a delivery snapshot first, then
// applies and writes the report. Reports go to <dataDir>/migrations/ (newest 10 kept). At boot it
// runs only when automation setting migrations.deliveryBackfill is `dry-run` or `apply`; a report
// identical to the last one is not written again. A boot apply is one-time: once any apply has run
// for the current delivery schema version (recorded in the state file), later boots skip it.
// Only applies that changed something add a line to the delivery audit log.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { STAGES } from '../packages/suite/core/delivery/vocab.js';
import { getPersistentDataDir } from '../data/storage-path.js';
import * as sales from '../data/sales.js';
import * as salesOffers from '../data/sales-offers.js';
import * as hub from '../data/hub.js';
import * as portalOffers from '../data/offers.js';
import * as clientPortal from '../data/client-portal.js';
import { getAutomationSettings } from '../data/automation-settings.js';
import { createDeliverySnapshot, DELIVERY_SCHEMA_VERSION } from './delivery-snapshots.js';
import { resolveSitePlan } from './site-plan.js';
import { normalizeSitePlan } from './site-plan-model.js';
import { deliveryEmailStamps, normalizeDelivery, planStageWrite } from './delivery-state.js';
import { featuresFromServices } from './website-tiers.js';
import { appendDeliveryAudit } from './delivery-audit.js';

export const BACKFILL_NAME = 'delivery-backfill';
export const BACKFILL_REPORT_VERSION = 1;
export const BACKFILL_STEPS = Object.freeze(['site-plans', 'plan-source', 'delivery-stage']);
export const MIGRATIONS_DIR = 'migrations';
export const BACKFILL_STATE_FILE = `${BACKFILL_NAME}-state.json`;
export const BACKFILL_REPORTS_KEEP = 10;

// The last stage at which each email can still be due. A key is stamped only for a client whose
// stage is strictly past it: a client in `gathering` because a workshop is booked still gets the
// pre-workshop email. Legacy live clients (live through the old go-live flow) count as past the
// site-live email; a verified go-live at `live` still has it due.
export const PRESTAMP_AFTER_STAGE = Object.freeze({
  preWorkshopSentAt: 'gathering',
  postWorkshopSentAt: 'gate',
  previewReadySentAt: 'client_preview',
  stagingReadySentAt: 'publishing',
  siteLiveSentAt: 'live',
});

/** The email keys to pre-stamp for a derived stage ({stage, subState}), skipping keys already sent. */
export function prestampKeys(derived = {}, sent = {}) {
  const at = STAGES.indexOf(derived?.stage);
  if (at < 0) return [];
  const legacyLive = derived.subState === 'legacy' && at >= STAGES.indexOf('live');
  return Object.entries(PRESTAMP_AFTER_STAGE)
    .filter(([key, after]) => !sent?.[key] && (at > STAGES.indexOf(after) || (legacyLive && key === 'siteLiveSentAt')))
    .map(([key]) => key);
}

function text(value = '') {
  return String(value ?? '').trim();
}

function isWebsiteClient(client) {
  return text(client?.product).toLowerCase() !== 'ssu';
}

function isSigned(client) {
  return client?.progression?.contractSigned === true;
}

function hostOf(value = '') {
  return text(value).toLowerCase().replace(/^https?:\/\//, '').split('/')[0].replace(/^www\./, '');
}

/** The hub site linked to a sales client: by hubSite.id, then site key, then domain. */
export function hubSiteForClient(client = {}, sites = []) {
  const link = client?.hubSite || {};
  const list = Array.isArray(sites) ? sites : [];
  if (text(link.id)) {
    const byId = list.find((site) => text(site?.id) === text(link.id));
    if (byId) return byId;
  }
  if (text(link.siteKey)) {
    const byKey = list.find((site) => text(site?.site_key) === text(link.siteKey));
    if (byKey) return byKey;
  }
  const domain = hostOf(link.domain);
  if (domain) return list.find((site) => hostOf(site?.domain) === domain) || null;
  return null;
}

/** The portal profile linked to a sales client (portal ids, then the website builder link). */
export function profileForClient(client = {}, profiles = []) {
  const list = Array.isArray(profiles) ? profiles : [];
  const businessId = text(client?.portalBusinessId);
  const userId = text(client?.portalUserId);
  return list.find((profile) => businessId && text(profile?.businessId) === businessId)
    || list.find((profile) => userId && text(profile?.userId) === userId)
    || list.find((profile) => text(profile?.websiteBuilder?.salesClientId) === text(client?.id))
    || null;
}

function flagDiff(expected = {}, actual = {}) {
  return Object.keys(expected).filter((flag) => Boolean(expected[flag]) !== Boolean(actual?.[flag]));
}

/**
 * Plans every step without writing. Inputs are plain arrays (the stores' records); `now` is an ISO
 * time. Returns { sitePlans, planSources, emailStamps, stages, report }.
 */
export function planDeliveryBackfill({
  clients = [],
  offers = [],
  portalOffers: portal = [],
  sites = [],
  profiles = [],
  now = new Date().toISOString(),
  oneTimeMonths = 6,
  steps = BACKFILL_STEPS,
} = {}) {
  const wanted = new Set(steps);
  const nowMs = Date.parse(now) || Date.now();
  const sitePlans = [];
  const needsChoice = [];
  const noEvidence = [];
  const planSources = [];
  const emailStamps = [];
  const stages = [];
  const counts = {
    clients: clients.length,
    websiteClients: 0,
    ssuClients: 0,
    signedWebsiteClients: 0,
    signedSsuClients: 0,
    sitePlans: { write: 0, existing: 0, needsChoice: 0, needsConfirmation: 0, noEvidence: 0, withConflicts: 0 },
    planSources: { write: 0, existing: 0, linkedSites: 0, unlinkedSites: 0, tierMismatches: 0, flagMismatches: 0 },
    stages: { write: 0, unchanged: 0 },
    emailStamps: { clients: 0, keys: 0 },
  };
  const plannedPlans = new Map();

  for (const client of clients) {
    if (!isWebsiteClient(client)) {
      counts.ssuClients += 1;
      if (isSigned(client)) counts.signedSsuClients += 1;
      continue;
    }
    counts.websiteClients += 1;
    if (!isSigned(client)) continue;
    counts.signedWebsiteClients += 1;
    if (normalizeSitePlan(client.sitePlan)) {
      counts.sitePlans.existing += 1;
      continue;
    }
    const hubSite = hubSiteForClient(client, sites);
    const profile = profileForClient(client, profiles);
    const resolved = resolveSitePlan(client, {
      offers,
      portalOffers: portal,
      hubSite,
      profile,
      bank: profile?.clientDataBank || {},
      now,
      oneTimeMonths,
    });
    if (resolved.needsChoice) {
      counts.sitePlans.needsChoice += 1;
      needsChoice.push({ clientId: client.id, offerId: resolved.offerId || '', evidence: resolved.evidence });
      continue;
    }
    if (!resolved.plan) {
      counts.sitePlans.noEvidence += 1;
      noEvidence.push({ clientId: client.id, reason: resolved.skipped });
      continue;
    }
    plannedPlans.set(client.id, resolved.plan);
    if (resolved.needsConfirmation) counts.sitePlans.needsConfirmation += 1;
    if (resolved.conflicts.length) counts.sitePlans.withConflicts += 1;
    if (wanted.has('site-plans')) {
      counts.sitePlans.write += 1;
      sitePlans.push({
        clientId: client.id,
        plan: resolved.plan,
        evidence: resolved.evidence,
        tierId: resolved.plan.tierId,
        services: resolved.plan.services,
        needsConfirmation: resolved.needsConfirmation,
        conflicts: resolved.conflicts.map((conflict) => ({ source: conflict.source, tierId: conflict.tierId })),
        unknownLines: (resolved.unknownLines || []).length,
      });
    }
  }

  // Hub sites linked to a sales client.
  const linkedSiteIds = new Set();
  for (const client of clients) {
    if (!isWebsiteClient(client)) continue;
    const site = hubSiteForClient(client, sites);
    if (!site || linkedSiteIds.has(site.id)) continue;
    linkedSiteIds.add(site.id);
    counts.planSources.linkedSites += 1;
    if (site.planSource && typeof site.planSource === 'object') {
      counts.planSources.existing += 1;
      continue;
    }
    const plan = plannedPlans.get(client.id) || normalizeSitePlan(client.sitePlan);
    const warnings = [];
    if (plan && plan.tierId !== site.websitePlan) {
      counts.planSources.tierMismatches += 1;
      warnings.push({ kind: 'tier', site: site.websitePlan, plan: plan.tierId });
    }
    const flags = plan ? flagDiff(featuresFromServices(plan.services), site.features) : [];
    if (flags.length) {
      counts.planSources.flagMismatches += 1;
      warnings.push({ kind: 'flags', flags });
    }
    if (wanted.has('plan-source')) {
      counts.planSources.write += 1;
      planSources.push({
        siteId: site.id,
        clientId: client.id,
        planSource: {
          kind: 'backfill',
          salesClientId: client.id,
          tierId: site.websitePlan,
          derivedFeatures: { ...site.features },
          appliedAt: now,
          appliedBy: 'backfill',
        },
        warnings,
      });
    }
  }
  counts.planSources.unlinkedSites = sites.filter((site) => !linkedSiteIds.has(site.id)).length;

  // Stages and email stamps (signed website clients), on the clients as they will be after the
  // plan step.
  if (wanted.has('delivery-stage')) {
    for (const client of clients) {
      if (!isWebsiteClient(client) || !(isSigned(client) || normalizeSitePlan(client.sitePlan))) continue;
      const planned = plannedPlans.get(client.id);
      const working = planned ? { ...client, sitePlan: planned } : client;
      const before = planStageWrite(working, { now: nowMs, by: 'backfill', reason: 'backfill' });
      const stage = before.derived?.stage;
      if (!stage) continue;
      const keys = prestampKeys(before.derived, deliveryEmailStamps(working));
      if (keys.length) {
        counts.emailStamps.clients += 1;
        counts.emailStamps.keys += keys.length;
        emailStamps.push({ clientId: client.id, keys, stage });
      }
      if (before.changed) {
        counts.stages.write += 1;
        stages.push({
          clientId: client.id,
          from: normalizeDelivery(client.delivery).stage || null,
          to: stage,
          overlay: before.derived.overlay || '',
          subState: before.derived.subState || '',
        });
      } else {
        counts.stages.unchanged += 1;
      }
    }
  }

  const report = {
    kind: BACKFILL_NAME,
    version: BACKFILL_REPORT_VERSION,
    codeSchemaVersion: DELIVERY_SCHEMA_VERSION,
    steps: [...wanted],
    counts,
    sitePlans: sitePlans.map(({ plan: _plan, ...rest }) => rest),
    needsChoice,
    noEvidence,
    planSources: planSources.map(({ planSource, ...rest }) => ({ ...rest, tierId: planSource.tierId })),
    emailStamps,
    stages,
  };
  return { sitePlans, planSources, emailStamps, stages, report };
}

/** Hash of what a report would change (ignores times), to skip identical boot reports. */
export function reportFingerprint(report = {}) {
  const body = JSON.stringify({
    steps: report.steps,
    counts: report.counts,
    sitePlans: report.sitePlans,
    needsChoice: report.needsChoice,
    noEvidence: report.noEvidence,
    planSources: (report.planSources || []).map(({ siteId, clientId, tierId, warnings }) => ({ siteId, clientId, tierId, warnings })),
    emailStamps: report.emailStamps,
    stages: report.stages,
    mode: report.mode,
  });
  return createHash('sha256').update(body).digest('hex').slice(0, 24);
}

function migrationsDir(dataDir) {
  return join(dataDir || getPersistentDataDir(), MIGRATIONS_DIR);
}

function readState(dataDir) {
  const file = join(migrationsDir(dataDir), BACKFILL_STATE_FILE);
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** Merges `patch` into the state file (keys not in the patch are kept). */
function writeState(dataDir, patch) {
  const dir = migrationsDir(dataDir);
  mkdirSync(dir, { recursive: true });
  const state = { ...readState(dataDir), ...patch };
  writeFileSync(join(dir, BACKFILL_STATE_FILE), `${JSON.stringify(state, null, 2)}\n`);
}

/** The last apply ({at, by, codeSchemaVersion, file}) recorded in the state file, or null. */
export function lastBackfillApply({ dataDir } = {}) {
  const last = readState(dataDir).lastApply;
  return last && typeof last === 'object' && last.at ? last : null;
}

function pruneReports(dataDir) {
  const dir = migrationsDir(dataDir);
  if (!existsSync(dir)) return;
  const reports = readdirSync(dir).filter((name) => name.startsWith(`${BACKFILL_NAME}-2`) && name.endsWith('.json')).sort();
  for (const name of reports.slice(0, Math.max(0, reports.length - BACKFILL_REPORTS_KEEP))) {
    rmSync(join(dir, name), { force: true });
  }
}

export function listBackfillReports({ dataDir } = {}) {
  const dir = migrationsDir(dataDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.startsWith(`${BACKFILL_NAME}-2`) && name.endsWith('.json'))
    .sort()
    .reverse();
}

export function readBackfillReport(name, { dataDir } = {}) {
  if (!/^delivery-backfill-[0-9tz]+(?:-[a-z-]+)?\.json$/i.test(String(name || ''))) return null;
  const file = join(migrationsDir(dataDir), name);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function stampFor(now) {
  return new Date(now).toISOString().replace(/[:.]/g, '').replace(/[^0-9tz]/gi, '').toLowerCase();
}

/** Reads the live stores (through the data modules) into the planner's inputs. */
export function loadBackfillInputs() {
  return {
    clients: sales.getSalesClients(),
    offers: salesOffers.listSalesOffers(),
    portalOffers: portalOffers.listOffers(),
    sites: hub.getAllSites(),
    profiles: clientPortal.listClientProfiles(),
  };
}

function hasChanges(planned) {
  return planned.sitePlans.length + planned.planSources.length + planned.emailStamps.length + planned.stages.length > 0;
}

/**
 * Runs the backfill on the stores. mode `dry-run` (default) or `apply`. Writes the report unless
 * `writeReport:false` or (`skipUnchanged`) it equals the last one. Returns the report.
 */
export function runDeliveryBackfill({
  mode = 'dry-run',
  dataDir,
  by = 'backfill',
  now = new Date().toISOString(),
  steps = BACKFILL_STEPS,
  writeReport = true,
  skipUnchanged = false,
  inputs = null,
  oneTimeMonths,
} = {}) {
  const apply = mode === 'apply';
  const settings = getAutomationSettings({ dataDir, fresh: true });
  const months = Number(oneTimeMonths) > 0 ? Number(oneTimeMonths) : Number(settings?.pricing?.oneTimeMonths) || 6;
  const planned = planDeliveryBackfill({ ...(inputs || loadBackfillInputs()), now, oneTimeMonths: months, steps });
  const report = { ...planned.report, mode: apply ? 'apply' : 'dry-run', by, startedAt: now };

  if (apply && hasChanges(planned)) {
    const snapshot = createDeliverySnapshot({ dataDir, label: 'backfill', reason: `delivery backfill by ${by}` });
    report.snapshotId = snapshot.id;
    const applied = { sitePlans: 0, planSources: 0, emailStamps: 0, stages: 0, errors: [] };
    for (const entry of planned.sitePlans) {
      const updated = sales.setSalesSitePlan(entry.clientId, entry.plan, { by, reason: `backfill:${entry.evidence}`, now });
      if (updated) applied.sitePlans += 1;
      else applied.errors.push({ step: 'site-plans', clientId: entry.clientId });
    }
    for (const entry of planned.planSources) {
      const result = hub.setSitePlanSource(entry.siteId, entry.planSource);
      if (result.ok) applied.planSources += 1;
      else applied.errors.push({ step: 'plan-source', siteId: entry.siteId });
    }
    for (const entry of planned.emailStamps) {
      const stamps = Object.fromEntries(entry.keys.map((key) => [key, now]));
      if (sales.stampDeliveryEmails(entry.clientId, stamps, { by, backfilled: true })) applied.emailStamps += 1;
    }
    if (steps.includes('delivery-stage')) {
      for (const client of sales.getSalesClients()) {
        if (!isWebsiteClient(client) || !(isSigned(client) || normalizeSitePlan(client.sitePlan))) continue;
        const result = sales.syncSalesDeliveryStage(client.id, { by, reason: 'backfill', now: Date.parse(now) || Date.now() });
        if (result.changed) applied.stages += 1;
      }
    }
    report.applied = applied;
    // Idempotence check: planning again on the written stores finds nothing left to do.
    const again = planDeliveryBackfill({ ...loadBackfillInputs(), now, oneTimeMonths: months, steps });
    report.remaining = {
      sitePlans: again.sitePlans.length,
      planSources: again.planSources.length,
      emailStamps: again.emailStamps.length,
      stages: again.stages.length,
    };
  }
  report.finishedAt = new Date().toISOString();
  report.fingerprint = reportFingerprint(report);

  if (writeReport) {
    const state = readState(dataDir);
    // At boot an identical report is not written again, and neither is an apply run that found
    // nothing left to do after an earlier apply (its report already says what was applied).
    const nothingLeft = report.mode === 'apply' && state.lastMode === 'apply' && !hasChanges(planned);
    const same = skipUnchanged && !report.applied && (state.lastFingerprint === report.fingerprint || nothingLeft);
    if (!same) {
      const dir = migrationsDir(dataDir);
      mkdirSync(dir, { recursive: true });
      const name = `${BACKFILL_NAME}-${stampFor(now)}-${report.mode}.json`;
      writeFileSync(join(dir, name), `${JSON.stringify(report, null, 2)}\n`);
      report.file = name;
      pruneReports(dataDir);
      writeState(dataDir, {
        lastFingerprint: report.fingerprint,
        lastReport: name,
        lastMode: report.mode,
        lastRunAt: report.finishedAt,
      });
    } else {
      report.file = state.lastReport || '';
      report.unchanged = true;
    }
  }
  const previousApply = apply ? lastBackfillApply({ dataDir }) : null;
  if (apply && (report.applied || !previousApply || Number(previousApply.codeSchemaVersion) < DELIVERY_SCHEMA_VERSION)) {
    // Recorded for every apply (route, script or boot) that changed something, and for the first
    // one per schema version: a boot apply runs once per schema version.
    writeState(dataDir, {
      lastApply: {
        at: report.finishedAt,
        by,
        codeSchemaVersion: DELIVERY_SCHEMA_VERSION,
        changed: Boolean(report.applied),
        snapshotId: report.snapshotId || '',
        file: report.file || '',
      },
    });
  }
  // The audit log records writes: only an apply that changed something adds a line (the writers
  // add their own per-client lines). Dry runs leave the log alone.
  if (report.applied) {
    appendDeliveryAudit({
      kind: 'backfill',
      by,
      mode: report.mode,
      sitePlans: report.applied.sitePlans,
      planSources: report.applied.planSources,
      emailStamps: report.applied.emailStamps,
      stages: report.applied.stages,
      snapshotId: report.snapshotId || '',
    }, { dataDir });
  }
  return report;
}

/**
 * Boot hook: runs only when migrations.deliveryBackfill is `dry-run` or `apply`. With the default
 * `off` it reads the settings and returns; nothing is written. `apply` is one-time: when an apply
 * (from any caller) is already recorded for the current delivery schema version, the boot skips it,
 * so restarts never re-plan clients that progressed since.
 */
export function runDeliveryBackfillAtBoot({ dataDir, now = new Date().toISOString() } = {}) {
  const settings = getAutomationSettings({ dataDir, fresh: true });
  const mode = settings?.migrations?.deliveryBackfill || 'off';
  if (mode !== 'dry-run' && mode !== 'apply') return { skipped: 'off' };
  if (mode === 'apply') {
    const last = lastBackfillApply({ dataDir });
    if (last && Number(last.codeSchemaVersion) >= DELIVERY_SCHEMA_VERSION) {
      console.log(
        `[delivery] backfill apply skipped: already applied at ${last.at} by ${last.by || 'unknown'} `
        + '(one-time; set migrations.deliveryBackfill to off)',
      );
      return { skipped: 'applied', lastApply: last };
    }
  }
  const report = runDeliveryBackfill({ mode, dataDir, by: 'boot', now, skipUnchanged: true });
  const counts = report.counts || {};
  console.log(
    `[delivery] backfill ${report.mode}${report.unchanged ? ' (unchanged, no new report)' : ''}: `
    + `sitePlans ${report.applied?.sitePlans ?? counts.sitePlans?.write ?? 0}, `
    + `planSources ${report.applied?.planSources ?? counts.planSources?.write ?? 0}, `
    + `stages ${report.applied?.stages ?? counts.stages?.write ?? 0}`
    + `${report.file ? ` -> ${MIGRATIONS_DIR}/${report.file}` : ''}`,
  );
  return report;
}
