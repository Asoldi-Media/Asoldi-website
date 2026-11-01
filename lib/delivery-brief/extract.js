/**
 * Map step of the brief extractor: one LLM call per transcript chunk, with a prompt per meeting
 * purpose (sales, demo, workshop, iteration) and a closed JSON schema. Every item the model returns
 * must carry a quote and a speaker; items without them are counted as invalid, and every quote is
 * verified against the meeting's transcript (verify-quotes.js) before an item is kept.
 *
 * Calls go only through the hub LLM facade (lib/llm): task brief.iteration for iteration meetings,
 * brief.map otherwise, both data class `transcript`. There is no other provider path: a failed call
 * leaves its chunk for the next rebuild. Results are cached per chunk sha and prompt hash, so a
 * rebuild that was cut short redoes only the chunks that have no cached result.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { writeJsonAtomic } from '../../data/atomic-json.js';
import { chunkTranscript } from './chunk.js';
import { QUOTE_MAX_CHARS, verifyItemQuotes } from './verify-quotes.js';
import { canonicalJson, clampNumber, isPlainObject, sha256, text, wordTokens } from './text.js';

export const BRIEF_PROMPT_VERSION = 1;
export const MEETING_PURPOSES = Object.freeze(['sales', 'demo', 'workshop', 'iteration']);
export const BRIEF_DATA_CLASS = 'transcript';

export const SINGLE_FACT_PATHS = Object.freeze([
  'identity.brandName',
  'identity.legalName',
  'identity.orgNumber',
  'logo.wordmarkSpec.text',
  'logo.wordmarkSpec.case',
  'logo.wordmarkSpec.weight',
  'logo.wordmarkSpec.letterSpacing',
  'contact.email',
  'contact.phone',
  'contact.address',
  'contact.town',
  'contact.addressVisibility',
  'contact.onlineOnly',
  'contact.serviceArea',
  'contact.openingHours',
  'socials.instagram',
  'socials.facebook',
  'socials.linkedin',
  'socials.tiktok',
  'socials.youtube',
  'positioning.businessWhat',
  'positioning.audience',
  'positioning.toneOfVoice',
  'positioning.story',
  'products.focusProduct',
  'products.salesStatus',
  'shop.shipping',
  'shop.returns',
  'timeline.targetLaunchAt',
  'content.density',
  'content.structure',
  'content.mediaPlan',
  'content.reuseOldSite',
]);

export const LIST_FACT_PATHS = Object.freeze([
  'importantLinks',
  'positioning.services',
  'positioning.differentiators',
  'positioning.priorities',
  'positioning.brandCues',
  'claims.stats',
  'claims.awards',
  'claims.certifications',
  'claims.guarantees',
  'claims.regulated',
  'products.productFacts',
  'content.pagesRequested',
  'content.pagesExcluded',
  'content.keepAsIs',
  'previewFeedback',
]);

export const FACT_PATHS = Object.freeze([...SINGLE_FACT_PATHS, ...LIST_FACT_PATHS]);
export const DIRECTIVE_KINDS = Object.freeze(['change', 'add', 'remove', 'keep']);
export const DIRECTIVE_SCOPES = Object.freeze(['site', 'page', 'section', 'element']);
export const PRIORITIES = Object.freeze(['must', 'should', 'could']);
export const REQUEST_KINDS = Object.freeze(['consent', 'contact-info']);
export const ITEM_LISTS = Object.freeze(['facts', 'directives', 'iterations', 'promises', 'followUps', 'approvalSignals', 'requests', 'openQuestions']);
const LIST_TYPE = {
  facts: 'fact',
  directives: 'directive',
  iterations: 'iteration',
  promises: 'promise',
  followUps: 'followUp',
  approvalSignals: 'approvalSignal',
  requests: 'request',
  openQuestions: 'openQuestion',
};

// ---------------------------------------------------------------- prompts

const quoted = {
  quote: { type: 'string', description: 'The exact words from the transcript, copied character for character, at most 15 words.' },
  speaker: { type: 'string', description: 'The speaker label of the line the quote comes from.' },
};

function closedObject(properties, required) {
  return { type: 'object', additionalProperties: false, required, properties };
}

function listOf(item) {
  return { type: 'array', items: item };
}

/** The closed JSON schema of one map answer. Lengths and ranges are enforced after parsing. */
export function mapSchema() {
  return closedObject({
    facts: listOf(closedObject({
      path: { enum: [...FACT_PATHS] },
      value: { type: 'string' },
      number: { type: 'number' },
      unit: { type: 'string' },
      label: { type: 'string' },
      confidence: { type: 'number' },
      ...quoted,
    }, ['path', 'value', 'quote', 'speaker'])),
    directives: listOf(closedObject({
      kind: { enum: [...DIRECTIVE_KINDS] },
      scope: { enum: [...DIRECTIVE_SCOPES] },
      area: { type: 'string' },
      route: { type: 'string' },
      pageKind: { type: 'string' },
      sectionKind: { type: 'string' },
      ask: { type: 'string' },
      priority: { enum: [...PRIORITIES] },
      confidence: { type: 'number' },
      ...quoted,
    }, ['kind', 'area', 'ask', 'quote', 'speaker'])),
    iterations: listOf(closedObject({
      area: { type: 'string' },
      route: { type: 'string' },
      ask: { type: 'string' },
      keepAsIs: { type: 'boolean' },
      confidence: { type: 'number' },
      ...quoted,
    }, ['area', 'ask', 'keepAsIs', 'quote', 'speaker'])),
    promises: listOf(closedObject({
      featureKey: { type: 'string' },
      text: { type: 'string' },
      confidence: { type: 'number' },
      ...quoted,
    }, ['text', 'quote', 'speaker'])),
    followUps: listOf(closedObject({
      dueAt: { type: 'string' },
      who: { type: 'string' },
      channel: { type: 'string' },
      text: { type: 'string' },
      confidence: { type: 'number' },
      ...quoted,
    }, ['text', 'quote', 'speaker'])),
    approvalSignals: listOf(closedObject({ text: { type: 'string' }, ...quoted }, ['text', 'quote', 'speaker'])),
    requests: listOf(closedObject({ kind: { enum: [...REQUEST_KINDS] }, text: { type: 'string' }, ...quoted }, ['kind', 'text', 'quote', 'speaker'])),
    openQuestions: listOf(closedObject({ text: { type: 'string' }, ...quoted }, ['text', 'quote', 'speaker'])),
  }, [...ITEM_LISTS]);
}

const BASE_RULES = [
  'You read one part of a recorded meeting between a web agency and its client and extract what matters for building the client\'s website.',
  'Answer with JSON only, in the given schema. Use empty lists when the part holds nothing for a list.',
  'Every item needs `quote` and `speaker`. `quote` is copied exactly from the transcript (same words, same spelling), one sentence or less, at most 15 words. Never paraphrase a quote, never join words from different lines, never invent one. If you cannot quote it, leave the item out.',
  '`speaker` is the label before the colon on the quoted line.',
  'Write `value`, `ask` and `text` in the transcript\'s language, short and neutral. Do not copy long passages.',
  'facts: what the client said about the business. `path` names the fact. For claims.stats give `number`, `unit` and `label`, and the quote must contain the number.',
  'directives: wishes about the website. kind change | add | remove | keep. `area` names the part of the site (for example chrome.header, hero, services, products, footer, page:contact). priority must when the client insists, otherwise should or could.',
  'promises: what the agency promised to deliver; `featureKey` is the closest key from the list, or empty.',
  'followUps: agreed next contacts (when, who, channel). approvalSignals: the client approving the site or a preview. requests: the client asking for consent to be contacted or for contact information. openQuestions: questions left open.',
  'Only facts stated by a participant count. Nothing about people outside the business: no health, family or private details.',
];

const PURPOSE_FOCUS = {
  sales: 'This is a sales meeting. Focus on what the business does, who it serves, what the client wants from the website, what the agency promised, and agreed follow-ups.',
  demo: 'This is a demo meeting where the agency showed a draft. Focus on the client\'s reactions: directives, previewFeedback facts and approval signals.',
  workshop: 'This is a workshop meeting. Focus on concrete facts (names, contact, services, products, shop terms, launch date, content) and on directives for pages and sections.',
  iteration: 'This is an iteration meeting about a built preview. Focus on iterations (keepAsIs true when the client wants something left as it is), directives, previewFeedback facts and approval signals.',
};

export function normalizePurpose(value) {
  const purpose = text(value).toLowerCase();
  return MEETING_PURPOSES.includes(purpose) ? purpose : 'sales';
}

export function taskForPurpose(purpose) {
  return normalizePurpose(purpose) === 'iteration' ? 'brief.iteration' : 'brief.map';
}

/** { purpose, task, system, schema, promptHash } for one meeting purpose. */
export function promptFor(purpose, { featureKeys = [] } = {}) {
  const which = normalizePurpose(purpose);
  const keys = [...new Set((Array.isArray(featureKeys) ? featureKeys : []).map((key) => text(key)).filter(Boolean))].sort();
  const system = [
    ...BASE_RULES,
    PURPOSE_FOCUS[which],
    keys.length ? `Feature keys: ${keys.join(', ')}.` : '',
  ].filter(Boolean).join('\n');
  const schema = mapSchema();
  const promptHash = sha256(canonicalJson({ version: BRIEF_PROMPT_VERSION, purpose: which, system, schema }));
  return { purpose: which, task: taskForPurpose(which), system, schema, promptHash };
}

export function userPromptFor({ meeting, chunk, total }) {
  return [
    `Meeting purpose: ${normalizePurpose(meeting?.purpose)}.`,
    meeting?.startedAt ? `Meeting date: ${String(meeting.startedAt).slice(0, 10)}.` : '',
    `Part ${chunk.index + 1} of ${total}.`,
    '',
    'Transcript part:',
    chunk.text,
  ].filter((line) => line !== '').join('\n');
}

// ---------------------------------------------------------------- normalizing one answer

function cleanQuote(value) {
  return text(value).replace(/\s+/g, ' ');
}

function optional(value, max) {
  const out = text(value, max);
  return out || '';
}

function numberFrom(item) {
  if (typeof item.number === 'number' && Number.isFinite(item.number)) return item.number;
  const match = /-?\d+(?:[.,]\d+)?/.exec(String(item.value ?? ''));
  return match ? Number(match[0].replace(',', '.')) : null;
}

/**
 * The model's answer as flat items: [{ type, quote, speaker, confidence, ...fields }], plus the count of
 * items dropped for a missing quote or speaker or an unusable field. Never throws.
 */
export function normalizeMapOutput(raw, { featureKeys = null } = {}) {
  const items = [];
  let invalid = 0;
  const known = featureKeys ? new Set(featureKeys) : null;
  const source = isPlainObject(raw) ? raw : {};
  for (const list of ITEM_LISTS) {
    for (const entry of Array.isArray(source[list]) ? source[list].slice(0, 200) : []) {
      if (!isPlainObject(entry)) {
        invalid += 1;
        continue;
      }
      const quote = cleanQuote(entry.quote);
      const speaker = text(entry.speaker, 120);
      if (!quote || !speaker || quote.length > QUOTE_MAX_CHARS) {
        invalid += 1;
        continue;
      }
      const base = { type: LIST_TYPE[list], quote, speaker, confidence: clampNumber(entry.confidence, 0, 1, 0.7) };
      let item = null;
      if (list === 'facts') {
        const path = text(entry.path);
        const value = text(entry.value, 500);
        if (!FACT_PATHS.includes(path)) {
          invalid += 1;
          continue;
        }
        if (path === 'claims.stats') {
          const number = numberFrom(entry);
          if (number === null) {
            invalid += 1;
            continue;
          }
          item = { ...base, path, value: value || String(number), number, unit: optional(entry.unit, 40), label: optional(entry.label, 120) };
        } else if (value) {
          item = { ...base, path, value };
        }
      } else if (list === 'directives') {
        const kind = text(entry.kind);
        const ask = text(entry.ask, 500);
        if (DIRECTIVE_KINDS.includes(kind) && ask) {
          const scope = DIRECTIVE_SCOPES.includes(text(entry.scope)) ? text(entry.scope) : 'section';
          item = {
            ...base,
            kind,
            scope,
            area: text(entry.area, 120) || 'site',
            route: optional(entry.route, 200),
            pageKind: optional(entry.pageKind, 60),
            sectionKind: optional(entry.sectionKind, 60),
            ask,
            priority: PRIORITIES.includes(text(entry.priority)) ? text(entry.priority) : 'should',
          };
        }
      } else if (list === 'iterations') {
        const ask = text(entry.ask, 500);
        if (ask) item = { ...base, area: text(entry.area, 120) || 'site', route: optional(entry.route, 200), ask, keepAsIs: entry.keepAsIs === true };
      } else if (list === 'promises') {
        const body = text(entry.text, 500);
        let featureKey = text(entry.featureKey, 120);
        if (featureKey && known && !known.has(featureKey)) featureKey = '';
        if (body) item = { ...base, featureKey, text: body };
      } else if (list === 'followUps') {
        const body = text(entry.text, 500);
        if (body) item = { ...base, text: body, dueAt: optional(entry.dueAt, 40), who: optional(entry.who, 120), channel: optional(entry.channel, 40) };
      } else if (list === 'requests') {
        const kind = text(entry.kind);
        const body = text(entry.text, 500);
        if (REQUEST_KINDS.includes(kind) && body) item = { ...base, kind, text: body };
      } else {
        const body = text(entry.text, 500);
        if (body) item = { ...base, text: body };
      }
      if (item) items.push(item);
      else invalid += 1;
    }
  }
  return { items, invalid };
}

/** A stat counts only when its number is in its (verified) quote. */
export function statHasQuotedNumber(item) {
  if (item?.type !== 'fact' || item.path !== 'claims.stats') return true;
  const tokens = new Set(wordTokens(item.quote));
  const number = Number(item.number);
  if (!Number.isFinite(number)) return false;
  const forms = new Set([String(number), String(number).replace('.', ','), String(Math.trunc(number))]);
  if (String(number).includes('.')) {
    const [whole, fraction] = String(number).split('.');
    if (tokens.has(whole) && tokens.has(fraction)) return true;
  }
  return [...forms].some((form) => tokens.has(form));
}

// ---------------------------------------------------------------- chunk cache

/** Map results on disk: <dir>/<chunkSha>-<promptHash 16>.json. */
export function createChunkCache(dir) {
  const pathFor = (key) => join(dir, `${key}.json`);
  return Object.freeze({
    dir,
    key: (chunkSha, promptHash) => `${chunkSha}-${String(promptHash).slice(0, 16)}`,
    get(key) {
      const path = pathFor(key);
      if (!existsSync(path)) return null;
      try {
        const value = JSON.parse(readFileSync(path, 'utf8'));
        return isPlainObject(value) && Array.isArray(value.items) ? value : null;
      } catch {
        return null;
      }
    },
    set(key, value) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeJsonAtomic(pathFor(key), value);
    },
    keys() {
      if (!existsSync(dir)) return [];
      return readdirSync(dir).filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -5));
    },
  });
}

/** An in-memory cache with the same interface (tests, the eval script). */
export function createMemoryChunkCache() {
  const store = new Map();
  return Object.freeze({
    dir: '',
    key: (chunkSha, promptHash) => `${chunkSha}-${String(promptHash).slice(0, 16)}`,
    get: (key) => (store.has(key) ? structuredClone(store.get(key)) : null),
    set: (key, value) => store.set(key, structuredClone(value)),
    keys: () => [...store.keys()],
  });
}

function errorCode(error) {
  return text(error?.code || error?.name || 'error', 60);
}

/**
 * Extracts one meeting. meeting: { meetingId, purpose, startedAt, transcript }.
 * Returns { meetingId, purpose, startedAt, complete, chunks: {total, cached, extracted, failed, skipped},
 *   items (verified), droppedUnverified, droppedInvalid, costUsd, routes, errors, promptHash }.
 * `deadline` (ms) stops starting new LLM calls; the remaining chunks are left for the next rebuild.
 */
export async function extractMeeting({
  meeting,
  llm,
  cache,
  clientId = '',
  featureKeys = [],
  deadline = Infinity,
  now = () => Date.now(),
  signal = null,
  chunkOptions = {},
} = {}) {
  const purpose = normalizePurpose(meeting?.purpose);
  const prompt = promptFor(purpose, { featureKeys });
  const transcript = String(meeting?.transcript ?? '');
  const chunks = chunkTranscript(transcript, chunkOptions);
  const out = {
    meetingId: text(meeting?.meetingId),
    purpose,
    startedAt: text(meeting?.startedAt),
    promptHash: prompt.promptHash,
    complete: true,
    chunks: { total: chunks.length, cached: 0, extracted: 0, failed: 0, skipped: 0 },
    items: [],
    droppedUnverified: 0,
    droppedInvalid: 0,
    costUsd: 0,
    routes: [],
    errors: [],
  };
  const raw = [];
  const routes = new Set();
  for (const chunk of chunks) {
    const key = cache.key(chunk.sha, prompt.promptHash);
    let entry = cache.get(key);
    if (entry) {
      out.chunks.cached += 1;
    } else {
      if (now() >= deadline || signal?.aborted) {
        out.chunks.skipped += 1;
        continue;
      }
      try {
        const result = await llm.json({
          task: prompt.task,
          system: prompt.system,
          user: userPromptFor({ meeting: { ...meeting, purpose }, chunk, total: chunks.length }),
          schema: prompt.schema,
          ctx: { salesClientId: clientId, dataClass: BRIEF_DATA_CLASS },
          ...(signal ? { signal } : {}),
        });
        const normalized = normalizeMapOutput(result?.data, { featureKeys: featureKeys.length ? featureKeys : null });
        const route = text(result?.route?.route || [result?.provider, result?.model].filter(Boolean).join(':'), 120);
        entry = {
          key,
          chunkSha: chunk.sha,
          promptHash: prompt.promptHash,
          task: prompt.task,
          items: normalized.items,
          invalid: normalized.invalid,
          usd: Number(result?.usd) || 0,
          route,
          at: new Date(now()).toISOString(),
        };
        cache.set(key, entry);
        out.chunks.extracted += 1;
        out.costUsd += entry.usd;
      } catch (error) {
        out.chunks.failed += 1;
        out.errors.push(errorCode(error));
        continue;
      }
    }
    if (entry.route) routes.add(entry.route);
    out.droppedInvalid += Number(entry.invalid) || 0;
    for (const item of entry.items) raw.push({ ...item, meetingId: out.meetingId, purpose, startedAt: out.startedAt, chunkSha: chunk.sha });
  }
  out.complete = out.chunks.failed === 0 && out.chunks.skipped === 0;
  const { kept, dropped } = verifyItemQuotes(raw, new Map([[out.meetingId, transcript]]));
  out.items = kept.filter((item) => statHasQuotedNumber(item));
  out.droppedUnverified = dropped.length + (kept.length - out.items.length);
  out.routes = [...routes].sort();
  out.costUsd = Math.round(out.costUsd * 1e6) / 1e6;
  return out;
}
