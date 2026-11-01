// The legal clause catalog covers everything that is sold or included, renders the terms, privacy
// policy and DPA, and cannot change without a new version.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.APP_DATA_DIR = mkdtempSync(join(tmpdir(), 'legal-catalog-'));
process.env.DATA_DIR = '';

const vocab = await import('../packages/suite/core/delivery/vocab.js');
const catalogModule = await import('../lib/legal/catalog.js');
const render = await import('../lib/legal/render.js');
const legalRender = await import('./legal-render.mjs');
const { defaultAutomationSettings, validateAutomationSettings } = await import('../data/automation-settings.js');

const {
  CATALOG,
  CATALOG_VERSION,
  DPA_VERSION,
  catalogFromDeclared,
  coverageGaps,
  declaredClauses,
  entitledFeatureKeys,
  requiredCoverage,
  unknownCoverage,
} = catalogModule;

function emptyGaps(gaps) {
  return Object.values(gaps).every((list) => list.length === 0);
}

test('every service id, entitled feature key, add-on, cancellation effect and billing kind has a contract clause and a terms clause', () => {
  const required = requiredCoverage();
  assert.deepEqual(required.services, [...vocab.SERVICE_IDS], 'every service id is required');
  assert.ok(required.features.length >= 60, `entitled features: ${required.features.length}`);
  for (const key of ['blog', 'blog.posts', 'blog.autoPosts', 'seo.linkNetwork', 'email.automations.abandonedCart', 'reviews.google', 'changeRequests']) {
    assert.ok(required.features.includes(key), key);
  }
  assert.deepEqual(coverageGaps('contract'), { services: [], features: [], addOns: [], cancellation: [], billing: [] });
  assert.deepEqual(coverageGaps('terms'), { services: [], features: [], addOns: [], cancellation: [], billing: [] });
  assert.deepEqual(coverageGaps('sales').services, [], 'every service has a sales line');
  assert.deepEqual(unknownCoverage(), [], 'every declared key, service and add-on exists');
});

test('coverage fails when a clause is missing or the vocabulary grows (negative control)', () => {
  const withoutBlog = catalogFromDeclared(declaredClauses().filter((clause) => clause.id !== 'service.blog'));
  const gaps = coverageGaps('contract', { catalog: withoutBlog });
  assert.deepEqual(gaps.services, ['blog']);
  assert.ok(gaps.features.includes('blog.posts'));
  const required = requiredCoverage();
  const grown = { ...required, services: [...required.services, 'newservice'], features: [...required.features, 'shop.newThing'] };
  const more = coverageGaps('terms', { required: grown });
  assert.deepEqual(more.services, ['newservice']);
  assert.deepEqual(more.features, ['shop.newThing']);
  assert.equal(emptyGaps(more), false);
});

test('coverage is generated from the shared vocabulary and the feature tree', () => {
  const required = requiredCoverage();
  for (const tier of Object.values(vocab.TIER_MATRIX)) for (const id of tier.services) assert.ok(required.services.includes(id), id);
  assert.deepEqual(required.addOns, [...vocab.ONE_TIME_ADDON_IDS]);
  assert.deepEqual(required.cancellation, [...vocab.CANCELLATION_EFFECTS, 'grace']);
  assert.deepEqual(required.features, entitledFeatureKeys());
  const site = CATALOG.find((clause) => clause.id === 'service.site');
  assert.ok(site.covers.features.includes('site.legalPages'), 'site.* patterns expand against the tree');
  const ecom = CATALOG.find((clause) => clause.id === 'service.ecom');
  assert.ok(ecom.covers.features.includes('shop.payments.vipps'), 'shop.** expands to every descendant');
});

test('every clause has the texts its documents need, in Norwegian, and contract lines in English', () => {
  const ids = new Set();
  for (const clause of CATALOG) {
    assert.equal(ids.has(clause.id), false, `duplicate ${clause.id}`);
    ids.add(clause.id);
    assert.ok(Number.isInteger(clause.version) && clause.version >= 1, clause.id);
    assert.ok(clause.nb?.title, `${clause.id} title`);
    for (const doc of clause.docs) assert.ok(catalogModule.LEGAL_DOCS.includes(doc), `${clause.id}: ${doc}`);
    if (clause.docs.some((doc) => ['terms', 'privacy', 'dpa'].includes(doc))) assert.ok(clause.nb.terms?.length, `${clause.id} terms text`);
    if (clause.docs.includes('contract')) {
      assert.ok(clause.nb.contract?.length, `${clause.id} contract lines`);
      assert.ok(clause.en?.contract?.length, `${clause.id} English contract lines`);
    }
    if (clause.docs.includes('sales')) assert.ok(clause.nb.sales?.length, `${clause.id} sales lines`);
  }
});

test('the owner decisions are in the texts', () => {
  const terms = render.documentPlainText(render.renderDocument('vilkar', { retentionText: null }));
  // Blog on every tier; automatic posts only with SEO.
  assert.match(terms, /Alle nivåer har blogg på nettsiden/);
  assert.match(terms, /Med SEO-tjenesten skriver Asoldi blogginnlegg/);
  // Backlinks: followed, contextual, relevance-matched, capped, never site-wide footer, removed on cancellation.
  assert.match(terms, /fulgte lenker i en partnerseksjon/);
  assert.match(terms, /kobles etter bransje og sted/);
  assert.match(terms, /tak på antall lenker/);
  assert.match(terms, /aldri i bunnteksten på alle sider/);
  assert.match(terms, /fjernes lenkene til og fra kundens nettside/);
  // Email automations, abandoned cart only with consent.
  assert.match(terms, /forlatt handlekurv sendes bare til kjøpere som har krysset av/);
  // Reviews, SEO and agreed keywords, change allowance, one-time purchase.
  assert.match(terms, /omtaler fra Google/);
  assert.match(terms, /avtaler søkeordene arbeidet rettes mot/);
  assert.match(terms, /Inntil 4 endringer per måned/);
  assert.match(terms, /Én godtatt forespørsel er én endring/);
  assert.match(terms, /Prisen er 9 ganger månedsprisen/);
  assert.match(terms, /Ubegrensede endringer inngår i 6 måneder/);
  // Cancellation, export and hosting end after the paid period plus 30 days.
  assert.match(terms, /Nettsiden er oppe i 30 dager etter at den betalte perioden er over\. Deretter stopper hostingen/);
  assert.match(terms, /Kunden kan be om eksport fram til hostingen stopper, i kundeportalen eller ved å kontakte Asoldi/);
  // No commitments beyond the owner decisions: no export deadline, no manual approval of AI changes.
  assert.doesNotMatch(terms, /virkedager\. Eksporten|leverer eksporten innen|godkjennes av en utvikler/);
  // AI processing.
  assert.match(terms, /Personopplysninger og møteopptak sendes bare til AI-leverandører/);
  // Business-to-business terms; consumer-facing clauses follow the consumer authority's standard terms.
  assert.match(terms, /avtale mellom næringsdrivende/);
  for (const clause of CATALOG.filter((entry) => entry.consumerFacing)) {
    assert.match(clause.nb.terms.join(' '), /Forbrukertilsynets standard salgsbetingelser/, clause.id);
  }
});

test('the rendered documents have no unfilled placeholders and carry their versions', () => {
  for (const doc of render.LEGAL_DOC_IDS) {
    const rendered = render.renderDocument(doc, { retentionText: null });
    assert.equal(rendered.catalogVersion, CATALOG_VERSION);
    assert.equal(rendered.dpaVersion, DPA_VERSION);
    const text = render.documentPlainText(rendered);
    assert.doesNotMatch(text, /\{[a-zA-Z]+\}/, doc);
    assert.ok(rendered.sections.length >= 5, doc);
  }
  for (const tierId of ['tier-1-standard', 'tier-2-seo', 'tier-3-ecommerce']) {
    const lines = render.contractLinesForPlan(tierId).flatMap((block) => block.lines).join('\n');
    assert.doesNotMatch(lines, /\{[a-zA-Z]+\}/, tierId);
  }
});

test('the settings values feed the texts: one-time multiplier, grace days and change time', () => {
  const settings = defaultAutomationSettings();
  settings.pricing.oneTimeMultiplier = 12;
  settings.lifecycle.cancellationGraceDays = 45;
  settings.changeRequests.slaWorkDays = 7;
  const terms = render.documentPlainText(render.renderDocument('vilkar', { settings, retentionText: null }));
  assert.match(terms, /Prisen er 12 ganger månedsprisen/);
  assert.match(terms, /oppe i 45 dager/);
  assert.match(terms, /innen 7 arbeidsdager/);
});

test('the archive, the DPA appendix and the contract-line snapshot are current, so a text change needs a new version', () => {
  assert.deepEqual(legalRender.checkGenerated(), []);
  const files = readdirSync(new URL('../lib/legal/archive/', import.meta.url));
  assert.ok(files.includes(`catalog-v${CATALOG_VERSION}.json`));
  const archived = JSON.parse(readFileSync(new URL(`../lib/legal/archive/catalog-v${CATALOG_VERSION}.json`, import.meta.url), 'utf8'));
  assert.equal(archived.catalogVersion, CATALOG_VERSION);
  assert.equal(archived.dpaVersion, DPA_VERSION);
  // A changed clause renders different text, which no longer equals the archive.
  const changed = declaredClauses().map((clause) => (clause.id === 'service.blog' ? { ...clause, nb: { ...clause.nb, terms: ['Endret tekst.'] } } : clause));
  const changedTerms = render.renderDocument('vilkar', { catalog: catalogFromDeclared(changed), settings: defaultAutomationSettings(), retentionText: null });
  assert.notDeepEqual(changedTerms, archived.docs.vilkar);
});

test('the published texts come from the archive and never follow stored settings', async () => {
  const texts = await import('../lib/legal/texts.js');
  const archive = await import('../lib/legal/archive.js');
  const archived = archive.loadArchivedCatalog(CATALOG_VERSION);
  assert.deepEqual(archived.published, texts.publishedValues(), 'the archive records the values it was published with');
  const served = texts.legalTextResponse('vilkar');
  assert.equal(served.status, 200);
  const { current, ...doc } = served.body;
  assert.equal(current, true);
  assert.deepEqual(doc, archived.docs.vilkar, 'the current terms are the archived ones');
  assert.deepEqual(texts.legalSettingsDrift(defaultAutomationSettings()), []);
  const changed = defaultAutomationSettings();
  changed.lifecycle.cancellationGraceDays = 60;
  changed.pricing.oneTimeMultiplier = 11;
  changed.retention.leadMonths = 18;
  const drift = texts.legalSettingsDrift(changed);
  // retention.meetings follows the lead months for companies that have not signed.
  assert.deepEqual(drift.map((row) => row.key).sort(), ['graceDays', 'oneTimeMultiplier', 'retention.leads', 'retention.meetings'].sort());
  assert.deepEqual(drift.find((row) => row.key === 'graceDays'), { key: 'graceDays', published: 30, current: 60 });
});

test('the archive cache only holds versions that exist, and refuses numbers above the current version', async () => {
  const archive = await import('../lib/legal/archive.js');
  archive.clearArchiveCache();
  assert.equal(archive.loadArchivedCatalog(1e21), null);
  assert.equal(archive.loadArchivedCatalog(CATALOG_VERSION + 1), null);
  for (let n = 0; n < 500; n += 1) archive.loadArchivedCatalog(CATALOG_VERSION + 2 + n);
  assert.equal(archive.archiveCacheSize(), 0, 'misses are never cached');
  assert.ok(archive.loadArchivedCatalog(CATALOG_VERSION));
  assert.equal(archive.archiveCacheSize(), 1);
  const texts = await import('../lib/legal/texts.js');
  assert.equal(texts.legalTextResponse('vilkar', { version: '1000000000000000000000' }).status, 404);
  assert.equal(archive.archiveCacheSize(), 1);
});

test('a tier snapshot keeps a sent contract scope when the tier vocabulary changes later', async () => {
  const { planForContract, tierSnapshot } = await import('../lib/legal/plan.js');
  const snapshot = tierSnapshot();
  assert.deepEqual(planForContract({ tierId: 'tier-2-seo' }, { tiers: snapshot }), planForContract({ tierId: 'tier-2-seo' }));
  const older = { ...snapshot, 'tier-2-seo': { services: ['site'], pages: 3 } };
  const frozen = planForContract({ tierId: 'tier-2-seo' }, { tiers: older });
  assert.equal(frozen.pages, 3);
  assert.equal(frozen.services.includes('seo'), false, 'the snapshot, not today\'s tier contents');
  const lines = render.contractLinesForPlan({ tierId: 'tier-2-seo' }, { tiers: older }).map((block) => block.clauseId);
  assert.equal(lines.includes('service.seo'), false);
  assert.ok(render.contractLinesForPlan({ tierId: 'tier-2-seo' }).some((block) => block.clauseId === 'service.seo'));
});

test('the generated appendix file is the committed one', () => {
  const committed = readFileSync(legalRender.APPENDIX_URL, 'utf8').replace(/\r\n/g, '\n');
  assert.equal(committed, legalRender.currentAppendix());
  assert.match(committed, /^# Databehandleravtale: vedlegg/);
});

test('the legal switch is a boolean that defaults to off', () => {
  assert.deepEqual(defaultAutomationSettings().legal, { catalogTexts: { enabled: false } });
  assert.equal(vocab.SETTINGS_KEYS.legalCatalogTexts, 'legal.catalogTexts.enabled');
  assert.equal(validateAutomationSettings({ legal: { catalogTexts: { enabled: true } } }).ok, true);
  const bad = validateAutomationSettings({ legal: { catalogTexts: { enabled: 'yes' } } });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((error) => error.path === 'legal.catalogTexts.enabled'));
});

test('the legal files use neutral public wording', () => {
  const files = [
    '../lib/legal/catalog.js', '../lib/legal/render.js', '../lib/legal/subprocessors.js', '../lib/legal/dpa.js',
    '../lib/legal/binding.js', '../lib/legal/terms-update.js', '../lib/legal/hosts-register.json', '../docs/legal-texts.md',
    '../docs/databehandleravtale-appendix.md', '../lib/routes/legal-routes.js', '../lib/legal/archive.js', '../lib/legal/contract.js',
    '../lib/legal/sales.js', '../lib/legal/switch.js', '../lib/legal/texts.js', '../lib/legal/plan.js', './legal/scan-hosts.mjs', './legal-render.mjs',
    '../app/data/catalogLegalTexts.js', '../app/pages/legal/CatalogLegalPage.tsx', '../app/components/client/ClientLegalCard.tsx',
  ];
  for (const file of files) {
    const text = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.doesNotMatch(text, /\bWS\d+|\bwave\s*\d|\bQ\d{1,2}\b/i, file);
    assert.doesNotMatch(text, /\b(leak|forge|spoof|exploit|vulnerability|attacker)\b/i, file);
  }
});
