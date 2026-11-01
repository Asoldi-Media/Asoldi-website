/**
 * Responses for GET /api/legal/texts/:doc?version=&tier= (lib/routes/legal-routes.js).
 *
 *   vilkar | personvern | databehandleravtale  a rendered document; version= picks an archived
 *                                              version, version=legacy answers {legacy:true} (the
 *                                              page then shows its static text)
 *   salg                                       the sales page's "what's included" per tier
 *   kontrakt?tier=<tier id>                    the contract lines of a tier's plan
 *   dpa-vedlegg                                the DPA appendix as Markdown
 */
import { CATALOG_VERSION, DPA_VERSION } from './catalog.js';
import { catalogForVersion, dpaVersionForCatalog, loadArchivedCatalog } from './archive.js';
import { LEGAL_DOC_IDS, LEGAL_DOC_META, contractLinesForPlan, renderDocument, renderDpaAppendixMarkdown, salesCopy } from './render.js';
import { TIER_IDS } from '../../packages/suite/core/delivery/vocab.js';

export const LEGAL_TEXT_DOCS = Object.freeze([...LEGAL_DOC_IDS, 'salg', 'kontrakt', 'dpa-vedlegg']);

function clean(value) {
  return String(value ?? '').trim();
}

function parseVersion(raw) {
  const value = clean(raw).toLowerCase();
  if (!value || value === 'current') return { kind: 'current' };
  if (value === 'legacy') return { kind: 'legacy' };
  const number = Number(value);
  return Number.isInteger(number) && number >= 1 ? { kind: 'number', number } : { kind: 'invalid' };
}

/** { status, body } for one request. `settings` are the automation settings (pricing, retention). */
export function legalTextResponse(doc, { version = '', tier = '', settings = null } = {}) {
  const id = clean(doc).toLowerCase();
  if (!LEGAL_TEXT_DOCS.includes(id)) return { status: 404, body: { code: 'unknown-document' } };
  const wanted = parseVersion(version);
  if (wanted.kind === 'invalid') return { status: 400, body: { code: 'invalid-version' } };
  const current = wanted.kind === 'current' || (wanted.kind === 'number' && wanted.number === CATALOG_VERSION);

  if (LEGAL_DOC_IDS.includes(id)) {
    if (wanted.kind === 'legacy') return { status: 200, body: { doc: id, legacy: true, path: LEGAL_DOC_META[id].path } };
    if (current) return { status: 200, body: { ...renderDocument(id, { settings }), current: true } };
    const archived = loadArchivedCatalog(wanted.number);
    if (!archived?.docs?.[id]) return { status: 404, body: { code: 'unknown-version' } };
    return { status: 200, body: { ...archived.docs[id], current: false } };
  }

  if (id === 'salg') {
    if (!current) return { status: 404, body: { code: 'unknown-version' } };
    return { status: 200, body: { catalogVersion: CATALOG_VERSION, tiers: salesCopy({ settings }) } };
  }

  if (id === 'dpa-vedlegg') {
    if (!current) return { status: 404, body: { code: 'unknown-version' } };
    return { status: 200, body: { dpaVersion: DPA_VERSION, catalogVersion: CATALOG_VERSION, markdown: renderDpaAppendixMarkdown({ settings }) } };
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
      blocks: contractLinesForPlan(tierId, { catalog, settings, params: { dpaVersion } }),
    },
  };
}
