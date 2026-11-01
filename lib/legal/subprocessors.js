/**
 * Subprocessors and other recipients, rendered from the register keyed by outbound host
 * (lib/legal/hosts-register.json), plus the AI providers of the LLM data policy and the retention
 * periods.
 *
 * Retention text comes from the personal-data registry (lib/personal-data.js retentionText(storeId))
 * when that module exists and answers for a store, and otherwise from the retention.* settings.
 */
import { readFileSync } from 'node:fs';
import { ASOLDI_LLM_POLICY } from '../../packages/suite/harness/asoldi/llm.js';

export const PERSONAL_DATA_CLASSES = Object.freeze(['personal', 'transcript']);
export const REGISTER_SCOPES = Object.freeze(['asoldi', 'client']);

function freezeDeep(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freezeDeep(child);
  }
  return value;
}

export const HOSTS_REGISTER = freezeDeep(JSON.parse(readFileSync(new URL('./hosts-register.json', import.meta.url), 'utf8')));

function clean(value) {
  return String(value ?? '').trim();
}

function asList(value) {
  return Array.isArray(value) ? value : [];
}

/** The register row for a host: an exact key, else the closest '*.<base>' key that covers it. */
export function registerRowForHost(host, register = HOSTS_REGISTER) {
  const target = clean(host).toLowerCase();
  if (!target) return null;
  const hosts = register?.hosts || {};
  if (Object.prototype.hasOwnProperty.call(hosts, target)) return { key: target, row: hosts[target] };
  const bare = target.startsWith('*.') ? target.slice(2) : target;
  let best = null;
  for (const key of Object.keys(hosts)) {
    if (!key.startsWith('*.')) continue;
    const base = key.slice(2);
    if (bare === base || bare.endsWith(`.${base}`)) {
      if (!best || base.length > best.key.length - 2) best = { key, row: hosts[key] };
    }
  }
  return best;
}

/** Scanned hosts that have no register row. */
export function hostsWithoutRow(hosts, register = HOSTS_REGISTER) {
  return asList(hosts).filter((host) => !registerRowForHost(host, register));
}

/** Problems with the register itself (shape, unknown processors, contradictions). */
export function validateRegister(register = HOSTS_REGISTER) {
  const problems = [];
  const processors = register?.processors || {};
  for (const [id, processor] of Object.entries(processors)) {
    for (const field of ['name', 'entity', 'region', 'role']) {
      if (!clean(processor?.[field])) problems.push(`processor ${id}: missing ${field}`);
    }
    if (!Array.isArray(processor?.scopes) || processor.scopes.some((scope) => !REGISTER_SCOPES.includes(scope))) {
      problems.push(`processor ${id}: scopes must list ${REGISTER_SCOPES.join(' or ')}`);
    }
  }
  for (const [host, row] of Object.entries(register?.hosts || {})) {
    if (row?.noPersonalData === true) {
      if (!clean(row.reason)) problems.push(`host ${host}: noPersonalData needs a reason`);
      if (row.processor) problems.push(`host ${host}: noPersonalData rows name no processor`);
      continue;
    }
    if (!row?.processor || !processors[row.processor]) {
      problems.push(`host ${host}: needs a known processor or noPersonalData`);
      continue;
    }
    if (!clean(row.purpose)) problems.push(`host ${host}: missing purpose`);
    if (!Array.isArray(row.dataCategories)) problems.push(`host ${host}: dataCategories must be a list`);
    if (!clean(row.region)) problems.push(`host ${host}: missing region`);
    if (processors[row.processor].personalData === false && asList(row.dataCategories).length) {
      problems.push(`host ${host}: ${row.processor} receives no personal data, so its rows list no data categories`);
    }
  }
  return problems;
}

/**
 * Processors for one scope ('asoldi': Asoldi's own processing, 'client': processing for clients),
 * each with its hosts' purposes and data categories. `self` rows (Asoldi itself) are left out.
 */
export function subprocessorList({ scope = 'client', register = HOSTS_REGISTER } = {}) {
  const processors = register?.processors || {};
  const byId = new Map();
  for (const [host, row] of Object.entries(register?.hosts || {})) {
    if (!row?.processor) continue;
    const processor = processors[row.processor];
    if (!processor || processor.self || !asList(processor.scopes).includes(scope)) continue;
    if (!byId.has(row.processor)) {
      byId.set(row.processor, {
        id: row.processor,
        name: processor.name,
        entity: processor.entity,
        region: processor.region,
        transfer: processor.transfer || '',
        role: processor.role,
        personalData: processor.personalData !== false,
        llmProvider: processor.llmProvider || '',
        purposes: [],
        dataCategories: [],
        hosts: [],
      });
    }
    const entry = byId.get(row.processor);
    entry.hosts.push(host);
    if (row.purpose && !entry.purposes.includes(row.purpose)) entry.purposes.push(row.purpose);
    for (const category of asList(row.dataCategories)) if (!entry.dataCategories.includes(category)) entry.dataCategories.push(category);
  }
  for (const entry of byId.values()) entry.hosts.sort();
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name, 'nb'));
}

/** The register's processor for an LLM policy provider id ('claude', 'gemini', ...). */
export function processorForLlmProvider(provider, register = HOSTS_REGISTER) {
  for (const [id, processor] of Object.entries(register?.processors || {})) {
    if (processor.llmProvider === provider) return { id, ...processor };
  }
  return null;
}

/**
 * The AI providers of the LLM data policy: which data classes each may receive, and whether that
 * includes a personal-data class.
 */
export function llmProviderRows({ policy = ASOLDI_LLM_POLICY, register = HOSTS_REGISTER } = {}) {
  return Object.entries(policy?.providers || {}).map(([provider, rule]) => {
    const allow = asList(rule?.allow);
    const processor = processorForLlmProvider(provider, register);
    return {
      provider,
      processorId: processor?.id || '',
      name: processor?.name || provider,
      allow: [...allow],
      personal: allow.some((cls) => PERSONAL_DATA_CLASSES.includes(cls)),
      tasksOnly: asList(rule?.tasks).length > 0,
      paidTierPending: provider === 'gemini' && !rule?.paidTierConfirmedAt,
    };
  });
}

/** Norwegian sentence for one AI provider row. */
export function llmProviderSentence(row) {
  if (row.personal) {
    const base = `${row.name}: kan få personopplysninger og møtetranskripsjoner når oppgaven krever det.`;
    return row.paidTierPending ? `${base} Brukes for slike data først når betalt tjenestenivå med databehandleravtale er bekreftet.` : base;
  }
  if (row.tasksOnly) return `${row.name}: brukes bare til automatisk kvalitetskontroll og får aldri personopplysninger.`;
  return `${row.name}: får bare offentlige opplysninger, opplysninger om bedriften eller anonymiserte data, aldri personopplysninger.`;
}

// ---------------------------------------------------------------- retention

let personalData = null;
try {
  personalData = await import('../personal-data.js');
} catch {
  personalData = null;
}

/** retentionText(storeId) of the personal-data registry when it exists, else null. */
export function registryRetentionText() {
  return typeof personalData?.retentionText === 'function' ? personalData.retentionText : null;
}

const RETENTION_ROWS = [
  { id: 'leads', storeId: 'sales-clients', label: 'Bedrifter og kontaktpersoner som ikke har signert', fallback: (r) => `${r.leadMonths} måneder etter siste aktivitet` },
  { id: 'clients', storeId: 'sales-clients', label: 'Kundeopplysninger og avtaler', fallback: (r) => `${r.afterContractMonths} måneder etter at avtalen er avsluttet, og lenger der bokføringsloven krever det` },
  { id: 'meetings', storeId: 'fireflies-meetings', label: 'Møteopptak og transkripsjoner', fallback: (r) => `som kundeopplysninger, eller ${r.leadMonths} måneder etter siste aktivitet for bedrifter som ikke har signert` },
  { id: 'drafts', storeId: 'delivery-briefs', label: 'Utkast og eldre versjoner av prosjektdokumenter', fallback: (r) => `${r.briefOldVersionsDays} dager` },
  { id: 'changeRequests', storeId: 'change-requests', label: 'Endringsforespørsler', fallback: (r) => `${r.changeRequestsMonths} måneder` },
  { id: 'consent', storeId: 'nurture', label: 'Dokumentasjon av samtykke', fallback: (r) => `${r.nurtureProofYears} år` },
  { id: 'inbox', storeId: 'inbox', label: 'Logg over e-post innboksen hoppet over', fallback: (r) => `${r.inboxSkipLogDays} dager` },
  { id: 'emailLog', storeId: 'email-log', label: 'Logg over e-post sendt fra Asoldi', fallback: () => '400 dager' },
  { id: 'screenshots', storeId: 'dev-screenshots', label: 'Skjermbilder fra utviklingsarbeid', fallback: () => '30 dager' },
];

const RETENTION_DEFAULTS = { leadMonths: 12, afterContractMonths: 12, briefOldVersionsDays: 90, changeRequestsMonths: 24, nurtureProofYears: 3, inboxSkipLogDays: 30 };

/**
 * Retention rows [{id, label, text}]. `retentionText` (default: the registry's when present) wins
 * for a store when it returns text; otherwise the retention.* settings are used.
 */
export function retentionRows({ settings = null, retentionText = registryRetentionText() } = {}) {
  const retention = { ...RETENTION_DEFAULTS, ...(settings?.retention || {}) };
  return RETENTION_ROWS.map((row) => {
    let text = '';
    if (typeof retentionText === 'function') {
      try {
        text = clean(retentionText(row.storeId));
      } catch {
        text = '';
      }
    }
    return { id: row.id, label: row.label, text: text || row.fallback(retention) };
  });
}
