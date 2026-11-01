/**
 * Reduce step: merges the verified items of every meeting into one list, deterministically.
 * - Items of one type are duplicates when their normalized keys match, or when their texts have a
 *   word Jaccard of at least 0.7 (facts of one path, directives of one area and kind, ...).
 * - Precedence: iteration > workshop > demo > sales; within a purpose the later meeting, then the
 *   higher confidence, then the id wins. The other item stays in the list with status `superseded`
 *   and `supersededBy` set to the winner's id.
 * - A single-valued fact (one brand name, one phone, one launch date) keeps only its winner.
 * - A keep directive and a change/remove directive on the same area conflict: the one with the
 *   higher precedence wins.
 * Ids are derived from content (type, meeting, key, quote), so an unchanged input gives the same ids.
 * An optional LLM merge (task brief.reduce) runs above MERGE_THRESHOLD active items; its result is
 * cached by its input, applied only to ids it got, and skipped when the call fails.
 */
import { SINGLE_FACT_PATHS } from './extract.js';
import { canonicalJson, jaccard, normalizeSpace, sha256, shortId, text, tokenSet } from './text.js';

export const JACCARD_MIN = 0.7;
export const MERGE_THRESHOLD = 40;
export const PURPOSE_RANK = Object.freeze({ iteration: 4, workshop: 3, demo: 2, sales: 1 });
const ID_PREFIX = { fact: 'f', directive: 'dir', iteration: 'it', promise: 'pr', followUp: 'fu', approvalSignal: 'ap', request: 'rq', openQuestion: 'oq' };
const SINGLE = new Set(SINGLE_FACT_PATHS);
const MERGE_PROMPT_VERSION = 1;

function keyText(item) {
  switch (item.type) {
    case 'fact':
      return item.path === 'claims.stats' ? `${item.number} ${item.unit} ${item.label}` : item.value;
    case 'directive':
    case 'iteration':
      return item.ask;
    default:
      return item.text;
  }
}

function groupKey(item) {
  switch (item.type) {
    case 'fact':
      return `fact|${item.path}`;
    case 'directive':
      return `directive|${normalizeSpace(item.area)}`;
    case 'iteration':
      return `iteration|${normalizeSpace(item.area)}`;
    case 'promise':
      return `promise|${item.featureKey || ''}`;
    case 'request':
      return `request|${item.kind}`;
    default:
      return item.type;
  }
}

export function itemId(item) {
  return shortId(ID_PREFIX[item.type] || 'x', item.type, item.meetingId, groupKey(item), normalizeSpace(keyText(item)), normalizeSpace(item.quote));
}

/** Higher first: purpose rank, meeting time, confidence, then id (for a stable order). */
export function compareByPrecedence(a, b) {
  return (PURPOSE_RANK[b.purpose] || 0) - (PURPOSE_RANK[a.purpose] || 0)
    || (Date.parse(b.startedAt || '') || 0) - (Date.parse(a.startedAt || '') || 0)
    || (Number(b.confidence) || 0) - (Number(a.confidence) || 0)
    || String(a.id).localeCompare(String(b.id));
}

function sameMeaning(a, b) {
  if (a.type === 'directive' && a.kind !== b.kind) return false;
  if (a.type === 'fact' && a.path === 'claims.stats' && Number(a.number) !== Number(b.number)) return false;
  const left = normalizeSpace(keyText(a));
  const right = normalizeSpace(keyText(b));
  if (left && left === right) return true;
  return jaccard(tokenSet(left), tokenSet(right)) >= JACCARD_MIN;
}

function conflicts(a, b) {
  if (a.type === 'fact') return SINGLE.has(a.path);
  if (a.type === 'directive' || a.type === 'iteration') {
    const keepA = a.type === 'directive' ? a.kind === 'keep' : a.keepAsIs === true;
    const keepB = b.type === 'directive' ? b.kind === 'keep' : b.keepAsIs === true;
    if (keepA === keepB) return false;
    const removeOrChange = (item) => item.type === 'iteration' || item.kind === 'change' || item.kind === 'remove';
    return removeOrChange(keepA ? b : a);
  }
  return false;
}

/**
 * items: verified items from extractMeeting (with type, purpose, meetingId, startedAt).
 * Returns { items (every item, with id, status 'active'|'superseded', supersededBy), active, counts }.
 */
export function reduceItems(items) {
  const withIds = new Map();
  for (const raw of Array.isArray(items) ? items : []) {
    const item = { ...raw, id: itemId(raw) };
    // The same statement seen twice (overlapping chunks): keep one copy.
    if (!withIds.has(item.id)) withIds.set(item.id, item);
  }
  const groups = new Map();
  for (const item of withIds.values()) {
    const key = groupKey(item);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  const out = [];
  for (const key of [...groups.keys()].sort()) {
    const ordered = groups.get(key).sort(compareByPrecedence);
    const winners = [];
    for (const item of ordered) {
      const winner = winners.find((kept) => sameMeaning(kept, item) || conflicts(kept, item));
      if (winner) out.push({ ...item, status: 'superseded', supersededBy: winner.id });
      else {
        const kept = { ...item, status: 'active' };
        winners.push(kept);
        out.push(kept);
      }
    }
  }
  // Directive conflicts across areas are not merged; keep the output order stable.
  out.sort((a, b) => groupKey(a).localeCompare(groupKey(b)) || compareByPrecedence(a, b));
  const active = out.filter((item) => item.status === 'active');
  return { items: out, active, counts: { input: Array.isArray(items) ? items.length : 0, unique: withIds.size, active: active.length, superseded: out.length - active.length } };
}

// ---------------------------------------------------------------- optional LLM merge

export function mergeSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['groups'],
    properties: {
      groups: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['keep', 'drop'],
          properties: { keep: { type: 'string' }, drop: { type: 'array', items: { type: 'string' } } },
        },
      },
    },
  };
}

const MERGE_SYSTEM = [
  'You get items extracted from meetings between a web agency and a client, as JSON lines with id, type and text.',
  'Find items of the same type that say the same thing in other words. For each such group, keep one id and list the others under drop.',
  'Only group items that clearly mean the same. Answer with JSON only: {"groups":[{"keep":"<id>","drop":["<id>"]}]}.',
].join('\n');

function mergeInput(active) {
  return active
    .map((item) => ({ id: item.id, type: item.type, text: text(keyText(item), 200) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Asks the model to group remaining duplicates when more than `threshold` items are active.
 * cache: { get(key), set(key, value) } (the chunk cache); the answer is cached by its input.
 * Returns { reduced, merged, usd, ran, error }.
 */
export async function llmMergeItems(reduced, { llm, cache = null, clientId = '', threshold = MERGE_THRESHOLD, deadline = Infinity, now = () => Date.now() } = {}) {
  const active = reduced.active;
  if (!llm || active.length <= threshold) return { reduced, merged: 0, usd: 0, ran: false, error: '' };
  const input = mergeInput(active);
  const key = `merge-${sha256(canonicalJson({ v: MERGE_PROMPT_VERSION, system: MERGE_SYSTEM, input }))}`;
  let entry = cache?.get(key) || null;
  let usd = 0;
  if (!entry) {
    if (now() >= deadline) return { reduced, merged: 0, usd: 0, ran: false, error: 'deadline' };
    try {
      const result = await llm.json({
        task: 'brief.reduce',
        system: MERGE_SYSTEM,
        user: input.map((row) => JSON.stringify(row)).join('\n'),
        schema: mergeSchema(),
        ctx: { salesClientId: clientId, dataClass: 'transcript' },
      });
      usd = Number(result?.usd) || 0;
      entry = { key, items: [], groups: Array.isArray(result?.data?.groups) ? result.data.groups : [], usd, at: new Date(now()).toISOString() };
      cache?.set(key, entry);
    } catch (error) {
      return { reduced, merged: 0, usd: 0, ran: true, error: text(error?.code || error?.name || 'error', 60) };
    }
  }
  const byId = new Map(reduced.items.map((item) => [item.id, item]));
  const superseded = new Map();
  for (const group of entry.groups || []) {
    const keep = byId.get(text(group?.keep));
    if (!keep || keep.status !== 'active') continue;
    for (const dropId of Array.isArray(group?.drop) ? group.drop : []) {
      const drop = byId.get(text(dropId));
      if (!drop || drop.id === keep.id || drop.status !== 'active' || drop.type !== keep.type || superseded.has(drop.id)) continue;
      // The model only groups; precedence still decides which of the two stays.
      const [winner, loser] = compareByPrecedence(keep, drop) <= 0 ? [keep, drop] : [drop, keep];
      if (superseded.has(winner.id)) continue;
      superseded.set(loser.id, winner.id);
    }
  }
  if (!superseded.size) return { reduced, merged: 0, usd, ran: true, error: '' };
  const items = reduced.items.map((item) => (superseded.has(item.id) ? { ...item, status: 'superseded', supersededBy: superseded.get(item.id) } : item));
  const nextActive = items.filter((item) => item.status === 'active');
  return {
    reduced: { items, active: nextActive, counts: { ...reduced.counts, active: nextActive.length, superseded: items.length - nextActive.length } },
    merged: superseded.size,
    usd,
    ran: true,
    error: '',
  };
}
