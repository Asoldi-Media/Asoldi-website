/**
 * Responses for GET /api/legal/texts/:doc?version=&tier= (lib/routes/legal-routes.js).
 *
 *   vilkar | personvern | databehandleravtale  a rendered document; version= picks an archived
 *                                              version, version=legacy answers {legacy:true} (the
 *                                              page then shows its static text)
 *   salg                                       the sales page's "what's included" per tier
 *   kontrakt?tier=<tier id>                    the contract lines of a tier's plan
 *   dpa-vedlegg                                the DPA appendix as Markdown
 *
 * Every published text belongs to a catalog version, so it never depends on stored settings: the
 * current documents are served from the archive of the current version, and the other texts are
 * rendered with the same options as that archive (archiveRenderOptions: the code defaults of the
 * automation settings and the personal-data registry's retention text). A stored setting that
 * differs from the published value (for example the grace days after cancellation) is reported by
 * legalSettingsDrift(); publishing the new value needs a new catalog version.
 */
import { defaultAutomationSettings } from '../../data/automation-settings.js';
import { CATALOG_VERSION, DPA_VERSION, legalParams } from './catalog.js';
import { catalogForVersion, dpaVersionForCatalog, loadArchivedCatalog } from './archive.js';
import { LEGAL_DOC_IDS, LEGAL_DOC_META, contractLinesForPlan, renderDocument, renderDpaAppendixMarkdown, salesCopy } from './render.js';
import { registryRetentionText, retentionRows } from './subprocessors.js';
import { TIER_IDS } from '../../packages/suite/core/delivery/vocab.js';

export const LEGAL_TEXT_DOCS = Object.freeze([...LEGAL_DOC_IDS, 'salg', 'kontrakt', 'dpa-vedlegg']);

/** The settings-derived values that are part of a catalog version's texts. */
export const VERSIONED_PARAMS = Object.freeze(['slaWorkDays', 'oneTimeMultiplier', 'oneTimeMonths', 'graceDays']);

function clean(value) {
  return String(value ?? '').trim();
}

/** The options every published text (and the archive) is rendered with. */
export function archiveRenderOptions() {
  return { settings: defaultAutomationSettings(), retentionText: registryRetentionText() };
}

/** The settings-derived values and retention rows a version was published with. */
export function publishedValues(options = archiveRenderOptions()) {
  const params = legalParams(options.settings);
  return {
    params: Object.fromEntries(VERSIONED_PARAMS.map((key) => [key, params[key]])),
    retention: retentionRows(options).map((row) => ({ id: row.id, text: row.text })),
  };
}

/**
 * The stored settings whose values differ from the ones the current version was published with:
 * [{ key, published, current }]. Empty when the published texts match the settings in use.
 */
export function legalSettingsDrift(settings, { archived = loadArchivedCatalog(CATALOG_VERSION) } = {}) {
  const published = archived?.published || publishedValues();
  const live = publishedValues({ settings: settings || defaultAutomationSettings(), retentionText: registryRetentionText() });
  const drift = [];
  for (const key of VERSIONED_PARAMS) {
    if (published.params?.[key] !== live.params[key]) drift.push({ key, published: published.params?.[key], current: live.params[key] });
  }
  const before = new Map((published.retention || []).map((row) => [row.id, row.text]));
  for (const row of live.retention) {
    if (before.get(row.id) !== row.text) drift.push({ key: `retention.${row.id}`, published: before.get(row.id), current: row.text });
  }
  return drift;
}

function parseVersion(raw) {
  const value = clean(raw).toLowerCase();
  if (!value || value === 'current') return { kind: 'current' };
  if (value === 'legacy') return { kind: 'legacy' };
  const number = Number(value);
  return Number.isInteger(number) && number >= 1 ? { kind: 'number', number } : { kind: 'invalid' };
}

/** The current version of a document: the archived one when present, else rendered with the archive's options. */
function currentDocument(id) {
  const archived = loadArchivedCatalog(CATALOG_VERSION);
  return archived?.docs?.[id] || renderDocument(id, archiveRenderOptions());
}

/** { status, body } for one request. */
export function legalTextResponse(doc, { version = '', tier = '' } = {}) {
  const id = clean(doc).toLowerCase();
  if (!LEGAL_TEXT_DOCS.includes(id)) return { status: 404, body: { code: 'unknown-document' } };
  const wanted = parseVersion(version);
  if (wanted.kind === 'invalid') return { status: 400, body: { code: 'invalid-version' } };
  const current = wanted.kind === 'current' || (wanted.kind === 'number' && wanted.number === CATALOG_VERSION);

  if (LEGAL_DOC_IDS.includes(id)) {
    if (wanted.kind === 'legacy') return { status: 200, body: { doc: id, legacy: true, path: LEGAL_DOC_META[id].path } };
    if (current) return { status: 200, body: { ...currentDocument(id), current: true } };
    const archived = loadArchivedCatalog(wanted.number);
    if (!archived?.docs?.[id]) return { status: 404, body: { code: 'unknown-version' } };
    return { status: 200, body: { ...archived.docs[id], current: false } };
  }

  const options = archiveRenderOptions();

  if (id === 'salg') {
    if (!current) return { status: 404, body: { code: 'unknown-version' } };
    // checkoutPromises: the checkout promises the terms back (none: the portal then shows none).
    return { status: 200, body: { catalogVersion: CATALOG_VERSION, tiers: salesCopy({ settings: options.settings }), checkoutPromises: [] } };
  }

  if (id === 'dpa-vedlegg') {
    if (!current) return { status: 404, body: { code: 'unknown-version' } };
    return { status: 200, body: { dpaVersion: DPA_VERSION, catalogVersion: CATALOG_VERSION, markdown: renderDpaAppendixMarkdown(options) } };
  }

  // kontrakt
  const tierId = clean(tier);
  if (!TIER_IDS.includes(tierId) || tierId === 'custom') return { status: 400, body: { code: 'tier-required' } };
  if (wanted.kind === 'legacy') return { status: 200, body: { tierId, legacy: true } };
  const versionNumber = current ? CATALOG_VERSION : wanted.number;
  const catalog = catalogForVersion(versionNumber);
  if (!catalog) return { status: 404, body: { code: 'unknown-version' } };
  const dpaVersion = dpaVersionForCatalog(versionNumber, DPA_VERSION);
  return {
    status: 200,
    body: {
      tierId,
      catalogVersion: versionNumber,
      dpaVersion,
      blocks: contractLinesForPlan(tierId, { catalog, settings: options.settings, params: { dpaVersion } }),
    },
  };
}
