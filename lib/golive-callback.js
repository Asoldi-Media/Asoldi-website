// Go-live callback, schema 2 (run.golive.updated from the Maker).
//
// A schema-2 payload is the old payload plus `schema: 2`, `target` (staging or production), a status
// from GOLIVE_STATUSES (the old `ready`, which means "pushed", is read as `pushed`) and
// `liveVerifiedAt`, set only when the Maker verified the live site. It reports status only: plan and
// feature fields in it (websitePlan, features, planSource) are never read.
//
// While the signing switch is off for the client, or the payload has no `schema: 2` (an older Maker),
// the hub handles the callback exactly as before. Otherwise:
//   - makerRun.goLive keeps the latest record per target (a staging record never hides a production
//     one) with liveVerifiedAt;
//   - a needs_import status opens a delivery task for the developer page;
//   - in auto, a verified production `live` sets progression.live and domainConnected, and a client
//     whose hub site is missing gets it from its plan (applySitePlanToHub) instead of a bare site.
import * as hub from '../data/hub.js';
import * as sales from '../data/sales.js';
import { normalizeDelivery } from './delivery-state.js';
import { appendDeliveryAudit } from './delivery-audit.js';
import { signingModeForClient, withSigningLease } from './contract-signing.js';
import { applySitePlanToHub, findSiteForClient } from './site-plan-apply.js';

export const GOLIVE_CALLBACK_SCHEMA = 2;
export const GOLIVE_TARGETS = Object.freeze(['staging', 'production']);
export const GOLIVE_STATUSES = Object.freeze(['pushed', 'deploying', 'needs_import', 'deploy_failed', 'verify_failed', 'live', 'failed']);
// Statuses after which the site's code is in the client repo, so the hub site is linked.
export const GOLIVE_LINK_STATUSES = Object.freeze(['pushed', 'deploying', 'needs_import', 'deploy_failed', 'verify_failed', 'live']);
const LEGACY_STATUS = Object.freeze({ ready: 'pushed' });
export const NEEDS_IMPORT_TASK = 'needs-import';
export const SITE_KEY_TASK = 'site-key-mismatch';

/** `list` with `task` open, or null when that task is open already. */
function withOpenTask(list, task) {
  const rows = (Array.isArray(list) ? list : []).filter(isPlainObject);
  if (rows.some((row) => row.id === task.id && row.status === 'open')) return null;
  return [...rows.filter((row) => row.id !== task.id), task].slice(-20);
}

function text(value, max = 200) {
  return String(value ?? '').trim().slice(0, max);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function iso(value) {
  const raw = text(value, 40);
  return raw && Number.isFinite(Date.parse(raw)) ? new Date(Date.parse(raw)).toISOString() : '';
}

function host(value) {
  return text(value, 253).toLowerCase().replace(/^https?:\/\//, '').split('/')[0];
}

function bounded(value, maxBytes = 2048) {
  if (!isPlainObject(value)) return null;
  try {
    const json = JSON.stringify(value);
    return json.length <= maxBytes ? JSON.parse(json) : null;
  } catch {
    return null;
  }
}

/** The status-only record of a schema-2 payload, or null for any other payload. */
export function normalizeGoLiveCallback(body = {}) {
  if (!isPlainObject(body) || Number(body.schema) !== GOLIVE_CALLBACK_SCHEMA) return null;
  const rawStatus = text(body.status, 40).toLowerCase();
  const status = LEGACY_STATUS[rawStatus] || (GOLIVE_STATUSES.includes(rawStatus) ? rawStatus : '');
  if (!status) return null;
  const target = GOLIVE_TARGETS.includes(text(body.target, 20)) ? text(body.target, 20) : 'production';
  const needsImport = status === 'needs_import'
    ? (bounded(body.needsImport) || { hint: text(body.needsImport || body.error, 300) })
    : null;
  return {
    schema: GOLIVE_CALLBACK_SCHEMA,
    target,
    status,
    liveVerifiedAt: status === 'live' ? iso(body.liveVerifiedAt) : '',
    domain: host(body.domain),
    stagingDomain: host(body.stagingDomain),
    githubRepo: text(body.githubRepo, 200),
    pushedSha: text(body.pushedSha, 64),
    packageVersion: text(body.packageVersion, 40),
    siteKeyFingerprint: text(body.siteKeyFingerprint, 16),
    verify: bounded(body.verify),
    publishGates: bounded(body.publishGates),
    needsImport,
    error: status === 'failed' || status.endsWith('_failed') ? text(body.error, 300) : '',
    runId: text(body.runId, 120),
  };
}

/** makerRun.goLive after one callback: the newest record per target, production on top. */
export function nextGoLiveRecord(current, record, at) {
  const entry = { ...record, at };
  const stored = isPlainObject(current) ? current : null;
  if (record.target === 'staging') {
    if (stored && stored.target === 'production') return { ...stored, staging: entry };
    return entry;
  }
  const staging = stored?.target === 'staging' ? { ...stored, staging: undefined } : stored?.staging;
  const keptLive = stored?.target === 'production' && !entry.liveVerifiedAt ? iso(stored.liveVerifiedAt) : '';
  const next = { ...entry, liveVerifiedAt: entry.liveVerifiedAt || keptLive };
  if (isPlainObject(staging)) {
    const { staging: _nested, ...flat } = staging;
    next.staging = flat;
  }
  return next;
}

function nextTasks(delivery, record, at) {
  const tasks = Array.isArray(delivery.tasks) ? delivery.tasks.filter(isPlainObject) : [];
  const id = `${NEEDS_IMPORT_TASK}:${record.target}`;
  const open = tasks.find((task) => task.id === id && task.status === 'open');
  if (record.status === 'needs_import') {
    if (open) return null;
    const hint = text(record.needsImport?.hint || record.needsImport?.reason || '', 300);
    return [...tasks.filter((task) => task.id !== id), { id, kind: 'needs_import', target: record.target, status: 'open', at, runId: record.runId, hint }].slice(-20);
  }
  if (open && GOLIVE_LINK_STATUSES.includes(record.status) && record.status !== 'needs_import' && record.status !== 'deploy_failed') {
    return tasks.map((task) => (task === open ? { ...task, status: 'done', doneAt: at } : task));
  }
  return null;
}

/**
 * The schema-2 handling for one callback, or null when the hub handles it as before (switch off for
 * the client, or no schema 2). linkSite(hints) links the hub site; record(client) stores the goLive
 * record and its consequences and returns the client.
 */
export function goLiveCallbackV2(body, client, { settings } = {}) {
  const record = normalizeGoLiveCallback(body);
  if (!record || !client?.id) return null;
  const mode = signingModeForClient(client, { settings });
  if (mode === 'off') return null;
  const at = new Date().toISOString();
  // auto: the client's site was made at signing with the hub's own key; a Maker that publishes with
  // another key is flagged for the developer (the site is not duplicated).
  let siteKeyMismatch = false;
  return {
    mode,
    record,
    /** The hub site for this callback: the client's site, its plan's site (auto), or a new bare site. */
    async linkSite({ siteKey = '', domain = '', githubRepo = '', name = '' } = {}) {
      if (!GOLIVE_LINK_STATUSES.includes(record.status) || !(siteKey || domain || mode === 'auto')) return null;
      const latest = sales.getSalesClientById(client.id) || client;
      if (mode === 'auto') {
        const existing = findSiteForClient(latest, { siteKey, domain });
        if (!existing) {
          const applied = await withSigningLease(client.id, () => applySitePlanToHub(client.id, { by: 'golive-callback', siteKey, domain, githubRepo, name }));
          if (applied?.ok && applied.site) {
            appendDeliveryAudit({ kind: 'golive', clientId: client.id, by: 'maker', siteId: applied.site.id, created: applied.created === true, status: record.status, target: record.target });
            return patchLinkedSite(applied.site, githubRepo, { keepRepo: true });
          }
        } else {
          siteKeyMismatch = Boolean(siteKey) && existing.site_key !== siteKey;
          return patchLinkedSite(existing, githubRepo, { keepRepo: true });
        }
      }
      if (!(siteKey || domain)) return null;
      const site = hub.createSite({ name: name || domain || 'New client', domain, site_key: siteKey, githubRepo, deliveryPhase: 'development' });
      return site?.id ? patchLinkedSite(site, githubRepo) : site;
    },
    /** Stores makerRun.goLive, the needs_import task and (auto, production live) the progression. */
    record(current) {
      const live = sales.getSalesClientById(client.id) || current || client;
      const entry = siteKeyMismatch ? { ...record, siteKeyMismatch: true } : record;
      let updated = sales.setSalesMakerRunGoLive(client.id, nextGoLiveRecord(live.makerRun?.goLive, entry, at)) || live;
      const delivery = normalizeDelivery(updated.delivery);
      let tasks = nextTasks(delivery, record, at);
      if (siteKeyMismatch) {
        const task = { id: `${SITE_KEY_TASK}:${record.target}`, kind: 'site_key_mismatch', target: record.target, status: 'open', at, runId: record.runId, hint: 'The Maker published with another site key than the hub site.' };
        tasks = withOpenTask(tasks || delivery.tasks, task) || tasks;
      }
      if (tasks) updated = sales.setSalesDelivery(client.id, { tasks }) || updated;
      const productionLive = record.target === 'production' && record.status === 'live' && Boolean(record.liveVerifiedAt);
      if (mode === 'auto' && productionLive && !(updated.progression?.live && updated.progression?.domainConnected)) {
        updated = sales.updateSalesClient(client.id, { progression: { domainConnected: true, live: true } }) || updated;
        sales.syncSalesDeliveryStage(client.id, { by: 'maker', reason: 'golive' });
        updated = sales.getSalesClientById(client.id) || updated;
      }
      appendDeliveryAudit({ kind: 'golive', clientId: client.id, by: 'maker', mode, target: record.target, status: record.status, live: productionLive });
      return updated;
    },
  };
}

// The old handler's site update (repo and delivery phase). keepRepo leaves a stored repo in place when
// the callback names none.
function patchLinkedSite(site, githubRepo, { keepRepo = false } = {}) {
  const patched = hub.updateSite(site.id, {
    ...(githubRepo || !keepRepo ? { githubRepo } : {}),
    deliveryPhase: site.development?.nettsideFerdig ? 'client' : 'development',
  });
  return patched.ok ? patched.site : site;
}
