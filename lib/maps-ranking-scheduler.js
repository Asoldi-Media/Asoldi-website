import * as clientPortal from '../data/client-portal.js';
import { mapsRankingIntervalMs } from './maps-ranking.js';
import {
  analyticsAccessFor,
  ensureMapsRanking,
  findHubSiteForProfile,
} from './client-analytics-service.js';
import { buildMapsSubject } from './maps-ranking.js';
import { getMapsRankingRecord } from '../data/client-analytics.js';
import { isDataForSeoMapsConfigured } from './dataforseo-maps.js';

let running = false;
let timer = null;

function due(record, intervalMs, now = Date.now()) {
  const last = Date.parse(record?.lastRunAt || '');
  if (!Number.isFinite(last)) return true;
  return now - last >= intervalMs;
}

export async function runDueMapsRankingJobs({ limit = 1 } = {}) {
  if (!isDataForSeoMapsConfigured()) return { ran: 0, skipped: 'not-configured' };
  const intervalMs = mapsRankingIntervalMs();
  const profiles = clientPortal.listClientProfiles();
  let ran = 0;
  for (const profile of profiles) {
    if (ran >= limit) break;
    const hubSite = findHubSiteForProfile(profile);
    const access = analyticsAccessFor(profile, hubSite);
    if (!access.allowed) continue;
    const subject = buildMapsSubject(profile, hubSite || {});
    if (!subject.address && !subject.town) continue;
    const id = subject.businessId || subject.siteKey;
    if (!id) continue;
    if (!due(getMapsRankingRecord(id), intervalMs)) continue;
    await ensureMapsRanking(profile, hubSite, { force: true });
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
