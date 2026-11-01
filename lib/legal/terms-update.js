/**
 * Terms updates: which signed clients are bound to an older version than the current catalog,
 * a draft of the notice they must get before a newer version applies to them, and the record of a
 * sent notice.
 *
 * Nothing here sends anything. The notice mail and its email kind come with the release suite.
 * When that mail goes out, its sender records the notice with termsNoticePatch(client, notice):
 * client.ext.legal.notice = { catalogVersion, dpaVersion, sentAt, effectiveFrom }. From
 * effectiveFrom on, lib/legal/binding.js legalBindingForClient binds the client to the noticed
 * version; until then (and without a recorded notice) the client stays on the version recorded at
 * signing, or on the legacy texts when no snapshot exists. A progression write on a client who is
 * already signed records nothing; a signing step that knows the accepted offer can move the client
 * to that offer's version with legalSnapshotPatch(client, acceptedOffer) (lib/legal/binding.js).
 */
import { CATALOG, CATALOG_DATE, CATALOG_VERSION, DPA_VERSION } from './catalog.js';
import { catalogForVersion } from './archive.js';
import { legalBindingForClient, versionedLegalUrl } from './binding.js';
import { LEGAL_URLS } from '../legal-urls.js';

export const NOTICE_DAYS = 30;

function clean(value) {
  return String(value ?? '').trim();
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function escapeHtml(value = '') {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Signed clients on an older version: [{ clientId, businessName, bound: 'legacy' | <version>,
 * dpaVersion, current, pendingNotice }]. Test clients and clients without a signed contract are
 * left out. `pendingNotice` is { catalogVersion, effectiveFrom } when a notice was recorded and
 * has not taken effect yet.
 */
export function clientsOnOlderVersions(clients, { currentVersion = CATALOG_VERSION, now = new Date() } = {}) {
  const out = [];
  for (const client of Array.isArray(clients) ? clients : []) {
    if (!client || client.isTest === true || client.progression?.contractSigned !== true) continue;
    const binding = legalBindingForClient(client, { now });
    if (binding.mode === 'catalog' && binding.catalogVersion >= currentVersion) continue;
    out.push({
      clientId: clean(client.id),
      businessName: clean(client.businessName),
      bound: binding.mode === 'catalog' ? binding.catalogVersion : 'legacy',
      dpaVersion: binding.mode === 'catalog' ? binding.dpaVersion : '',
      current: currentVersion,
      pendingNotice: binding.pendingNotice || null,
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
 * A draft notice { subject, text, html, effectiveFrom, from, to, dpaVersion } for one client on an
 * older version. It names the new version, what changed and the date it applies from, with links
 * to the published texts. The date holds only once the sender records the notice
 * (termsNoticePatch with this draft), which is what moves the client's binding on that date.
 */
export function draftTermsUpdateNotice(client, { now = new Date(), currentVersion = CATALOG_VERSION, dpaVersion = DPA_VERSION } = {}) {
  const binding = legalBindingForClient(client, { now });
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
    `Versjon ${currentVersion} gjelder for deg fra ${effectiveFrom}, ${NOTICE_DAYS} dager etter dette varselet. Til da gjelder vilkårene du signerte.`,
    `Vilkår: ${versionedLegalUrl('vilkar', currentVersion)}`,
    `Personvernerklæring: ${LEGAL_URLS.personvern}`,
    `Databehandleravtale (versjon ${dpaVersion}): ${versionedLegalUrl('databehandleravtale', currentVersion)}`,
    '',
    'Har du spørsmål, svarer du bare på denne e-posten.',
    '',
    'Vennlig hilsen',
    'Asoldi',
  ];
  const text = lines.join('\n');
  const html = lines.map((line) => (line ? `<p>${escapeHtml(line)}</p>` : '')).join('');
  return { subject, text, html, effectiveFrom, from, to: currentVersion, dpaVersion, catalogDate: CATALOG_DATE };
}

/**
 * The client update that records a sent terms notice (from draftTermsUpdateNotice), or null when
 * that notice is already recorded. Keeps every other ext key and the signing snapshot; the
 * binding moves to the noticed version on its effectiveFrom date. For the notice mail's sender.
 */
export function termsNoticePatch(client, notice, { now = new Date() } = {}) {
  const version = Number(notice?.to);
  const effectiveFrom = clean(notice?.effectiveFrom);
  if (!client || !Number.isInteger(version) || version < 1 || !Number.isFinite(Date.parse(effectiveFrom))) return null;
  const ext = isPlainObject(client.ext) ? client.ext : {};
  const legal = isPlainObject(ext.legal) ? ext.legal : {};
  const current = isPlainObject(legal.notice) ? legal.notice : null;
  if (current && Number(current.catalogVersion) === version && clean(current.effectiveFrom) === effectiveFrom) return null;
  return {
    ext: {
      ...ext,
      legal: {
        ...legal,
        notice: {
          catalogVersion: version,
          dpaVersion: clean(notice.dpaVersion),
          sentAt: (now instanceof Date ? now : new Date(now)).toISOString(),
          effectiveFrom,
        },
      },
    },
  };
}
