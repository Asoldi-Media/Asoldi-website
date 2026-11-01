import * as clientPortal from '../data/client-portal.js';
import { mapsRankingIntervalMs } from './maps-ranking.js';
import {
  ensureMapsRanking,
  findHubSiteForProfile,
  mapsRankingGate,
} from './client-analytics-service.js';
import { buildMapsSubject } from './maps-ranking.js';
import { getMapsRankingRecord } from '../data/client-analytics.js';
import { isDataForSeoMapsConfigured } from './dataforseo-maps.js';
import { seoScheduler } from './seo-ops/schedulers.js';

// The Maps gate lives next to ensureMapsRanking, which also applies it in auto.
export { mapsRankingGate, mapsRankingGateInput } from './client-analytics-service.js';

let running = false;
let timer = null;

function due(record, intervalMs, now = Date.now()) {
  const last = Date.parse(record?.lastRunAt || '');
  if (!Number.isFinite(last)) return true;
  return now - last >= intervalMs;
}

/**
 * One pass of the Maps loop: ranks up to `limit` due profiles. In hub safe mode only sites the
 * seo-ops scheduler registry allows run, and their DataForSEO calls replay recorded fixtures unless
 * the registry says live (lib/seo-ops/schedulers.js); with safe mode off everything is as before.
 */
export async function runDueMapsRankingJobs({ limit = 1, settings = null, scheduler = null } = {}) {
  if (!isDataForSeoMapsConfigured()) return { ran: 0, skipped: 'not-configured' };
  const registry = scheduler || seoScheduler('rank-tracker.maps');
  const intervalMs = mapsRankingIntervalMs();
  const profiles = clientPortal.listClientProfiles();
  let ran = 0;
  for (const profile of profiles) {
    if (ran >= limit) break;
    const hubSite = findHubSiteForProfile(profile);
    if (!mapsRankingGate(profile, hubSite, { settings }).allowed) continue;
    const subject = buildMapsSubject(profile, hubSite || {});
    if (!subject.address && !subject.town) continue;
    const id = subject.businessId || subject.siteKey;
    if (!id) continue;
    const plan = registry.planFor(subject.siteKey || id);
    if (!plan.run) continue;
    if (!due(getMapsRankingRecord(id), intervalMs)) continue;
    await ensureMapsRanking(profile, hubSite, plan.fetchImpl ? { force: true, fetchImpl: plan.fetchImpl, settings } : { force: true, settings });
    ran += 1;
  }
  return { ran };
}

export function startMapsRankingLoop({ intervalMs = 60 * 60 * 1000 } = {}) {
  if (timer) return;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const result = await runDueMapsRankingJobs({ limit: 1 });
      if (result.ran) console.log(`[analytics] maps ranking ran=${result.ran}`);
    } catch (error) {
      console.error('[analytics] maps ranking tick failed', error);
    } finally {
      running = false;
    }
  };
  timer = setInterval(() => {
    tick().catch((error) => console.error('[analytics] maps ranking loop', error));
  }, intervalMs);
  setTimeout(() => tick().catch(() => {}), 20_000);
}
