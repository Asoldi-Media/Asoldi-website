/**
 * The hub wakes every client CMS whose email is on: POST https://<site domain>/api/cms/email/tick,
 * signed with the site's emailKey (lib/email-hint.js postCmsTick). The CMS then runs its email
 * tick, so due mail goes out on time even when its host lets an idle app sleep. The CMS runs the
 * tick at most once a minute, whoever calls.
 *
 * A site is woken when the email platform is on, the kill switch is off, the rollout lists the
 * site and its key is confirmed. Four calls run at a time, each with a 10 s limit. Failed wakes
 * are counted per site in memory (three in a row are logged once). Nothing here writes a file
 * while there is no site to wake, and the lease 'email-wake' keeps two hub workers from waking
 * the same sites at once.
 */
import { acquireLease, readEmailSettings } from '../data/email-store.js';
import { postCmsTick } from './email-hint.js';
import { currentEmailKey, emailPlatformEnabled, siteInRollout } from './email-site-auth.js';

export const WAKE_EVERY_MS = 5 * 60_000;
export const WAKE_CONCURRENCY = 4;
const WAKE_LEASE_MS = 4 * 60_000;
const FAILURES_LOGGED_AT = 3;

function clean(value, max = 200) {
  return String(value ?? '').trim().slice(0, max);
}

/** The sites a wake goes to now (platform on, kill switch off, in the rollout, key confirmed). */
export function sitesToWake(sites = [], settings = readEmailSettings()) {
  if (!emailPlatformEnabled(settings) || settings?.killSwitch === true) return [];
  return (Array.isArray(sites) ? sites : []).filter((site) => site?.id && siteInRollout(site.id, settings) && currentEmailKey(site.id));
}

/**
 * Wakes sites. Options: getAllSites, now, fetchImpl, env, settings, log, lease (false skips the
 * lease, for one site woken by hand), only (a site id). Resolves { ran, results: [{ siteId, ok,
 * status?, reason?, answer? }] }; ran is false when there was nothing to do or another worker
 * holds the lease. Never throws.
 */
export function createEmailWake({ getAllSites, log = console } = {}) {
  const failures = new Map();

  function note(siteId, result) {
    if (result.ok) {
      failures.delete(siteId);
      return;
    }
    const count = (failures.get(siteId) || 0) + 1;
    failures.set(siteId, count);
    if (count === FAILURES_LOGGED_AT) log.warn?.(`[email-wake] ${siteId}: ${count} wakes in a row failed (${result.reason || result.status || 'error'})`);
  }

  async function wake({ now = Date.now(), fetchImpl, env = process.env, settings = null, lease = true, only = '' } = {}) {
    let cfg;
    let targets;
    try {
      cfg = settings || readEmailSettings();
      const all = typeof getAllSites === 'function' ? getAllSites() : [];
      targets = sitesToWake(only ? all.filter((site) => String(site?.id) === clean(only, 80)) : all, cfg);
    } catch (error) {
      log.warn?.(`[email-wake] sites could not be read: ${error?.code || 'error'}`);
      return { ran: false, results: [] };
    }
    if (!targets.length) return { ran: false, results: [] };
    let held = null;
    if (lease) {
      held = await acquireLease('email-wake', WAKE_LEASE_MS).catch(() => null);
      if (!held) return { ran: false, results: [], busy: true };
    }
    try {
      const results = [];
      const queue = [...targets];
      const worker = async () => {
        for (let site = queue.shift(); site; site = queue.shift()) {
          let result;
          try {
            result = await postCmsTick(site, { now, settings: cfg, env, log, ...(fetchImpl ? { fetchImpl } : {}) });
          } catch {
            result = { ok: false, reason: 'error' };
          }
          note(String(site.id), result);
          results.push({ siteId: String(site.id), ...result });
        }
      };
      await Promise.all(Array.from({ length: Math.min(WAKE_CONCURRENCY, targets.length) }, worker));
      return { ran: true, results };
    } finally {
      if (held) await held.release().catch(() => {});
    }
  }

  return {
    wake,
    /** Consecutive failed wakes per site id (memory of this process). */
    failures: () => Object.fromEntries(failures),
  };
}
