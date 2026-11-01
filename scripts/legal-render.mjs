#!/usr/bin/env node
/**
 * Generated legal files:
 *   - lib/legal/archive/catalog-v<CATALOG_VERSION>.json  the clauses and rendered documents of the current version
 *   - docs/databehandleravtale-appendix.md              the DPA appendix (sub-processors and AI processing)
 *   - scripts/fixtures/legal/contract-lines.json        the contract lines of tiers 1-3 (snapshot)
 *
 *   node scripts/legal-render.mjs --write   write them. An existing archive of the current version is never
 *                                           rewritten with different content: bump CATALOG_VERSION (and
 *                                           DPA_VERSION when the DPA changed) in lib/legal/catalog.js first.
 *   node scripts/legal-render.mjs --check   exit 1 when any of them is stale, or when the DPA text changed
 *                                           without a new DPA_VERSION.
 *
 * Rendering uses the code defaults of the automation settings and no personal-data registry text,
 * so the output depends only on the code.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { defaultAutomationSettings } from '../data/automation-settings.js';
import { CATALOG_DATE, CATALOG_VERSION, DPA_VERSION, declaredClauses } from '../lib/legal/catalog.js';
import { ARCHIVE_DIR, ARCHIVE_FORMAT, archiveUrl, archivedVersions, clearArchiveCache, loadArchivedCatalog } from '../lib/legal/archive.js';
import { LEGAL_DOC_IDS, contractLinesForPlan, renderDocument, renderDpaAppendixMarkdown } from '../lib/legal/render.js';

export const APPENDIX_URL = new URL('../docs/databehandleravtale-appendix.md', import.meta.url);
export const CONTRACT_LINES_URL = new URL('./fixtures/legal/contract-lines.json', import.meta.url);

const SNAPSHOT_PLANS = Object.freeze({
  'tier-1-standard': { tierId: 'tier-1-standard' },
  'tier-2-seo': { tierId: 'tier-2-seo' },
  'tier-3-ecommerce': { tierId: 'tier-3-ecommerce' },
  'tier-1-standard:once': { tierId: 'tier-1-standard', billing: 'once' },
});

function renderOptions() {
  return { settings: defaultAutomationSettings(), retentionText: null };
}

export function currentArchive() {
  const options = renderOptions();
  return {
    format: ARCHIVE_FORMAT,
    catalogVersion: CATALOG_VERSION,
    dpaVersion: DPA_VERSION,
    date: CATALOG_DATE,
    clauses: declaredClauses(),
    docs: Object.fromEntries(LEGAL_DOC_IDS.map((doc) => [doc, renderDocument(doc, options)])),
  };
}

export function currentAppendix() {
  return renderDpaAppendixMarkdown(renderOptions());
}

export function currentContractLines() {
  const out = {};
  for (const [key, plan] of Object.entries(SNAPSHOT_PLANS)) {
    out[key] = {
      nb: contractLinesForPlan(plan, { settings: defaultAutomationSettings() }),
      en: contractLinesForPlan(plan, { language: 'en', settings: defaultAutomationSettings() }),
    };
  }
  return { catalogVersion: CATALOG_VERSION, dpaVersion: DPA_VERSION, plans: out };
}

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function readJson(url) {
  if (!existsSync(url)) return null;
  try {
    return JSON.parse(readFileSync(url, 'utf8'));
  } catch {
    return null;
  }
}

function readText(url) {
  return existsSync(url) ? readFileSync(url, 'utf8').replace(/\r\n/g, '\n') : null;
}

function dpaBody(doc) {
  return JSON.stringify(doc?.sections || []);
}

/** Problems with the generated files (an empty list when all are current). */
export function checkGenerated() {
  const problems = [];
  const archive = currentArchive();
  const stored = loadArchivedCatalog(CATALOG_VERSION);
  if (!stored) problems.push(`lib/legal/archive/catalog-v${CATALOG_VERSION}.json is missing. Run node scripts/legal-render.mjs --write.`);
  else if (!same(stored, archive)) {
    problems.push(`The legal texts differ from lib/legal/archive/catalog-v${CATALOG_VERSION}.json. Bump CATALOG_VERSION in lib/legal/catalog.js (and DPA_VERSION when the DPA changed), then run node scripts/legal-render.mjs --write.`);
  }
  for (const version of archivedVersions()) {
    if (version === CATALOG_VERSION) continue;
    const old = loadArchivedCatalog(version);
    if (old?.dpaVersion === DPA_VERSION && dpaBody(old.docs?.databehandleravtale) !== dpaBody(archive.docs.databehandleravtale)) {
      problems.push(`The data processing agreement changed since catalog version ${version} without a new DPA_VERSION (${DPA_VERSION}).`);
    }
  }
  if (readText(APPENDIX_URL) !== currentAppendix()) problems.push('docs/databehandleravtale-appendix.md is stale. Run node scripts/legal-render.mjs --write.');
  if (!same(readJson(CONTRACT_LINES_URL), currentContractLines())) problems.push('scripts/fixtures/legal/contract-lines.json is stale. Run node scripts/legal-render.mjs --write.');
  return problems;
}

/** Writes the generated files. Refuses to change an existing archive of the current version. */
export function writeGenerated() {
  const archive = currentArchive();
  const stored = loadArchivedCatalog(CATALOG_VERSION);
  if (stored && !same(stored, archive)) {
    throw new Error(`Catalog version ${CATALOG_VERSION} is already archived with other texts. Bump CATALOG_VERSION in lib/legal/catalog.js (and DPA_VERSION when the DPA changed) and run --write again.`);
  }
  mkdirSync(ARCHIVE_DIR, { recursive: true });
  if (!stored) writeFileSync(archiveUrl(CATALOG_VERSION), json(archive));
  clearArchiveCache();
  mkdirSync(new URL('.', CONTRACT_LINES_URL), { recursive: true });
  writeFileSync(APPENDIX_URL, currentAppendix());
  writeFileSync(CONTRACT_LINES_URL, json(currentContractLines()));
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--write')) {
    writeGenerated();
    const problems = checkGenerated();
    if (problems.length) {
      console.error(problems.join('\n'));
      process.exit(1);
    }
    console.log(`Legal texts written (catalog version ${CATALOG_VERSION}, ${DPA_VERSION}).`);
    return;
  }
  if (args.includes('--check')) {
    const problems = checkGenerated();
    if (problems.length) {
      console.error(problems.join('\n'));
      process.exit(1);
    }
    console.log(`Legal texts are current (catalog version ${CATALOG_VERSION}, ${DPA_VERSION}).`);
    return;
  }
  console.error('Usage: node scripts/legal-render.mjs --write | --check');
  process.exit(2);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main();
