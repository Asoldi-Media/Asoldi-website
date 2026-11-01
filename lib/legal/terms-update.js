/**
 * Terms updates: which signed clients are bound to an older version than the current catalog,
 * and a draft of the notice they must get before a newer version applies to them.
 *
 * Nothing here sends anything. The notice mail and its email kind come with the release suite;
 * until a client is notified (and signs again), the client stays on the version recorded at
 * signing, or on the legacy texts when no snapshot exists.
 */
import { CATALOG, CATALOG_DATE, CATALOG_VERSION, DPA_VERSION } from './catalog.js';
import { catalogForVersion } from './archive.js';
import { legalBindingForClient } from './binding.js';
import { LEGAL_URLS } from '../legal-urls.js';

export const NOTICE_DAYS = 30;

function clean(value) {
  return String(value ?? '').trim();
}

function escapeHtml(value = '') {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Signed clients on an older version: [{ clientId, businessName, bound: 'legacy' | <version>,
 * dpaVersion, current }]. Test clients and clients without a signed contract are left out.
 */
export function clientsOnOlderVersions(clients, { currentVersion = CATALOG_VERSION } = {}) {
  const out = [];
  for (const client of Array.isArray(clients) ? clients : []) {
    if (!client || client.isTest === true || client.progression?.contractSigned !== true) continue;
    const binding = legalBindingForClient(client);
    if (binding.mode === 'catalog' && binding.catalogVersion >= currentVersion) continue;
    out.push({
      clientId: clean(client.id),
      businessName: clean(client.businessName),
      bound: binding.mode === 'catalog' ? binding.catalogVersion : 'legacy',
      dpaVersion: binding.mode === 'catalog' ? binding.dpaVersion : '',
      current: currentVersion,
    });
  }
  return out;
}

function clauseText(clause) {
  return JSON.stringify([clause.nb, clause.en || null]);
}

/** Titles of the clauses that are new or changed between two catalog versions ('legacy': every clause). */
export function changedClauseTitles(fromVersion, { toCatalog = CATALOG } = {}) {
  const from = fromVersion === 'legacy' ? null : catalogForVersion(fromVersion);
  const titles = [];
  for (const clause of toCatalog) {
    if (!clause.docs.includes('terms') && !clause.docs.includes('contract')) continue;
    const before = from ? from.find((entry) => entry.id === clause.id) : null;
    if (!before || clauseText(before) !== clauseText(clause)) titles.push(clause.nb.title);
  }
  return titles;
}

function addDays(date, days) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * A draft notice { subject, text, html, effectiveFrom } for one client on an older version. It
 * names the new version, what changed and when it applies, with links to the published texts.
 */
export function draftTermsUpdateNotice(client, { now = new Date(), currentVersion = CATALOG_VERSION, dpaVersion = DPA_VERSION } = {}) {
  const binding = legalBindingForClient(client);
  const from = binding.mode === 'catalog' ? binding.catalogVersion : 'legacy';
  const changed = changedClauseTitles(from);
  const effectiveFrom = addDays(now instanceof Date ? now : new Date(now), NOTICE_DAYS);
  const name = clean(client?.contactPerson) || clean(client?.businessName) || 'kunde';
  const subject = `Oppdaterte vilkår fra Asoldi (versjon ${currentVersion})`;
  const intro = from === 'legacy'
    ? 'Vi har samlet vilkårene, personvernerklæringen og databehandleravtalen i én versjonert kilde, slik at teksten alltid beskriver det du faktisk får.'
    : `Vi har oppdatert vilkårene fra versjon ${from} til versjon ${currentVersion}.`;
  const lines = [
    `Hei ${name},`,
    '',
    intro,
    '',
    changed.length ? 'Endrede eller nye punkter:' : 'Ingen punkter i tjenesteavtalen er endret.',
    ...changed.map((title) => `- ${title}`),
    '',
    `De nye vilkårene gjelder for deg fra ${effectiveFrom}. Til da gjelder vilkårene du signerte.`,
    `Vilkår: ${LEGAL_URLS.vilkar}`,
    `Personvernerklæring: ${LEGAL_URLS.personvern}`,
    `Databehandleravtale (versjon ${dpaVersion}): ${LEGAL_URLS.databehandleravtale}`,
    '',
    'Har du spørsmål, svarer du bare på denne e-posten.',
    '',
    'Vennlig hilsen',
    'Asoldi',
  ];
  const text = lines.join('\n');
  const html = lines.map((line) => (line ? `<p>${escapeHtml(line)}</p>` : '')).join('');
  return { subject, text, html, effectiveFrom, from, to: currentVersion, catalogDate: CATALOG_DATE };
}
