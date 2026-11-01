// Delivery gate: what a signed client still has to supply before development starts (`dev`) and
// before the production publish (`ready`), as one list of lines per client.
//
// - evaluateDeliveryGate(client, inputs) is pure: it reads only its arguments, makes no network
//   call and writes nothing. gatherGateInputs(client) collects the inputs from stored data only
//   (Kundedata, the Maker materials snapshot, inbox items, stored shop connections, and the
//   delivery brief, agreed keywords and DPA status when those modules are present).
// - The switch is `gate` in automation-settings.json ({enabled, mode, paused}); every per-client
//   decision goes through spineModeForClient('gate', client). Off: nothing is evaluated, stored,
//   shown or mailed. Shadow: lines are computed and shown to developers; mails that would use them
//   are recorded, never sent.
// - The result is stored on client.delivery.gate with the hash of its inputs. Waivers, the
//   approval and the note are kept across evaluations.
// - askableLines(gate) gives the lines a client can be asked for by email, grouped as Merke,
//   Innhold, Kontakt, Bilder, Nettbutikk and Synlighet.
import { createHash } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { getAutomationSettings } from '../data/automation-settings.js';
import {
  GATE_INFO_LINES,
  expandServices,
  servicesForTier,
} from '../packages/suite/core/delivery/vocab.js';
import { appendDeliveryAudit, deliveryAuditFile, readDeliveryAudit } from './delivery-audit.js';
import { normalizeDelivery } from './delivery-state.js';
import { activeSitePlan, normalizeSitePlan } from './site-plan-model.js';
import { spineModeForClient } from './spine-mode.js';
import {
  GATE_GROUPS,
  filled,
  isPlainObject,
  requirementGate,
  requirementLevel,
  serviceRequirementsFor,
  text,
} from './site-plan-requirements.js';
import { pageKindRequirementsFor, pageKindsForClient, waiveDirective } from './page-kind-requirements.js';

export { GATE_GROUPS };

export const GATE_VERSION = 1;
export const ASKABLE_MAX = 12;
export const GATE_SWITCH = 'gate';
const WAIVER_MAX = 40;

// Assistant steps (bank.assistantIntake) and the lines a skip there declines.
const ASSISTANT_SKIPS = Object.freeze({
  logo: ['logo'],
  media: ['hero-media', 'project-images'],
  products: ['products', 'catalog-items', 'menu-items'],
  staff: ['staff'],
  hours: ['opening-hours'],
});

function listOf(value) {
  return Array.isArray(value) ? value : [];
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (isPlainObject(value)) {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] !== undefined) out[key] = stable(value[key]);
    }
    return out;
  }
  return value;
}

export function stableHash(value) {
  return createHash('sha256').update(JSON.stringify(stable(value ?? null))).digest('hex');
}

function isoOf(now) {
  if (now instanceof Date) return now.toISOString();
  if (typeof now === 'number' && Number.isFinite(now)) return new Date(now).toISOString();
  const parsed = Date.parse(text(now, 40));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date().toISOString();
}

// ---------------------------------------------------------------- switch

/** off | shadow | paused | auto for one client (the pilot rule applies through spineModeForClient). */
export function gateModeForClient(client, { settings = null, dataDir } = {}) {
  try {
    return spineModeForClient(GATE_SWITCH, client, { settings: settings || getAutomationSettings({ dataDir }), dataDir });
  } catch {
    return 'off';
  }
}

/** True when the gate runs for this client (shadow or auto). */
export function gateActiveForClient(client, options = {}) {
  const mode = gateModeForClient(client, options);
  return mode === 'shadow' || mode === 'auto';
}

/** True when the gate switch is enabled (paused or not), whatever the client. Routes answer 404 otherwise. */
export function gateSwitchEnabled({ settings = null, dataDir } = {}) {
  try {
    const resolved = settings || getAutomationSettings({ dataDir });
    return isPlainObject(resolved?.gate) && resolved.gate.enabled === true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- evidence

function makerMaterialsOf(client) {
  const makerRun = isPlainObject(client?.makerRun) ? client.makerRun : {};
  const materials = isPlainObject(makerRun.materials) ? makerRun.materials : null;
  if (!materials) return null;
  // A snapshot of an earlier run never speaks for the run linked now.
  const linked = text(makerRun.runId, 80);
  if (linked && text(materials.runId, 80) && text(materials.runId, 80) !== linked) return null;
  return materials;
}

function inboxFoundIds(items) {
  const ids = new Set();
  for (const item of listOf(items)) {
    if (!['staged', 'filed', 'done', 'applied'].includes(text(item?.status))) continue;
    for (const id of listOf(item?.found)) if (text(id)) ids.add(text(id));
  }
  return ids;
}

function declinedLines(bank) {
  const intake = isPlainObject(bank?.assistantIntake) ? bank.assistantIntake : {};
  const out = new Set();
  for (const [step, lines] of Object.entries(ASSISTANT_SKIPS)) {
    if (text(intake[step]) === 'skipped') for (const id of lines) out.add(id);
  }
  return out;
}

function agreedKeywordCount(client, inputs) {
  if (Number.isFinite(inputs?.agreedKeywords)) return Math.max(0, inputs.agreedKeywords);
  return listOf(client?.seo?.agreedKeywords).filter((row) => text(row?.status) === 'approved' && text(row?.phrase)).length;
}

function planOf(client, inputs) {
  const fromInputs = normalizeSitePlan(inputs?.plan);
  if (fromInputs && fromInputs.status === 'active') return fromInputs;
  const stored = activeSitePlan(client);
  if (stored) return stored;
  const tierId = text(inputs?.tierId);
  const services = servicesForTier(tierId);
  return services.length ? { tierId, services: expandServices(services), languages: ['nb'], derived: true } : null;
}

/** The Maker materials of the inputs; when the inputs do not name any, the client's own snapshot. */
function materialsOf(client, inputs) {
  if (inputs && Object.prototype.hasOwnProperty.call(inputs, 'materials')) return isPlainObject(inputs.materials) ? inputs.materials : null;
  return makerMaterialsOf(client);
}

/** The page kinds of the inputs: given ones, else those of the materials snapshot or Kundedata. */
function pageKindsOf(client, inputs) {
  if (isPlainObject(inputs?.pageKinds)) return inputs.pageKinds;
  return pageKindsForClient({ materials: materialsOf(client, inputs), bank: inputs?.bank || null });
}

function buildEvidence(client, inputs) {
  const bank = isPlainObject(inputs?.bank) ? inputs.bank : {};
  const materials = materialsOf(client, inputs);
  const facts = isPlainObject(inputs?.brief?.facts) ? inputs.brief.facts : {};
  const needs = listOf(materials?.needs?.items).filter(isPlainObject);
  const pageKinds = pageKindsOf(client, inputs);
  const logoNeed = needs.find((item) => text(item.id) === 'logo');
  return {
    client: isPlainObject(client) ? client : {},
    bank,
    materials,
    facts,
    needs,
    answers: isPlainObject(inputs?.makerAnswers) ? inputs.makerAnswers : {},
    inboxFound: inboxFoundIds(inputs?.inboxItems),
    workshop: isPlainObject(client?.workshop) ? client.workshop : {},
    delivery: normalizeDelivery(client?.delivery),
    plan: planOf(client, inputs),
    pageKindList: listOf(pageKinds.list),
    shopConnections: isPlainObject(inputs?.shopConnections) ? inputs.shopConnections : {},
    agreedKeywords: agreedKeywordCount(client, inputs),
    seoScope: text(inputs?.seoScope ?? client?.seo?.scope),
    onboardingCity: text(inputs?.onboardingCity),
    offerPartyName: text(inputs?.offerPartyName) || (client?.progression?.contractSigned === true ? text(client?.businessName) : ''),
    wordmarkAvailable: Boolean(facts?.logo?.wordmarkSpec) || materials?.textLogo === true || text(logoNeed?.status) === 'wordmark',
  };
}

// ---------------------------------------------------------------- evaluation

function storedGate(client) {
  const gate = normalizeDelivery(client?.delivery).gate;
  return isPlainObject(gate) ? gate : null;
}

function normalizeWaivers(raw) {
  const out = {};
  if (!isPlainObject(raw)) return out;
  for (const [id, waiver] of Object.entries(raw).slice(0, WAIVER_MAX)) {
    if (!isPlainObject(waiver) || !text(waiver.option)) continue;
    out[text(id, 60)] = {
      option: text(waiver.option, 120),
      by: text(waiver.by, 120),
      at: text(waiver.at, 40),
      reason: text(waiver.reason, 300),
      ...(isPlainObject(waiver.directive) ? { directive: waiver.directive } : {}),
    };
  }
  return out;
}

function lineOrigin(row, services, pageKindList) {
  if (row.services) {
    const sold = row.services.find((service) => services.includes(service));
    if (sold) return `service:${sold}`;
  }
  const kinds = new Set(pageKindList.map((entry) => text(entry?.kind)));
  const kind = (row.pageKinds || []).find((entry) => kinds.has(entry));
  return kind ? `page-kind:${kind}` : 'service';
}

function infoLines(client, ev, inputs) {
  const out = [];
  const qa = isPlainObject(ev.materials?.step1Qa) ? ev.materials.step1Qa : (isPlainObject(client?.makerRun?.step1Qa) ? client.makerRun.step1Qa : null);
  if (qa && ['warn', 'fail'].includes(text(qa.status))) {
    const score = Number.isFinite(qa.score) ? ` (${qa.score})` : '';
    out.push({ id: 'step1Qa', status: text(qa.status), detail: `Kvalitetssjekken av importen: ${text(qa.status)}${score}` });
  }
  const hard = ev.needs.filter((item) => !['logo', 'media.placeholders'].includes(text(item.id))
    && ['missing', 'required', 'unconfirmed'].includes(text(item.status).toLowerCase()));
  if (hard.length) {
    out.push({ id: 'needs-hard', status: 'warn', detail: `${hard.length} punkter fra Maker: ${hard.map((item) => text(item.id, 40)).slice(0, 8).join(', ')}` });
  }
  if (inputs?.dpa && inputs.dpa.missing === true) {
    out.push({ id: 'dpa-missing', status: 'warn', detail: 'Databehandleravtalen er ikke signert' });
  }
  const planChangedAt = Date.parse(ev.delivery.events.planChangedAt || '');
  const runAt = Date.parse(text(ev.materials?.at) || text(client?.makerRun?.createdAt) || text(client?.makerRun?.updatedAt) || '');
  if (Number.isFinite(planChangedAt) && text(client?.makerRun?.runId) && (!Number.isFinite(runAt) || runAt < planChangedAt)) {
    out.push({ id: 'plan-changed-rerun', status: 'warn', detail: 'Planen er endret etter siste Maker-kjøring' });
  }
  return out.filter((line) => GATE_INFO_LINES.includes(line.id));
}

/**
 * The hash of everything the gate reads. Two evaluations with the same hash give the same lines,
 * so the tick re-evaluates only when it changes.
 */
export function gateInputHash(client, inputs = {}) {
  const stored = storedGate(client);
  const delivery = normalizeDelivery(client?.delivery);
  const plan = planOf(client, inputs);
  return stableHash({
    v: GATE_VERSION,
    plan: plan ? { tierId: plan.tierId, services: plan.services, languages: plan.languages || [] } : null,
    client: {
      contactPhone: text(client?.contactPhone),
      contactEmail: text(client?.contactEmail),
      clientEmail: text(client?.clientEmail),
      orgNumber: text(client?.orgNumber),
      legalName: text(client?.legalName),
      businessName: text(client?.businessName),
      signed: client?.progression?.contractSigned === true,
      googleBusinessProfile: text(client?.details?.googleBusinessProfile),
      seo: client?.seo ?? null,
      runId: text(client?.makerRun?.runId),
      step1Qa: client?.makerRun?.step1Qa ?? null,
    },
    workshop: {
      heldAt: text(client?.workshop?.heldAt),
      notes: listOf(client?.workshop?.notes).length,
    },
    events: {
      approval: delivery.events.approval,
      previewReady: delivery.events.previewReady,
      planChangedAt: delivery.events.planChangedAt,
    },
    waivers: normalizeWaivers(stored?.waivers),
    approvedAt: text(stored?.approvedAt),
    bank: inputs.bank ?? null,
    materials: materialsOf(client, inputs),
    makerAnswers: inputs.makerAnswers ?? null,
    inbox: [...inboxFoundIds(inputs.inboxItems)].sort(),
    pageKinds: pageKindsOf(client, inputs),
    brief: inputs.brief?.hash || (inputs.brief?.facts ? stableHash(inputs.brief.facts) : ''),
    agreedKeywords: inputs.agreedKeywords ?? null,
    seoScope: inputs.seoScope ?? '',
    shop: inputs.shopConnections ?? null,
    shopConnectionRev: inputs.shopConnectionRev ?? 0,
    dpa: inputs.dpa ?? null,
    tierId: inputs.tierId ?? '',
    onboardingCity: inputs.onboardingCity ?? '',
    offerPartyName: inputs.offerPartyName ?? '',
  });
}

/**
 * Evaluates the gate for one client. Pure: no I/O, no clock unless options.now is missing.
 * `inputs`: { bank, materials, inboxItems, shopConnections, shopConnectionRev, pageKinds,
 * brief: {facts, hash}, agreedKeywords, seoScope, dpa: {missing} | null, plan, tierId,
 * makerAnswers, onboardingCity, offerPartyName }.
 */
export function evaluateDeliveryGate(client, inputs = {}, { now } = {}) {
  const ev = buildEvidence(client, inputs);
  const stored = storedGate(client);
  const waivers = normalizeWaivers(stored?.waivers);
  const declined = declinedLines(ev.bank);
  const services = ev.plan ? listOf(ev.plan.services) : expandServices(['site']);
  const rows = new Map();
  for (const row of serviceRequirementsFor(services, ev)) rows.set(row.id, { row, extraWaive: [] });
  for (const row of pageKindRequirementsFor(ev.pageKindList)) {
    if (rows.has(row.id)) rows.get(row.id).extraWaive.push(...row.waiveOptions);
    else rows.set(row.id, { row, extraWaive: [] });
  }
  const lines = [];
  for (const { row, extraWaive } of rows.values()) {
    const result = row.evaluate(ev);
    let status = result.have ? 'have' : 'missing';
    const waiver = waivers[row.id] || null;
    if (status === 'missing' && waiver) status = 'waived';
    if (status === 'missing' && declined.has(row.id)) status = 'declined';
    const waiveOptions = [...new Set([...row.waiveOptions, ...extraWaive])];
    lines.push({
      id: row.id,
      group: row.group,
      label: row.label,
      askText: row.askText || row.label,
      gate: requirementGate(row),
      level: requirementLevel(row),
      dev: row.dev || '',
      ready: row.ready || '',
      askable: row.askable === true,
      status,
      source: result.source || '',
      evidence: result.evidence || '',
      origin: lineOrigin(row, services, ev.pageKindList),
      waiveOptions,
      waiver,
      directive: waiver ? (waiver.directive || waiveDirective(row.id, waiver.option)) : null,
    });
  }
  const blocking = (line, column) => line[column] === 'required' && (line.status === 'missing' || line.status === 'declined');
  const missingDev = lines.filter((line) => blocking(line, 'dev')).map((line) => line.id);
  const missingReady = lines.filter((line) => blocking(line, 'ready')).map((line) => line.id);
  const approvedAt = text(stored?.approvedAt, 40);
  return {
    version: GATE_VERSION,
    evaluatedAt: isoOf(now),
    inputHash: gateInputHash(client, inputs),
    inputs: {
      bankHash: stableHash(inputs.bank ?? null).slice(0, 16),
      materialsAt: text(ev.materials?.receivedAt || ev.materials?.at, 40),
      briefHash: text(inputs.brief?.hash, 80),
      seoRevision: ev.agreedKeywords,
      shopConnectionRev: Number(inputs.shopConnectionRev) || 0,
      waiversRev: stableHash(waivers).slice(0, 12),
      pageKindsHash: stableHash(ev.pageKindList).slice(0, 12),
      pageKindSource: text(pageKindsOf(client, inputs).source, 40),
    },
    tierId: text(ev.plan?.tierId, 40),
    services,
    devComplete: missingDev.length === 0,
    readyComplete: missingDev.length === 0 && missingReady.length === 0,
    passed: missingDev.length === 0 || Boolean(approvedAt),
    missingDev,
    missingReady,
    approvedBy: text(stored?.approvedBy, 120),
    approvedAt,
    note: text(stored?.note, 1000),
    waivers,
    lines,
    info: infoLines(client, ev, inputs),
  };
}

/** The developer's build directives from the waivers (for example: remove the team page). */
export function gateDirectives(gate) {
  return listOf(gate?.lines).map((line) => line.directive).filter(isPlainObject);
}

// ---------------------------------------------------------------- askable lines

function rank(line) {
  if (line.gate === 'dev' && line.level === 'required') return 0;
  if (line.ready === 'required') return 1;
  return 2;
}

function clientDetail(line) {
  if (line.id === 'contact' && /^Mangler /.test(line.evidence)) return `Vi har ikke ${line.evidence.slice('Mangler '.length)} ennå.`;
  return '';
}

/**
 * The lines a client can be asked for by email: askable and missing (never declined, waived or
 * already there), required before optional, at most `max`. Returns
 * { rows: [{id, group, title, detail, source:'gate', gate, level}], groups: [{group, rows}], total, omitted }.
 */
export function askableLines(gate, { max = ASKABLE_MAX, gateColumn = '' } = {}) {
  const candidates = listOf(gate?.lines)
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => line.askable === true && line.status === 'missing' && (!gateColumn || line.gate === gateColumn))
    .sort((a, b) => rank(a.line) - rank(b.line) || a.index - b.index);
  const picked = candidates.slice(0, Math.max(0, Number(max) || 0)).map(({ line }) => ({
    id: line.id,
    group: GATE_GROUPS.includes(line.group) ? line.group : 'Innhold',
    title: line.askText || line.label,
    detail: clientDetail(line),
    source: 'gate',
    gate: line.gate,
    level: line.level,
  }));
  const groups = GATE_GROUPS
    .map((group) => ({ group, rows: picked.filter((row) => row.group === group) }))
    .filter((entry) => entry.rows.length);
  return {
    rows: groups.flatMap((entry) => entry.rows),
    groups,
    total: candidates.length,
    omitted: Math.max(0, candidates.length - picked.length),
  };
}

/**
 * Open placeholder slots from the Maker's needs (pictures that are still the template's):
 * { count, routes, sentence }. `sentence` is '' when there are none.
 */
export function placeholderSlots(materials) {
  const items = listOf(materials?.needs?.items).filter(isPlainObject);
  const item = items.find((need) => text(need.id) === 'media.placeholders' && !['have', 'done', 'ok'].includes(text(need.status).toLowerCase()));
  const slots = listOf(item?.slots).filter(isPlainObject);
  const counted = Number(materials?.placeholders?.images) || 0;
  const count = Math.max(slots.length, counted);
  const routes = [...new Set(slots.map((slot) => text(slot.route, 120)).filter((route) => route.startsWith('/')))];
  if (!count) return { count: 0, routes: [], sentence: '' };
  const where = routes.length ? `, blant annet på ${routes.slice(0, 2).join(' og ')}` : '';
  const noun = count === 1 ? 'eksempelbilde' : 'eksempelbilder';
  return { count, routes, sentence: `Vi bruker fortsatt ${count} ${noun}${where}.` };
}

/** Mail rows for a gate: the askable rows plus one row for the open placeholder slots (under Bilder). */
export function gateMailRows(gate, materials, { max = ASKABLE_MAX } = {}) {
  const asked = askableLines(gate, { max });
  const slots = placeholderSlots(materials);
  if (!slots.sentence) return asked.rows;
  const row = { id: 'placeholders', group: 'Bilder', title: slots.sentence, detail: 'Send oss gjerne egne bilder til disse stedene.', source: 'gate', placeholder: true };
  const rows = [...asked.rows];
  const lastBilder = rows.map((entry) => entry.group).lastIndexOf('Bilder');
  if (lastBilder >= 0) rows.splice(lastBilder + 1, 0, row);
  else {
    const order = GATE_GROUPS.indexOf('Bilder');
    const at = rows.findIndex((entry) => GATE_GROUPS.indexOf(entry.group) > order);
    rows.splice(at === -1 ? rows.length : at, 0, row);
  }
  return rows;
}

// ---------------------------------------------------------------- inputs from stored data

const optionalModules = new Map();

/** A module that may not exist in this build (another part of the delivery work), or null. */
export async function optionalModule(relative) {
  if (optionalModules.has(relative)) return optionalModules.get(relative);
  const url = new URL(relative, import.meta.url);
  const loading = existsSync(url) ? import(url.href).catch(() => null) : Promise.resolve(null);
  optionalModules.set(relative, loading);
  return loading;
}

async function callFirst(mod, names, ...args) {
  for (const name of names) {
    if (typeof mod?.[name] === 'function') {
      try {
        return await mod[name](...args);
      } catch {
        return null;
      }
    }
  }
  return null;
}

async function briefInputs(client) {
  const store = await optionalModule('./delivery-brief/store.js');
  if (!store) return null;
  const brief = await callFirst(store, ['readLatestBrief', 'getLatestBrief', 'latestBrief', 'readBrief'], text(client?.id));
  const body = isPlainObject(brief?.brief) ? brief.brief : brief;
  if (!isPlainObject(body)) return null;
  const facts = isPlainObject(body.facts) ? body.facts : null;
  return facts ? { facts, hash: text(body.hash || brief?.hash, 80) } : null;
}

async function agreedKeywordInputs(client) {
  const record = await optionalModule('./seo-ops/record.js');
  if (!record || typeof record.agreedKeywordsFor !== 'function') return null;
  const result = await callFirst(record, ['agreedKeywordsFor'], text(client?.id), { client });
  const rows = Array.isArray(result) ? result : listOf(result?.agreedKeywords);
  return rows.filter((row) => text(row?.status || 'approved') === 'approved' && text(row?.phrase ?? row)).length;
}

async function dpaInputs(client) {
  const dpa = await optionalModule('./legal/dpa.js');
  if (!dpa || typeof dpa.dpaStatus !== 'function') return null;
  const status = await callFirst(dpa, ['dpaStatus'], client);
  if (!isPlainObject(status)) return null;
  const missing = status.missing === true || (status.required === true && status.signed !== true);
  return { missing, version: text(status.version, 80) };
}

/** Connection state as stored on the hub (no provider call). */
async function shopInputs(site) {
  if (!site?.id) return { connections: null, rev: 0 };
  let connections = null;
  try {
    const shop = await import('./shop-payments.js');
    connections = typeof shop.readStoredShopConnections === 'function' ? shop.readStoredShopConnections(site.id) : null;
  } catch {
    connections = null;
  }
  return { connections, rev: Number(site.shopConnectionRev) || 0 };
}

async function hubSiteFor(client, hub) {
  try {
    const source = hub || await import('../data/hub.js');
    const byId = text(client?.hubSite?.id) ? source.getSiteById(text(client.hubSite.id)) : null;
    if (byId) return byId;
    return text(client?.hubSite?.siteKey) ? source.getSiteByKey(text(client.hubSite.siteKey)) : null;
  } catch {
    return null;
  }
}

async function bankAndProfile(client, deps) {
  if (typeof deps.getProfile === 'function') {
    const profile = deps.getProfile(client);
    return { bank: isPlainObject(profile?.clientDataBank) ? profile.clientDataBank : {}, profile };
  }
  const userId = text(client?.portalUserId);
  if (!userId) return { bank: {}, profile: null };
  try {
    const portal = await import('../data/client-portal.js');
    const profile = portal.getClientProfileByUserId(userId);
    return { bank: isPlainObject(profile?.clientDataBank) ? profile.clientDataBank : {}, profile };
  } catch {
    return { bank: {}, profile: null };
  }
}

async function inboxItemsFor(client, deps) {
  if (typeof deps.listInbox === 'function') return listOf(deps.listInbox({ salesClientId: text(client?.id), kind: 'client_elements' }));
  const store = await optionalModule('./inbox-bot/store.js');
  if (!store || typeof store.listInboxItems !== 'function') return [];
  try {
    return listOf(store.listInboxItems({ salesClientId: text(client?.id), kind: 'client_elements' }));
  } catch {
    return [];
  }
}

async function offerFor(client, deps) {
  if (typeof deps.getOffer === 'function') return deps.getOffer(client) || null;
  try {
    const offers = deps.salesOffers || await import('../data/sales-offers.js');
    return typeof offers.getOfferForClient === 'function' ? offers.getOfferForClient(text(client?.id)) || null : null;
  } catch {
    return null;
  }
}

/**
 * The gate inputs for one client, from stored data only: no network call, no write.
 * deps (all optional): { hub, salesOffers, getProfile, listInbox, getOffer }.
 */
export async function gatherGateInputs(client, deps = {}) {
  const { bank, profile } = await bankAndProfile(client, deps);
  const materials = makerMaterialsOf(client);
  const offer = await offerFor(client, deps);
  const site = await hubSiteFor(client, deps.hub);
  const shop = await shopInputs(site);
  const tierId = activeSitePlan(client)?.tierId || text(offer?.tierId) || text(client?.portalTierId) || text(client?.details?.meetingQuote?.tierId);
  return {
    bank,
    materials,
    inboxItems: await inboxItemsFor(client, deps),
    shopConnections: shop.connections,
    shopConnectionRev: shop.rev,
    pageKinds: pageKindsForClient({ materials, offer, bank }),
    brief: await briefInputs(client),
    agreedKeywords: await agreedKeywordInputs(client),
    seoScope: text(client?.seo?.scope),
    dpa: await dpaInputs(client),
    tierId,
    onboardingCity: text(profile?.onboarding?.city || profile?.onboarding?.town),
    offerPartyName: text(offer?.client?.businessName || offer?.partyName),
  };
}

// ---------------------------------------------------------------- stored gate

/** The new gate with the fields people set (waivers, approval, note) carried over. */
export function withKeptGateFields(previous, next) {
  const kept = isPlainObject(previous) ? previous : {};
  return {
    ...next,
    waivers: normalizeWaivers(kept.waivers),
    approvedBy: text(kept.approvedBy, 120),
    approvedAt: text(kept.approvedAt, 40),
    note: text(kept.note, 1000),
  };
}

/**
 * Evaluates and stores the gate on client.delivery.gate. Returns { client, gate, changed }.
 * `sales` is data/sales.js (getSalesClientById, setSalesDelivery).
 */
export async function evaluateAndStoreGate(clientId, { sales, now, deps = {} } = {}) {
  const client = sales.getSalesClientById(clientId);
  if (!client) return { client: null, gate: null, changed: false };
  const inputs = await gatherGateInputs(client, deps);
  const stored = storedGate(client);
  const hash = gateInputHash(client, inputs);
  if (stored && stored.inputHash === hash && stored.version === GATE_VERSION) return { client, gate: stored, changed: false };
  const gate = withKeptGateFields(stored, evaluateDeliveryGate(client, inputs, { now }));
  const updated = sales.setSalesDelivery(client.id, { gate });
  return { client: updated || client, gate, changed: true };
}

/** The client as if `gate` were stored on it (for evaluating before the one write). */
function withStoredGate(client, gate) {
  const delivery = isPlainObject(client?.delivery) ? client.delivery : {};
  return { ...client, delivery: { ...delivery, gate } };
}

/** Stores a waiver for one line (or removes it with option ''). Returns the stored gate. */
export async function setGateWaiver(clientId, { lineId, option = '', reason = '', by = '', now, sales, deps = {} } = {}) {
  const client = sales.getSalesClientById(clientId);
  if (!client) return { ok: false, status: 404, error: 'Client not found.' };
  const id = text(lineId, 60);
  const inputs = await gatherGateInputs(client, deps);
  const current = evaluateDeliveryGate(client, inputs, { now });
  const line = current.lines.find((entry) => entry.id === id);
  if (!line) return { ok: false, status: 400, error: 'Unknown gate line.' };
  const stored = storedGate(client) || {};
  const waivers = normalizeWaivers(stored.waivers);
  if (!text(option)) delete waivers[id];
  else {
    if (!line.waiveOptions.includes(text(option))) return { ok: false, status: 400, error: 'Unknown waive option for this line.' };
    const directive = waiveDirective(id, option);
    waivers[id] = { option: text(option, 120), by: text(by, 120), at: isoOf(now), reason: text(reason, 300), ...(directive ? { directive } : {}) };
  }
  const withWaivers = { ...stored, waivers };
  const gate = withKeptGateFields(withWaivers, evaluateDeliveryGate(withStoredGate(client, withWaivers), inputs, { now }));
  sales.setSalesDelivery(client.id, { gate });
  appendDeliveryAudit({ kind: 'gate-waiver', clientId: client.id, by, line: id, option: text(option, 80) || 'removed' });
  return { ok: true, gate };
}

/** Records an approval of the gate (development may start although lines are missing). */
export async function approveGate(clientId, { by = '', note = '', approve = true, now, sales, deps = {} } = {}) {
  const client = sales.getSalesClientById(clientId);
  if (!client) return { ok: false, status: 404, error: 'Client not found.' };
  const stored = storedGate(client) || {};
  const next = { ...stored, approvedBy: approve ? text(by, 120) : '', approvedAt: approve ? isoOf(now) : '', note: text(note, 1000) || text(stored.note, 1000) };
  const inputs = await gatherGateInputs(client, deps);
  const gate = withKeptGateFields(next, evaluateDeliveryGate(withStoredGate(client, next), inputs, { now }));
  sales.setSalesDelivery(client.id, { gate });
  appendDeliveryAudit({ kind: 'gate-approval', clientId: client.id, by, approved: approve });
  return { ok: true, gate };
}

// ---------------------------------------------------------------- mail lines

/**
 * Gate mail rows for the pre-workshop and Datainnsamling mails, or null when they keep today's
 * lines: the gate is off for the client or emails.preWorkshop.lines is not 'gate'.
 */
export async function gateMailLinesFor(client, { settings = null, deps = {}, now } = {}) {
  let resolved;
  try {
    resolved = settings || getAutomationSettings();
  } catch {
    return null;
  }
  if (resolved?.emails?.preWorkshop?.lines !== 'gate') return null;
  if (!gateActiveForClient(client, { settings: resolved })) return null;
  const inputs = await gatherGateInputs(client, deps);
  const gate = evaluateDeliveryGate(client, inputs, { now });
  return gateMailRows(gate, inputs.materials);
}

// ---------------------------------------------------------------- shop connections

function inDelivery(client) {
  if (text(client?.product).toLowerCase() === 'ssu') return false;
  return client?.progression?.contractSigned === true || Boolean(activeSitePlan(client));
}

/**
 * Listens to stored payment-connection changes (lib/shop-payments.js): while the gate switch is
 * enabled, a change bumps the site's shopConnectionRev and marks the linked clients in delivery for
 * a gate check, so the next tick re-evaluates the payment line without calling a provider. With the
 * switch off a connection write changes nothing more than before.
 */
export async function installShopConnectionListener({ sales, hub } = {}) {
  const shop = await import('./shop-payments.js');
  if (typeof shop.setShopConnectionListener !== 'function') return false;
  shop.setShopConnectionListener(({ siteId }) => {
    if (!gateSwitchEnabled()) return;
    const bumped = hub?.bumpSiteShopConnectionRev?.(siteId);
    if (!bumped?.ok) return;
    const at = new Date().toISOString();
    for (const client of sales?.getSalesClients?.() || []) {
      if (text(client?.hubSite?.id) !== text(siteId) || !inDelivery(client)) continue;
      sales.setSalesDelivery(client.id, { dirtyAt: at });
    }
    appendDeliveryAudit({ kind: 'shop-connection', siteId: text(siteId, 80), rev: bumped.shopConnectionRev });
  });
  return true;
}

// ---------------------------------------------------------------- tick

let shadowCache = { file: '', size: -1, hashes: new Map() };

/** The input hash of the last shadow record for a client this month (the audit file is re-read only when it grew). */
function lastShadowHash(clientId, { dataDir, now }) {
  const at = isoOf(now);
  const file = deliveryAuditFile(dataDir, at);
  let size = 0;
  try {
    size = statSync(file).size;
  } catch {
    size = 0;
  }
  if (shadowCache.file !== file || shadowCache.size !== size) {
    const hashes = new Map();
    for (const row of readDeliveryAudit({ dataDir, month: at.slice(0, 7) })) {
      if (row.kind === 'gate-shadow' && row.clientId) hashes.set(row.clientId, row.hash);
    }
    shadowCache = { file, size, hashes };
  }
  return shadowCache.hashes.get(clientId) || '';
}

/**
 * One client in the delivery tick. Gate off or paused: nothing is read or written. Loop mode
 * auto: the gate is stored when its inputs changed. Any other loop mode: only a delivery-audit
 * record, once per input hash.
 */
export async function runGateStep(ctx = {}, client = null) {
  if (!client?.id) return { wrote: false };
  const settings = ctx.settings || getAutomationSettings({ dataDir: ctx.dataDir });
  const gateMode = gateModeForClient(client, { settings });
  if (gateMode !== 'shadow' && gateMode !== 'auto') return { wrote: false, skipped: `gate-${gateMode}` };
  const loopMode = text(ctx.mode) || 'shadow';
  if (loopMode === 'off' || loopMode === 'paused') return { wrote: false, skipped: `loop-${loopMode}` };
  const now = ctx.now ?? Date.now();
  const deps = { hub: ctx.hub, salesOffers: ctx.salesOffers, ...(ctx.gateDeps || {}) };
  const inputs = await gatherGateInputs(client, deps);
  const hash = gateInputHash(client, inputs);
  if (loopMode === 'auto') {
    const stored = storedGate(client);
    if (stored && stored.inputHash === hash && stored.version === GATE_VERSION) return { wrote: false };
    const gate = withKeptGateFields(stored, evaluateDeliveryGate(client, inputs, { now }));
    const sales = ctx.sales || await import('../data/sales.js');
    sales.setSalesDelivery(client.id, { gate });
    return { wrote: true, devComplete: gate.devComplete };
  }
  if (lastShadowHash(client.id, { dataDir: ctx.dataDir, now }) === hash.slice(0, 32)) return { wrote: false };
  const gate = evaluateDeliveryGate(client, inputs, { now });
  appendDeliveryAudit({
    at: isoOf(now),
    kind: 'gate-shadow',
    clientId: client.id,
    hash: hash.slice(0, 32),
    devComplete: gate.devComplete,
    missingDev: gate.missingDev,
    missingReady: gate.missingReady,
  }, { dataDir: ctx.dataDir });
  return { wrote: true, shadow: true, devComplete: gate.devComplete };
}

export const tickSteps = Object.freeze([
  Object.freeze({ name: 'gate', order: 40, scope: 'client', run: runGateStep }),
]);

/** Test hook: forget the cached shadow hashes. */
export function resetGateShadowCacheForTests() {
  shadowCache = { file: '', size: -1, hashes: new Map() };
}

// Fields a caller may use without importing the requirement modules.
export { filled };
