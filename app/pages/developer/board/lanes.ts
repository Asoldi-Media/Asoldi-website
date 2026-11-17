import type { BoardItem, BoardSnapshot } from './types';

export const LANES = [
  { key: 'preview', title: 'Preview (før signering)' },
  { key: 'signed', title: 'Signert / Innsamling' },
  { key: 'workshop', title: 'Workshop' },
  { key: 'waiting-info', title: 'Venter på info' },
  { key: 'development', title: 'Utvikling' },
  { key: 'review', title: 'Til gjennomgang' },
  { key: 'at-client', title: 'Hos kunde' },
  { key: 'iteration', title: 'Iterasjon' },
  { key: 'approved', title: 'Godkjent / Publisering' },
  { key: 'live', title: 'Live' },
] as const;

export const FALLBACK_LANE = { key: 'unknown', title: 'Ukjent steg' };

const STAGE_LANE: Record<string, string> = {
  lead: 'preview',
  sales_meeting: 'preview',
  offer_sent: 'preview',
  signed: 'signed',
  gathering: 'signed',
  workshop_held: 'workshop',
  gate: 'waiting-info',
  developing: 'development',
  dev_review: 'review',
  client_preview: 'at-client',
  iterating: 'iteration',
  approved: 'approved',
  publishing: 'approved',
  live: 'live',
  maintenance: 'live',
  handed_over: 'live',
};

export type LaneKey = (typeof LANES)[number]['key'] | typeof FALLBACK_LANE.key;

export type BoardParts = {
  development: BoardItem[];
  preview: BoardItem[];
  ssu: BoardItem[];
};

/** Delivery stage the board item carries. Empty when the item has none. */
export function stageOf(item: BoardItem): string {
  return String(item?.deliveryStage || item?.delivery?.stage || '').trim();
}

/** Lane key for a stage name. An unknown stage uses the fallback lane. */
export function laneKeyForStage(stage: string): LaneKey {
  const key = STAGE_LANE[String(stage || '').trim()];
  return (key as LaneKey) || FALLBACK_LANE.key;
}

/** Lane descriptor for one item. */
export function laneForItem(item: BoardItem): { key: string; title: string } {
  const key = laneKeyForStage(stageOf(item));
  return LANES.find((lane) => lane.key === key) || FALLBACK_LANE;
}

/** Sales client id used in card test ids and client routes. */
export function clientIdOf(item: BoardItem): string {
  const sales = String(item?.salesClientId || '').trim();
  if (sales) return sales;
  return String(item?.id || '').replace(/^sales:/, '');
}

/** Tier id shown on the card. */
export function tierOf(item: BoardItem): string {
  return String(item?.sitePlan?.tierId || item?.offerTierId || '').trim();
}

/** Services on the plan, when the item has a plan. */
export function servicesOf(item: BoardItem): string[] {
  const list = item?.sitePlan?.services;
  return Array.isArray(list) ? list.map((entry) => String(entry || '').trim()).filter(Boolean) : [];
}

/** Due instant in ms, or +Infinity when the item has no due date. */
export function dueMs(item: BoardItem): number {
  const raw = item?.websiteDue?.dueAt || item?.websiteDue?.effectiveDate || item?.rankAt || '';
  const ms = Date.parse(String(raw));
  return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY;
}

/** Soonest due date first. Items without a due date stay last, then by name. */
export function sortByDue(items: BoardItem[]): BoardItem[] {
  return [...items].sort((a, b) => {
    const delta = dueMs(a) - dueMs(b);
    if (delta !== 0) return delta;
    return String(a.businessName || '').localeCompare(String(b.businessName || ''), 'nb');
  });
}

/** Blocking codes already on the item (job code, plus any list the item carries). */
export function blockingCodesOf(item: BoardItem): string[] {
  const codes: string[] = [];
  const job = String(item?.delivery?.job?.blocking || '').trim();
  if (job) codes.push(job);
  if (Array.isArray(item?.blocking)) {
    for (const code of item.blocking) {
      const text = String(code || '').trim();
      if (text) codes.push(text);
    }
  }
  return [...new Set(codes)];
}

/** True when the job or the gate summary says the card is blocked. */
export function isBlocked(item: BoardItem): boolean {
  if (blockingCodesOf(item).length > 0) return true;
  const count = item?.delivery?.gate?.blocking;
  return typeof count === 'number' && count > 0;
}

function loopbackHost(host: string): boolean {
  const name = String(host || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!name || name === 'localhost' || name === '::1' || name === '0.0.0.0') return true;
  const parts = name.split('.');
  return parts.length === 4 && parts[0] === '127';
}

/**
 * Maker origin from the item's port and the page hostname.
 * A loopback page hostname yields '' so the UI never builds a loopback URL.
 */
export function makerOrigin(makerPort: unknown, pageHostname: string): string {
  const port = Number(makerPort);
  const host = String(pageHostname || '').trim();
  if (!Number.isInteger(port) || port < 1 || port > 65535) return '';
  if (loopbackHost(host)) return '';
  return `https://${host}:${port}`;
}

/** Public site admin link for payment setup. Empty when the domain is missing or loopback. */
export function stagingCmsHref(item: BoardItem): string {
  const domain = String(item?.websiteDomain || item?.hubSite?.domain || '').trim().replace(/^https?:\/\//i, '').split('/')[0];
  if (!domain || loopbackHost(domain)) return '';
  return `https://${domain}/admin`;
}

export function dueLabel(item: BoardItem): string {
  const label = String(item?.websiteDue?.label || '').trim();
  if (label) return label;
  const raw = item?.websiteDue?.dueAt || item?.websiteDue?.effectiveDate || '';
  if (!raw) return 'Ingen frist';
  const ms = Date.parse(String(raw));
  if (!Number.isFinite(ms)) return 'Ingen frist';
  return new Date(ms).toLocaleDateString('nb-NO', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function partitionBoard(snapshot: BoardSnapshot | null | undefined): BoardParts {
  const preview = Array.isArray(snapshot?.previewItems) ? snapshot.previewItems : [];
  const ssu = Array.isArray(snapshot?.ssuItems) ? snapshot.ssuItems : [];
  const previewIds = new Set(preview.map((item) => item.id));
  const ssuIds = new Set(ssu.map((item) => item.id));
  const development = Array.isArray(snapshot?.developmentItems)
    ? snapshot.developmentItems
    : (Array.isArray(snapshot?.items) ? snapshot.items : []).filter((item) => !previewIds.has(item.id) && !ssuIds.has(item.id) && item.product !== 'ssu');
  return {
    development: development.filter((item) => !ssuIds.has(item.id)),
    preview,
    ssu,
  };
}

function upsert(list: BoardItem[], item: BoardItem, removed: Set<string>): BoardItem[] {
  if (removed.has(item.id)) return list.filter((row) => row.id !== item.id);
  const index = list.findIndex((row) => row.id === item.id);
  if (index === -1) return [...list, item];
  const next = list.slice();
  next[index] = { ...list[index], ...item };
  return next;
}

function drop(list: BoardItem[], removed: Set<string>): BoardItem[] {
  return removed.size ? list.filter((item) => !removed.has(item.id)) : list;
}

/**
 * Folds a board-status body into the three lists. Changed rows replace the same id.
 * A new row lands in SSU, preview, or the development list from fields the row already has.
 */
export function applyBoardStatus(parts: BoardParts, body: BoardSnapshot): BoardParts {
  const removed = new Set((Array.isArray(body?.removed) ? body.removed : []).map((id) => String(id)));
  let development = drop(parts.development, removed);
  let preview = drop(parts.preview, removed);
  let ssu = drop(parts.ssu, removed);
  if (Array.isArray(body?.previewItems)) preview = body.previewItems;
  if (Array.isArray(body?.ssuItems)) ssu = body.ssuItems;
  const changed = Array.isArray(body?.items) ? body.items : [];
  for (const item of changed) {
    if (!item?.id || removed.has(item.id)) continue;
    if (ssu.some((row) => row.id === item.id) || item.product === 'ssu') {
      ssu = upsert(ssu, item, removed);
      development = development.filter((row) => row.id !== item.id);
      preview = preview.filter((row) => row.id !== item.id);
      continue;
    }
    if (preview.some((row) => row.id === item.id)) {
      preview = upsert(preview, item, removed);
      continue;
    }
    if (development.some((row) => row.id === item.id)) {
      development = upsert(development, item, removed);
      continue;
    }
    const stage = stageOf(item);
    const previewStage = !stage || laneKeyForStage(stage) === 'preview';
    if (item.contractSigned === false && previewStage) preview = [...preview, item];
    else development = [...development, item];
  }
  return { development, preview, ssu };
}

export type BoardFilters = {
  mine: boolean;
  tier: string;
  blocked: boolean;
  ownerKey: string;
};

function keep(item: BoardItem, filters: BoardFilters): boolean {
  if (filters.mine && String(item.developerOwnerId || '') !== filters.ownerKey) return false;
  if (filters.tier && tierOf(item) !== filters.tier) return false;
  if (filters.blocked && !isBlocked(item)) return false;
  return true;
}

/** Cards per lane plus the SSU list, after filters. Preview rows always stay in the preview lane. */
export function groupBoard(parts: BoardParts, filters: BoardFilters): { lanes: Map<string, BoardItem[]>; ssu: BoardItem[] } {
  const lanes = new Map<string, BoardItem[]>();
  for (const lane of LANES) lanes.set(lane.key, []);
  lanes.set(FALLBACK_LANE.key, []);
  const previewIds = new Set(parts.preview.map((item) => item.id));
  const ssuIds = new Set(parts.ssu.map((item) => item.id));
  for (const item of parts.development) {
    if (previewIds.has(item.id) || ssuIds.has(item.id) || item.product === 'ssu') continue;
    if (!keep(item, filters)) continue;
    const key = laneForItem(item).key;
    lanes.get(key)?.push(item);
  }
  const previewLane = lanes.get('preview') || [];
  const seen = new Set(previewLane.map((item) => item.id));
  for (const item of parts.preview) {
    if (ssuIds.has(item.id) || seen.has(item.id) || !keep(item, filters)) continue;
    previewLane.push(item);
    seen.add(item.id);
  }
  lanes.set('preview', previewLane);
  for (const [key, list] of lanes) lanes.set(key, sortByDue(list));
  return { lanes, ssu: sortByDue(parts.ssu.filter((item) => keep(item, filters))) };
}
