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
  assert.match(terms, /Kunden kan be Asoldi om eksport av nettsiden, CMS-data og mediefiler fram til hostingen stopper/);
  // Nothing is promised that is not built: no portal export and no cancellation or hosting-stop mails.
  assert.doesNotMatch(terms, /i kundeportalen eller ved å kontakte|sju dager før hostingen|Asoldi sender e-post når avtalen avsluttes/);
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

test('the wording a catalog contract adds around the clauses is archived, so changing it needs a new version', async () => {
  const archive = await import('../lib/legal/archive.js');
  const stored = archive.loadArchivedCatalog(CATALOG_VERSION);
  assert.deepEqual(stored.contract, legalRender.contractWording());
  assert.match(stored.contract.nb.section4.join(' '), /etter skriftlig varsel minst 30 dager i forveien/);
  assert.match(stored.contract.en.introLegal, /Data Processing Agreement/);
  // Negative control: an archive with other wording than the code renders is reported as stale.
  archive.useArchivedCatalogForTests(CATALOG_VERSION, { ...stored, contract: { ...stored.contract, nb: { ...stored.contract.nb, section4: ['Annen tekst.'] } } });
  try {
    assert.ok(legalRender.checkGenerated().some((problem) => /Bump CATALOG_VERSION/.test(problem)));
  } finally {
    archive.clearArchiveCache();
  }
  assert.deepEqual(legalRender.checkGenerated(), []);
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
  assert.equal(validateAutomationSettings({
    retention: { analyticsTraffic: { enabled: true, mode: 'auto' } },
    legal: { catalogTexts: { enabled: true } },
  }).ok, true);
  const bad = validateAutomationSettings({ legal: { catalogTexts: { enabled: 'yes' } } });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((error) => error.path === 'legal.catalogTexts.enabled'));
});

test('legal texts can be switched on only while visit statistics retention runs in auto', () => {
  function refusal(result) {
    assert.equal(result.ok, false);
    const error = result.errors.find((entry) => entry.path === 'legal.catalogTexts.enabled');
    assert.ok(error, JSON.stringify(result.errors));
    assert.match(error.message, /retention\.analyticsTraffic/);
    assert.match(error.message, /client CMS/);
  }
  refusal(validateAutomationSettings({ legal: { catalogTexts: { enabled: true } } }));
  refusal(validateAutomationSettings({
    retention: { analyticsTraffic: { enabled: true, mode: 'shadow' } },
    legal: { catalogTexts: { enabled: true } },
  }));
  refusal(validateAutomationSettings({
    retention: { analyticsTraffic: { enabled: true, mode: 'auto', paused: { reason: 'x' } } },
    legal: { catalogTexts: { enabled: true } },
  }));
  assert.equal(validateAutomationSettings({
    retention: { analyticsTraffic: { enabled: true, mode: 'auto' } },
    legal: { catalogTexts: { enabled: true } },
  }).ok, true);
  assert.equal(validateAutomationSettings({}, {
    current: {
      legal: { catalogTexts: { enabled: true } },
      retention: { analyticsTraffic: { enabled: false } },
    },
  }).ok, true);
});

test('the legal files use neutral public wording', () => {
  const files = [
    '../lib/legal/catalog.js', '../lib/legal/render.js', '../lib/legal/subprocessors.js', '../lib/legal/dpa.js',
    '../lib/legal/binding.js', '../lib/legal/terms-update.js', '../lib/legal/hosts-register.json', '../docs/legal-texts.md',
    '../docs/databehandleravtale-appendix.md', '../lib/routes/legal-routes.js', '../lib/legal/archive.js', '../lib/legal/contract.js',
    '../lib/legal/sales.js', '../lib/legal/switch.js', '../lib/legal/texts.js', '../lib/legal/plan.js', '../lib/legal/terms-update-send.js', './legal/scan-hosts.mjs', './legal-render.mjs',
    '../app/data/catalogLegalTexts.js', '../app/pages/legal/CatalogLegalPage.tsx', '../app/components/client/ClientLegalCard.tsx',
  ];
  for (const file of files) {
    const text = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.doesNotMatch(text, /\bWS\d+|\bwave\s*\d|\bQ\d{1,2}\b/i, file);
    assert.doesNotMatch(text, /\b(leak|forge|spoof|exploit|vulnerability|attacker)\b/i, file);
  }
});

test('published terms, privacy policy and DPA do not embed a tier list price', async () => {
  const texts = await import('../lib/legal/texts.js');
  const { WEBSITE_TIERS, formatKr } = await import('../lib/website-tiers.js');
  const prices = WEBSITE_TIERS.map((tier) => formatKr(tier.monthlyExMva));
  for (const doc of ['vilkar', 'personvern', 'databehandleravtale']) {
    const body = JSON.stringify(texts.legalTextResponse(doc).body);
    for (const price of prices) assert.equal(body.includes(price), false, `${doc} contains ${price}`);
  }
  assert.match(JSON.stringify(texts.legalTextResponse('vilkar').body), /tilbudet/);
});

test('the documents describe plan changes, self-booking links, site mail, storage-free statistics and the CMS retention schedule', async () => {
  const texts = await import('../lib/legal/texts.js');
  const body = (doc) => JSON.stringify(texts.legalTextResponse(doc).body);
  const terms = body('vilkar');
  assert.match(terms, /Endring av nivå og tjenester/);
  assert.match(terms, /SEO-vedlikehold/);
  const privacy = body('personvern');
  assert.match(privacy, /Bestilling av møtetid med lenke/);
  assert.match(privacy, /uten informasjonskapsler/);
  assert.match(privacy, /klikker for å vise/);
  const dpa = body('databehandleravtale');
  assert.match(dpa, /påminnelse om forlatt handlekurv/);
  assert.match(dpa, /Lagringstid for opplysninger i kundens CMS/);
  assert.match(dpa, /rapportmodus/);
  for (const id of ['general.planChange', 'privacy.booking', 'privacy.siteAnalytics', 'dpa.siteMail', 'dpa.cmsRetention']) {
    assert.ok(CATALOG.some((clause) => clause.id === id), id);
  }
  const contract = JSON.stringify(CATALOG.filter((c) => c.id === 'general.planChange'));
  assert.match(contract, /signert tilbud endres ikke/);
});

test('the cancellation and booking clauses state only what the system does', () => {
  const clauses = declaredClauses();
  const cancellation = JSON.stringify(clauses.find((clause) => clause.id === 'general.cancellation'));
  assert.doesNotMatch(cancellation, /kundeportalen|sju dager før|sender e-post når avtalen/);
  const booking = JSON.stringify(clauses.find((clause) => clause.id === 'privacy.booking'));
  assert.match(booking, /kunde-ID, formålet og tidspunktet/);
  assert.match(booking, /tidligst 60 dager etter at lenken utløp/);
  assert.doesNotMatch(booking, /slettes etter to måneder|bare et tilfeldig engangsnummer/);
});

// What the statistics clause must say for each field of a stored visit row. `ua` holds the device
// class a client site sends (never a browser string from it). `path` is the page address with its
// query string; `href` is filled only on a click event and holds the address of the clicked link.
const VISIT_ROW_WORDING = Object.freeze({
  type: /hendelsestype/,
  visitorId: /besøksnøkkel/,
  sessionId: /øktnøkkel/,
  path: /adressen til siden med eventuelle parametere/,
  href: /adressen til lenken som ble klikket/,
  referrer: /henvisningsadressen/,
  ua: /enhetstype \(datamaskin, mobil eller nettbrett\)/,
  host: /domenet/,
  ms: /tid på siden/,
  at: /tidspunktet/,
  siteKey: /nettsidens CMS og hos Asoldi/,
});

/** What a statistics text leaves out or gets wrong about the stored visit rows. */
function visitRowWordingProblems(text, rowKeys) {
  const problems = [];
  for (const key of rowKeys) {
    const wording = VISIT_ROW_WORDING[key];
    if (!wording) problems.push(`stored field without wording: ${key}`);
    else if (!wording.test(text)) problems.push(`field not described: ${key}`);
  }
  if (!/lagres én rad/.test(text)) problems.push('does not say one row per event');
  if (/besøkstall/.test(text)) problems.push('calls the rows a count');
  if (!/Radene slettes automatisk etter 26 måneder/.test(text)) problems.push('no retention statement');
  if (/ingen automatisk slettefrist/.test(text) || /sletter dem manuelt/.test(text)) problems.push('says the rows are never deleted automatically');
  // The rows are deleted after 26 months, not when hosting ends, so that phrase is still wrong.
  if (/så lenge Asoldi drifter nettsiden/.test(text)) problems.push('gives the rows an end point no code enforces');
  return problems;
}

test('the statistics clause names every field of a stored visit row, one row per event, and how long rows are kept', async () => {
  const { readdirSync: ls, readFileSync: read } = await import('node:fs');
  const { getPersistentDataDir } = await import('../data/storage-path.js');
  const dataDir = getPersistentDataDir();
  let rows;
  let files;
  {
    const guards = await import('../lib/site-public-guards.js');
    const store = await import('../data/client-analytics.js');
    const at = new Date().toISOString();
    // A client site sends server-made keys and the device class in `ua`; fields outside the list are dropped.
    // A click event carries the clicked link's path in `href`; the other events leave it empty.
    const sent = ['pageview', 'cta'].map((type) => ({
      type, visitorId: 'a'.repeat(32), sessionId: 'b'.repeat(32), path: '/tjenester?kilde=x', href: type === 'cta' ? '/bestill' : '',
      referrer: 'https://example.com/', ua: 'mobile', host: 'kunde.example.com', ms: 1500, at, ip: '203.0.113.9', email: 'person@example.com', name: 'Test Person',
    }));
    const events = guards.normalizeTrafficEvents(sent);
    assert.equal(store.appendTrafficEvents('legal-traffic-site', events), 2);
    const dir = join(dataDir, 'client-analytics-traffic', 'legal-traffic-site');
    files = ls(dir);
    rows = files.flatMap((name) => read(join(dir, name), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)));
  }
  // One row per event in a file per day: not a daily count.
  assert.equal(rows.length, 2);
  assert.deepEqual(files, [`${rows[0].at.slice(0, 10)}.jsonl`]);
  const keys = [...new Set(rows.flatMap((row) => Object.keys(row)))].sort();
  assert.deepEqual(keys, ['at', 'host', 'href', 'ms', 'path', 'referrer', 'sessionId', 'siteKey', 'type', 'ua', 'visitorId']);
  // The page address with its query string is in `path`; `href` is the clicked link, on the click row only.
  assert.deepEqual(rows.map((row) => [row.type, row.path, row.href]), [['pageview', '/tjenester?kilde=x', ''], ['cta', '/tjenester?kilde=x', '/bestill']]);
  // No name, e-mail address or IP address reaches a row.
  assert.doesNotMatch(JSON.stringify(rows), /203\.0\.113\.9|person@example\.com|Test Person/);

  const clause = declaredClauses().find((entry) => entry.id === 'privacy.siteAnalytics');
  const text = clause.nb.terms.join(' ');
  assert.deepEqual(visitRowWordingProblems(text, keys), []);
  assert.match(text, /uten informasjonskapsler og uten lagring i besøkendes nettleser/);
  assert.match(text, /byttes hver dag/);
  assert.match(text, /inneholder ikke navn, e-postadresse eller IP-adresse/);
  const retentionJob = await import('../lib/analytics-traffic-retention.js');
  const { BACKGROUND_JOBS } = await import('../lib/safe-mode.js');
  assert.equal(retentionJob.TRAFFIC_RETENTION_MONTHS, 26);
  assert.match(text, new RegExp(`${retentionJob.TRAFFIC_RETENTION_MONTHS} måneder`));
  assert.ok(BACKGROUND_JOBS.analyticsTrafficRetention);
  const { mkdirSync, writeFileSync, existsSync } = await import('node:fs');
  const oldStamp = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() - 28, 1));
  const oldDay = oldStamp.toISOString().slice(0, 10);
  const oldDir = join(dataDir, 'client-analytics-traffic', 'legal-traffic-archive');
  mkdirSync(oldDir, { recursive: true });
  const oldFile = join(oldDir, `${oldDay}.jsonl`);
  writeFileSync(oldFile, '{"type":"pageview"}\n');
  const todayFile = join(dataDir, 'client-analytics-traffic', 'legal-traffic-site', files[0]);
  const ran = await retentionJob.runTrafficRetention({
    now: Date.now(),
    settings: { retention: { analyticsTraffic: { enabled: true, mode: 'auto', paused: null } } },
    logger: { log() {}, error() {} },
  });
  assert.equal(ran.ran, true);
  assert.equal(existsSync(oldFile), false);
  assert.equal(existsSync(todayFile), true);
  // The rendered privacy policy carries the same text.
  assert.deepEqual(visitRowWordingProblems(render.documentPlainText(render.renderDocument('personvern', { retentionText: null })), keys), []);

  // Negative controls: the earlier sentence, the wording that said the rows are never deleted
  // automatically, a text with the 26-month sentence removed, and a row with a field the text
  // does not describe.
  const earlier = 'Nettsidene Asoldi leverer, teller besøk uten informasjonskapsler og uten lagring i besøkendes nettleser. Vi lagrer et daglig anonymisert besøkstall med enhetstype og side, ikke en person.';
  const earlierProblems = visitRowWordingProblems(earlier, keys);
  for (const expected of ['field not described: visitorId', 'field not described: sessionId', 'field not described: href', 'field not described: referrer', 'does not say one row per event', 'calls the rows a count', 'no retention statement']) {
    assert.ok(earlierProblems.includes(expected), expected);
  }
  const keptByHand = text.replace(
    'Radene slettes automatisk etter 26 måneder, både i CMS-et og hos Asoldi, også når avtalen er avsluttet før det.',
    'De har ingen automatisk slettefrist. Radene blir liggende til Asoldi sletter dem manuelt, også etter at avtalen er avsluttet.',
  );
  assert.deepEqual(visitRowWordingProblems(keptByHand, keys), ['no retention statement', 'says the rows are never deleted automatically']);
  const dropped = text.replace(' Radene slettes automatisk etter 26 måneder, både i CMS-et og hos Asoldi, også når avtalen er avsluttet før det.', '');
  assert.deepEqual(visitRowWordingProblems(dropped, keys), ['no retention statement']);
  // The wording that named the page address for both fields, and gave the rows an end point, also fails.
  const previous = text
    .replace(', ved et klikk på en lenke adressen til lenken som ble klikket', '')
    .replace('Radene slettes automatisk etter 26 måneder, både i CMS-et og hos Asoldi, også når avtalen er avsluttet før det.', 'De oppbevares så lenge Asoldi drifter nettsiden.');
  assert.deepEqual(visitRowWordingProblems(previous, keys), ['field not described: href', 'no retention statement', 'gives the rows an end point no code enforces']);
  // Nothing else that handles the rows on the hub deletes them either.
  const hubSources = ['../lib/site-public-guards.js', '../lib/analytics-traffic.js'].map((file) => read(new URL(file, import.meta.url), 'utf8')).join('\n');
  assert.doesNotMatch(hubSources, /\b(rmSync|unlinkSync|rmdirSync)\b/);
  assert.deepEqual(visitRowWordingProblems(text, [...keys, 'ip']), ['stored field without wording: ip']);
});

test('the booking link, remembered embed and CMS retention clauses carry the periods and rules the code uses', async () => {
  const booking = await import('../lib/client-booking.js');
  const day = 24 * 60 * 60 * 1000;
  const clauses = declaredClauses();
  const textOf = (id) => clauses.find((clause) => clause.id === id).nb.terms.join(' ');
  // The link's life and the ledger's keep time are the code's constants.
  assert.equal(booking.BOOKING_TOKEN_TTL_MS, 21 * day);
  assert.equal(booking.BOOKING_LEDGER_KEEP_MS, 60 * day);
  assert.match(textOf('privacy.booking'), /utløper etter tre uker/);
  assert.match(textOf('privacy.booking'), /tidligst 60 dager etter at lenken utløp/);
  // A remembered embed choice is a cookie, so the text says so and does not claim every embed waits for a click.
  const analytics = textOf('privacy.siteAnalytics');
  assert.match(analytics, /huske valget, lagres det i en nødvendig informasjonskapsel i 180 dager/);
  assert.match(analytics, /lastes da uten nytt klikk/);
  // Only cross-origin frames wait for a click; the text may not promise that for other third-party content.
  const embedScopeProblems = (value) => [
    ...(/Innebygde rammer \(iframe\) fra tredjeparter/.test(value) ? [] : ['click-to-load is not limited to frames']),
    ...(/Før klikket sendes ingen opplysninger til tredjeparten/.test(value) ? ['says nothing reaches a third party before a click'] : []),
    ...(/Annet innhold fra tredjeparter[^.]*lastes uten klikk/.test(value) ? [] : ['does not say other third-party content loads without a click']),
  ];
  assert.deepEqual(embedScopeProblems(analytics), []);
  assert.deepEqual(
    embedScopeProblems('Innebygd innhold fra tredjeparter, for eksempel kart og video, lastes først når den besøkende klikker for å vise det. Før klikket sendes ingen opplysninger til tredjeparten.'),
    ['click-to-load is not limited to frames', 'says nothing reaches a third party before a click', 'does not say other third-party content loads without a click'],
  );
  // Orders and the other shop rows have no deletion period, so the text gives none.
  const ordersProblems = (value) => [
    ...(/Ordrer: ingen automatisk slettefrist/.test(value) ? [] : ['orders lack the no-period statement']),
    ...(/Ordrer: regnskapsperioden/.test(value) ? ['orders are given a period'] : []),
    ...(/timebestillinger, abonnementer, gavekort, anmeldelser og nettbutikkens endringslogg/.test(value) ? [] : ['shop rows not listed']),
  ];
  assert.deepEqual(ordersProblems(textOf('dpa.cmsRetention')), []);
  assert.deepEqual(ordersProblems('Ordrer: regnskapsperioden. Adresse og kontaktopplysninger fjernes når en sletting krever det, men raden beholdes for regnskapet.'), ['orders lack the no-period statement', 'orders are given a period', 'shop rows not listed']);
  // Retention: Asoldi switches deletion on per site, form answers count from when they came in, and
  // the 30-day step rows are the ones without an address.
  const retention = textOf('dpa.cmsRetention');
  assert.match(retention, /når Asoldi har slått det på for nettsiden etter å ha lest rapporten/);
  assert.match(retention, /sikkerhetskopi før den første slettingen/);
  assert.match(retention, /Skjemasvar: to år etter at de kom inn/);
  assert.match(retention, /30 dager for rader uten e-postadresse/);
  assert.match(retention, /Besøksstatistikk: 26 måneder/);
  assert.doesNotMatch(retention, /når kunden slår det på|Henvendelser og skjemasvar: to år etter siste aktivitet|Rader uten samtykke/);
});

test('legal-render --write refuses to change an archive that exists with other texts unless it is marked unreleased', async () => {
  const { cpSync, mkdtempSync: mk, rmSync, existsSync } = await import('node:fs');
  const archive = await import('../lib/legal/archive.js');
  const file = new URL(`../lib/legal/archive/catalog-v${CATALOG_VERSION}.json`, import.meta.url);
  const original = readFileSync(file, 'utf8');
  const copy = join(mk(join(tmpdir(), 'legal-archive-')), 'backup.json');
  cpSync(file, copy);
  const { writeFileSync } = await import('node:fs');
  // A checkout may hold the archive with CRLF line endings while the writer writes LF; compare the
  // text the way legal-render --check reads it.
  const lf = (text) => text.replace(/\r\n/g, '\n');
  try {
    const stale = JSON.parse(original);
    stale.docs.vilkar = { ...stale.docs.vilkar, title: 'Eldre tittel' };
    writeFileSync(file, `${JSON.stringify(stale, null, 2)}\n`);
    archive.clearArchiveCache();
    assert.throws(() => legalRender.writeGenerated(), /already archived with other texts/);
    assert.notEqual(lf(readFileSync(file, 'utf8')), lf(original), 'the refused write left the archive as it was');
    legalRender.writeGenerated({ unreleased: true });
    assert.equal(lf(readFileSync(file, 'utf8')), lf(original), 'the explicit unreleased write restores the current texts');
  } finally {
    writeFileSync(file, original);
    archive.clearArchiveCache();
    rmSync(copy, { force: true });
    assert.ok(existsSync(file));
  }
});
